import base64
import json
import os
import time
import urllib.parse

import boto3
import requests
from boto3.dynamodb.conditions import Attr
from botocore.exceptions import ClientError
from datetime import datetime, timezone

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
# CONFIG (GitHub instead of Bitbucket Server)
# =====================================================

GITHUB_API_URL = os.environ.get("GITHUB_API_URL", "https://api.github.com")
GITHUB_OWNER = os.environ["GITHUB_OWNER"]
GITHUB_REPO = os.environ["GITHUB_REPO"]

SOURCE_BRANCH = "dev"

REPO_BASE_PATH = os.environ["REPO_BASE_PATH"]

SUPPORTED_SECTIONS = [
    "buckets",
    "secrets",
    "kmsKeys",
    "functions"
]

yaml_parser = YAML()
yaml_parser.preserve_quotes = True
yaml_parser.default_flow_style = False

yaml_parser.indent(
    mapping=2,
    sequence=4,
    offset=2
)

GITHUB_TOKEN = ""

# =====================================================
# APPROVERS / NOTIFICATIONS CONFIG
# =====================================================
# No verified SES domain for personal testing - leave DOMAIN unset in
# terraform.tfvars and every notify_* function below no-ops on its own
# (see the `if not NOTIFICATION_FROM_EMAIL` guards). Nothing else to
# change: approvals/reviewers still work via PR_APPROVER_USERNAMES even
# with notifications off.

PR_APPROVER_USERNAMES = [
    name.strip()
    for name in os.environ.get("PR_APPROVER_USERNAMES", "").split(",")
    if name.strip()
]

PR_APPROVER_EMAILS = [
    email.strip()
    for email in os.environ.get("PR_APPROVER_EMAILS", "").split(",")
    if email.strip()
]

DOMAIN = os.environ.get("DOMAIN")

NOTIFICATION_FROM_EMAIL = (
    f"noreply@{DOMAIN}" if DOMAIN else None
)

# =====================================================
# PROMOTION PIPELINE (dev -> qa -> master)
# =====================================================
_DYNAMODB_TABLE_NAME = os.environ.get("DYNAMODB_TABLE")
_dynamodb_table = None


def _table():
    global _dynamodb_table
    if _dynamodb_table is None:
        if not _DYNAMODB_TABLE_NAME:
            raise Exception("DYNAMODB_TABLE is not configured - required for promotion PRs")
        _dynamodb_table = session.resource("dynamodb").Table(_DYNAMODB_TABLE_NAME)
    return _dynamodb_table

# =====================================================
# AUTH
# =====================================================

