import json
import os
from datetime import datetime, timezone

import boto3
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError


table = boto3.resource("dynamodb").Table(os.environ["REQUESTS_TABLE"])
allowed_origins = set(json.loads(os.environ.get("CORS_ALLOW_ORIGINS", "[]")))


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

    return response(404, {"message": "Route not found"}, origin)


def lambda_handler(event, _context):
    origin = event.get("headers", {}).get("origin")
    try:
        return handle_request(event)
    except Exception as error:
        print(f"Unhandled request API error: {error}")
        return response(500, {"message": "Unable to process the request"}, origin)
