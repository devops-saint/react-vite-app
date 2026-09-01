import json
import os
import re
import uuid
from datetime import datetime, timezone
from decimal import Decimal

import boto3
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError


table = boto3.resource("dynamodb").Table(os.environ["DYNAMODB_TABLE"])
allowed_origins = set(json.loads(os.environ.get("CORS_ALLOW_ORIGINS", "[]")))

lambda_client = boto3.client("lambda")
gitops_lambda_name = os.environ.get("GITOPS_LAMBDA_NAME")

ses_client = boto3.client("ses")
DOMAIN = os.environ.get("DOMAIN")

# No verified SES domain for personal testing - leave DOMAIN unset and
# notify_requester_merged below no-ops on its own. Nothing else to change.
notification_from_email = (
    f"noreply@{DOMAIN}" if DOMAIN else None
)

# Internal status vocabulary - identical to the Bitbucket/org Lambda.
# GitHub events are normalised into these same keys in handle_webhook
# below, so every function past that point is unchanged from org.
WEBHOOK_STATUS_MAP = {
    "pr:opened": "PR_CREATED",
    "pr:modified": "PR_UPDATED",
    "pr:reviewer:approved": "PR_APPROVED",
    "pr:reviewer:needs_work": "PR_NEEDS_WORK",
    "pr:merged": "COMPLETED",
    "pr:declined": "PR_DECLINED",
    "pr:deleted": "PR_DELETED",
}

# =====================================================
# PROMOTION PIPELINE (dev -> qa -> master)
# =====================================================
ENV_STAGE_ORDER = ["dev", "qa", "master"]
ENV_TO_BRANCH = {"dev": "dev", "qa": "qa", "prd": "master"}
BRANCH_TO_ENV = {"dev": "DEV", "qa": "QA", "master": "PRD"}
PR_FIELD_FOR_BRANCH = {"dev": "pr_dev", "qa": "pr_qa", "master": "pr_master"}


def stage_summary(item):
    """targetEnvironment/currentStage/prs for the request-detail response -
    all derived from target_stages/stage_index/pr_<branch> fields already
    on the item, no extra storage needed beyond the pr_<branch> values
    handle_stage_event (pr:opened) and handle_promote set directly."""
    target_stages = item.get("target_stages") or ["dev"]
    stage_index = int(item.get("stage_index", -1))
    current_index = min(stage_index + 1, len(target_stages) - 1)

    return {
        "targetEnvironment": BRANCH_TO_ENV.get(target_stages[-1], target_stages[-1]),
        "currentStage": BRANCH_TO_ENV.get(target_stages[current_index], target_stages[current_index]),
        "prs": {
            BRANCH_TO_ENV.get(branch, branch): item.get(PR_FIELD_FOR_BRANCH.get(branch, ""))
            for branch in target_stages
        },
    }


def compute_target_stages(payload):
    environments = payload.get("environments") or {}
    branches = {
        ENV_TO_BRANCH.get(env, env)
        for env in environments.keys()
    }
    indices = [
        ENV_STAGE_ORDER.index(branch)
        for branch in branches
        if branch in ENV_STAGE_ORDER
    ]
    highest = max(indices, default=0)
    return ENV_STAGE_ORDER[: highest + 1]


def advance_stage(item):
    target_stages = item.get("target_stages") or ["dev"]
    # DynamoDB Number attributes deserialize as decimal.Decimal via the
    # boto3 resource API, and Decimal can't be used as a list index
    # (no __index__) - cast to a plain int before doing any of that.
    stage_index = int(item.get("stage_index", -1))
    new_stage_index = stage_index + 1
    final_index = len(target_stages) - 1

    if new_stage_index >= final_index:
        return new_stage_index, True, None
    return new_stage_index, False, target_stages[new_stage_index + 1]


class _DecimalEncoder(json.JSONEncoder):
    """DynamoDB's boto3 resource API returns every Number attribute
    (stage_index, pr_dev/pr_qa/pr_master, ...) as decimal.Decimal, which
    the stdlib json module doesn't know how to serialize. Whole-valued
    Decimals (the only kind this table ever stores) become int; anything
    fractional falls back to float rather than crashing."""

    def default(self, o):
        if isinstance(o, Decimal):
            return int(o) if o % 1 == 0 else float(o)
        return super().default(o)


def response(status_code, body, origin=None):
    headers = {"content-type": "application/json", "vary": "Origin"}
    if origin in allowed_origins:
        headers["access-control-allow-origin"] = origin
    return {
        "statusCode": status_code,
        "headers": headers,
        "body": json.dumps(body, cls=_DecimalEncoder),
    }