def get_headers():
    return {
        "Authorization": f"Bearer {GITHUB_TOKEN}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }

# =====================================================
# GITHUB REQUEST HELPER
# =====================================================

def check_response(response, operation):
    print(f"\n--- {operation} ---")
    print(f"Status: {response.status_code}")

    if response.text:
        print(f"Response: {response.text[:2000]}")

    response.raise_for_status()

# =====================================================
# RETRY / RESILIENCE (GitHub down-for-maintenance handling)
# =====================================================
# Applies to every GitHub API call this Lambda makes. Retries transient
# failures (connection errors, timeouts, 429/5xx) with a short backoff
# so a brief outage/maintenance window doesn't immediately fail the
# whole sync. 4xx errors are never retried here - they won't succeed on
# a retry and would just waste the budget.

MAX_HTTP_ATTEMPTS = 3
RETRY_BACKOFF_SECONDS = [2, 5]
RETRYABLE_STATUS_CODES = {429, 500, 502, 503, 504}


def _request_with_retry(method, url, *, operation, **kwargs):
    last_error = None
    for attempt in range(1, MAX_HTTP_ATTEMPTS + 1):
        try:
            response = requests.request(method, url, **kwargs)
        except requests.exceptions.RequestException as error:
            last_error = error
            print(f"[RETRY] {operation}: attempt {attempt}/{MAX_HTTP_ATTEMPTS} network error: {error}")
        else:
            if response.status_code in RETRYABLE_STATUS_CODES:
                last_error = requests.exceptions.HTTPError(
                    f"{response.status_code} {response.reason} for {operation} (retryable)",
                    response=response,
                )
                print(f"[RETRY] {operation}: attempt {attempt}/{MAX_HTTP_ATTEMPTS} got retryable status {response.status_code}")
            else:
                return response

        if attempt < MAX_HTTP_ATTEMPTS:
            time.sleep(RETRY_BACKOFF_SECONDS[attempt - 1])

    raise last_error

# =====================================================
# GET LATEST COMMIT
# =====================================================

def get_latest_commit(branch_name):

    url = (
        f"{GITHUB_API_URL}/repos/{GITHUB_OWNER}/{GITHUB_REPO}"
        f"/git/ref/heads/{branch_name}"
    )

    response = _request_with_retry(
        "GET",
        url,
        operation=f"Get branch: {branch_name}",
        headers=get_headers(),
        timeout=30
    )

    check_response(response, f"Get branch: {branch_name}")

    return response.json()["object"]["sha"]

# =====================================================
# CREATE BRANCH
# =====================================================

def create_branch(branch_name, commit_sha):

    url = (
        f"{GITHUB_API_URL}/repos/{GITHUB_OWNER}/{GITHUB_REPO}"
        f"/git/refs"
    )

    payload = {
        "ref": f"refs/heads/{branch_name}",
        "sha": commit_sha
    }

    response = _request_with_retry(
        "POST",
        url,
        operation=f"Create branch: {branch_name}",
        headers={
            **get_headers(),
            "Content-Type": "application/json"
        },
        json=payload,
        timeout=30
    )

    if response.status_code == 422 and "already exists" in response.text.lower():
        # Idempotent: a retry (Lambda's built-in retry, or the SWEEP
        # action) after a prior attempt that created this branch but
        # failed on a later step. Nothing to do - keep going.
        print(f"[IDEMPOTENT] Branch {branch_name} already exists - continuing")
        return

    check_response(response, f"Create branch: {branch_name}")

# =====================================================
# GET FILE (content + blob sha, one call on GitHub)
# =====================================================

def get_file(branch_name, file_path):

    encoded_path = urllib.parse.quote(
        file_path,
        safe="/"
    )

    url = (
        f"{GITHUB_API_URL}/repos/{GITHUB_OWNER}/{GITHUB_REPO}"
        f"/contents/{encoded_path}"
    )

    response = _request_with_retry(
        "GET",
        url,
        operation=f"Get file: {file_path}",
        headers=get_headers(),
        params={"ref": branch_name},
        timeout=30
    )

    check_response(response, f"Get file: {file_path}")

    data = response.json()
    content = base64.b64decode(data["content"]).decode("utf-8")
    return content, data["sha"]

# =====================================================
# UPDATE YAML DATA (identical to the Bitbucket version -
# git-host-agnostic)
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

        content, blob_sha = get_file(
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
                "content": updated_content,
                "sha": blob_sha,
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
    blob_sha,
    commit_message
):

    encoded_path = urllib.parse.quote(
        file_path,
        safe="/"
    )

    url = (
        f"{GITHUB_API_URL}/repos/{GITHUB_OWNER}/{GITHUB_REPO}"
        f"/contents/{encoded_path}"
    )

    payload = {
        "message": commit_message,
        "content": base64.b64encode(content.encode("utf-8")).decode("ascii"),
        "branch": branch_name,
        "sha": blob_sha,
    }

    response = _request_with_retry(
        "PUT",
        url,
        operation=f"Commit file: {file_path}",
        headers={
            **get_headers(),
            "Content-Type": "application/json"
        },
        json=payload,
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
            blob_sha=file["sha"],
            commit_message=commit_message
        )

        commit_results.append(
            {
                "file_path": file["file_path"],
                "commit_id": result.get("commit", {}).get("sha"),
                "commit_message": commit_message,
            }
        )

    return commit_results

# =====================================================
# CREATE PULL REQUEST
# =====================================================

def _find_existing_pull_request(head_branch, base_branch):
    """Looks up an already-open PR for this head/base pair. Used when
    create_pull_request hits GitHub's "A pull request already exists"
    422 - happens when a retry (Lambda's built-in retry, or the SWEEP
    action) runs handle_create_pr/handle_promote again after a prior
    attempt already opened the PR but failed on a later step."""
    url = f"{GITHUB_API_URL}/repos/{GITHUB_OWNER}/{GITHUB_REPO}/pulls"
    response = _request_with_retry(
        "GET",
        url,
        operation=f"Find existing PR for {head_branch} -> {base_branch}",
        headers=get_headers(),
        params={"head": f"{GITHUB_OWNER}:{head_branch}", "base": base_branch, "state": "open"},
        timeout=30,
    )
    check_response(response, f"Find existing PR for {head_branch} -> {base_branch}")
    results = response.json()
    return results[0] if results else None


def create_pull_request(head_branch, base_branch=None, title=None, body=None):
    """`head_branch`/`base_branch` are branch names (e.g. "gitops/REQ-1234",
    "dev", "qa"). `base_branch` defaults to SOURCE_BRANCH so every existing
    call site keeps working exactly as before."""

    base_branch = base_branch or SOURCE_BRANCH

    url = (
        f"{GITHUB_API_URL}/repos/{GITHUB_OWNER}/{GITHUB_REPO}"
        f"/pulls"
    )

    payload = {
        "title": title or f"GitOps Update {head_branch}",
        "body": body or "Automated GitOps update created by Lambda.",
        "head": head_branch,
        "base": base_branch,
    }

    response = _request_with_retry(
        "POST",
        url,
        operation="Create pull request",
        headers={
            **get_headers(),
            "Content-Type": "application/json"
        },
        json=payload,
        timeout=30
    )

    if response.status_code == 422 and "already exists" in response.text.lower():
        # Idempotent: a retry after a prior attempt already opened this
        # exact PR but failed on a later step (e.g. writing the PR#<id>
        # lookup record, or notifying approvers). Reuse the existing PR
        # instead of failing.
        existing = _find_existing_pull_request(head_branch, base_branch)
        if existing:
            print(f"[IDEMPOTENT] PR already exists for {head_branch} -> {base_branch}: reusing #{existing.get('number')}")
            pr = existing
        else:
            check_response(response, "Create pull request")
            pr = response.json()
    else:
        check_response(
            response,
            "Create pull request"
        )
        pr = response.json()

    # GitHub adds reviewers via a separate call (unlike Bitbucket, which
    # takes them in the create-PR payload) - best-effort, must not fail
    # PR creation itself if it errors (including a connection error, not
    # just an HTTP error - broadened from the original except clause,
    # which only caught HTTPError and would otherwise let a GitHub
    # outage here fail the whole PR creation despite the PR already
    # existing).
    if PR_APPROVER_USERNAMES:
        try:
            reviewers_url = (
                f"{GITHUB_API_URL}/repos/{GITHUB_OWNER}/{GITHUB_REPO}"
                f"/pulls/{pr['number']}/requested_reviewers"
            )
            rresponse = _request_with_retry(
                "POST",
                reviewers_url,
                operation="Add reviewers",
                headers={
                    **get_headers(),
                    "Content-Type": "application/json"
                },
                json={"reviewers": PR_APPROVER_USERNAMES},
                timeout=30
            )
            check_response(rresponse, "Add reviewers")
        except Exception as error:
            print(f"[REVIEWERS] Failed to add reviewers to PR #{pr['number']}: {error}")

    return pr

# =====================================================
# NOTIFY APPROVERS (PR CREATED)
# =====================================================
def notify_approvers_pr_created(pr, payload):
    request_id = payload.get("request_id", "unknown")

    if not PR_APPROVER_EMAILS:
        print(f"[NOTIFY] PR_APPROVER_EMAILS not configured - skipping approver notification for {request_id}")
        return
    if not NOTIFICATION_FROM_EMAIL:
        print(f"[NOTIFY] NOTIFICATION_FROM_EMAIL not configured (no DOMAIN set) - skipping approver notification for {request_id}")
        return

    market_code = payload.get("market_code", "unknown")
    submitted_by = payload.get("submitted_by", {})
    pr_url = pr.get("html_url", "")

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


def notify_approvers_promotion_created(pr, promotion_id, request_ids, to_branch):
    if not PR_APPROVER_EMAILS:
        print(f"[NOTIFY] PR_APPROVER_EMAILS not configured - skipping approver notification for {promotion_id}")
        return
    if not NOTIFICATION_FROM_EMAIL:
        print(f"[NOTIFY] NOTIFICATION_FROM_EMAIL not configured (no DOMAIN set) - skipping approver notification for {promotion_id}")
        return

    pr_url = pr.get("html_url", "")

    subject = f"[Action required] Review promotion to {to_branch.upper()} ({promotion_id})"
    body = (
        f"A batch of whitelist requests is ready to promote to {to_branch.upper()}.\n\n"
        f"Promotion ID: {promotion_id}\n"
        f"Requests included: {', '.join(request_ids) or '(none recorded)'}\n"
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
        print(f"[NOTIFY] Failed to email approvers for {promotion_id}: {error}")

# =====================================================
# CREATE_PR ACTION (original per-request flow)
# =====================================================

def handle_create_pr(event):
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
    pr_id = pr.get("number")

    try:
        dynamo_table = _table()
        dynamo_table.put_item(Item={
            "request_id": f"PR#{pr_id}",
            "type": "initial",
            "request_ids": [request_id],
        })
    except Exception as error:
        # Best-effort: a lookup-record failure must not fail a PR that
        # already exists on GitHub. Without this record, decline/approve
        # comments on the initial PR just won't correlate back to the
        # request - the PR itself is unaffected.
        print(f"[PR#] Failed to write lookup record for PR #{pr_id}: {error}")

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
            "id": pr.get("number"),
            "title": pr.get("title"),
            "state": pr.get("state"),
            "url": pr.get("html_url"),
        }
    }

