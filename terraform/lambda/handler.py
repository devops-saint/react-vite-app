import json
import os
from datetime import datetime, timezone

import boto3
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError


table = boto3.resource("dynamodb").Table(os.environ["REQUESTS_TABLE"])
allowed_origins = set(json.loads(os.environ.get("CORS_ALLOW_ORIGINS", "[]")))

# GitOps integration (optional): if unset, request creation still succeeds,
# it just won't kick off a PR. Set GITOPS_LAMBDA_NAME once the GitOps
# Lambda + its invoke permission are wired up in terraform.
lambda_client = boto3.client("lambda")
gitops_lambda_name = os.environ.get("GITOPS_LAMBDA_NAME")

# Merge notification (optional): if unset, the webhook still updates status
# as normal, it just won't email the requester.
ses_client = boto3.client("ses")
notification_from_email = os.environ.get("NOTIFICATION_FROM_EMAIL", "")

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
        "createdAt": item["createdAt"],
        "updatedAt": item.get("updatedAt", item["createdAt"]),
    }


def trigger_gitops(request_id, payload):
    """Fire-and-forget invoke of the GitOps Lambda to open the PR for this
    request. Best-effort: a failure here must not turn an already-persisted
    request into a 500 for the caller, since the DynamoDB record already
    exists and can be retried/reconciled independently."""
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


def notify_requester_merged(item):
    """Best-effort email to the original requester once their PR has
    merged. Must never raise: the status is already durably updated in
    DynamoDB by the time this runs, so a notification failure shouldn't
    fail the webhook response back to Bitbucket."""
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


def handle_webhook(payload, origin=None):
    event_key = payload.get("eventKey")

    branch_name = (
        payload.get("pullRequest", {})
        .get("fromRef", {})
        .get("displayId", "")
    )

    if not branch_name or "/" not in branch_name:
        return response(400, {"message": "Source branch not found"}, origin)

    # gitops/REQ-xxxxxxxx
    request_id = branch_name.split("/")[-1]
    status = WEBHOOK_STATUS_MAP.get(event_key, "UNKNOWN")
    now = datetime.now(timezone.utc).isoformat()

    try:
        updated = table.update_item(
            Key={"request_id": request_id},
            UpdateExpression="SET #s = :s, updatedAt = :u, lastEvent = :e",
            ConditionExpression="attribute_exists(request_id)",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={":s": status, ":u": now, ":e": event_key},
            ReturnValues="ALL_NEW",
        )
    except ClientError as error:
        if error.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return response(404, {"message": f"No request found for {request_id}"}, origin)
        raise

    if status == "COMPLETED":
        notify_requester_merged(updated["Attributes"])

    return response(200, {"requestId": request_id, "status": status}, origin)


def handle_request(event):
    method = event["requestContext"]["http"]["method"]
    path = event.get("rawPath", "")
    origin = event.get("headers", {}).get("origin")
    user_id = (event.get("queryStringParameters") or {}).get("userId")

    if method == "POST" and path == "/request":
        try:
            payload = json.loads(event.get("body") or "{}")
            request_id = payload["request_id"]
            submitted_by = payload["submitted_by"]
            if not payload.get("market_code") or not payload.get("environments") or not submitted_by.get("id"):
                return response(400, {"message": "market_code, environments, and submitted_by.id are required"}, origin)
        except (json.JSONDecodeError, KeyError):
            return response(400, {"message": "Invalid request payload"}, origin)

        now = datetime.now(timezone.utc).isoformat()
        try:
            table.put_item(
                Item={
                    "request_id": request_id,
                    "status": "REQUEST_RECEIVED",
                    "createdAt": now,
                    "updatedAt": now,
                    "submitted_by_id": submitted_by["id"],
                    "payload": payload,
                },
                ConditionExpression="attribute_not_exists(request_id)",
            )
        except ClientError as error:
            if error.response["Error"]["Code"] == "ConditionalCheckFailedException":
                return response(409, {"message": "A request with this ID already exists"}, origin)
            raise

        trigger_gitops(request_id, payload)
        return response(201, {"statusCode": 201, "message": "Request received", "requestId": request_id}, origin)

    if method == "GET" and path == "/listrequests":
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

    if method == "GET" and path.startswith("/requests/"):
        if not user_id:
            return response(400, {"message": "userId is required"}, origin)
        request_id = event.get("pathParameters", {}).get("requestId")
        result = table.get_item(Key={"request_id": request_id})
        if "Item" not in result or result["Item"].get("submitted_by_id") != user_id:
            return response(404, {"message": "Request not found"}, origin)
        item = result["Item"]
        request = frontend_request(item)
        request["history"] = [{"status": item["status"], "timestamp": item["createdAt"], "performedBy": "System"}]
        request["comments"] = []
        return response(200, request, origin)

    if method == "POST" and path == "/webhook":
        try:
            payload = json.loads(event.get("body") or "{}")
        except json.JSONDecodeError:
            return response(400, {"message": "Invalid webhook payload"}, origin)
        return handle_webhook(payload, origin)

    return response(404, {"message": "Route not found"}, origin)


def lambda_handler(event, _context):
    origin = event.get("headers", {}).get("origin")
    try:
        return handle_request(event)
    except Exception as error:
        print(f"Unhandled request API error: {error}")
        return response(500, {"message": "Unable to process the request"}, origin)