def frontend_request(item):
    payload = item["payload"]
    environments = []
    for name, resources in payload.get("environments", {}).items():
        environments.append(
            {
                "environment": name.upper(),
                "resources": {
                    "s3Buckets": [{"bucketName": value} for value in resources.get("buckets", [])],
                    "secretsManager": [{"secretArn": value} for value in resources.get("secrets", [])],
                    "kmsKeys": [{"keyArn": value} for value in resources.get("kmsKeys", [])],
                    "lambdaFunctions": [{"functionArn": value} for value in resources.get("functions", [])],
                },
            }
        )
    return {
        "requestId": item["request_id"],
        "marketCode": payload.get("market_code", "UNKNOWN").upper(),
        "marketName": payload.get("market_name", "Unknown Market"),
        "repositoryName": payload.get("repository_name", "aws-whitelist-config"),
        "businessJustification": payload.get("business_justification", ""),
        "requestedBy": payload.get("submitted_by", {"id": item["submitted_by_id"], "name": "Current User", "email": "user@company.com"}),
        "aws": {"accountId": payload.get("aws_account_id", "123456789012"), "region": payload.get("aws_region", "eu-west-1")},
        "environments": environments,
        "status": item["status"],
        "targetStages": item.get("target_stages", ["dev"]),
        "stageIndex": item.get("stage_index", -1),
        "createdAt": item["createdAt"],
        "updatedAt": item.get("updatedAt", item["createdAt"]),
    }


def trigger_gitops(request_id, payload):
    if not gitops_lambda_name:
        print(f"[GITOPS] GITOPS_LAMBDA_NAME not configured - skipping trigger for {request_id}")
        return
    try:
        lambda_client.invoke(
            FunctionName=gitops_lambda_name,
            InvocationType="Event",
            Payload=json.dumps(
                {
                    "request_id": request_id,
                    "action": "CREATE_PR",
                    "payload": payload,
                }
            ),
        )
    except ClientError as error:
        print(f"[GITOPS] Failed to trigger GitOps lambda for {request_id}: {error}")


def trigger_promotion(request_id, next_branch):
    if not gitops_lambda_name:
        print(f"[GITOPS] GITOPS_LAMBDA_NAME not configured - skipping promotion for {request_id}")
        return

    lock_key = f"LOCK#{next_branch.upper()}"
    now = datetime.now(timezone.utc).isoformat()
    promotion_id = f"PROMO-{uuid.uuid4().hex[:8]}"

    try:
        table.put_item(
            Item={
                "request_id": lock_key,
                "promotion_id": promotion_id,
                "request_ids": [request_id],
                "to_branch": next_branch,
                "status": "CLAIMING",
                "createdAt": now,
            },
            ConditionExpression="attribute_not_exists(request_id)",
        )
    except ClientError as error:
        if error.response["Error"]["Code"] == "ConditionalCheckFailedException":
            table.update_item(
                Key={"request_id": lock_key},
                UpdateExpression="SET request_ids = list_append(if_not_exists(request_ids, :empty), :r)",
                ExpressionAttributeValues={":r": [request_id], ":empty": []},
            )
            return
        raise

    from_branch = "dev" if next_branch == "qa" else "qa"
    try:
        lambda_client.invoke(
            FunctionName=gitops_lambda_name,
            InvocationType="Event",
            Payload=json.dumps(
                {
                    "action": "PROMOTE",
                    "promotion_id": promotion_id,
                    "from_branch": from_branch,
                    "to_branch": next_branch,
                    "lock_key": lock_key,
                }
            ),
        )
    except ClientError as error:
        print(f"[GITOPS] Failed to trigger promotion {promotion_id} for {request_id}: {error}")


def _release_promotion(promotion_key):
    """Drops the LOCK item so the next promotion can be claimed fresh,
    and drops the PR#<id> lookup item itself too - its audit-trail job is
    now covered by each request's own `history` list (see _update_item /
    handle_promote), so nothing is lost by removing it."""
    lookup = table.get_item(Key={"request_id": promotion_key}).get("Item")
    if not lookup:
        return
    lock_key = lookup.get("lock_key")
    if lock_key:
        table.delete_item(Key={"request_id": lock_key})
    table.delete_item(Key={"request_id": promotion_key})


