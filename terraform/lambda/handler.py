import base64
import fnmatch
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor, wait
from datetime import datetime, timezone
from decimal import Decimal
from html.parser import HTMLParser

import boto3
from boto3.dynamodb.conditions import Attr, Key
from botocore.exceptions import ClientError


table = boto3.resource("dynamodb").Table(os.environ["DYNAMODB_TABLE"])
allowed_origins = set(json.loads(os.environ.get("CORS_ALLOW_ORIGINS", "[]")))

lambda_client = boto3.client("lambda")
secrets_client = boto3.client("secretsmanager")
gitops_lambda_name = os.environ.get("GITOPS_LAMBDA_NAME")
# RBAC (idea #19) - a separate org Lambda (aws_lambda_function.azure_ad_group_fetch,
# provisioned outside this repo) that GET /dpc/access invokes
# synchronously with {"email": ...} to resolve a user's real role and
# market/environment access from Azure AD group membership. Unset just
# means GET /dpc/access returns 503 - the frontend already treats a
# failed/unavailable access lookup as read-only, not a hard error.
azure_ad_group_fetch_lambda_name = os.environ.get("AZURE_AD_GROUP_FETCH_LAMBDA_NAME")

ses_client = boto3.client("ses")
DOMAIN = os.environ.get("DOMAIN")

notification_from_email = (
    f"noreply@{DOMAIN}" if DOMAIN else None
)

# Only used to build a human-viewable Bitbucket PR link per stage (see
# stage_summary) - this Lambda never talks to Bitbucket's API itself,
# that stays exclusively the gitops Lambda's job.
BITBUCKET_URL = os.environ.get("BITBUCKET_URL", "")
PROJECT_KEY = os.environ.get("PROJECT_KEY", "")
REPO_SLUG = os.environ.get("REPO_NAME", "")


def _pr_url(pr_id):
    if not pr_id or not BITBUCKET_URL or not PROJECT_KEY or not REPO_SLUG:
        return None
    # Bitbucket Server's standard PR-overview URL shape.
    return (
        f"{BITBUCKET_URL.rstrip('/')}/projects/{PROJECT_KEY}"
        f"/repos/{REPO_SLUG}/pull-requests/{pr_id}/overview"
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
# A request's payload["environments"] can name dev, qa and/or prd. The
# first PR always lands on `dev` (unchanged, existing behaviour below).
# Reaching qa/master afterwards is a plain branch-to-branch pull request
# between the persistent branches - no new commits, no cherry-picking -
# which is why it's safe as long as each environment keeps its own YAML
# file (confirmed: values.<env>.yaml, per market).
ENV_STAGE_ORDER = ["dev", "qa", "master"]
ENV_TO_BRANCH = {"dev": "dev", "qa": "qa", "prd": "master"}
BRANCH_TO_ENV = {"dev": "DEV", "qa": "QA", "master": "PRD"}
PR_FIELD_FOR_BRANCH = {"dev": "pr_dev", "qa": "pr_qa", "master": "pr_master"}

# =====================================================
# PER-MARKET REQUEST SERIALIZATION (queueing)
# =====================================================
# Two open requests for the same market can otherwise race: their gitops
# PRs land on the same shared dev/qa/master branches and touch the same
# market's values.<env>.yaml file, so a second request submitted before
# the first has finished its whole pipeline can produce a real merge
# conflict. A MARKETLOCK#{MARKET_CODE} item (same claim/ride-along shape
# as the existing per-branch promotion LOCK# above) makes only one
# request per market active at a time; anything else submitted for that
# market is held as QUEUED and promoted, oldest first, once the active
# request reaches a terminal state (COMPLETED/PR_DECLINED/PR_DELETED).
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
        # Human-viewable Bitbucket PR link per stage, for the admin-only
        # "view PR" link on the request-details page. None where a PR id
        # isn't on record yet, or BITBUCKET_URL/PROJECT_KEY/REPO_NAME
        # aren't configured on this Lambda.
        "prUrls": {env: _pr_url(pr_id) for env, pr_id in prs.items()},
    }


def compute_target_stages(payload):
    """['dev'] for a dev-only request, ['dev','qa'] if qa is requested,
    ['dev','qa','master'] if prd is requested (prd can only be reached
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


def _frontend_resources(lists):
    return {
        "s3Buckets": [{"bucketName": value} for value in lists.get("buckets", [])],
        "secretsManager": [{"secretArn": value} for value in lists.get("secrets", [])],
        "kmsKeys": [{"keyArn": value} for value in lists.get("kmsKeys", [])],
        "lambdaFunctions": [{"functionArn": value} for value in lists.get("functions", [])],
    }


def frontend_request(item):
    payload = item["payload"]
    environments = []
    for name, resources in payload.get("environments", {}).items():
        environment = {
            "environment": name.upper(),
            "resources": _frontend_resources(resources),
        }
        # COMBINED requests: the resources the request also removes.
        if isinstance(resources.get("remove"), dict):
            environment["removals"] = _frontend_resources(resources["remove"])
        environments.append(environment)
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
        "requestType": str(payload.get("request_type", "WHITELIST")).upper(),
        "targetStages": item.get("target_stages", ["dev"]),
        "stageIndex": item.get("stage_index", -1),
        "createdAt": item["createdAt"],
        "updatedAt": item.get("updatedAt", item["createdAt"]),
        "verificationAttempts": item.get("verificationAttempts", 0),
        "lastVerificationAttemptAt": item.get("lastVerificationAttemptAt"),
        "lastVerificationDetail": item.get("lastVerificationDetail"),
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


def trigger_cancel(request_id, payload):
    """Fire-and-forget: asks the GitOps lambda to decline/close any open
    PR and delete the gitops/{request_id} branch for a cancelled request.
    Best-effort cleanup only - the request's own status is already set to
    CANCELLED synchronously by handle_request's /cancel handler regardless
    of whether this succeeds, since a leftover Bitbucket/GitHub-side
    branch or PR is cosmetic once the portal itself has abandoned the
    request."""
    if not gitops_lambda_name:
        print(f"[CANCEL] GITOPS_LAMBDA_NAME not configured - skipping cleanup for {request_id}")
        return
    try:
        lambda_client.invoke(
            FunctionName=gitops_lambda_name,
            InvocationType="Event",
            Payload=json.dumps(
                {
                    "request_id": request_id,
                    "action": "CANCEL",
                    "payload": payload,
                }
            ),
        )
    except ClientError as error:
        print(f"[CANCEL] Failed to trigger GitOps cleanup for {request_id}: {error}")


def _join_promotion_lock(lock_key, request_id):
    """Add request_id to an already-claimed LOCK#{MARKET}#{BRANCH}'s
    request_ids so it rides along instead of opening a duplicate PR. If
    the real promotion PR has ALREADY been opened (lock status OPEN,
    pr_id set), also patch the frozen PR#<id> lookup item the merge
    webhook actually reads: handle_promote only snapshots request_ids
    from the lock ONCE, at PR-creation time (see its own docstring in
    lambda-gitops/handler.py), so without this a late joiner's changes
    would land in the PR's live diff but the joiner itself would never
    be advanced/completed when that PR resolves - handle_webhook
    resolves everything through PR#<id>, never the LOCK# item directly.
    This was a real gap: a request that joined a promotion lock before
    the real PR opened rode along correctly (handle_promote's own
    snapshot picks it up), but one that joined after was silently
    orphaned at its current status forever, even though its file
    changes were already merged."""
    lock_item = table.update_item(
        Key={"request_id": lock_key},
        UpdateExpression="SET request_ids = list_append(if_not_exists(request_ids, :empty), :r)",
        ExpressionAttributeValues={":r": [request_id], ":empty": []},
        ReturnValues="ALL_NEW",
    ).get("Attributes", {})

    pr_id = lock_item.get("pr_id")
    if pr_id is None:
        # Still CLAIMING (or FAILED) - the PR doesn't exist yet, so
        # handle_promote's own snapshot (taken from this same lock item
        # right before it opens the PR) will pick this joiner up
        # naturally. Nothing further to do.
        return

    promotion_key = f"PR#{pr_id}"
    pr_item = table.get_item(Key={"request_id": promotion_key}).get("Item")
    if not pr_item:
        # Shouldn't happen - handle_promote always creates this
        # alongside setting pr_id on the lock - but don't fail the
        # request over a bookkeeping inconsistency.
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
    """Claim (or join) the promotion into `next_branch` and ask the GitOps
    lambda to open the dev->qa / qa->master pull request. If another
    request for the SAME MARKET already claimed this promotion (it merged
    into the previous stage moments earlier), this one just joins it
    instead of opening a second, redundant PR between the same two
    branches. The lock is scoped per market (not just per branch) so
    unrelated markets promoting to the same branch at the same time each
    get their own promotion PR instead of being batched together - see
    the "per node" note on this in the audit doc. Note: dev/qa/master are
    still shared trunk branches across every market (each market only
    owns its own values.<env>.yaml file within them), so a market-scoped
    promotion PR's branch-to-branch diff can still show another market's
    unrelated pending changes if that market also merged to dev but
    hasn't promoted yet - the lock stops duplicate PRs, it can't fully
    isolate the diff without moving to per-market branches."""
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
    """Once a promotion PR resolves (merged/declined/deleted): drop every
    LOCK item riding on it so the next promotion to that branch can be
    claimed fresh, and drop the PR#<id> lookup item itself too. Its job
    was purely to correlate a webhook PR id back to request ids while
    the promotion was in flight - the actual audit trail (which PR drove
    which transition) now lives permanently on each request's own
    `history` list (see _update_item and handle_promote's history
    append), so nothing is lost by removing it here.

    lock_keys is a LIST, not a single value: dev/qa/master are shared
    trunk branches across every market, so Bitbucket only ever allows
    one open PR for a given branch pair - two different markets'
    promotions to e.g. dev->qa genuinely have to share the same real PR
    (see _link_promotion_pr in lambda-gitops/handler.py). Every market
    riding this PR has its own LOCK#{MARKET}#{BRANCH} item and all of
    them need releasing here, or whichever one isn't recorded stays
    stuck forever - this was a real bug: only a single lock_key used to
    be tracked, so the market that DIDN'T write it last never got
    released. lock_key (singular) is kept as a fallback for any
    promotion item written before this fix shipped."""
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
    only - this API has no server-side authorization yet (see the
    codebase audit doc's auth-gap finding, unchanged by this feature)."""
    lock_key = f"MARKETLOCK#{market_code.upper()}"
    table.delete_item(Key={"request_id": lock_key})
    _promote_next_queued(market_code, now)


