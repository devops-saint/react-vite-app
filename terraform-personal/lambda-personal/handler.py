import json
import os
import re
import uuid
from datetime import datetime, timezone
from decimal import Decimal

import boto3
from boto3.dynamodb.conditions import Attr, Key
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

# Only used to build a human-viewable GitHub PR link per stage (see
# stage_summary) - this Lambda never talks to the GitHub API itself,
# that stays exclusively the gitops Lambda's job.
GITHUB_URL = os.environ.get("GITHUB_URL", "https://github.com")
GITHUB_OWNER = os.environ.get("GITHUB_OWNER", "")
GITHUB_REPO = os.environ.get("GITHUB_REPO", "")


def _pr_url(pr_id):
    if not pr_id or not GITHUB_OWNER or not GITHUB_REPO:
        return None
    return f"{GITHUB_URL.rstrip('/')}/{GITHUB_OWNER}/{GITHUB_REPO}/pull/{pr_id}"

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

# =====================================================
# PER-MARKET REQUEST SERIALIZATION (queueing) - identical to org Lambda
# =====================================================
# See the long comment on this in terraform/lambda/handler.py. Same
# MARKETLOCK#{MARKET_CODE} mechanism, same QUEUED status, same staleness
# sweep + admin override.
MARKET_LOCK_STALE_SECONDS = int(os.environ.get("MARKET_LOCK_STALE_SECONDS", str(24 * 60 * 60)))