# =====================================================
# PROMOTE ACTION (dev -> qa, qa -> master)
# =====================================================
PR_FIELD_FOR_BRANCH = {"dev": "pr_dev", "qa": "pr_qa", "master": "pr_master"}


def _append_history(dynamo_table, request_id, comments, now):
    """Appends a history entry to a request item without touching its
    status (only the request-api Lambda's handle_stage_event changes
    status - this just records that a promotion PR was opened). Reuses
    the request's current status for the entry so the timeline reads
    naturally. Best-effort: a missing request item, or any DynamoDB
    error, must not fail a promotion PR that already exists on
    GitHub/Bitbucket."""
    try:
        item = dynamo_table.get_item(Key={"request_id": request_id}).get("Item")
        if not item:
            return
        entry = {
            "status": item.get("status", "UNKNOWN"),
            "timestamp": now,
            "performedBy": "System",
            "comments": comments,
        }
        dynamo_table.update_item(
            Key={"request_id": request_id},
            UpdateExpression="SET #h = list_append(if_not_exists(#h, :empty_list), :h)",
            ExpressionAttributeNames={"#h": "history"},
            ExpressionAttributeValues={":h": [entry], ":empty_list": []},
        )
    except ClientError as error:
        print(f"[HISTORY] Failed to append history for {request_id}: {error}")