def notify_requester_merged(item):
    if not item:
        return
    request_id = item["request_id"]

    if not notification_from_email:
        print(f"[NOTIFY] NOTIFICATION_FROM_EMAIL not configured (no DOMAIN set) - skipping requester notification for {request_id}")
        return

    submitted_by = item.get("payload", {}).get("submitted_by", {})
    to_email = submitted_by.get("email")
    if not to_email:
        print(f"[NOTIFY] No requester email on record for {request_id} - skipping notification")
        return

    subject = f"Your whitelist request {request_id} has been completed"
    body = (
        f"Good news - the pull request for your AWS whitelist request has been merged.\n\n"
        f"Request ID: {request_id}\n"
        f"Status: COMPLETED\n"
    )

    try:
        ses_client.send_email(
            Source=notification_from_email,
            Destination={"ToAddresses": [to_email]},
            Message={
                "Subject": {"Data": subject},
                "Body": {"Text": {"Data": body}},
            },
        )
    except ClientError as error:
        print(f"[NOTIFY] Failed to email requester for {request_id}: {error}")


def _update_item(request_id, status, event_key, now, stage_index=None, comments=None, pr_field=None, pr_value=None):
    """Every status change is also appended to `history` (list_append,
    defaulting a missing attribute to []) so the full lifecycle of a
    request - including which PR drove each transition, via `comments` -
    lives on the request item itself instead of a separate PR#<id>
    record."""
    history_entry = {"status": status, "timestamp": now, "performedBy": "System"}
    if comments:
        history_entry["comments"] = comments

    expr_names = {"#s": "status", "#h": "history"}
    expr_values = {
        ":s": status,
        ":u": now,
        ":e": event_key,
        ":h": [history_entry],
        ":empty_list": [],
    }
    update_expr = (
        "SET #s = :s, updatedAt = :u, lastEvent = :e, "
        "#h = list_append(if_not_exists(#h, :empty_list), :h)"
    )
    if stage_index is not None:
        update_expr += ", stage_index = :si"
        expr_values[":si"] = stage_index
    if pr_field:
        update_expr += f", {pr_field} = :prv"
        expr_values[":prv"] = pr_value

    try:
        result = table.update_item(
            Key={"request_id": request_id},
            UpdateExpression=update_expr,
            ConditionExpression="attribute_exists(request_id)",
            ExpressionAttributeNames=expr_names,
            ExpressionAttributeValues=expr_values,
            ReturnValues="ALL_NEW",
        )
        return result.get("Attributes")
    except ClientError as error:
        if error.response["Error"]["Code"] == "ConditionalCheckFailedException":
            print(f"[WEBHOOK] No request found for {request_id} - skipping update")
            return None
        raise


def handle_stage_event(event_key, request_ids, origin, promotion_key=None, pr_id=None):
    request_ids = [r for r in request_ids if r]
    if not request_ids:
        return response(200, {"message": "ignored - no linked requests"}, origin)

    now = datetime.now(timezone.utc).isoformat()

    comments = f"PR #{pr_id}" if pr_id is not None else None

    if event_key != "pr:merged":
        status = WEBHOOK_STATUS_MAP.get(event_key, "UNKNOWN")
        # The webhook's branch-name path only ever fires for the initial
        # per-request PR into dev (promotion PRs are identified by PR id,
        # not branch name - see handle_webhook) so "pr:opened" here always
        # means the dev PR just opened.
        pr_field = "pr_dev" if event_key == "pr:opened" and pr_id is not None else None
        for request_id in request_ids:
            _update_item(request_id, status, event_key, now, comments=comments, pr_field=pr_field, pr_value=pr_id)
        if event_key in ("pr:declined", "pr:deleted") and promotion_key:
            _release_promotion(promotion_key)
        return response(200, {"requestIds": request_ids, "status": status}, origin)

    completed_ids = []
    promoted = []

    for request_id in request_ids:
        item = table.get_item(Key={"request_id": request_id}).get("Item")
        if not item:
            print(f"[WEBHOOK] No request found for {request_id} on merge - skipping")
            continue

        new_stage_index, is_final, next_branch = advance_stage(item)

        if is_final:
            updated = _update_item(request_id, "COMPLETED", "pr:merged", now, stage_index=new_stage_index, comments=comments)
            notify_requester_merged(updated)
            completed_ids.append(request_id)
        else:
            just_finished = item.get("target_stages", ["dev"])[new_stage_index]
            status = f"{just_finished.upper()}_MERGED_AWAITING_{next_branch.upper()}"
            _update_item(request_id, status, "pr:merged", now, stage_index=new_stage_index, comments=comments)
            promoted.append((request_id, next_branch))

    if promotion_key:
        _release_promotion(promotion_key)

    for request_id, next_branch in promoted:
        trigger_promotion(request_id, next_branch)

    return response(
        200,
        {"completed": completed_ids, "promoted": [r for r, _ in promoted]},
        origin,
    )


