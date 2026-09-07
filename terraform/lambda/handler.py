import json
import os
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

    return response(404, {"message": "Route not found"}, origin)


def lambda_handler(event, _context):
    print(event)
    origin = event.get("headers", {}).get("origin")
    try:
        return handle_request(event)
    except Exception as error:
        print(f"Unhandled request API error: {error}")
        return response(500, {"message": "Unable to process the request"}, origin)