def stage_summary(item):
    """targetEnvironment/currentStage/prs for the request-detail response -
    all derived from target_stages/stage_index/pr_<branch> fields already
    on the item, no extra storage needed beyond the pr_<branch> values
    handle_stage_event (pr:opened) and handle_promote set directly."""
    target_stages = item.get("target_stages") or ["dev"]
    stage_index = int(item.get("stage_index", -1))
    current_index = min(stage_index + 1, len(target_stages) - 1)

    prs = {
        BRANCH_TO_ENV.get(branch, branch): item.get(PR_FIELD_FOR_BRANCH.get(branch, ""))
        for branch in target_stages
    }
    return {
        "targetEnvironment": BRANCH_TO_ENV.get(target_stages[-1], target_stages[-1]),
        "currentStage": BRANCH_TO_ENV.get(target_stages[current_index], target_stages[current_index]),
        "prs": prs,
        # Human-viewable GitHub PR link per stage, for the admin-only
        # "view PR" link on the request-details page. None where a PR id
        # isn't on record yet, or GITHUB_OWNER/GITHUB_REPO aren't
        # configured on this Lambda.
        "prUrls": {env: _pr_url(pr_id) for env, pr_id in prs.items()},
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


def _join_promotion_lock(lock_key, request_id):
    """Add request_id to an already-claimed LOCK#{MARKET}#{BRANCH}'s
    request_ids so it rides along instead of opening a duplicate PR. If
    the real promotion PR has ALREADY been opened (lock status OPEN,
    pr_id set), also patch the frozen PR#<id> lookup item the merge
    webhook actually reads - see the identical, fuller comment on this
    in the org Lambda's _join_promotion_lock. Without this, a request
    that joins a promotion lock after the real PR already exists gets
    its changes merged (the branch-to-branch PR diff is live) but is
    never advanced/completed when that PR resolves, since the webhook
    only ever reads PR#<id>, never the LOCK# item directly."""
    lock_item = table.update_item(
        Key={"request_id": lock_key},
        UpdateExpression="SET request_ids = list_append(if_not_exists(request_ids, :empty), :r)",
        ExpressionAttributeValues={":r": [request_id], ":empty": []},
        ReturnValues="ALL_NEW",
    ).get("Attributes", {})

    pr_id = lock_item.get("pr_id")
    if pr_id is None:
        return

    promotion_key = f"PR#{pr_id}"
    pr_item = table.get_item(Key={"request_id": promotion_key}).get("Item")
    if not pr_item:
        print(f"[GITOPS] {promotion_key} missing while joining {lock_key} for {request_id}")
        return
    if request_id in (pr_item.get("request_ids") or []):
        return  # already recorded - a retried/duplicate join, no-op

    table.update_item(
        Key={"request_id": promotion_key},
        UpdateExpression="SET request_ids = list_append(if_not_exists(request_ids, :empty), :r)",
        ExpressionAttributeValues={":r": [request_id], ":empty": []},
    )
    print(f"[GITOPS] Late-joined {request_id} onto already-open promotion {promotion_key}")


def trigger_promotion(request_id, next_branch, market_code):
    """Per-market-scoped promotion lock - see the identical comment on
    this in the org Lambda's trigger_promotion. Two markets promoting to
    the same branch at once now each get their own promotion PR instead
    of being batched together."""
    if not gitops_lambda_name:
        print(f"[GITOPS] GITOPS_LAMBDA_NAME not configured - skipping promotion for {request_id}")
        return

    lock_key = f"LOCK#{market_code.upper()}#{next_branch.upper()}"
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
            _join_promotion_lock(lock_key, request_id)
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
    """Drops every LOCK item riding on this promotion so the next
    promotion to that branch can be claimed fresh, and drops the
    PR#<id> lookup item itself too - its audit-trail job is now covered
    by each request's own `history` list (see _update_item /
    handle_promote), so nothing is lost by removing it.

    lock_keys is a LIST, not a single value - see the identical, fuller
    comment on this in the org Lambda. dev/qa/master are shared trunk
    branches, so two different markets' promotions to the same branch
    pair can end up sharing one real PR (see _link_promotion_pr in
    lambda-gitops-personal/handler.py); every market riding it needs
    releasing here, not just whichever one wrote last. lock_key
    (singular) is kept as a fallback for anything written before this
    fix shipped."""
    lookup = table.get_item(Key={"request_id": promotion_key}).get("Item")
    if not lookup:
        return
    lock_keys = lookup.get("lock_keys") or ([lookup["lock_key"]] if lookup.get("lock_key") else [])
    for lock_key in lock_keys:
        table.delete_item(Key={"request_id": lock_key})
    table.delete_item(Key={"request_id": promotion_key})


def _is_market_lock_stale(claimed_at, now_iso):
    try:
        claimed = datetime.fromisoformat(claimed_at)
        now_dt = datetime.fromisoformat(now_iso)
    except (TypeError, ValueError):
        return False
    return (now_dt - claimed).total_seconds() > MARKET_LOCK_STALE_SECONDS


def _claim_market_lock(market_code, request_id, now, allow_stale_reclaim=True):
    """Atomically claim MARKETLOCK#{market_code} for request_id via a
    conditional put (attribute_not_exists), exactly like trigger_promotion's
    per-branch LOCK# above. Returns True if claimed. If the lock is
    already held and looks abandoned (older than MARKET_LOCK_STALE_SECONDS
    - default 24h, e.g. an approver who never acted, or a request stuck
    permanently in SYNC_FAILED), force-releases it and retries once so a
    dead lock can never wedge a market's queue forever without a human;
    see also the admin-triggered /release-lock endpoint for the immediate
    override path."""
    lock_key = f"MARKETLOCK#{market_code.upper()}"
    try:
        table.put_item(
            Item={"request_id": lock_key, "held_request_id": request_id, "claimed_at": now},
            ConditionExpression="attribute_not_exists(request_id)",
        )
        return True
    except ClientError as error:
        if error.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise

    if not allow_stale_reclaim:
        return False

    existing = table.get_item(Key={"request_id": lock_key}).get("Item")
    if not existing:
        # Released between our failed put and this read - try once more.
        return _claim_market_lock(market_code, request_id, now, allow_stale_reclaim=False)

    claimed_at = existing.get("claimed_at")
    if not _is_market_lock_stale(claimed_at, now):
        return False

    try:
        table.delete_item(
            Key={"request_id": lock_key},
            ConditionExpression="claimed_at = :c",
            ExpressionAttributeValues={":c": claimed_at},
        )
    except ClientError as error:
        if error.response["Error"]["Code"] == "ConditionalCheckFailedException":
            # Someone else already dealt with this lock in the meantime
            # (released it, or it was reclaimed first) - don't fight over
            # it, just re-check current state once more.
            return _claim_market_lock(market_code, request_id, now, allow_stale_reclaim=False)
        raise

    print(f"[MARKETLOCK] Force-released stale lock {lock_key} (idle since {claimed_at}) - reclaiming for {request_id}")
    return _claim_market_lock(market_code, request_id, now, allow_stale_reclaim=False)


def _promote_next_queued(market_code, now):
    """Find the oldest still-QUEUED request for this market (FIFO on
    createdAt) and, if one exists, atomically claim the now-free market
    lock for it and kick off its GitOps trigger - the same thing a brand
    new submission does in handle_request, just entered from the queue
    instead of directly."""
    result = table.query(
        IndexName="market-code-created-at",
        KeyConditionExpression=Key("market_code").eq(market_code.upper()),
        FilterExpression=Attr("status").eq("QUEUED"),
        ScanIndexForward=True,
    )
    candidates = result.get("Items", [])
    while not candidates and "LastEvaluatedKey" in result:
        result = table.query(
            IndexName="market-code-created-at",
            KeyConditionExpression=Key("market_code").eq(market_code.upper()),
            FilterExpression=Attr("status").eq("QUEUED"),
            ScanIndexForward=True,
            ExclusiveStartKey=result["LastEvaluatedKey"],
        )
        candidates = result.get("Items", [])
    if not candidates:
        return

    next_item = candidates[0]
    next_request_id = next_item["request_id"]

    if not _claim_market_lock(market_code, next_request_id, now):
        # A brand new submission for this market raced in between our
        # release and this promote attempt and claimed it first - fine,
        # this queued request just stays queued, it'll be picked up on
        # that request's own eventual release.
        return

    updated = _update_item(next_request_id, "REQUEST_RECEIVED", "queue:promoted", now, comments="Promoted from queue")
    trigger_gitops(next_request_id, (updated or next_item).get("payload", {}))


def _release_and_forward_market_lock(market_code, request_id, now):
    """Release MARKETLOCK#{market_code} once `request_id` (the request
    that was holding it) reaches a terminal state, then hand it to the
    next queued request for that market, if any. The delete is
    conditioned on this request still being the holder, so a duplicate/
    racing webhook delivery - or a lock this request never actually held
    because a staleness sweep already reassigned it - is a safe no-op
    instead of releasing (or forwarding) twice."""
    lock_key = f"MARKETLOCK#{market_code.upper()}"
    try:
        table.delete_item(
            Key={"request_id": lock_key},
            ConditionExpression="held_request_id = :r",
            ExpressionAttributeValues={":r": request_id},
        )
    except ClientError as error:
        if error.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return
        raise

    _promote_next_queued(market_code, now)


def _admin_force_release_market_lock(market_code, now):
    """Unconditional escape hatch for /dpc/requests/{id}/release-lock -
    force-drops whatever currently holds MARKETLOCK#{market_code} (no
    holder-match check, unlike the normal release above) and promotes the
    oldest queued request. For an admin who has confirmed the blocking
    request is genuinely dead (declined outside the system, permanently
    stuck in SYNC_FAILED, etc) and doesn't want to wait for the
    MARKET_LOCK_STALE_SECONDS sweep. Gated client-side by UserRole.ADMIN
    only - this API has no server-side authorization yet."""
    lock_key = f"MARKETLOCK#{market_code.upper()}"
    table.delete_item(Key={"request_id": lock_key})
    _promote_next_queued(market_code, now)


def _admin_force_retry_promotion(request_id, now):
    """Unconditional escape hatch for /dpc/requests/{id}/retry-promotion -
    see the identical, fuller comment on this in the org Lambda. For a
    request stuck at <BRANCH>_MERGED_AWAITING_<NEXT> because its
    LOCK#{MARKET}#{NEXT} was orphaned (e.g. an earlier promotion PR to
    that branch was resolved directly in GitHub rather than through the
    portal's webhook). No automatic time-based sweep for this - a
    promotion lock can legitimately sit OPEN for days during real
    review, so only an admin who has confirmed it's actually dead
    should force a retry. Force-drops whatever currently holds the
    lock (and its PR#<id> lookup item, if any) and re-claims a clean
    one via trigger_promotion. Returns the branch/market retried, or
    None if there's no further stage to promote into."""
    item = table.get_item(Key={"request_id": request_id}).get("Item")
    if not item:
        return None

    target_stages = item.get("target_stages") or ["dev"]
    stage_index = int(item.get("stage_index", -1))
    if stage_index >= len(target_stages) - 1:
        return None

    next_branch = target_stages[stage_index + 1]
    market_code = (item.get("payload") or {}).get("market_code", "")
    if not market_code:
        return None
    market_code = market_code.upper()

    lock_key = f"LOCK#{market_code}#{next_branch.upper()}"
    existing_lock = table.get_item(Key={"request_id": lock_key}).get("Item")
    if existing_lock:
        stale_pr_id = existing_lock.get("pr_id")
        if stale_pr_id is not None:
            table.delete_item(Key={"request_id": f"PR#{stale_pr_id}"})
        table.delete_item(Key={"request_id": lock_key})

    trigger_promotion(request_id, next_branch, market_code)
    return {"nextBranch": next_branch, "marketCode": market_code}


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


def _update_item(request_id, status, event_key, now, stage_index=None, comments=None, pr_field=None, pr_value=None, stage=None, update_status=True):
    """Every status change is also appended to `history` (list_append,
    defaulting a missing attribute to []) so the full lifecycle of a
    request - including which PR drove each transition, via `comments` -
    lives on the request item itself instead of a separate PR#<id>
    record. `stage` (DEV/QA/PRD) records which environment's PR this
    transition belongs to, so the UI can show which branch a PR_APPROVED/
    PR_CREATED/etc. entry was actually for.

    update_status=False records the event in `history` without touching
    the item's own top-level `status` field - see the identical, fuller
    comment on this in the org Lambda. Used for a non-merge event on a
    stage this request has already merged past, so a late/reordered
    webhook can't stomp its real progression status back to something
    that looks earlier than it actually is.

    When update_status=True (the normal path), the update is conditioned
    on the target status actually being new (attribute_not_exists(#s) OR
    #s <> :s), so a duplicate webhook delivery is a no-op instead of
    appending a second identical history entry - identical fix to the
    org Lambda."""
    history_entry = {"status": status, "timestamp": now, "performedBy": "System"}
    if comments:
        history_entry["comments"] = comments
    if stage:
        history_entry["stage"] = stage

    expr_names = {"#h": "history"}
    expr_values = {
        ":u": now,
        ":e": event_key,
        ":h": [history_entry],
        ":empty_list": [],
    }
    set_clauses = [
        "updatedAt = :u",
        "lastEvent = :e",
        "#h = list_append(if_not_exists(#h, :empty_list), :h)",
    ]
    condition = "attribute_exists(request_id)"

    if update_status:
        expr_names["#s"] = "status"
        expr_values[":s"] = status
        set_clauses.insert(0, "#s = :s")
        condition += " AND (attribute_not_exists(#s) OR #s <> :s)"

    if stage_index is not None:
        set_clauses.append("stage_index = :si")
        expr_values[":si"] = stage_index
    if pr_field:
        set_clauses.append(f"{pr_field} = :prv")
        expr_values[":prv"] = pr_value

    update_expr = "SET " + ", ".join(set_clauses)

    try:
        result = table.update_item(
            Key={"request_id": request_id},
            UpdateExpression=update_expr,
            ConditionExpression=condition,
            ExpressionAttributeNames=expr_names,
            ExpressionAttributeValues=expr_values,
            ReturnValues="ALL_NEW",
        )
        return result.get("Attributes")
    except ClientError as error:
        if error.response["Error"]["Code"] == "ConditionalCheckFailedException":
            # Either request_id doesn't exist, or this exact status was
            # already applied (duplicate/racing webhook delivery) - both
            # are a safe no-op here.
            print(f"[WEBHOOK] Skipped update for {request_id} - not found, or {status} already applied")
            return None
        raise


def handle_stage_event(event_key, request_ids, origin, promotion_key=None, pr_id=None, to_branch="dev"):
    """`to_branch` is the branch this PR targets ("dev" for the original
    per-request PR, "qa"/"master" for a promotion PR - see handle_webhook)
    so pr_field/stage below are attributed to the right stage instead of
    always assuming dev - identical fix to the org Lambda."""
    request_ids = [r for r in request_ids if r]
    if not request_ids:
        return response(200, {"message": "ignored - no linked requests"}, origin)

    now = datetime.now(timezone.utc).isoformat()

    comments = f"PR #{pr_id}" if pr_id is not None else None
    stage = BRANCH_TO_ENV.get(to_branch, to_branch.upper())

    if event_key != "pr:merged":
        status = WEBHOOK_STATUS_MAP.get(event_key, "UNKNOWN")
        # pr_field is keyed off the PR's actual target branch (to_branch),
        # not hardcoded to dev - a qa/master promotion PR opening must set
        # pr_qa/pr_master, never overwrite pr_dev with the wrong PR id.
        pr_field = PR_FIELD_FOR_BRANCH.get(to_branch) if event_key == "pr:opened" and pr_id is not None else None
        for request_id in request_ids:
            # A non-merge event about a stage this request has ALREADY
            # merged past must not stomp its real progression status
            # back to something that looks earlier than it actually is
            # - see the identical, fuller comment on this in the org
            # Lambda. stage_index only ever moves on a real merge, so
            # it's a reliable "how far has this request actually
            # gotten" signal independent of whichever PR just fired an
            # event.
            item = table.get_item(Key={"request_id": request_id}).get("Item")
            target_stages = (item or {}).get("target_stages") or ["dev"]
            item_stage_index = int((item or {}).get("stage_index", -1))
            branch_index = target_stages.index(to_branch) if to_branch in target_stages else None
            stale_stage_event = branch_index is not None and branch_index <= item_stage_index

            updated = _update_item(
                request_id, status, event_key, now,
                comments=comments, pr_field=pr_field, pr_value=pr_id, stage=stage,
                update_status=not stale_stage_event,
            )
            # A declined/deleted PR at ANY stage kills the whole request -
            # it will never reach COMPLETED - so the market lock has to be
            # released here too, not just on a successful final merge.
            if updated and status in ("PR_DECLINED", "PR_DELETED"):
                market_code = (updated.get("payload") or {}).get("market_code")
                if market_code:
                    _release_and_forward_market_lock(market_code, request_id, now)
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
        merged_branch = item.get("target_stages", ["dev"])[new_stage_index]
        merged_stage = BRANCH_TO_ENV.get(merged_branch, merged_branch.upper())
        market_code = item.get("payload", {}).get("market_code", "unknown")

        if is_final:
            updated = _update_item(request_id, "COMPLETED", "pr:merged", now, stage_index=new_stage_index, comments=comments, stage=merged_stage)
            notify_requester_merged(updated)
            completed_ids.append(request_id)
            if updated:
                _release_and_forward_market_lock(market_code, request_id, now)
        else:
            status = f"{merged_branch.upper()}_MERGED_AWAITING_{next_branch.upper()}"
            _update_item(request_id, status, "pr:merged", now, stage_index=new_stage_index, comments=comments, stage=merged_stage)
            promoted.append((request_id, next_branch, market_code))

    if promotion_key:
        _release_promotion(promotion_key)

    for request_id, next_branch, market_code in promoted:
        trigger_promotion(request_id, next_branch, market_code)

    return response(
        200,
        {"completed": completed_ids, "promoted": [r for r, _, _ in promoted]},
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
        return handle_stage_event(event_key, [request_id], origin, promotion_key=promotion_key, pr_id=pr_id, to_branch="dev")

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
        to_branch=promotion.get("to_branch", "dev"),
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
        market_code = payload["market_code"].upper()

        # Claim this market's lock before the request even exists - see
        # the identical comment on this in the org Lambda. If claimed,
        # this proceeds exactly as before; if not, another request for
        # the same market is already in flight and this one is held as
        # QUEUED until that one reaches a terminal state.
        claimed = _claim_market_lock(market_code, request_id, now)
        status = "REQUEST_RECEIVED" if claimed else "QUEUED"

        try:
            table.put_item(
                Item={
                    "request_id": request_id,
                    "status": status,
                    "market_code": market_code,
                    "createdAt": now,
                    "updatedAt": now,
                    "submitted_by_id": submitted_by["id"],
                    "payload": payload,
                    "target_stages": target_stages,
                    "stage_index": -1,
                    "history": [{"status": status, "timestamp": now, "performedBy": "System"}],
                },
                ConditionExpression="attribute_not_exists(request_id)",
            )
        except ClientError as error:
            if error.response["Error"]["Code"] == "ConditionalCheckFailedException":
                if claimed:
                    _release_and_forward_market_lock(market_code, request_id, now)
                return response(409, {"message": "A request with this ID already exists"}, origin)
            raise

        if claimed:
            trigger_gitops(request_id, payload)
            message = "Request received"
        else:
            print(f"[QUEUE] {request_id} queued - market {market_code} lock held by another in-flight request")
            message = "Request queued - another request for this market is already in progress"

        return response(201, {"statusCode": 201, "message": message, "requestId": request_id, "status": status}, origin)

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
        if item.get("status") == "QUEUED":
            item_market_code = item.get("payload", {}).get("market_code", "")
            lock = table.get_item(Key={"request_id": f"MARKETLOCK#{item_market_code.upper()}"}).get("Item")
            request["blockedBy"] = (lock or {}).get("held_request_id")
        return response(200, request, origin)

    if method == "GET" and path.startswith("/dpc/whitelist/"):
        path_params = event.get("pathParameters") or {}
        market_code = path_params.get("market_code")
        environment = path_params.get("environment")
        if not market_code or not environment:
            return response(400, {"message": "market_code and environment are required"}, origin)
        if not gitops_lambda_name:
            return response(503, {"message": "GitOps Lambda not configured"}, origin)

        try:
            invoke_result = lambda_client.invoke(
                FunctionName=gitops_lambda_name,
                # Synchronous - the only RequestResponse call this Lambda
                # makes to the gitops Lambda (everything else is
                # fire-and-forget Event). Bounded in practice by API
                # Gateway's own fixed 30s HTTP API integration timeout,
                # which applies regardless of either Lambda's configured
                # timeout - see the request_api timeout comment in main.tf.
                InvocationType="RequestResponse",
                Payload=json.dumps(
                    {
                        "action": "GET_WHITELIST",
                        "market_code": market_code,
                        "environment": environment,
                    }
                ),
            )
            whitelist_payload = json.loads(invoke_result["Payload"].read())
        except ClientError as error:
            print(f"[WHITELIST] Failed to invoke GitOps lambda: {error}")
            return response(502, {"message": "Failed to fetch current whitelist"}, origin)

        if invoke_result.get("FunctionError") or whitelist_payload.get("status") == "ERROR":
            print(f"[WHITELIST] GitOps lambda error: {whitelist_payload}")
            return response(
                502,
                {"message": whitelist_payload.get("message", "Failed to fetch current whitelist")},
                origin,
            )

        return response(200, whitelist_payload, origin)

    if method == "POST" and path.startswith("/dpc/requests/") and path.endswith("/release-lock"):
        request_id = event.get("pathParameters", {}).get("request_id")
        if not request_id:
            return response(400, {"message": "request_id is required"}, origin)
        item = table.get_item(Key={"request_id": request_id}).get("Item")
        if not item:
            return response(404, {"message": "Request not found"}, origin)
        market_code = item.get("payload", {}).get("market_code", "")
        if not market_code:
            return response(400, {"message": "Request has no market_code on record"}, origin)
        now = datetime.now(timezone.utc).isoformat()
        # Admin-only override (gated client-side - see
        # _admin_force_release_market_lock) to unstick a market's queue
        # without waiting for the MARKET_LOCK_STALE_SECONDS sweep.
        _admin_force_release_market_lock(market_code.upper(), now)
        return response(200, {"message": f"Market lock released for {market_code.upper()}", "marketCode": market_code.upper()}, origin)

    if method == "POST" and path.startswith("/dpc/requests/") and path.endswith("/retry-promotion"):
        request_id = event.get("pathParameters", {}).get("request_id")
        if not request_id:
            return response(400, {"message": "request_id is required"}, origin)
        now = datetime.now(timezone.utc).isoformat()
        result = _admin_force_retry_promotion(request_id, now)
        if result is None:
            return response(
                400,
                {"message": "Request not found, or it has no further stage to promote into"},
                origin,
            )
        next_env = BRANCH_TO_ENV.get(result["nextBranch"], result["nextBranch"].upper())
        return response(
            200,
            {
                "message": f"Retried promotion to {next_env} for {request_id}",
                "requestId": request_id,
                "nextBranch": result["nextBranch"],
                "marketCode": result["marketCode"],
            },
            origin,
        )

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