def handle_promote(event):
    promotion_id = event["promotion_id"]
    from_branch = event["from_branch"]
    to_branch = event["to_branch"]
    lock_key = event["lock_key"]

    pr = create_pull_request(
        head_branch=from_branch,
        base_branch=to_branch,
        title=f"Promote {from_branch} -> {to_branch} ({promotion_id})",
        body=f"Automated promotion PR.\nPromotion ID: {promotion_id}",
    )
    pr_id = pr.get("number")

    dynamo_table = _table()

    lock_item = dynamo_table.get_item(Key={"request_id": lock_key}).get("Item", {})
    request_ids = lock_item.get("request_ids", [])

    dynamo_table.put_item(Item={
        "request_id": f"PR#{pr_id}",
        "type": "promotion",
        "promotion_id": promotion_id,
        "request_ids": request_ids,
        "to_branch": to_branch,
        "lock_key": lock_key,
    })
    dynamo_table.update_item(
        Key={"request_id": lock_key},
        UpdateExpression="SET pr_id = :p, #st = :s",
        ExpressionAttributeNames={"#st": "status"},
        ExpressionAttributeValues={":p": pr_id, ":s": "OPEN"},
    )

    history_now = datetime.now(timezone.utc).isoformat()
    pr_field = PR_FIELD_FOR_BRANCH.get(to_branch)
    for linked_request_id in request_ids:
        _append_history(
            dynamo_table,
            linked_request_id,
            f"Promotion PR opened: {from_branch} -> {to_branch} (PR #{pr_id})",
            history_now,
        )
        if pr_field:
            try:
                dynamo_table.update_item(
                    Key={"request_id": linked_request_id},
                    UpdateExpression=f"SET {pr_field} = :p",
                    ExpressionAttributeValues={":p": pr_id},
                )
            except ClientError as error:
                print(f"[HISTORY] Failed to set {pr_field} for {linked_request_id}: {error}")

    notify_approvers_promotion_created(pr, promotion_id, request_ids, to_branch)

    return {
        "status": "SUCCESS",
        "promotion_id": promotion_id,
        "from_branch": from_branch,
        "to_branch": to_branch,
        "request_ids": request_ids,
        "pull_request": {
            "id": pr.get("number"),
            "title": pr.get("title"),
            "state": pr.get("state"),
            "url": pr.get("html_url"),
        }
    }


