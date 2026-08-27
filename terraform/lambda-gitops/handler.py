import json
import os
import urllib.parse
import boto3
import requests
from ruamel.yaml import YAML
from ruamel.yaml.scalarstring import DoubleQuotedScalarString
from ruamel.yaml.comments import CommentedSeq
from io import StringIO
# =====================================================
# AWS LAMBDA SESSION
# =====================================================
session = boto3.Session(
    region_name="eu-west-1"
)
sm = session.client(
    "secretsmanager"
)
ses = session.client(
    "ses"
)
# =====================================================
# CONFIG
# =====================================================
BITBUCKET_URL = "https://xxxxxxxxxxxxxxxx.biz" #os.environ["BITBUCKET_URL"]
PROJECT_KEY = "xxxxxxxxxxx" #os.environ["PROJECT_KEY"]
REPO_SLUG = "xxxxxxxxxxxx" #os.environ["REPO_SLUG"]
SOURCE_BRANCH = "dev" #os.environ.get("SOURCE_BRANCH", "main")
REPO_BASE_PATH = "apps/dpc" #os.environ["REPO_BASE_PATH"]
SUPPORTED_SECTIONS = [
    "buckets",
    "secrets",
    "kmsKeys",
    "functions"
]
from ruamel.yaml import YAML
yaml_parser = YAML()
yaml_parser.preserve_quotes = True
yaml_parser.default_flow_style = False
# Preserve standard YAML indentation
yaml_parser.indent(
    mapping=2,
    sequence=4,
    offset=2
)
GIT_TOKEN = ""

# =====================================================
# APPROVERS / NOTIFICATIONS CONFIG
# =====================================================
# Bitbucket usernames added as PR reviewers. Injected via Lambda env var,
# comma-separated, e.g. "jdoe,asmith".
PR_APPROVER_USERNAMES = [
    name.strip()
    for name in os.environ.get("PR_APPROVER_USERNAMES", "").split(",")
    if name.strip()
]
# Email addresses notified when a PR is opened. Not assumed to be the same
# as the Bitbucket usernames above - kept as a separate list since a
# Bitbucket username and an email address aren't necessarily the same
# identifier for a given approver.
PR_APPROVER_EMAILS = [
    email.strip()
    for email in os.environ.get("PR_APPROVER_EMAILS", "").split(",")
    if email.strip()
]
# Verified SES sender identity (or domain) required for send_email to work.
NOTIFICATION_FROM_EMAIL = os.environ.get("NOTIFICATION_FROM_EMAIL", "")

# =====================================================
# AUTH
# =====================================================
def get_headers():
    return {
        "Authorization": f"Bearer {GIT_TOKEN}",
        "Accept": "application/json"
    }
# =====================================================
# BITBUCKET REQUEST HELPER
# =====================================================
def check_response(response, operation):
    print(f"\n--- {operation} ---")
    print(f"Status: {response.status_code}")
    if response.text:
        print(f"Response: {response.text[:2000]}")
    response.raise_for_status()
# =====================================================
# GET LATEST COMMIT
# =====================================================
def get_latest_commit(branch_name):
    url = (
        f"{BITBUCKET_URL}"
        f"/rest/api/latest/projects/{PROJECT_KEY}"
        f"/repos/{REPO_SLUG}/branches"
    )
    response = requests.get(
        url,
        headers=get_headers(),
        params={"filterText": branch_name},
        timeout=30
    )
    check_response(response, f"Get branch: {branch_name}")
    branches = response.json().get("values", [])
    for branch in branches:
        if branch["displayId"] == branch_name:
            return branch["latestCommit"]
    raise Exception(f"Branch {branch_name} not found")
# =====================================================
# CREATE BRANCH
# =====================================================
def create_branch(branch_name, commit_hash):
    url = (
        f"{BITBUCKET_URL}"
        f"/rest/api/latest/projects/{PROJECT_KEY}"
        f"/repos/{REPO_SLUG}/branches"
    )
    payload = {
        "name": f"refs/heads/{branch_name}",
        "startPoint": commit_hash
    }
    response = requests.post(
        url,
        headers={
            **get_headers(),
            "Content-Type": "application/json"
        },
        json=payload,
        timeout=30
    )
    check_response(response, f"Create branch: {branch_name}")
# =====================================================
# GET FILE CONTENT
# =====================================================
def get_file_content(branch_name, file_path):
    encoded_path = urllib.parse.quote(
        file_path,
        safe="/"
    )
    url = (
        f"{BITBUCKET_URL}"
        f"/rest/api/latest/projects/{PROJECT_KEY}"
        f"/repos/{REPO_SLUG}"
        f"/raw/{encoded_path}"
    )
    response = requests.get(
        url,
        headers=get_headers(),
        params={"at": f"refs/heads/{branch_name}"},
        timeout=30
    )
    check_response(response, f"Get file: {file_path}")
    return response.text