def _admin_force_retry_promotion(request_id, now):
    """Unconditional escape hatch for /dpc/requests/{id}/retry-promotion -
    for a request stuck at <BRANCH>_MERGED_AWAITING_<NEXT> with no
    promotion PR ever appearing. This happens when a
    LOCK#{MARKET}#{NEXT} gets orphaned - most commonly because an
    earlier promotion PR to that same branch was resolved outside this
    portal (closed/merged directly in Bitbucket rather than through the
    normal webhook flow), so _release_promotion was never called and
    the dead lock silently absorbs every future promotion attempt for
    that market/branch via the "ride along" path in trigger_promotion,
    without ever opening a visible PR. There is deliberately no
    automatic time-based sweep for this the way there is for
    MARKETLOCK#: a promotion lock can legitimately sit OPEN for days
    while a real PR is still in review, and auto-releasing it on a
    timer would risk discarding the tracking for a PR that later does
    get merged for real. An admin confirming the lock is actually dead
    and retrying explicitly is the safe way to unstick this.

    Force-drops whatever currently holds this request's next-stage
    lock (and its PR#<id> lookup item, if any, so a delayed webhook for
    that stale PR can't resurrect it) and re-claims a clean one via
    trigger_promotion, which opens a fresh promotion PR. Returns a dict
    with the branch/market that was retried, or None if this request
    has no further stage to promote into (already at its final stage,
    already COMPLETED, or not found) - gated client-side by
    UserRole.ADMIN only, same no-server-side-authorization caveat as
    every other admin action in this API."""
    item = table.get_item(Key={"request_id": request_id}).get("Item")
    if not item:
        return None

    target_stages = item.get("target_stages") or ["dev"]
    # Same Decimal-can't-be-a-list-index caveat as advance_stage.
    stage_index = int(item.get("stage_index", -1))
    if stage_index >= len(target_stages) - 1:
        return None  # already at (or past) its final stage

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

    payload = item.get("payload", {})
    submitted_by = payload.get("submitted_by", {})
    to_email = submitted_by.get("email")
    if not to_email:
        print(f"[NOTIFY] No requester email on record for {request_id} - skipping notification")
        return

    market_code = payload.get("market_code", "unknown")
    business_justification = (payload.get("business_justification") or "").strip()

    subject = f"Your whitelist request {request_id} has been completed"
    body = (
        f"Good news - the pull request for your AWS whitelist request has been merged.\n\n"
        f"Request ID: {request_id}\n"
        f"Market: {market_code}\n"
        f"Requested by: {submitted_by.get('name', 'Unknown')} <{to_email}>\n"
        f"Justification: {business_justification or '(none provided)'}\n"
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

    update_status=False records the event in `history` (so the timeline
    still shows it) WITHOUT touching the item's own top-level `status`
    field - used by handle_stage_event for a non-merge event on a stage
    this request has already merged past (see the stale_stage_event
    check there), so a late/reordered webhook - a redelivery, or a
    shared qa/master promotion PR's own pr:opened/pr:modified firing for
    every market riding it - can't stomp a request's real progression
    status back to something that looks earlier than it actually is.

    When update_status=True (the normal path), the update is conditioned
    on the target status actually being new (attribute_not_exists(#s) OR
    #s <> :s), so a duplicate webhook delivery - Bitbucket redelivery, or
    two concurrent Lambda invocations racing on the same event before
    either commits - is a no-op instead of appending a second identical
    history entry. This is what caused the duplicate *_MERGED_AWAITING_*
    timeline entries. That guard is naturally skipped when
    update_status=False, since there's no status write to dedupe
    against - a stale-stage event redelivering is rare enough, and low
    enough stakes (an extra history line, nothing state-changing), that
    it doesn't need its own dedup mechanism."""
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


# =====================================================
# AWS-SIDE ACCESS VERIFICATION (post-merge, before COMPLETED)
# =====================================================
# Once a request's final-stage PR merges, the change is live in git but
# not yet confirmed live in AWS - Matillion's agent picks up the new
# values.<env>.yaml on its own schedule/redeploy. Rather than mark a
# request COMPLETED purely because git merged, this Lambda periodically
# (action=VALIDATE_SWEEP, an EventBridge-triggered sweep - see main.tf)
# reads the actual IAM policy attached to the target market/environment's
# agent role and only flips PENDING_AWS_VERIFICATION -> COMPLETED once
# the requested resources are (for WHITELIST) present, or (for
# DEWHITELIST) absent, from that policy.
#
# Cross-account convention (new - nothing like this existed before):
# DEV/QA/PRD each live in their own AWS account (see buildAgentRoleArn in
# src/config/index.ts for the account-id-per-env pattern this mirrors).
# This Lambda's own role has no standing access into those accounts, so
# each target account must define a role - by convention named
# "dpc-portal-validator" - whose trust policy allows this Lambda's own
# execution role (aws_iam_role.lambda, this same stack) to sts:AssumeRole
# into it, and whose permissions policy grants at least iam:GetRole,
# iam:ListRolePolicies, iam:ListAttachedRolePolicies, iam:GetRolePolicy,
# iam:GetPolicy and iam:GetPolicyVersion, scoped to the
# matillion-dpc-*-agent-*-irsa role(s) in that account. The role is
# provisioned by validator_role.tf (same account) or
# validator_role_cross_account/ (other accounts) next to this Lambda's
# Terraform - AWS_VALIDATION_ROLE_ARN_DEV/QA/PRD below is that role's ARN
# once it exists; an unset/empty value for a given environment means
# verification is skipped for requests targeting it (they stay
# PENDING_AWS_VERIFICATION indefinitely until the env var is configured -
# logged every sweep, not silently dropped).
AWS_ACCOUNT_IDS = {
    "DEV": os.environ.get("AWS_ACCOUNT_ID_DEV", ""),
    "QA": os.environ.get("AWS_ACCOUNT_ID_QA", ""),
    "PRD": os.environ.get("AWS_ACCOUNT_ID_PRD", ""),
}
AWS_VALIDATION_ROLE_ARNS = {
    "DEV": os.environ.get("AWS_VALIDATION_ROLE_ARN_DEV", ""),
    "QA": os.environ.get("AWS_VALIDATION_ROLE_ARN_QA", ""),
    "PRD": os.environ.get("AWS_VALIDATION_ROLE_ARN_PRD", ""),
}
MAX_VERIFICATION_ATTEMPTS = int(os.environ.get("MAX_VERIFICATION_ATTEMPTS", "144"))
sts_client = boto3.client("sts")


def _build_agent_role_arn(environment, market_code):
    """Mirrors buildAgentRoleArn() in src/config/index.ts exactly - same
    naming convention, same lower-casing. Returns None when this env's
    account id isn't configured."""
    account_id = AWS_ACCOUNT_IDS.get(environment.upper())
    if not account_id:
        return None
    return (
        f"arn:aws:iam::{account_id}:role/"
        f"matillion-dpc-{environment.lower()}-agent-{market_code.lower()}-irsa"
    )


def _assume_validation_role(environment):
    """Returns a boto3 IAM client using temporary credentials for the
    target account's dpc-portal-validator role, or None if that
    environment has no validation role configured (or the assume-role
    call itself fails, e.g. trust not yet set up on the target side)."""
    role_arn = AWS_VALIDATION_ROLE_ARNS.get(environment.upper())
    if not role_arn:
        return None
    try:
        creds = sts_client.assume_role(
            RoleArn=role_arn,
            RoleSessionName="dpc-portal-verify",
            DurationSeconds=900,
        )["Credentials"]
    except ClientError as error:
        print(f"[VERIFY] Could not assume validation role for {environment}: {error}")
        return None
    return boto3.client(
        "iam",
        aws_access_key_id=creds["AccessKeyId"],
        aws_secret_access_key=creds["SecretAccessKey"],
        aws_session_token=creds["SessionToken"],
    )


def _extract_allow_resources(policy_document):
    """Flattens every Resource entry from every Allow statement in an IAM
    policy document into a flat list of resource ARN patterns. Deny
    statements are ignored - this is a presence check for what the role
    CAN reach, matching the same representative-not-exhaustive spirit as
    buildPolicyPreview on the frontend, not a full policy simulator."""
    resources = []
    for statement in policy_document.get("Statement", []):
        if statement.get("Effect") != "Allow":
            continue
        resource = statement.get("Resource", [])
        if isinstance(resource, str):
            resource = [resource]
        resources.extend(resource)
    return resources


def _collect_role_policy_resources(iam_client, role_name):
    """Every Allow-Resource pattern across a role's inline policies and
    its attached managed policies' default versions, as one flat list.
    Returns None (not []) on any read failure, so callers can tell
    "role has no matching resources" apart from "couldn't read the
    role's policies at all"."""
    resources = []
    try:
        inline_names = iam_client.list_role_policies(RoleName=role_name)["PolicyNames"]
        for name in inline_names:
            doc = iam_client.get_role_policy(RoleName=role_name, PolicyName=name)["PolicyDocument"]
            resources.extend(_extract_allow_resources(doc))

        attached = iam_client.list_attached_role_policies(RoleName=role_name)["AttachedPolicies"]
        for policy in attached:
            policy_arn = policy["PolicyArn"]
            version_id = iam_client.get_policy(PolicyArn=policy_arn)["Policy"]["DefaultVersionId"]
            doc = iam_client.get_policy_version(PolicyArn=policy_arn, VersionId=version_id)["PolicyVersion"]["Document"]
            resources.extend(_extract_allow_resources(doc))
    except ClientError as error:
        print(f"[VERIFY] Failed reading policies for role {role_name}: {error}")
        return None
    return resources


def _resource_covered(resource_arn, allowed_patterns):
    """True if resource_arn matches any allowed pattern exactly or via
    IAM-style wildcards (*, ?) - fnmatch handles both."""
    return any(fnmatch.fnmatchcase(resource_arn, pattern) for pattern in allowed_patterns)


def _requested_resource_arns(env_resources):
    """Mirrors buildPolicyPreview()'s ARN construction (src/utils/policyPreview.ts)
    exactly: S3 entries are bucket names unless already a full ARN, and
    get both the bucket-level and bucket/* object-level ARN; Secrets/KMS/
    Lambda entries are already full ARNs and used as-is."""
    arns = []
    for bucket in env_resources.get("buckets", []):
        if bucket.startswith("arn:aws:s3:::"):
            arns.extend([bucket, f"{bucket}/*"])
        else:
            arns.extend([f"arn:aws:s3:::{bucket}", f"arn:aws:s3:::{bucket}/*"])
    arns.extend(env_resources.get("secrets", []))
    arns.extend(env_resources.get("kmsKeys", []))
    arns.extend(env_resources.get("functions", []))
    return arns


def verify_environment_access(market_code, environment, env_resources, request_type):
    """Returns True (confirmed), False (not yet confirmed), or None
    (skipped - no validation role configured for this env, or the agent
    role/policies couldn't be read). For WHITELIST, every requested
    resource ARN must be covered by an Allow statement on the market/
    env's agent role; for DEWHITELIST, none of them may still be."""
    role_arn = _build_agent_role_arn(environment, market_code)
    if not role_arn:
        return None
    role_name = role_arn.rsplit("/", 1)[-1]

    iam_client = _assume_validation_role(environment)
    if iam_client is None:
        return None

    allowed_patterns = _collect_role_policy_resources(iam_client, role_name)
    if allowed_patterns is None:
        return None

    requested = _requested_resource_arns(env_resources)
    if request_type == "DEWHITELIST":
        # Every listed resource must be gone.
        return not any(_resource_covered(arn, allowed_patterns) for arn in requested)

    # WHITELIST: every listed resource must be present. COMBINED: the same,
    # AND everything under "remove" must be gone.
    to_remove = []
    if request_type == "COMBINED" and isinstance(env_resources.get("remove"), dict):
        to_remove = _requested_resource_arns(env_resources["remove"])

    if not requested and not to_remove:
        return True

    return all(_resource_covered(arn, allowed_patterns) for arn in requested) and not any(
        _resource_covered(arn, allowed_patterns) for arn in to_remove
    )


def _record_verification_attempt(request_id, now, detail):
    """Bumps verificationAttempts and records the latest attempt's
    outcome, without touching status/history - a plain metadata update
    so repeated sweep passes over a still-pending request don't fight
    _update_item's status-changed guard (see its docstring)."""
    try:
        table.update_item(
            Key={"request_id": request_id},
            UpdateExpression=(
                "SET verificationAttempts = if_not_exists(verificationAttempts, :zero) + :one, "
                "lastVerificationAttemptAt = :now, lastVerificationDetail = :detail"
            ),
            ConditionExpression="attribute_exists(request_id)",
            ExpressionAttributeValues={":zero": 0, ":one": 1, ":now": now, ":detail": detail},
        )
    except ClientError as error:
        print(f"[VERIFY] Failed to record verification attempt for {request_id}: {error}")


def _scan_by_status(status):
    """Small-table full scan filtered by status - fine at this table's
    expected size (mirrors the pattern already used for market-queue
    lookups elsewhere), avoids needing a new GSI just for the sweep."""
    items = []
    kwargs = {"FilterExpression": Attr("status").eq(status)}
    while True:
        result = table.scan(**kwargs)
        items.extend(result.get("Items", []))
        last_key = result.get("LastEvaluatedKey")
        if not last_key:
            return items
        kwargs["ExclusiveStartKey"] = last_key


def handle_validation_sweep(event):
    """EventBridge-triggered (action: VALIDATE_SWEEP) - for every request
    sitting in PENDING_AWS_VERIFICATION, checks each of its requested
    environments against the live agent-role IAM policy in that
    environment's AWS account. All environments confirmed -> COMPLETED
    (and the deferred requester-completion email finally goes out).
    Anything not yet confirmed (or unverifiable - no validation role
    configured) is left pending with its attempt recorded, so the UI can
    show why a request is still waiting."""
    now = datetime.now(timezone.utc).isoformat()
    pending = _scan_by_status("PENDING_AWS_VERIFICATION")
    checked = 0
    completed = 0

    for item in pending:
        request_id = item["request_id"]
        payload = item.get("payload", {})
        market_code = payload.get("market_code", "")
        request_type = str(payload.get("request_type", "WHITELIST")).upper()
        environments = payload.get("environments", {})
        if not market_code or not environments:
            continue

        checked += 1
        results = {}
        for env_name, env_resources in environments.items():
            environment = env_name.upper()
            results[environment] = verify_environment_access(market_code, environment, env_resources, request_type)

        all_confirmed = all(value is True for value in results.values())
        detail = json.dumps(results)

        if all_confirmed:
            updated = _update_item(request_id, "COMPLETED", "aws:verified", now, comments="AWS access verification confirmed")
            if updated:
                notify_requester_merged(updated)
                completed += 1
        else:
            attempts = int(item.get("verificationAttempts", 0))
            if attempts >= MAX_VERIFICATION_ATTEMPTS:
                print(f"[VERIFY] {request_id} still unverified after {attempts} attempts: {detail}")
            _record_verification_attempt(request_id, now, detail)

    print(f"[VERIFY] Sweep checked {checked} pending request(s), completed {completed}")
    return {"status": "OK", "checked": checked, "completed": completed}


def handle_stage_event(event_key, request_ids, origin, promotion_key=None, pr_id=None, to_branch="dev"):
    """Applies one Bitbucket PR event to every request linked to that PR.
    `request_ids` has exactly one entry for the original custom-branch PR
    (gitops/REQ-xxxxxxxx), and one-or-more for a batched dev->qa / qa->master
    promotion PR. `to_branch` is the branch this PR targets ("dev" for the
    original per-request PR, "qa"/"master" for a promotion PR - see
    handle_webhook) so pr_field/stage below are attributed to the right
    stage instead of always assuming dev."""
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
            # merged past - its own dev PR getting a late "modified"
            # event after dev already merged, or a shared qa/master
            # promotion PR's own pr:opened/pr:modified events (which
            # fire for every market riding that PR, since dev/qa/master
            # are shared trunk branches - see _link_promotion_pr in
            # lambda-gitops/handler.py) - must not stomp this request's
            # real progression status back to something that looks
            # earlier than it actually is. stage_index only ever moves
            # on a real merge, so it's a reliable "how far has this
            # request actually gotten" signal independent of whichever
            # PR just fired an event.
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
        merged_branch = item.get("target_stages", ["dev"])[new_stage_index]
        merged_stage = BRANCH_TO_ENV.get(merged_branch, merged_branch.upper())
        market_code = item.get("payload", {}).get("market_code", "unknown")

        if is_final:
            # Git has merged, but the change isn't confirmed live in AWS
            # yet - PENDING_AWS_VERIFICATION, not COMPLETED, until the
            # VALIDATE_SWEEP sweep (see handle_validation_sweep below)
            # confirms the agent role's real IAM policy reflects it. The
            # market lock still releases here (the git-side pipeline for
            # this market really is done), but the requester's
            # completion email is deferred to the sweep.
            updated = _update_item(request_id, "PENDING_AWS_VERIFICATION", "pr:merged", now, stage_index=new_stage_index, comments=comments, stage=merged_stage)
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
        return handle_stage_event(event_key, [request_id], origin, pr_id=pr_id, to_branch="dev")

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
        pr_id=pr_id,
        to_branch=promotion.get("to_branch", "dev"),
    )


# =====================================================
# Q&A FORUM (idea #15)
# =====================================================
# Questions live in the same DynamoDB table as requests, under a
# "QNA#<question_id>" key (same prefix-namespacing the MARKETLOCK#/LOCK#
# items already use). Every question also carries submitted_by_id="QNA",
# so the existing submitted-by-created-at index lists them newest-first
# with a plain Query - no Scan and no new infrastructure. The thread's
# comments are a list on the question item itself (same shape as the
# request items' existing comments[]), appended atomically with
# list_append. Deliberately uses `qna_status` (not `status`) so none of
# the request-status scans/sweeps can ever pick these items up.
QNA_PREFIX = "QNA#"
QNA_PARTITION = "QNA"
QNA_MAX_TITLE = 200
QNA_MAX_BODY = 5000
QNA_MAX_COMMENTS = 200
QNA_LIST_LIMIT = 300
QNA_ROLE_CACHE_SECONDS = 300
# Admins to email when a question is asked (comma-separated). Also treated
# as admins when answering, as a fallback if the Azure AD group-fetch
# Lambda isn't configured/reachable.
QNA_ADMIN_EMAILS = [
    email.strip()
    for email in os.environ.get("QNA_ADMIN_EMAILS", "").split(",")
    if email.strip()
]
# Frontend base URL, only used to put a direct link to the thread in the
# notification emails (e.g. https://portal.example.com). Optional.
PORTAL_BASE_URL = os.environ.get("PORTAL_BASE_URL", "").rstrip("/")

_qna_role_cache = {}


# =====================================================
# ADMIN ALLOW-LIST (RBAC refinement)
# =====================================================
# The Azure AD group-fetch Lambda marks anyone in the tool's admin group as
# role "admin" - which also includes developers doing migration work who
# should not have admin powers in this portal. PORTAL_ADMIN_EMAILS is the
# list of people who really are admins: an AD "admin" whose email isn't on
# it is reported as role "developer" instead (same all-markets, all-
# environments reach, but none of the admin-only actions).
#
# An EMPTY list switches this off and keeps the old behaviour (every AD
# admin is an admin), so deploying this change without setting the variable
# demotes nobody. Set it to enforce the split. The division is made here on
# the backend, in the one place both the frontend (GET /dpc/access) and the
# Q&A admin check read from.
PORTAL_ADMIN_EMAILS = frozenset(
    email.strip().lower()
    for email in os.environ.get("PORTAL_ADMIN_EMAILS", "").split(",")
    if email.strip()
)
if not PORTAL_ADMIN_EMAILS:
    print("[ACCESS] PORTAL_ADMIN_EMAILS is empty - every Azure AD admin is treated as a portal admin")


def _apply_admin_allowlist(access_body, requested_email):
    """Returns access_body with role "admin" downgraded to "developer"
    unless the user is on PORTAL_ADMIN_EMAILS. Anything that is not a
    well-formed admin response (a plain user, a malformed body) is returned
    untouched, and the input is never mutated. Never promotes: it can only
    turn "admin" into "developer", so a bug here can't create admins.

    The identity compared is the email the group-fetch Lambda itself
    reports, falling back to the one that was asked about - not blindly the
    request's query string."""
    if not PORTAL_ADMIN_EMAILS or not isinstance(access_body, dict):
        return access_body
    access = access_body.get("access")
    if not isinstance(access, dict) or access.get("role") != "admin":
        return access_body

    identity = str(access_body.get("email") or requested_email or "").strip().lower()
    if identity in PORTAL_ADMIN_EMAILS:
        return access_body

    # !r so a crafted email can't inject extra log lines.
    print(f"[ACCESS] {identity!r} is an Azure AD admin but not on PORTAL_ADMIN_EMAILS - reporting role developer")
    return {**access_body, "access": {**access, "role": "developer"}}


# =====================================================
# MARKETS (list from the config repo / admin onboarding)
# =====================================================
# GET  /dpc/markets - the market codes found in the config repo (folders
#      under REPO_BASE_PATH on the dev branch), via the GitOps Lambda.
#      Cached briefly per warm container: the Create Request and View
#      Whitelist pages both load it, and the repo changes rarely.
# POST /dpc/markets - admin-only: opens PRs that add a new market folder
#      (values.yaml + values.dev/qa/prd.yaml) to dev, qa and master.
MARKET_CODE_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")
MARKETS_CACHE_SECONDS = 60
_markets_cache = {"markets": None, "expires": 0.0}


def _invoke_gitops_sync(payload):
    """Synchronous GitOps Lambda call. Returns its result dict, or None
    when the call or the Lambda itself failed (logged, never raised)."""
    try:
        invoke_result = lambda_client.invoke(
            FunctionName=gitops_lambda_name,
            InvocationType="RequestResponse",
            Payload=json.dumps(payload),
        )
        result = json.loads(invoke_result["Payload"].read())
    except (ClientError, json.JSONDecodeError) as error:
        print(f"[MARKETS] GitOps invoke failed for {payload.get('action')}: {error}")
        return None
    if invoke_result.get("FunctionError") or not isinstance(result, dict):
        print(f"[MARKETS] GitOps lambda error for {payload.get('action')}: {result}")
        return None
    return result


def _is_portal_admin(email):
    """True only for a real portal admin: on PORTAL_ADMIN_EMAILS, or
    reported as role admin by the Azure AD group lookup (which already
    demotes anyone not on that list). Unlike the Q&A check it ignores
    QNA_ADMIN_EMAILS - that list is just who gets notified about
    questions. Any failure means "not admin"."""
    if not email:
        return False
    if email.strip().lower() in PORTAL_ADMIN_EMAILS:
        return True
    return _qna_is_admin(email, include_qna_admins=False)


def _send_notification_email(to_addresses, subject, body):
    """Best-effort email. Never raises - a notification failure must not
    fail the question/comment that was already durably stored."""
    to_addresses = [address for address in to_addresses if address]
    if not to_addresses:
        return
    if not notification_from_email:
        print(f"[QNA] DOMAIN not configured - skipping email: {subject}")
        return
    try:
        ses_client.send_email(
            Source=notification_from_email,
            Destination={"ToAddresses": to_addresses},
            Message={
                "Subject": {"Data": subject},
                "Body": {"Text": {"Data": body}},
            },
        )
    except ClientError as error:
        print(f"[QNA] Failed to send email '{subject}': {error}")


def _qna_is_admin(email, include_qna_admins=True):
    """True only when the email is positively known to be an admin: either
    listed in QNA_ADMIN_EMAILS, or the Azure AD group-fetch Lambda (same
    one GET /dpc/access uses) says role == admin. Any failure means
    "not admin" - this never grants admin on an error. Cached briefly per
    warm container, since a busy thread would otherwise invoke the
    group-fetch Lambda on every comment."""
    if not email:
        return False
    normalized = email.strip().lower()
    if include_qna_admins and normalized in {admin.lower() for admin in QNA_ADMIN_EMAILS}:
        return True
    if not azure_ad_group_fetch_lambda_name:
        return False

    cached = _qna_role_cache.get(normalized)
    now = time.time()
    if cached and cached[1] > now:
        return cached[0]

    is_admin = False
    try:
        invoke_result = lambda_client.invoke(
            FunctionName=azure_ad_group_fetch_lambda_name,
            InvocationType="RequestResponse",
            Payload=json.dumps({"email": email}),
        )
        raw_payload = json.loads(invoke_result["Payload"].read())
        if not invoke_result.get("FunctionError") and raw_payload.get("statusCode", 200) == 200:
            body = _apply_admin_allowlist(json.loads(raw_payload.get("body") or "{}"), email)
            is_admin = (body.get("access") or {}).get("role") == "admin"
    except (ClientError, json.JSONDecodeError, TypeError, AttributeError) as error:
        print(f"[QNA] Role lookup failed for {email}: {error}")
        return False

    _qna_role_cache[normalized] = (is_admin, now + QNA_ROLE_CACHE_SECONDS)
    return is_admin


def _qna_question_id_from_path(path):
    """('<id>', remainder) for /dpc/qna/<id>[/comments], else (None, None)."""
    parts = [part for part in path.split("/") if part]
    if len(parts) < 3 or parts[0] != "dpc" or parts[1] != "qna":
        return None, None
    question_id = parts[2]
    if not question_id.replace("-", "").isalnum() or len(question_id) > 64:
        return None, None
    return question_id, "/".join(parts[3:])


def _qna_comment_public(comment):
    # Authors are exposed by display name only - emails stay server-side.
    return {
        "commentId": comment.get("commentId"),
        "body": comment.get("body", ""),
        "authorName": comment.get("authorName", "Unknown"),
        "isAdmin": bool(comment.get("isAdmin")),
        "createdAt": comment.get("createdAt"),
    }


def _qna_public(item, include_comments):
    comments = item.get("comments") or []
    admin_answer = next((c for c in comments if c.get("isAdmin")), None)
    result = {
        "questionId": item["question_id"],
        "title": item.get("title", ""),
        "body": item.get("body", ""),
        "askedByName": (item.get("asked_by") or {}).get("name", "Unknown"),
        "askedById": (item.get("asked_by") or {}).get("id"),
        "status": item.get("qna_status", "OPEN"),
        "commentCount": len(comments),
        "createdAt": item["createdAt"],
        "updatedAt": item.get("updatedAt", item["createdAt"]),
        # Short preview of the first admin answer, so list views (and the
        # troubleshooting page's search) can show a solution without
        # loading every thread.
        "answerPreview": (admin_answer.get("body", "")[:300] if admin_answer else None),
    }
    if include_comments:
        result["comments"] = [_qna_comment_public(c) for c in comments]
    return result


def _qna_thread_link(question_id):
    return f"{PORTAL_BASE_URL}/qna/{question_id}" if PORTAL_BASE_URL else None


def _notify_admins_new_question(item):
    asked_by = item.get("asked_by") or {}
    link = _qna_thread_link(item["question_id"])
    body = (
        "A new question was asked in the portal's Q&A forum and needs a response.\n\n"
        f"Title: {item['title']}\n"
        f"Asked by: {asked_by.get('name', 'Unknown')} <{asked_by.get('email', 'unknown')}>\n\n"
        f"{item['body']}\n\n"
        + (f"Answer it here: {link}\n" if link else "Open the portal's Q&A page to answer it.\n")
    )
    _send_notification_email(
        QNA_ADMIN_EMAILS, f"[DPC Portal Q&A] New question: {item['title']}", body
    )


def _notify_asker_answered(item, answer):
    asked_by = item.get("asked_by") or {}
    asker_email = asked_by.get("email")
    if not asker_email:
        return
    link = _qna_thread_link(item["question_id"])
    body = (
        f"An admin has responded to your question \"{item['title']}\".\n\n"
        f"{answer['authorName']} wrote:\n{answer['body']}\n\n"
        + (f"View the thread: {link}\n" if link else "")
    )
    _send_notification_email(
        [asker_email], f"[DPC Portal Q&A] Your question was answered: {item['title']}", body
    )


def handle_qna(method, path, event, origin):
    """Routes for /dpc/qna*. Returns None when the path isn't a Q&A route,
    so handle_request can fall through to its other routes."""
    if path == "/dpc/qna":
        if method == "GET":
            items = []
            start_key = None
            while len(items) < QNA_LIST_LIMIT:
                query_args = {
                    "IndexName": "submitted-by-created-at",
                    "KeyConditionExpression": Key("submitted_by_id").eq(QNA_PARTITION),
                    "ScanIndexForward": False,
                }
                if start_key:
                    query_args["ExclusiveStartKey"] = start_key
                result = table.query(**query_args)
                items.extend(result.get("Items", []))
                start_key = result.get("LastEvaluatedKey")
                if not start_key:
                    break
            return response(
                200,
                {"questions": [_qna_public(item, False) for item in items[:QNA_LIST_LIMIT]]},
                origin,
            )

        if method == "POST":
            try:
                payload = json.loads(event.get("body") or "{}")
            except json.JSONDecodeError:
                return response(400, {"message": "Invalid request payload"}, origin)
            title = str(payload.get("title") or "").strip()
            body = str(payload.get("body") or "").strip()
            asked_by = payload.get("askedBy") or {}
            if not title or not body or not asked_by.get("id"):
                return response(400, {"message": "title, body and askedBy.id are required"}, origin)
            if len(title) > QNA_MAX_TITLE or len(body) > QNA_MAX_BODY:
                return response(400, {"message": "Question is too long"}, origin)

            now = datetime.now(timezone.utc).isoformat()
            question_id = str(uuid.uuid4())
            item = {
                "request_id": f"{QNA_PREFIX}{question_id}",
                "question_id": question_id,
                "submitted_by_id": QNA_PARTITION,
                "qna_status": "OPEN",
                "title": title,
                "body": body,
                "asked_by": {
                    "id": str(asked_by["id"]),
                    "name": str(asked_by.get("name") or "Unknown"),
                    "email": str(asked_by.get("email") or ""),
                },
                "comments": [],
                "createdAt": now,
                "updatedAt": now,
            }
            table.put_item(Item=item)
            _notify_admins_new_question(item)
            return response(201, _qna_public(item, True), origin)

        return response(405, {"message": "Method not allowed"}, origin)

    question_id, remainder = _qna_question_id_from_path(path)
    if not question_id:
        return None
    key = {"request_id": f"{QNA_PREFIX}{question_id}"}

    if method == "GET" and remainder == "":
        item = table.get_item(Key=key).get("Item")
        if not item:
            return response(404, {"message": "Question not found"}, origin)
        return response(200, _qna_public(item, True), origin)

    if method == "POST" and remainder == "comments":
        try:
            payload = json.loads(event.get("body") or "{}")
        except json.JSONDecodeError:
            return response(400, {"message": "Invalid request payload"}, origin)
        comment_body = str(payload.get("body") or "").strip()
        author = payload.get("author") or {}
        if not comment_body or not author.get("id"):
            return response(400, {"message": "body and author.id are required"}, origin)
        if len(comment_body) > QNA_MAX_BODY:
            return response(400, {"message": "Comment is too long"}, origin)

        is_admin = _qna_is_admin(author.get("email"))
        now = datetime.now(timezone.utc).isoformat()
        comment = {
            "commentId": str(uuid.uuid4()),
            "body": comment_body,
            "authorId": str(author["id"]),
            "authorName": str(author.get("name") or "Unknown"),
            "authorEmail": str(author.get("email") or ""),
            "isAdmin": is_admin,
            "createdAt": now,
        }
        update_expression = "SET comments = list_append(if_not_exists(comments, :empty), :comment), updatedAt = :now"
        values = {
            ":empty": [],
            ":comment": [comment],
            ":now": now,
            ":max": QNA_MAX_COMMENTS,
        }
        if is_admin:
            # An admin response is what moves a question from OPEN to
            # ANSWERED - ordinary users' comments never do.
            update_expression += ", qna_status = :answered"
            values[":answered"] = "ANSWERED"
        try:
            updated = table.update_item(
                Key=key,
                UpdateExpression=update_expression,
                ConditionExpression="attribute_exists(request_id) AND (attribute_not_exists(comments) OR size(comments) < :max)",
                ExpressionAttributeValues=values,
                ReturnValues="ALL_NEW",
            )["Attributes"]
        except ClientError as error:
            if error.response["Error"]["Code"] == "ConditionalCheckFailedException":
                return response(404, {"message": "Question not found, or the thread is full"}, origin)
            raise

        if is_admin:
            _notify_asker_answered(updated, comment)
        return response(201, _qna_public(updated, True), origin)

    return None


# ---------------------------------------------------------------------------
# Troubleshooting knowledge: Confluence pages read with a service account
#
# The browser can't read the org's Confluence pages (they need a login), so
# GET /dpc/troubleshoot/confluence fetches the pages listed in
# CONFLUENCE_PAGE_URLS here, using a service account whose credentials live
# in Secrets Manager (CONFLUENCE_SECRET_ID), and returns their plain text for
# the Troubleshooting page's search. The endpoint takes NO input: it can only
# ever fetch the configured pages, from the hosts in those URLs, over https,
# and the credentials are never sent anywhere else (redirects are not
# followed). Results are cached in memory for CONFLUENCE_CACHE_SECONDS.
#
# Secret format (JSON, or a bare token string):
#   {"username": "...", "api_token": "..."}   -> HTTP Basic (Confluence Cloud
#                                                email + API token, or Data
#                                                Center user + password/token)
#   {"token": "..."}                          -> Bearer (Data Center personal
#                                                access token)
# Accepted key names: username|user|email and api_token|apiToken|token|pat|
# password.
# ---------------------------------------------------------------------------
def _confluence_int_env(name, default):
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


CONFLUENCE_PAGE_URLS = [
    url.strip()
    for url in os.environ.get("CONFLUENCE_PAGE_URLS", "").split(",")
    if url.strip()
]
CONFLUENCE_SECRET_ID = os.environ.get("CONFLUENCE_SECRET_ID", "").strip()
CONFLUENCE_API_BASE_URL = os.environ.get("CONFLUENCE_API_BASE_URL", "").strip().rstrip("/")
CONFLUENCE_CACHE_SECONDS = max(60, _confluence_int_env("CONFLUENCE_CACHE_SECONDS", 900))
CONFLUENCE_MAX_PAGES = 20
CONFLUENCE_TEXT_LIMIT = 8000
CONFLUENCE_REQUEST_TIMEOUT = 6
CONFLUENCE_TOTAL_TIMEOUT = 20
CONFLUENCE_RETRY_SECONDS = 60

_confluence_cache = {"expires": 0.0, "pages": []}
_confluence_auth_cache = {"expires": 0.0, "header": None}


class _ConfluenceNoRedirect(urllib.request.HTTPRedirectHandler):
    """Never follow a redirect: it could carry the Authorization header to
    another host. A 3xx simply surfaces as an HTTPError."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_confluence_opener = urllib.request.build_opener(_ConfluenceNoRedirect)


class _ConfluenceText(HTMLParser):
    """Confluence storage format (XHTML + ac:/ri: macros) -> plain text."""

    _BLOCK_TAGS = {"p", "div", "br", "li", "tr", "td", "th", "h1", "h2", "h3", "h4", "h5", "h6", "pre"}
    _SKIP_TAGS = {"script", "style", "ac:parameter"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self._skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in self._SKIP_TAGS:
            self._skip += 1
        elif tag in self._BLOCK_TAGS:
            self.parts.append(" ")

    def handle_endtag(self, tag):
        if tag in self._SKIP_TAGS and self._skip:
            self._skip -= 1
        elif tag in self._BLOCK_TAGS:
            self.parts.append(" ")

    def handle_data(self, data):
        if not self._skip:
            self.parts.append(data)

    def unknown_decl(self, data):
        # <![CDATA[ ... ]]> (code/noformat macro bodies).
        if not self._skip and data.startswith("CDATA["):
            self.parts.append(data[len("CDATA["):])


def _confluence_html_to_text(markup):
    parser = _ConfluenceText()
    try:
        parser.feed(markup or "")
        parser.close()
    except Exception as error:  # malformed markup: keep whatever was parsed
        print(f"[CONFLUENCE] HTML parse problem ({type(error).__name__}) - using partial text")
    return re.sub(r"\s+", " ", " ".join(parser.parts)).strip()[:CONFLUENCE_TEXT_LIMIT]


def _confluence_page_ref(url):
    """Works out the REST API base and page reference for one configured
    page URL. Returns None for anything unsupported (not https, a tiny
    /x/ link, ...)."""
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        return None
    host_root = f"https://{parsed.netloc}"
    path = parsed.path or ""

    api_base = ""
    if CONFLUENCE_API_BASE_URL and urllib.parse.urlparse(CONFLUENCE_API_BASE_URL).netloc == parsed.netloc:
        api_base = CONFLUENCE_API_BASE_URL
    elif parsed.hostname.endswith(".atlassian.net"):
        api_base = f"{host_root}/wiki/rest/api"
    else:
        positions = [path.index(m) for m in ("/pages/", "/display/", "/spaces/") if m in path]
        context = path[: min(positions)] if positions else ""
        api_base = f"{host_root}{context}/rest/api"

    page_id = None
    match = re.search(r"/pages/(\d+)", path)
    if match:
        page_id = match.group(1)
    else:
        values = urllib.parse.parse_qs(parsed.query).get("pageId", [])
        if values and values[0].isdigit():
            page_id = values[0]
    if page_id:
        return {"api_base": api_base, "page_id": page_id}

    match = re.search(r"/display/([^/]+)/([^/?#]+)", path)
    if match:
        return {
            "api_base": api_base,
            "space": urllib.parse.unquote(match.group(1)),
            "title": urllib.parse.unquote_plus(match.group(2)),
        }
    return None


def _confluence_auth_header():
    """Authorization header for the Confluence service account, read from
    Secrets Manager (cached for 5 minutes). None if it can't be read."""
    now = time.time()
    if _confluence_auth_cache["header"] and now < _confluence_auth_cache["expires"]:
        return _confluence_auth_cache["header"]
    if not CONFLUENCE_SECRET_ID:
        return None
    try:
        raw = secrets_client.get_secret_value(SecretId=CONFLUENCE_SECRET_ID).get("SecretString") or ""
    except ClientError as error:
        code = error.response.get("Error", {}).get("Code", "unknown")
        print(f"[CONFLUENCE] Could not read the service account secret ({code})")
        return None
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        data = raw.strip()
    if isinstance(data, str):
        data = {"token": data}
    if not isinstance(data, dict):
        print("[CONFLUENCE] Service account secret has an unsupported format")
        return None

    def first(*names):
        for name in names:
            value = data.get(name)
            if isinstance(value, str) and value:
                return value
        return None

    username = first("username", "user", "email")
    secret = first("api_token", "apiToken", "token", "pat", "password")
    if username and secret:
        header = "Basic " + base64.b64encode(f"{username}:{secret}".encode("utf-8")).decode("ascii")
    elif secret:
        header = "Bearer " + secret
    else:
        print("[CONFLUENCE] Service account secret has no usable token/password")
        return None
    _confluence_auth_cache.update({"header": header, "expires": now + 300})
    return header


def _confluence_get_json(url, auth):
    request = urllib.request.Request(
        url,
        headers={
            "Authorization": auth,
            "Accept": "application/json",
            "User-Agent": "dpc-portal-troubleshooting/1.0",
        },
    )
    with _confluence_opener.open(request, timeout=CONFLUENCE_REQUEST_TIMEOUT) as reply:
        return json.loads(reply.read(2_000_000))


def _fetch_confluence_page(url, auth):
    """Title + plain text of one configured page, or None."""
    ref = _confluence_page_ref(url)
    if not ref:
        print("[CONFLUENCE] Skipping a page URL this portal can't map to the REST API")
        return None
    query = urllib.parse.urlencode({"expand": "body.storage"})
    if ref.get("page_id"):
        data = _confluence_get_json(f"{ref['api_base']}/content/{ref['page_id']}?{query}", auth)
    else:
        lookup = urllib.parse.urlencode(
            {"spaceKey": ref["space"], "title": ref["title"], "expand": "body.storage", "limit": 1}
        )
        found = _confluence_get_json(f"{ref['api_base']}/content?{lookup}", auth)
        results = found.get("results") if isinstance(found, dict) else None
        data = results[0] if results else None
    if not isinstance(data, dict):
        return None
    storage = (data.get("body") or {}).get("storage") or {}
    return {
        "url": url,
        "title": str(data.get("title") or "")[:200],
        "text": _confluence_html_to_text(storage.get("value", "")),
    }


def get_confluence_pages():
    """Cached list of {url, title, text} for CONFLUENCE_PAGE_URLS. Pages that
    can't be read right now fall back to their last good copy (if any)."""
    now = time.time()
    if _confluence_cache["expires"] > now:
        return _confluence_cache["pages"]

    urls = CONFLUENCE_PAGE_URLS[:CONFLUENCE_MAX_PAGES]
    auth = _confluence_auth_header()
    previous = {page["url"]: page for page in _confluence_cache["pages"]}
    if not auth:
        _confluence_cache["expires"] = now + CONFLUENCE_RETRY_SECONDS
        return _confluence_cache["pages"]

    pool = ThreadPoolExecutor(max_workers=5)
    futures = {pool.submit(_fetch_confluence_page, url, auth): url for url in urls}
    done, _not_done = wait(futures, timeout=CONFLUENCE_TOTAL_TIMEOUT)
    pool.shutdown(wait=False, cancel_futures=True)

    pages = []
    failures = 0
    for future, url in futures.items():
        page = None
        if future in done:
            try:
                page = future.result()
            except urllib.error.HTTPError as error:
                print(f"[CONFLUENCE] A page returned HTTP {error.code}")
            except Exception as error:
                print(f"[CONFLUENCE] A page could not be read ({type(error).__name__})")
        page = page or previous.get(url)
        if page:
            pages.append(page)
        else:
            failures += 1

    _confluence_cache["pages"] = pages
    _confluence_cache["expires"] = now + (CONFLUENCE_RETRY_SECONDS if failures else CONFLUENCE_CACHE_SECONDS)
    return pages


REQUEST_TYPES = ("WHITELIST", "DEWHITELIST", "COMBINED")
REQUEST_RESOURCE_SECTIONS = ("buckets", "secrets", "kmsKeys", "functions")


def _validate_request_payload(payload):
    """Returns an error message for a malformed new request, else None.
    request_type must be one of REQUEST_TYPES. An environment's nested
    "remove" lists (the resources a COMBINED request takes away) are only
    allowed on COMBINED requests, must be lists of strings, and must not
    name anything that the same environment also adds."""
    if not isinstance(payload, dict):
        return "Invalid request payload"
    request_type = payload.get("request_type")
    if request_type is not None and str(request_type).upper() not in REQUEST_TYPES:
        return "request_type must be WHITELIST, DEWHITELIST or COMBINED"
    environments = payload.get("environments")
    if not isinstance(environments, dict):
        return "environments must be an object"
    is_combined = str(request_type or "").upper() == "COMBINED"
    has_removal = False
    for env_resources in environments.values():
        if not isinstance(env_resources, dict):
            return "each environment must be an object"
        remove = env_resources.get("remove")
        if remove is None:
            continue
        if not is_combined:
            return "remove lists are only allowed on COMBINED requests"
        if not isinstance(remove, dict):
            return "remove must be an object"
        for section in REQUEST_RESOURCE_SECTIONS:
            removed = remove.get(section, [])
            if not isinstance(removed, list) or not all(isinstance(value, str) for value in removed):
                return "remove lists must be lists of strings"
            added = env_resources.get(section, [])
            if not isinstance(added, list):
                return "resource lists must be lists"
            if removed:
                has_removal = True
            if {value.lower() for value in removed} & {str(value).lower() for value in added}:
                return "A resource cannot be added and removed in the same request"
    if is_combined and not has_removal:
        return "COMBINED requests need at least one resource to remove"
    return None


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

        validation_error = _validate_request_payload(payload)
        if validation_error:
            return response(400, {"message": validation_error}, origin)

        now = datetime.now(timezone.utc).isoformat()
        target_stages = compute_target_stages(payload)
        market_code = payload["market_code"].upper()

        # Claim this market's lock before the request even exists, so
        # there's no window where the item is visible but nothing has
        # decided REQUEST_RECEIVED vs QUEUED yet. If claimed, this is the
        # only active request for the market and proceeds exactly as
        # before; if not, another request for the same market is already
        # in flight and this one is held as QUEUED until that one reaches
        # a terminal state (see _release_and_forward_market_lock) - this
        # is what prevents two open requests for the same market from
        # racing onto the same dev/qa/master branches and conflicting.
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
                    # The lock was claimed for a request that turned out
                    # to be a duplicate id and was never persisted - free
                    # it up for whoever's actually next instead of
                    # leaking it until the staleness sweep.
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

    if method == "GET" and path == "/dpc/troubleshoot/confluence":
        # Page text for the Troubleshooting page's search (see
        # get_confluence_pages). Unconfigured -> an empty, successful answer.
        if not CONFLUENCE_PAGE_URLS or not CONFLUENCE_SECRET_ID:
            return response(200, {"configured": False, "pages": []}, origin)
        return response(200, {"configured": True, "pages": get_confluence_pages()}, origin)

    if method == "GET" and path == "/dpc/listrequests":
        if not user_id:
            return response(400, {"message": "userId is required"}, origin)
        # "QNA" is the reserved partition Q&A forum questions are stored
        # under (see QNA_PARTITION) - never a real user id, and listing it
        # here would dump raw forum items including asker emails.
        if user_id == QNA_PARTITION:
            return response(400, {"message": "Invalid userId"}, origin)
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
        # Merge in prUrls (and the rest of stage_summary) per item so the
        # My Requests list can show admin-only PR links too, not just the
        # single-request detail view - stage_summary is a pure computation
        # over fields already on each item (target_stages/stage_index/
        # pr_<branch>), so this adds no extra reads.
        for item in items:
            item.update(stage_summary(item))
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
        request.update(stage_summary(item))
        request["history"] = item.get("history") or [
            {"status": item["status"], "timestamp": item.get("updatedAt", item["createdAt"]), "performedBy": "System"}
        ]
        request["comments"] = []
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

    if path == "/dpc/markets" and method == "GET":
        if not gitops_lambda_name:
            return response(503, {"message": "GitOps Lambda not configured"}, origin)
        now_ts = time.time()
        cached_markets = _markets_cache["markets"]
        if cached_markets is not None and _markets_cache["expires"] > now_ts:
            return response(200, {"markets": cached_markets}, origin)
        markets_result = _invoke_gitops_sync({"action": "LIST_MARKETS"})
        if markets_result is None or markets_result.get("status") != "SUCCESS":
            return response(502, {"message": "Failed to load markets from the repository"}, origin)
        markets = sorted(
            {str(code).upper() for code in markets_result.get("markets", []) if isinstance(code, str)}
        )
        _markets_cache["markets"] = markets
        _markets_cache["expires"] = now_ts + MARKETS_CACHE_SECONDS
        return response(200, {"markets": markets}, origin)

    if path == "/dpc/markets" and method == "POST":
        try:
            market_body = json.loads(event.get("body") or "{}")
        except json.JSONDecodeError:
            return response(400, {"message": "Invalid request body"}, origin)
        if not isinstance(market_body, dict):
            return response(400, {"message": "Invalid request body"}, origin)
        new_market = str(market_body.get("market_code") or "").strip().lower()
        admin_email = str(market_body.get("email") or "").strip()
        if not MARKET_CODE_PATTERN.match(new_market):
            return response(
                400,
                {"message": "Market code must be 1-32 letters, digits, '-' or '_' and start with a letter or digit"},
                origin,
            )
        if not _is_portal_admin(admin_email):
            print(f"[MARKETS] Refused onboarding of {new_market!r}: {admin_email!r} is not a portal admin")
            return response(403, {"message": "Only portal admins can onboard a market"}, origin)
        if not gitops_lambda_name:
            return response(503, {"message": "GitOps Lambda not configured"}, origin)

        print(f"[MARKETS] {admin_email!r} is onboarding market {new_market!r}")
        onboard_result = _invoke_gitops_sync(
            {"action": "ONBOARD_MARKET", "market_code": new_market, "requested_by": {"email": admin_email}}
        )
        if onboard_result is None:
            return response(502, {"message": "Failed to reach the repository to onboard the market"}, origin)
        onboard_status = onboard_result.get("status")
        if onboard_status == "EXISTS":
            return response(409, {"message": onboard_result.get("message", "Market already exists")}, origin)
        if onboard_status == "INVALID":
            return response(400, {"message": onboard_result.get("message", "Invalid market code")}, origin)
        if onboard_status != "SUCCESS":
            return response(
                502,
                {
                    "message": onboard_result.get("message", "Failed to onboard the market"),
                    "pullRequests": onboard_result.get("results", []),
                },
                origin,
            )
        _markets_cache["markets"] = None
        return response(
            201,
            {
                "marketCode": onboard_result.get("marketCode", new_market.upper()),
                "pullRequests": onboard_result.get("results", []),
                "alreadyPresentOn": onboard_result.get("alreadyPresentOn", []),
            },
            origin,
        )

    if method == "GET" and path == "/dpc/access":
        # RBAC (idea #19): resolve the caller's real role and
        # market/environment access by invoking the org's separate Azure
        # AD group-fetch Lambda synchronously - triggered from the
        # frontend right after login (see accessService.getAccess /
        # AuthProvider.tsx). Mirrors the GET /dpc/whitelist/ pattern above
        # (same-account RequestResponse invoke, not the cross-account
        # sts:AssumeRole path idea #4 uses for AWS-state verification).
        query = event.get("queryStringParameters") or {}
        email = query.get("email")
        if not email:
            return response(400, {"message": "email is required"}, origin)
        if not azure_ad_group_fetch_lambda_name:
            return response(503, {"message": "Azure AD group fetch Lambda not configured"}, origin)

        try:
            invoke_result = lambda_client.invoke(
                FunctionName=azure_ad_group_fetch_lambda_name,
                InvocationType="RequestResponse",
                Payload=json.dumps({"email": email}),
            )
            raw_payload = json.loads(invoke_result["Payload"].read())
        except ClientError as error:
            print(f"[ACCESS] Failed to invoke Azure AD group fetch lambda: {error}")
            return response(502, {"message": "Failed to fetch access"}, origin)
        except json.JSONDecodeError as error:
            print(f"[ACCESS] Non-JSON response from Azure AD group fetch lambda: {error}")
            return response(502, {"message": "Failed to fetch access"}, origin)

        if invoke_result.get("FunctionError"):
            print(f"[ACCESS] Azure AD group fetch lambda error: {raw_payload}")
            return response(502, {"message": "Failed to fetch access"}, origin)

        # azure_ad_group_fetch returns its own {"statusCode": ..., "body":
        # "<json string>"} shape - a raw Lambda invoke response, not
        # routed through API Gateway - so it has to be unwrapped the same
        # way API Gateway itself would, rather than passed straight
        # through to the frontend.
        access_status = raw_payload.get("statusCode", 200)
        try:
            access_body = json.loads(raw_payload.get("body") or "{}")
        except (json.JSONDecodeError, TypeError) as error:
            print(f"[ACCESS] Malformed body from Azure AD group fetch lambda: {raw_payload} ({error})")
            return response(502, {"message": "Malformed access response"}, origin)

        if access_status != 200:
            print(f"[ACCESS] Azure AD group fetch lambda returned {access_status}: {access_body}")
            return response(502, {"message": "Failed to fetch access"}, origin)

        # Admin allow-list: an Azure AD admin who isn't on PORTAL_ADMIN_EMAILS
        # is reported as role "developer" (see _apply_admin_allowlist).
        access_body = _apply_admin_allowlist(access_body, email)
        return response(200, access_body, origin)

    if method == "POST" and path.startswith("/dpc/requests/") and path.endswith("/cancel"):
        request_id = event.get("pathParameters", {}).get("request_id")
        if not request_id:
            return response(400, {"message": "request_id is required"}, origin)
        if not user_id:
            return response(400, {"message": "userId is required"}, origin)

        item = table.get_item(Key={"request_id": request_id}).get("Item")
        if not item or item.get("submitted_by_id") != user_id:
            return response(404, {"message": "Request not found"}, origin)

        # Cancellable only while this request hasn't merged to its first
        # stage (dev) yet - stage_index only ever moves forward on a real
        # merge (see advance_stage), so -1 reliably means "no merge has
        # happened", for both a dev-only request and a multi-env one.
        # Once it's merged to dev, other environments may already be
        # riding a shared qa/master promotion PR alongside other markets'
        # requests, so unwinding it safely is no longer possible from here
        # - matches the requester-facing rule this was built for.
        stage_index = int(item.get("stage_index", -1))
        current_status = item.get("status")
        if stage_index >= 0:
            return response(
                400,
                {"message": "This request has already merged to DEV and can no longer be cancelled"},
                origin,
            )
        if current_status in ("COMPLETED", "PR_DECLINED", "PR_DELETED", "CANCELLED"):
            return response(
                400,
                {"message": "This request has already reached a final state and cannot be cancelled"},
                origin,
            )

        try:
            body = json.loads(event.get("body") or "{}")
        except json.JSONDecodeError:
            body = {}
        reason = (body.get("reason") or "").strip()

        now = datetime.now(timezone.utc).isoformat()
        updated = _update_item(
            request_id, "CANCELLED", "user:cancel", now,
            comments=reason or "Cancelled by requester",
        )
        if updated is None:
            # Status moved in the meantime (e.g. it merged to dev just
            # before this landed) - report cleanly instead of silently
            # applying nothing, since a naive retry could confuse a user
            # who thinks they successfully cancelled a request that's now
            # actually progressing.
            return response(
                409,
                {"message": "This request's status just changed - please refresh and try again"},
                origin,
            )

        market_code = (updated.get("payload") or {}).get("market_code")
        if market_code:
            # Safe even if this request was QUEUED (never claimed the
            # lock) - the delete is conditioned on this request actually
            # being the holder, so it's a no-op in that case.
            _release_and_forward_market_lock(market_code, request_id, now)

        trigger_cancel(request_id, updated.get("payload", {}))

        return response(
            200,
            {"message": "Request cancelled", "requestId": request_id, "status": "CANCELLED"},
            origin,
        )

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
        # Admin-only override (gated client-side - see
        # _admin_force_retry_promotion) for a request stuck awaiting a
        # promotion PR that never appeared, because the lock guarding it
        # was orphaned by a promotion resolved outside this portal.
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

    if method == "POST" and path == "/dpc/bitbucket/webhook":
        try:
            payload = json.loads(event.get("body") or "{}")
        except json.JSONDecodeError:
            return response(400, {"message": "Invalid webhook payload"}, origin)
        return handle_webhook(payload, origin)

    # Q&A forum (idea #15) - see the Q&A FORUM block above handle_request.
    if path == "/dpc/qna" or path.startswith("/dpc/qna/"):
        qna_response = handle_qna(method, path, event, origin)
        if qna_response is not None:
            return qna_response

    return response(404, {"message": "Route not found"}, origin)


def lambda_handler(event, _context):
    print(event)
    # EventBridge-triggered sweep - a different event shape entirely
    # (no headers/path/method), so this has to be checked before
    # anything else touches event.get("headers").
    if event.get("action") == "VALIDATE_SWEEP":
        try:
            return handle_validation_sweep(event)
        except Exception as error:
            print(f"Unhandled validation sweep error: {error}")
            return {"status": "ERROR", "message": str(error)}
    origin = event.get("headers", {}).get("origin")
    try:
        return handle_request(event)
    except Exception as error:
        print(f"Unhandled request API error: {error}")
        return response(500, {"message": "Unable to process the request"}, origin)