# =====================================================
# FAILURE REPORTING + AUTOMATIC RETRY SWEEP
# =====================================================
# If GitHub stays unreachable through _request_with_retry's whole
# budget, handle_create_pr/handle_promote's exception reaches
# lambda_handler, which records it here (so the UI shows SYNC_FAILED /
# a promotion LOCK stops silently blocking future promotions) and
# re-raises so Lambda's own built-in async retries + on-failure
# destination still get a chance too. handle_sweep, invoked on a
# schedule by EventBridge, is the last line of defense: it finds
# anything still stuck past SWEEP_STALE_MINUTES and drives
# handle_create_pr/handle_promote again directly.

SYNC_MAX_AUTO_RETRIES = 5
SWEEP_STALE_MINUTES = 10
SWEEP_TIME_BUDGET_MARGIN_MS = 30000


def _minutes_since(timestamp_str):
    if not timestamp_str:
        return None
    try:
        then = datetime.fromisoformat(timestamp_str.replace("Z", "+00:00"))
        if then.tzinfo is None:
            then = then.replace(tzinfo=timezone.utc)
        return (datetime.now(timezone.utc) - then).total_seconds() / 60
    except (ValueError, TypeError):
        return None


def _scan(dynamo_table, filter_expression):
    items = []
    result = dynamo_table.scan(FilterExpression=filter_expression)
    items.extend(result.get("Items", []))
    while "LastEvaluatedKey" in result:
        result = dynamo_table.scan(FilterExpression=filter_expression, ExclusiveStartKey=result["LastEvaluatedKey"])
        items.extend(result.get("Items", []))
    return items