# =====================================================
# GET FILE LAST COMMIT
# =====================================================
def get_file_last_commit(branch_name, file_path):
    url = (
        f"{BITBUCKET_URL}"
        f"/rest/api/latest/projects/{PROJECT_KEY}"
        f"/repos/{REPO_SLUG}"
        f"/commits"
    )
    response = requests.get(
        url,
        headers=get_headers(),
        params={
            "until": f"refs/heads/{branch_name}",
            "path": file_path,
            "limit": 1
        },
        timeout=30
    )
    check_response(
        response,
        f"Get last modified commit: {file_path}"
    )
    values = response.json().get("values", [])
    if not values:
        return None
    return values[0].get("id")
# =====================================================
# UPDATE YAML DATA
# =====================================================
def update_yaml_data(yaml_data, env_payload):
    for section in SUPPORTED_SECTIONS:
        values = env_payload.get(section, [])
        if not values:
            continue
        if section not in yaml_data or yaml_data[section] is None:
            yaml_data[section] = []
        existing = {
            str(v) for v in yaml_data[section]
        }
        for value in values:
            if value not in existing:
                if section in [
                    "secrets",
                    "kmsKeys",
                    "functions"
                ]:
                    yaml_data[section].append(
                        DoubleQuotedScalarString(value)
                    )
                else:
                    yaml_data[section].append(value)
                existing.add(value)
                print(
                    f"Added {value} "
                    f"to {section}"
                )
            else:
                print(
                    f"{value} already exists "
                    f"in {section}"
                )
# =====================================================
# PROCESS YAML FILES
# =====================================================
def process_yaml_updates(
    branch_name,
    event
):
    market_code = event["market_code"]
    environments = event["environments"]
    updated_files = []
    for env_name, env_payload in environments.items():
        file_path = (
            f"{REPO_BASE_PATH}/"
            f"{market_code}/"
            f"values.{env_name}.yaml"
        )
        print(
            f"\nReading file: {file_path}"
        )
        content = get_file_content(
            branch_name,
            file_path
        )
        print(
            f"Original content:\n{content}"
        )
        yaml_data = yaml_parser.load(
            content
        )
        if yaml_data is None:
            yaml_data = {}
        # Remove preserved blank-line metadata
        # from the last item of each YAML sequence
        for section in SUPPORTED_SECTIONS:
            if (
                section in yaml_data
                and hasattr(yaml_data[section], "ca")
                and hasattr(yaml_data[section].ca, "items")
                and len(yaml_data[section]) > 0
            ):
                seq = yaml_data[section]
                last_idx = len(seq) - 1
                if last_idx in seq.ca.items:
                    metadata = seq.ca.items[last_idx]
                    if (
                        metadata
                        and len(metadata) > 0
                    ):
                        metadata[0] = None
        update_yaml_data(
            yaml_data,
            env_payload
        )
        stream = StringIO()
        yaml_parser.dump(
            yaml_data,
            stream
        )
        updated_content = stream.getvalue()
        print(
            f"\nUpdated content:\n"
            f"{updated_content}"
        )
        updated_files.append(
            {
                "file_path": file_path,
                "content": updated_content
            }
        )
    return updated_files
# =====================================================
# COMMIT FILE
# =====================================================
def commit_file(
    branch_name,
    file_path,
    content,
    commit_message
):
    encoded_path = urllib.parse.quote(
        file_path,
        safe="/"
    )
    url = (
        f"{BITBUCKET_URL}"
        f"/rest/api/latest/projects/{PROJECT_KEY}"
        f"/repos/{REPO_SLUG}"
        f"/browse/{encoded_path}"
    )
    source_commit_id = get_file_last_commit(
        branch_name,
        file_path
    )
    files = {
        "content": (
            file_path.split("/")[-1],
            content,
            "text/plain"
        )
    }
    data = {
        "message": commit_message,
        "branch": branch_name
    }
    if source_commit_id:
        data["sourceCommitId"] = source_commit_id
    response = requests.put(
        url,
        headers=get_headers(),
        files=files,
        data=data,
        timeout=60
    )
    check_response(
        response,
        f"Commit file: {file_path}"
    )
    return response.json()
