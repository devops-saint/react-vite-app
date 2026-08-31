import json
import os
import uuid
from datetime import datetime, timezone

import boto3
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError


table = boto3.resource("dynamodb").Table(os.environ["DYNAMODB_TABLE"])
allowed_origins = set(json.loads(os.environ.get("CORS_ALLOW_ORIGINS", "[]")))

lambda_client = boto3.client("lambda")
gitops_lambda_name = os.environ.get("GITOPS_LAMBDA_NAME")

ses_client = boto3.client("ses")
DOMAIN = os.environ.get("DOMAIN")

notification_from_email = (
    f"noreply@{DOMAIN}" if DOMAIN else None
)

# Webhook -> status mapping (branch format: gitops/REQ-xxxxxxxx)
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
# A request's payload["environments"] can name dev, qa and/or prod. The
# first PR always lands on `dev` (unchanged, existing behaviour below).
# Reaching qa/master afterwards is a plain branch-to-branch pull request
# between the persistent branches - no new commits, no cherry-picking -
# which is why it's safe as long as each environment keeps its own YAML
# file (confirmed: values.<env>.yaml, per market).
ENV_STAGE_ORDER = ["dev", "qa", "master"]
ENV_TO_BRANCH = {"dev": "dev", "qa": "qa", "prod": "master"}


def compute_target_stages(payload):
    """['dev'] for a dev-only request, ['dev','qa'] if qa is requested,
    ['dev','qa','master'] if prod is requested (prod can only be reached
    by passing through qa first)."""
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
    """Given a request item whose *current* stage's PR just merged, return
    (new_stage_index, is_final, next_branch). Missing target_stages /
    stage_index (items created before this change shipped) default to a
    dev-only pipeline, which reproduces exactly today's behaviour for any
    request already in flight at deploy time."""
    target_stages = item.get("target_stages") or ["dev"]
    stage_index = item.get("stage_index", -1)
    new_stage_index = stage_index + 1
    final_index = len(target_stages) - 1

    if new_stage_index >= final_index:
        return new_stage_index, True, None
    return new_stage_index, False, target_stages[new_stage_index + 1]