def _mark_request_sync_failed(dynamo_table, request_id, error):
    """Best-effort: records that syncing this request to GitHub failed,
    so the UI shows SYNC_FAILED instead of the request silently hanging
    at REQUEST_RECEIVED forever, and so handle_sweep knows to retry it.
    A later successful retry naturally overwrites `status` again via
    the normal pr:opened webhook path - nothing here needs to "undo"
    this on success."""
    now = datetime.now(timezone.utc).isoformat()
    try:
        dynamo_table.update_item(
            Key={"request_id": request_id},
            UpdateExpression=(
                "SET #s = :sf, last_sync_error = :err, last_sync_attempt_at = :now, "
                "#h = list_append(if_not_exists(#h, :empty_list), :h) "
                "ADD sync_failure_count :one"
            ),
            ConditionExpression="attribute_exists(request_id)",
            ExpressionAttributeNames={"#s": "status", "#h": "history"},
            ExpressionAttributeValues={
                ":sf": "SYNC_FAILED",
                ":err": str(error)[:1000],
                ":now": now,
                ":h": [{
                    "status": "SYNC_FAILED",
                    "timestamp": now,
                    "performedBy": "System",
                    "comments": f"GitHub sync failed: {str(error)[:500]}",
                }],
                ":empty_list": [],
                ":one": 1,
            },
        )
    except Exception as report_error:
        print(f"[FAILURE] Could not record SYNC_FAILED for {request_id}: {report_error}")


def _mark_lock_failed(dynamo_table, lock_key, error):
    """Best-effort: marks a promotion LOCK item FAILED instead of
    leaving it stuck at CLAIMING forever - trigger_promotion only ever
    creates a new lock when none exists yet, so a lock stuck at
    CLAIMING with no pr_id permanently blocks every future promotion to
    that branch. Also appends a history note (not a status change,
    matching _append_history's existing philosophy) to every linked
    request so the failure is visible in their timeline."""
    now = datetime.now(timezone.utc).isoformat()
    try:
        result = dynamo_table.update_item(
            Key={"request_id": lock_key},
            UpdateExpression=(
                "SET #s = :failed, last_sync_error = :err, last_sync_attempt_at = :now "
                "ADD sync_failure_count :one"
            ),
            ConditionExpression="attribute_exists(request_id)",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={":failed": "FAILED", ":err": str(error)[:1000], ":now": now, ":one": 1},
            ReturnValues="ALL_NEW",
        )
    except Exception as report_error:
        print(f"[FAILURE] Could not mark {lock_key} as FAILED: {report_error}")
        return

    lock_item = result.get("Attributes", {})
    for linked_request_id in lock_item.get("request_ids", []):
        _append_history(
            dynamo_table,
            linked_request_id,
            f"Promotion PR failed to open ({lock_key}): {str(error)[:300]}",
            now,
        )


def _report_failure(action, event, error):
    dynamo_table = _table()
    if action == "PROMOTE":
        lock_key = event.get("lock_key")
        if lock_key:
            _mark_lock_failed(dynamo_table, lock_key, error)
        return
    payload = event.get("payload") or {}
    request_id = payload.get("request_id")
    if request_id:
        _mark_request_sync_failed(dynamo_table, request_id, error)