# =====================================================
# COMMIT FILES
# =====================================================
def commit_files(
    branch_name,
    updated_files,
    request_id
):
    commit_results = []
    commit_message = (
        f"GitOps update for {request_id}"
    )
    for file in updated_files:
        result = commit_file(
            branch_name=branch_name,
            file_path=file["file_path"],
            content=file["content"],
            commit_message=commit_message
        )
        commit_results.append(
            {
                "file_path": file["file_path"],
                "commit_id": result.get("id"),
                "commit_message": result.get("message")
            }
        )
    return commit_results
# =====================================================
# CREATE PULL REQUEST
# =====================================================
def create_pull_request(branch_name):
    url = (
        f"{BITBUCKET_URL}"
        f"/rest/api/latest/projects/{PROJECT_KEY}"
        f"/repos/{REPO_SLUG}"
        f"/pull-requests"
    )
    payload = {
        "title": f"GitOps Update {branch_name}",
        "description": "Automated GitOps update created by Lambda.",
        "fromRef": {
            "id": f"refs/heads/{branch_name}"
        },
        "toRef": {
            "id": f"refs/heads/{SOURCE_BRANCH}"
        }
    }
    if PR_APPROVER_USERNAMES:
        payload["reviewers"] = [
            {"user": {"name": username}}
            for username in PR_APPROVER_USERNAMES
        ]
    response = requests.post(
        url,
        headers={
            **get_headers(),
            "Content-Type": "application/json"
        },
        json=payload,
        timeout=30
    )
    check_response(
        response,
        "Create pull request"
    )
    return response.json()
# =====================================================
# NOTIFY APPROVERS (PR CREATED)
# =====================================================
def notify_approvers_pr_created(pr, payload):
    """Best-effort email to PR_APPROVER_EMAILS when a PR is opened. Must
    never raise: the branch, commits, and PR already exist by this point,
    so a notification failure shouldn't fail the whole GitOps run."""
    request_id = payload.get("request_id", "unknown")

    if not PR_APPROVER_EMAILS:
        print(f"[NOTIFY] PR_APPROVER_EMAILS not configured - skipping approver notification for {request_id}")
        return
    if not NOTIFICATION_FROM_EMAIL:
        print(f"[NOTIFY] NOTIFICATION_FROM_EMAIL not configured - skipping approver notification for {request_id}")
        return

    market_code = payload.get("market_code", "unknown")
    submitted_by = payload.get("submitted_by", {})
    pr_url = (
        pr.get("links", {})
        .get("self", [{}])[0]
        .get("href", "")
    )

    subject = f"[Action required] Review PR for whitelist request {request_id}"
    body = (
        f"A new AWS whitelist request needs review.\n\n"
        f"Request ID: {request_id}\n"
        f"Market: {market_code}\n"
        f"Requested by: {submitted_by.get('name', 'Unknown')} ({submitted_by.get('email', 'unknown')})\n"
        f"Pull request: {pr_url or '(link unavailable)'}\n"
    )

    try:
        ses.send_email(
            Source=NOTIFICATION_FROM_EMAIL,
            Destination={"ToAddresses": PR_APPROVER_EMAILS},
            Message={
                "Subject": {"Data": subject},
                "Body": {"Text": {"Data": body}},
            },
        )
    except Exception as error:
        print(f"[NOTIFY] Failed to email approvers for {request_id}: {error}")
# =====================================================
# LAMBDA HANDLER
# =====================================================
def lambda_handler(event, context):
    print(event)
    global GIT_TOKEN
    secret = sm.get_secret_value(
        SecretId="bitbucket-token"
    )
    GIT_TOKEN = secret["SecretString"].strip()
    if not GIT_TOKEN:
        raise Exception("Bitbucket token is empty")
    payload = event["payload"]
    request_id = payload["request_id"]
    branch_name = f"gitops/{request_id}"
    latest_commit = get_latest_commit(
        SOURCE_BRANCH
    )
    create_branch(
        branch_name,
        latest_commit
    )
    updated_files = process_yaml_updates(
        branch_name,
        payload
    )
    if not updated_files:
        return {
            "status": "SUCCESS",
            "message": "No files require updating"
        }
    commit_results = commit_files(
        branch_name=branch_name,
        updated_files=updated_files,
        request_id=request_id
    )
    pr = create_pull_request(
        branch_name
    )
    notify_approvers_pr_created(
        pr,
        payload
    )
    return {
        "status": "SUCCESS",
        "request_id": request_id,
        "branch": branch_name,
        "source_branch": SOURCE_BRANCH,
        "commits": commit_results,
        "pull_request": {
            "id": pr.get("id"),
            "title": pr.get("title"),
            "state": pr.get("state"),
            "url": pr.get("links", {})
            .get("self", [{}])[0]
            .get("href")
        }
    }