def _append_comment(request_id, comment_id, author, content, timestamp):
    """Appends a GitHub PR-thread comment (issue_comment event) to the
    request's `comments` list. Best-effort like _update_item's history
    append: a missing request item, or any DynamoDB error, must not
    fail the webhook response - GitHub only cares about a 2xx status."""
    try:
        table.update_item(
            Key={"request_id": request_id},
            UpdateExpression="SET comments = list_append(if_not_exists(comments, :empty_list), :c)",
            ConditionExpression="attribute_exists(request_id)",
            ExpressionAttributeValues={
                ":c": [{
                    "id": str(comment_id),
                    "author": author,
                    "content": content,
                    "timestamp": timestamp,
                }],
                ":empty_list": [],
            },
        )
    except ClientError as error:
        if error.response["Error"]["Code"] == "ConditionalCheckFailedException":
            print(f"[COMMENT] No request found for {request_id} - skipping")
        else:
            print(f"[COMMENT] Failed to append comment to {request_id}: {error}")


def handle_issue_comment(payload, origin):
    """GitHub's `issue_comment` event fires for any comment left on a PR's
    conversation thread - including a comment left while closing
    (declining) or approving a PR without a formal review. Unlike
    `pull_request`/`pull_request_review`, this payload carries no branch
    name, only the issue/PR number and title.

    Correlation is two-tiered:
    - Initial PRs (branch gitops/REQ-XXXX) always get a deterministic
      title, "GitOps Update gitops/REQ-XXXX" (create_pull_request's
      default when no title is passed - see handle_create_pr in
      lambda-gitops-personal/handler.py), so the request_id is pulled
      straight out of the title. This works even for PRs opened before
      the PR#<id> initial-PR lookup record existed, and doesn't depend
      on any DynamoDB write at PR-creation time having succeeded.
    - Promotion PRs ("Promote dev -> qa (...)") have no REQ- id in the
      title and can span multiple request_ids, so those still go
      through the PR#<id> lookup record written by handle_promote."""
    if payload.get("action") != "created":
        return response(200, {"message": "ignored - comment action not created"}, origin)

    issue = payload.get("issue", {})
    if "pull_request" not in issue:
        return response(200, {"message": "ignored - comment not on a pull request"}, origin)

    pr_id = issue.get("number")
    comment = payload.get("comment", {})
    content = comment.get("body")
    if pr_id is None or not content:
        return response(200, {"message": "ignored - missing PR number or comment body"}, origin)

    title_match = re.search(r"gitops/(REQ-[^\s/]+)", issue.get("title") or "")
    if title_match:
        request_ids = [title_match.group(1)]
    else:
        lookup = table.get_item(Key={"request_id": f"PR#{pr_id}"}).get("Item")
        if not lookup:
            return response(200, {"message": "ignored - not our PR"}, origin)
        request_ids = lookup.get("request_ids", [])

    author = comment.get("user", {}).get("login", "GitHub")
    timestamp = comment.get("created_at") or datetime.now(timezone.utc).isoformat()
    for request_id in request_ids:
        _append_comment(request_id, comment.get("id"), author, content, timestamp)

    return response(200, {"message": "comment recorded"}, origin)


def handle_webhook(github_event, payload, origin=None):
    """Normalises a GitHub `pull_request` / `pull_request_review` webhook
    into the same internal event_key vocabulary the Bitbucket/org Lambda
    uses, then hands off to the shared handle_stage_event - identical
    from that point on."""
    pr = payload.get("pull_request", {})
    branch_name = pr.get("head", {}).get("ref", "")
    pr_id = pr.get("number")

    if github_event == "pull_request":
        action = payload.get("action")
        if action == "closed":
            event_key = "pr:merged" if pr.get("merged") else "pr:declined"
        elif action in ("opened", "reopened"):
            event_key = "pr:opened"
        elif action == "synchronize":
            event_key = "pr:modified"
        else:
            return response(200, {"message": f"ignored - unhandled pull_request action {action}"}, origin)

    elif github_event == "pull_request_review":
        if payload.get("action") != "submitted":
            return response(200, {"message": "ignored - review not submitted"}, origin)
        review_state = payload.get("review", {}).get("state")
        if review_state == "approved":
            event_key = "pr:reviewer:approved"
        elif review_state == "changes_requested":
            event_key = "pr:reviewer:needs_work"
        else:
            return response(200, {"message": f"ignored - review state {review_state}"}, origin)

    elif github_event == "issue_comment":
        return handle_issue_comment(payload, origin)

    else:
        return response(200, {"message": f"ignored - event type {github_event}"}, origin)

    if branch_name and "/" in branch_name and branch_name.split("/")[-1].startswith("REQ-"):
        request_id = branch_name.split("/")[-1]
        promotion_key = f"PR#{pr_id}" if pr_id is not None else None
        return handle_stage_event(event_key, [request_id], origin, promotion_key=promotion_key, pr_id=pr_id)

    if pr_id is None:
        return response(200, {"message": "ignored - no PR number on event"}, origin)

    promotion = table.get_item(Key={"request_id": f"PR#{pr_id}"}).get("Item")
    if not promotion:
        return response(200, {"message": "ignored - not our PR"}, origin)

    return handle_stage_event(
        event_key,
        promotion.get("request_ids", []),
        origin,
        promotion_key=f"PR#{pr_id}",
        pr_id=pr_id,
    )