def response(status_code, body, origin=None):
    headers = {"content-type": "application/json", "vary": "Origin"}
    if origin in allowed_origins:
        headers["access-control-allow-origin"] = origin
    return {
        "statusCode": status_code,
        "headers": headers,
        "body": json.dumps(body),
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
    """Claim (or join) the promotion into `next_branch` and ask the GitOps
    lambda to open the dev->qa / qa->master pull request. If another
    request already claimed this promotion (it merged into the previous
    stage moments earlier), this one just joins it instead of opening a
    second, redundant PR between the same two branches."""
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
            # A promotion to this branch is already open/in flight -
            # ride along on it instead of opening a duplicate PR.
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
    """Once a promotion PR resolves (merged/declined/deleted), drop its
    LOCK item so the next promotion to that branch can be claimed fresh.
    The PR#<id> lookup item itself is left in place as a record."""
    lookup = table.get_item(Key={"request_id": promotion_key}).get("Item")
    if not lookup:
        return
    lock_key = lookup.get("lock_key")
    if lock_key:
        table.delete_item(Key={"request_id": lock_key})


def notify_requester_merged(item):
    """Best-effort email to the original requester once their PR has
    merged. Must never raise: the status is already durably updated in
    DynamoDB by the time this runs, so a notification failure shouldn't
    fail the webhook response back to Bitbucket."""
    if not item:
        return
    request_id = item["request_id"]

    if not notification_from_email:
        print(f"[NOTIFY] NOTIFICATION_FROM_EMAIL not configured - skipping requester notification for {request_id}")
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


def _update_item(request_id, status, event_key, now, stage_index=None):
    expr_names = {"#s": "status"}
    expr_values = {":s": status, ":u": now, ":e": event_key}
    update_expr = "SET #s = :s, updatedAt = :u, lastEvent = :e"
    if stage_index is not None:
        update_expr += ", stage_index = :si"
        expr_values[":si"] = stage_index

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


def handle_stage_event(event_key, request_ids, origin, promotion_key=None):
    """Applies one Bitbucket PR event to every request linked to that PR.
    `request_ids` has exactly one entry for the original custom-branch PR
    (gitops/REQ-xxxxxxxx), and one-or-more for a batched dev->qa / qa->master
    promotion PR."""
    request_ids = [r for r in request_ids if r]
    if not request_ids:
        return response(200, {"message": "ignored - no linked requests"}, origin)

    now = datetime.now(timezone.utc).isoformat()

    if event_key != "pr:merged":
        status = WEBHOOK_STATUS_MAP.get(event_key, "UNKNOWN")
        for request_id in request_ids:
            _update_item(request_id, status, event_key, now)
        if event_key in ("pr:declined", "pr:deleted") and promotion_key:
            _release_promotion(promotion_key)
        return response(200, {"requestIds": request_ids, "status": status}, origin)

    # pr:merged - each linked request advances its own pipeline
    # independently (they can be at different points if they joined the
    # same promotion at different times).
    completed_ids = []
    promoted = []

    for request_id in request_ids:
        item = table.get_item(Key={"request_id": request_id}).get("Item")
        if not item:
            print(f"[WEBHOOK] No request found for {request_id} on merge - skipping")
            continue

        new_stage_index, is_final, next_branch = advance_stage(item)

        if is_final:
            updated = _update_item(request_id, "COMPLETED", "pr:merged", now, stage_index=new_stage_index)
            notify_requester_merged(updated)
            completed_ids.append(request_id)
        else:
            just_finished = item.get("target_stages", ["dev"])[new_stage_index]
            status = f"{just_finished.upper()}_MERGED_AWAITING_{next_branch.upper()}"
            _update_item(request_id, status, "pr:merged", now, stage_index=new_stage_index)
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


def handle_webhook(payload, origin=None):
    event_key = payload.get("eventKey")

    branch_name = (
        payload.get("pullRequest", {})
        .get("fromRef", {})
        .get("displayId", "")
    )
    pr_id = payload.get("pullRequest", {}).get("id")

    if branch_name and "/" in branch_name and branch_name.split("/")[-1].startswith("REQ-"):
        # gitops/REQ-xxxxxxxx - the original per-request PR into dev.
        # Unchanged from before: identified by branch name, exactly as
        # today.
        request_id = branch_name.split("/")[-1]
        return handle_stage_event(event_key, [request_id], origin)

    # Not a per-request branch: either a dev->qa / qa->master promotion PR
    # (persistent branches, no slash in the name) or a PR that has nothing
    # to do with this portal. Resolve it by Bitbucket PR id instead - a
    # miss just means it isn't ours.
    if pr_id is None:
        return response(200, {"message": "ignored - no PR id on event"}, origin)

    promotion = table.get_item(Key={"request_id": f"PR#{pr_id}"}).get("Item")
    if not promotion:
        return response(200, {"message": "ignored - not our PR"}, origin)

    return handle_stage_event(
        event_key,
        promotion.get("request_ids", []),
        origin,
        promotion_key=f"PR#{pr_id}",
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
        print(request_id)
        result = table.get_item(Key={"request_id": request_id})
        if "Item" not in result or result["Item"].get("submitted_by_id") != user_id:
            return response(404, {"message": "Request not found"}, origin)
        item = result["Item"]
        request = frontend_request(item)
        request["history"] = [{"status": item["status"], "timestamp": item["createdAt"], "performedBy": "System"}]
        request["comments"] = []
        return response(200, request, origin)

    if method == "POST" and path == "/dpc/bitbucket/webhook":
        try:
            payload = json.loads(event.get("body") or "{}")
        except json.JSONDecodeError:
            return response(400, {"message": "Invalid webhook payload"}, origin)
        return handle_webhook(payload, origin)

    return response(404, {"message": "Route not found"}, origin)


def lambda_handler(event, _context):
    print(event)
    origin = event.get("headers", {}).get("origin")
    try:
        return handle_request(event)
    except Exception as error:
        print(f"Unhandled request API error: {error}")
        return response(500, {"message": "Unable to process the request"}, origin)