def handle_sweep(event, context=None):
    """Invoked on a schedule by EventBridge. Finds anything still stuck
    past SWEEP_STALE_MINUTES - either an initial PR that never got
    created (status SYNC_FAILED) or a promotion whose PR never opened
    (LOCK item FAILED, or stuck CLAIMING with no pr_id, e.g. because the
    Lambda crashed before it could even self-report) - and retries it
    directly, up to SYNC_MAX_AUTO_RETRIES per item. Bails out early if
    running low on time so a long-lasting outage can't blow the
    Lambda's own timeout mid-sweep; whatever's left over just gets
    picked up on the next scheduled run."""
    dynamo_table = _table()
    swept = {
        "requests_retried": [],
        "requests_skipped_cap": [],
        "locks_retried": [],
        "locks_skipped_cap": [],
    }

    def time_left():
        if context is None:
            return None
        try:
            return context.get_remaining_time_in_millis()
        except Exception:
            return None

    failed_requests = _scan(dynamo_table, Attr("status").eq("SYNC_FAILED"))
    for item in failed_requests:
        remaining = time_left()
        if remaining is not None and remaining < SWEEP_TIME_BUDGET_MARGIN_MS:
            print("[SWEEP] Time budget nearly exhausted - stopping early")
            break

        request_id = item["request_id"]
        # A missing/unparseable timestamp does not block a retry - it
        # just means we can't confirm staleness, so we proceed anyway;
        # sync_failure_count still bounds how many times this happens.
        age = _minutes_since(item.get("last_sync_attempt_at") or item.get("updatedAt"))
        if age is not None and age < SWEEP_STALE_MINUTES:
            continue
        if int(item.get("sync_failure_count", 0)) >= SYNC_MAX_AUTO_RETRIES:
            swept["requests_skipped_cap"].append(request_id)
            continue

        payload = item.get("payload")
        if not payload:
            print(f"[SWEEP] {request_id} has no stored payload - cannot retry, skipping")
            continue

        try:
            handle_create_pr({"payload": payload})
            swept["requests_retried"].append(request_id)
        except Exception as error:
            print(f"[SWEEP] Retry failed for {request_id}: {error}")
            _mark_request_sync_failed(dynamo_table, request_id, error)

    failed_locks = _scan(
        dynamo_table,
        Attr("request_id").begins_with("LOCK#") & (
            Attr("status").eq("FAILED")
            | (Attr("status").eq("CLAIMING") & Attr("pr_id").not_exists())
        ),
    )
    for lock_item in failed_locks:
        remaining = time_left()
        if remaining is not None and remaining < SWEEP_TIME_BUDGET_MARGIN_MS:
            print("[SWEEP] Time budget nearly exhausted - stopping early")
            break

        lock_key = lock_item["request_id"]
        age = _minutes_since(lock_item.get("last_sync_attempt_at") or lock_item.get("createdAt"))
        if age is not None and age < SWEEP_STALE_MINUTES:
            continue
        if int(lock_item.get("sync_failure_count", 0)) >= SYNC_MAX_AUTO_RETRIES:
            swept["locks_skipped_cap"].append(lock_key)
            continue

        to_branch = lock_item.get("to_branch")
        promotion_id = lock_item.get("promotion_id")
        if not to_branch or not promotion_id:
            print(f"[SWEEP] {lock_key} is missing to_branch/promotion_id - cannot retry, skipping")
            continue
        from_branch = "dev" if to_branch == "qa" else "qa"

        try:
            handle_promote({
                "promotion_id": promotion_id,
                "from_branch": from_branch,
                "to_branch": to_branch,
                "lock_key": lock_key,
            })
            swept["locks_retried"].append(lock_key)
        except Exception as error:
            print(f"[SWEEP] Retry failed for {lock_key}: {error}")
            _mark_lock_failed(dynamo_table, lock_key, error)

    print(f"[SWEEP] {swept}")
    return swept

# =====================================================
# LAMBDA HANDLER
# =====================================================

def lambda_handler(event, context):
    print(event)

    global GITHUB_TOKEN

    secret = sm.get_secret_value(
        SecretId="github-token"
    )

    GITHUB_TOKEN = secret["SecretString"].strip()

    if not GITHUB_TOKEN:
        raise Exception("GitHub token is empty")

    action = event.get("action", "CREATE_PR")

    if action == "SWEEP":
        return handle_sweep(event, context)

    try:
        if action == "PROMOTE":
            return handle_promote(event)
        return handle_create_pr(event)
    except Exception as error:
        # In-function retries (_request_with_retry) and idempotent
        # branch/PR creation already absorb a transient outage. If we
        # still ended up here, retries are exhausted - record the
        # failure so the UI shows it and handle_sweep can retry later,
        # then re-raise so Lambda's own built-in async retries (and the
        # on-failure destination, if configured) still apply as a
        # second layer of defense.
        print(f"[FAILURE] action={action} failed after retries: {error}")
        try:
            _report_failure(action, event, error)
        except Exception as report_error:
            print(f"[FAILURE] _report_failure itself errored: {report_error}")
        raise