def handle_request(event):
    method = event["requestContext"]["http"]["method"]
    path = event.get("rawPath", "")
    origin = event.get("headers", {}).get("origin")
    user_id = (event.get("queryStringParameters") or {}).get("userId")

    if method == "POST" and path == "/dpc/request":
        try:
            payload = json.loads(event.get("body") or "{}")
            request_id = payload["request_id"]
            submitted_by = payload["submitted_by"]
            if not payload.get("market_code") or not payload.get("environments") or not submitted_by.get("id"):
                return response(400, {"message": "market_code, environments, and submitted_by.id are required"}, origin)
        except (json.JSONDecodeError, KeyError):
            return response(400, {"message": "Invalid request payload"}, origin)

        now = datetime.now(timezone.utc).isoformat()
        target_stages = compute_target_stages(payload)
        try:
            table.put_item(
                Item={
                    "request_id": request_id,
                    "status": "REQUEST_RECEIVED",
                    "createdAt": now,
                    "updatedAt": now,
                    "submitted_by_id": submitted_by["id"],
                    "payload": payload,
                    "target_stages": target_stages,
                    "stage_index": -1,
                    "history": [{"status": "REQUEST_RECEIVED", "timestamp": now, "performedBy": "System"}],
                },
                ConditionExpression="attribute_not_exists(request_id)",
            )
        except ClientError as error:
            if error.response["Error"]["Code"] == "ConditionalCheckFailedException":
                return response(409, {"message": "A request with this ID already exists"}, origin)
            raise

        trigger_gitops(request_id, payload)
        return response(201, {"statusCode": 201, "message": "Request received", "requestId": request_id}, origin)

    if method == "GET" and path == "/dpc/listrequests":
        if not user_id:
            return response(400, {"message": "userId is required"}, origin)
        result = table.query(
            IndexName="submitted-by-created-at",
            KeyConditionExpression=Key("submitted_by_id").eq(user_id),
            ScanIndexForward=False,
        )
        items = result.get("Items", [])
        while "LastEvaluatedKey" in result:
            result = table.query(
                IndexName="submitted-by-created-at",
                KeyConditionExpression=Key("submitted_by_id").eq(user_id),
                ScanIndexForward=False,
                ExclusiveStartKey=result["LastEvaluatedKey"],
            )
            items.extend(result.get("Items", []))
        return response(200, {"count": len(items), "requests": items}, origin)

    if method == "GET" and path.startswith("/dpc/requests/"):
        if not user_id:
            return response(400, {"message": "userId is required"}, origin)
        request_id = event.get("pathParameters", {}).get("request_id")
        result = table.get_item(Key={"request_id": request_id})
        if "Item" not in result or result["Item"].get("submitted_by_id") != user_id:
            return response(404, {"message": "Request not found"}, origin)
        item = result["Item"]
        request = frontend_request(item)
        request.update(stage_summary(item))
        request["history"] = item.get("history") or [
            {"status": item["status"], "timestamp": item.get("updatedAt", item["createdAt"]), "performedBy": "System"}
        ]
        request["comments"] = item.get("comments", [])
        return response(200, request, origin)

    if method == "POST" and path == "/dpc/github/webhook":
        try:
            payload = json.loads(event.get("body") or "{}")
        except json.JSONDecodeError:
            return response(400, {"message": "Invalid webhook payload"}, origin)
        github_event = (event.get("headers") or {}).get("x-github-event", "")
        return handle_webhook(github_event, payload, origin)

    return response(404, {"message": "Route not found"}, origin)


def lambda_handler(event, _context):
    print(event)
    origin = event.get("headers", {}).get("origin")
    try:
        return handle_request(event)
    except Exception as error:
        print(f"Unhandled request API error: {error}")
        return response(500, {"message": "Unable to process the request"}, origin)
