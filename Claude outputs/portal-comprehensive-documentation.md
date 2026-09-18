# DPC Self-Service Whitelisting Portal — Comprehensive Documentation

Two audiences, one document: **Part 1 (User Guide)** is for anyone requesting, tracking, or approving a whitelisting request. **Part 2 (Developer Documentation)** is for engineers building on or maintaining the system.

This is deliberately kept **separate from the [Operations Runbook](./portal-operations-runbook.md)** — that document covers deployment, monitoring, incident response, and the PR/completion workflow from a day-2-operations angle; this one covers how to use the portal and how it's built.

## Contents

**Part 1 — User Guide**
1. [Accessing the Portal](#1-accessing-the-portal)
2. [Submitting a Whitelisting Request](#2-submitting-a-whitelisting-request-step-by-step)
3. [Request Status Meanings & Timelines](#3-request-status-meanings--timelines)
4. [Examples](#4-examples)
5. [FAQ](#5-faq)

**Part 2 — Developer Documentation**
6. [System Architecture Overview](#6-system-architecture-overview)
7. [API Specifications & Endpoints](#7-api-specifications--endpoints)
8. [DynamoDB Schema](#8-dynamodb-schema)
9. [Integration Patterns](#9-integration-patterns-entra-id-bitbucketgithub-ses)
10. [Code Structure & Key Components](#10-code-structure--key-components)
11. [Local Development Setup](#11-local-development-setup)
12. [Testing & Verification](#12-testing--verification)
13. [Known Issues & Roadmap](#13-known-issues--roadmap)

---

# Part 1 — User Guide

## 1. Accessing the Portal

The portal is a web app reached at whatever URL your deployment's frontend is hosted at (ask your admin/team channel if you don't have it — the frontend isn't managed by Terraform, so there's no single fixed URL across every deployment; see [section 6](#6-system-architecture-overview)).

Sign-in uses your organization's single sign-on (Azure AD / Entra ID) — the same credentials you use for everything else. There's no separate portal password to create or remember. On first visit (or once your session expires) you're redirected to a Microsoft login screen; after authenticating you land on the Dashboard.

## 2. Submitting a Whitelisting Request (step-by-step)

From the sidebar, open **Create Request**.

1. **Select a market.** Nothing else on the page is usable until you do — resource inputs and the environment tabs stay disabled with a "Select a market first" hint. The dropdown shows only the market code (e.g. `AM`), not the full name.
2. **Pick an environment tab** — DEV, QA, or PRD. Each tab has its own independent set of resource entries; switching tabs doesn't carry over anything you were mid-typing on another tab.
3. **Add resources.** For each type you need — S3 bucket, Secrets Manager secret, KMS key, Lambda function — type the identifier (bucket name, secret ARN, key ARN, function ARN) and click Add. Before it's added, the portal checks it against what's *already live* for that market/environment; if it's already whitelisted, you get a message instead of a duplicate entry.
4. **Add a business justification** — a short line on why this is needed.
5. **Submit.**

That's the entire user-facing step. From here, the pipeline takes over automatically: a branch is created, your requested changes are committed to the market's config file, and a pull request opens for review — you never touch the underlying config repository yourself. If you asked for QA or PRD as well as DEV, the same request keeps promoting itself through those stages automatically once each prior stage's PR merges — no separate submission needed per environment.

**One thing to know before you submit:** only one request per market can be actively moving through the pipeline at a time. If someone (including you) already has one in flight for the same market, yours is accepted but held as **Queued** — it starts automatically the moment the one ahead of it finishes. This isn't a bug; it's what stops two requests from racing onto the same branches and conflicting.

## 3. Request Status Meanings & Timelines

| Status | Meaning |
|---|---|
| Submitted / Request Received | Accepted; the automated pipeline has started. |
| Queued | Held because another request for the same market is already in progress. Starts automatically — see above. |
| Branch Created | The pipeline created a working branch for your change. |
| PR Created / PR Updated | A pull request is open for review against the current stage's branch (DEV first, then QA/PRD if requested). |
| Pending Approval | Waiting on a reviewer. |
| PR Approved | A reviewer approved it; it will be merged. |
| Merged | The change merged into that stage's branch. If there's a next stage, promotion starts automatically. |
| PR Needs Work / PR Declined / PR Deleted | The reviewer sent it back, declined it, or the PR was removed — treat as rejected for that stage. |
| Rejected | The request was rejected. |
| Completed | Promoted all the way through; live everywhere it needed to be. This happens automatically — see the [Operations Runbook](./portal-operations-runbook.md) for exactly when. |
| Sync Failed (retrying) | An automated step (branch/commit/PR) couldn't reach the source-control host at that moment — usually transient. **No action needed**: a scheduled sweep retries automatically every 10 minutes, up to 5 attempts, and resolves the large majority of these without anyone doing anything. |
| Unknown | The portal doesn't recognize the status string the backend returned — a safe fallback so the UI never breaks on an unrecognized value. |

**On timelines:** there's no fixed SLA baked into the system — how long a request takes end-to-end depends entirely on how quickly a human reviewer approves each stage's pull request. The automated parts (branch creation, commit, PR open, promotion to the next stage after a merge) each typically complete within seconds to low minutes; a "Sync Failed" retry cycle adds up to 10 minutes per retry attempt. The only genuinely unbounded step is waiting for a reviewer.

## 4. Examples

This is a text-based knowledge document rather than a screenshot gallery, so this section walks through a worked example instead of images. (If your team wants annotated screenshots added, that's straightforward to capture once a staging/live URL is available to browse — flag it and it can be added as a follow-up.)

**Worked example — requesting an S3 bucket for DEV and QA:**

1. Market: select `AM` from the dropdown.
2. Environment tab: stay on **DEV**. Resource type: **S3 Bucket**. Enter `am-payments-inbound` and click Add — it appears in the DEV list.
3. Switch to the **QA** tab. Add the same bucket name there too (each tab is independent — QA doesn't inherit what you added to DEV).
4. Business justification: "New inbound payments bucket for the AM market's Q4 integration."
5. Submit. The response is immediate: `Request received`, status `Request Received` (or `Queued` if AM already has something in flight).
6. Because both DEV and QA were requested, this one request has a `targetStages` of `['dev', 'qa']` — it will first open a PR into `dev`; once that's approved and merged, a second PR automatically opens promoting the change from `dev` into `qa`. No second form to fill in.
7. Track it from **My Requests** or the Dashboard's Recent Requests table; open it for the full timeline and (if it stalls) which stage it's waiting on.

## 5. FAQ

**Is this secure — can anyone submit for any market?** Login is real (Azure AD), but today the backend doesn't yet independently verify the caller at the API level, and there's no restriction on which markets a signed-in user can submit for. Both are tracked, known gaps — see [section 13](#13-known-issues--roadmap) — not a surprise or an oversight.

**What if two people request the same market at the same time?** The second one is held as `Queued` and starts automatically once the first reaches a finished state. See [section 2](#2-submitting-a-whitelisting-request-step-by-step).

**My request has been "Sync Failed" for a while — do I need to do anything?** Not usually — an automatic sweep retries it every 10 minutes, up to 5 attempts. If it's been stuck well beyond that, flag it to whoever maintains the portal; the automatic retries have likely been exhausted (see the Operations Runbook's incident playbook).

**Who can force-unstick a queued or stuck-promotion request?** Two admin-only actions exist on the Request Details page for exactly these situations — "Force release market lock" (for a `Queued` request stuck behind a dead one) and "Retry promotion" (for a request that merged but never got its next-stage PR opened). There's currently no equivalent manual action for `Sync Failed` specifically.

**Can I request PRD without going through DEV/QA first?** No — PRD is only reachable by passing through QA first (which itself passes through DEV). This is enforced by how `target_stages` is computed from what you select.

**Why does the market dropdown only show a code, not a name?** Deliberate — it keeps the list scannable when there are many markets. Market name is still shown on the request detail page once submitted.

**Who reviews my pull request, and how do I know it needs review?** See the [Operations Runbook's PR review process](./portal-operations-runbook.md#pr-review-process-for-developers) — in short, configured approvers get an email notification when your PR opens; they aren't automatically added to the PR as GitHub/Bitbucket reviewers.

**What does "marking a request completed" involve on my end?** Nothing — completion is fully automatic once the final requested stage's PR merges. See the [Operations Runbook](./portal-operations-runbook.md#how-requests-become-completed) for exactly how.

---

# Part 2 — Developer Documentation

## 6. System Architecture Overview

### Two parallel stacks

The portal is deployed as two independent Terraform stacks that share the same design and the same frontend codebase, but talk to different source-control hosts:

| | Org stack | Personal/test stack |
|---|---|---|
| Source control | Bitbucket Server | GitHub |
| Credential variable | `bitbucket_token_secret_name` | `github_token_secret_name` |
| Repo location variables | `bitbucket_url` + `project_key` + `repo_name` | `github_owner` + `github_repo` |
| Webhook route | `POST /dpc/bitbucket/webhook` | `POST /dpc/github/webhook` |

Every backend fix made during this engineering effort was applied to both stacks and diff-verified to be functionally identical between them — the two are kept in lockstep by convention, not by any shared Terraform module.

### System diagram

```mermaid
flowchart TB
    User[User's browser] -->|Azure AD SSO login| SPA[React SPA]
    SPA -->|HTTPS| APIGW[API Gateway HTTP API]
    APIGW -->|AWS_PROXY| MainLambda["Main Lambda\n(request-api)"]
    MainLambda -->|read/write| DDB[(DynamoDB\nrequests table)]
    MainLambda -->|Invoke: GET_WHITELIST\n(sync, RequestResponse)| GitopsLambda["GitOps Lambda\n(gitops)"]
    MainLambda -->|Invoke: CREATE_PR\n(async, Event)| GitopsLambda
    GitopsLambda -->|read/write| DDB
    GitopsLambda -->|REST API calls| GitHost[Bitbucket Server / GitHub]
    GitopsLambda -->|SendEmail| SES[Amazon SES]
    GitHost -->|webhook: PR opened/approved/merged/declined| APIGW
    EventBridge["EventBridge rule\n(rate(10 min))"] -->|action: SWEEP| GitopsLambda
    GitopsLambda -.on exhausted retries.-> DLQ[(SQS DLQ\noptional)]
```

### Request lifecycle at a glance

`Create Request` submit → **Main Lambda** claims a per-market lock and writes the DynamoDB item → asynchronously invokes the **GitOps Lambda** (`CREATE_PR`) → GitOps Lambda creates a branch, commits the YAML change, opens a PR, emails approvers → reviewer approves & merges on the git host → git host webhook fires → **Main Lambda** advances status and, if there's a next stage, invokes GitOps (`PROMOTE`) to open the dev→qa or qa→master PR → repeat until the final stage merges → status `COMPLETED`.

### Concurrency model

All concurrency control is built on DynamoDB's atomic conditional writes (`ConditionExpression="attribute_not_exists(...)"`) — no external locking service:

- **`MARKETLOCK#<MARKET_CODE>`** — one active request per market at a time; others queue and are promoted (oldest first) once the lock frees. Auto-reclaimed if stale (default 24h).
- **`LOCK#<market>#<branch>`** — held while a dev→qa or qa→master promotion PR is in flight for that market/branch, so multiple requests riding the same shared-trunk promotion PR don't each open a duplicate one.

### Retry sweep & dead-letter queue

An EventBridge rule (`rate(10 minutes)` by default) fires the GitOps Lambda with `{"action": "SWEEP"}`. It scans for requests stuck at `SYNC_FAILED` and orphaned promotion locks, retrying anything older than ~10 minutes that hasn't exhausted its retry cap (5 attempts). An optional SQS dead-letter queue (`enable_gitops_dlq`, default on) catches anything that exhausts every retry layer, purely as a last-resort inspection backstop — the sweep doesn't depend on it.

## 7. API Specifications & Endpoints

All routes are served by the Main Lambda behind one API Gateway HTTP API (`$default` stage, `AWS_PROXY` integration, 30s hard integration timeout). CORS is origin-matched against `CORS_ALLOW_ORIGINS`. Every response goes through a shared `response()` helper; any unhandled exception becomes a generic `500`.

### `POST /dpc/request` — submit a new request

Request body:
```json
{
  "request_id": "string (client-generated, unique)",
  "submitted_by": { "id": "string", "name": "string", "email": "string" },
  "market_code": "AM",
  "market_name": "Armenia",
  "business_justification": "string",
  "repository_name": "aws-whitelist-config",
  "aws_account_id": "123456789012",
  "aws_region": "eu-west-1",
  "environments": {
    "dev": {
      "buckets": ["my-bucket-name"],
      "secrets": ["arn:aws:secretsmanager:...:secret:my-secret"],
      "kmsKeys": ["arn:aws:kms:...:key/..."],
      "functions": ["arn:aws:lambda:...:function:..."]
    },
    "qa": { "buckets": [], "secrets": [], "kmsKeys": [], "functions": [] }
  }
}
```
`request_id`, `submitted_by.id`, `market_code`, and `environments` are required — a 400 is returned (`"market_code, environments, and submitted_by.id are required"`) if any is missing, or `"Invalid request payload"` if the body isn't valid JSON. The keys present in `environments` (any of `dev`/`qa`/`prd`) determine `target_stages` — PRD is only reachable if `qa` is also present.

Response (`201`):
```json
{ "statusCode": 201, "message": "Request received", "requestId": "...", "status": "REQUEST_RECEIVED" }
```
(`status` is `"QUEUED"` and `message` says so instead, if another request for the same market is already active.) A `409` (`"A request with this ID already exists"`) is returned if `request_id` collides with an existing item.

### `GET /dpc/listrequests?userId=<id>` — list a user's requests

Returns the raw DynamoDB items for that `submitted_by_id` (queried via the `submitted-by-created-at` GSI, newest first, fully paginated server-side):
```json
{ "count": 3, "requests": [ { "request_id": "...", "status": "...", "market_code": "...", "payload": {...}, "target_stages": [...], "stage_index": 0, "history": [...] }, ... ] }
```
`userId` is required (`400` without it).

### `GET /dpc/requests/{request_id}?userId=<id>` — request detail

`userId` required; returns `404` if the item doesn't exist or belongs to a different `submitted_by_id` (a user can only look up their own requests here). Response shape (built from `frontend_request()` + `stage_summary()`):
```json
{
  "requestId": "...", "marketCode": "AM", "marketName": "Armenia",
  "repositoryName": "aws-whitelist-config",
  "businessJustification": "...",
  "requestedBy": { "id": "...", "name": "...", "email": "..." },
  "aws": { "accountId": "123456789012", "region": "eu-west-1" },
  "environments": [
    { "environment": "DEV", "resources": {
        "s3Buckets": [{ "bucketName": "..." }],
        "secretsManager": [{ "secretArn": "..." }],
        "kmsKeys": [{ "keyArn": "..." }],
        "lambdaFunctions": [{ "functionArn": "..." }] } }
  ],
  "status": "PR_CREATED", "targetStages": ["dev", "qa"], "stageIndex": 0,
  "createdAt": "...", "updatedAt": "...",
  "targetEnvironment": "QA", "currentStage": "DEV",
  "prs": { "DEV": "123", "QA": null }, "prUrls": { "DEV": "https://...", "QA": null },
  "history": [ { "status": "REQUEST_RECEIVED", "timestamp": "...", "performedBy": "System" } ],
  "comments": [],
  "blockedBy": "other-request-id"
}
```
`blockedBy` is present only when `status` is `QUEUED` — the id of the request currently holding that market's lock.

### `GET /dpc/whitelist/{market_code}/{environment}` — live whitelist read

Synchronously invokes the GitOps Lambda (`GET_WHITELIST`) and returns its parsed `values.<env>.yaml` contents for that market/environment. `400` if either path param is missing, `503` if the GitOps Lambda isn't configured, `502` if the invoke or the GitOps Lambda itself fails.

### `POST /dpc/requests/{request_id}/release-lock` — admin: force-release a market lock

No body. `400` if `request_id` is missing or the request has no `market_code` on record. Response:
```json
{ "message": "Market lock released for AM", "marketCode": "AM" }
```

### `POST /dpc/requests/{request_id}/retry-promotion` — admin: force-retry a stuck promotion

No body. `400` (`"Request not found, or it has no further stage to promote into"`) if inapplicable. Response:
```json
{ "message": "Retried promotion to QA for ...", "requestId": "...", "nextEnvironment": "QA" }
```

### `POST /dpc/bitbucket/webhook` (org) / `POST /dpc/github/webhook` (personal) — inbound only

Not intended to be called by frontend or third-party code — these are configured as webhook targets on the git host itself, invoked by Bitbucket Server / GitHub on PR events (opened, updated, approved, merged, declined). See [section 9](#9-integration-patterns-entra-id-bitbucketgithub-ses).

None of the above routes has a backend authorizer today — see [section 13](#13-known-issues--roadmap).

## 8. DynamoDB Schema

Single table (`PAY_PER_REQUEST`, point-in-time recovery + encryption on), hash key `request_id`, one item shape distinguished by prefix convention:

| `request_id` value | Represents |
|---|---|
| `<uuid>` | A whitelist request: `status`, `market_code`, `createdAt`, `updatedAt`, `submitted_by_id`, `payload` (the original submitted body), `target_stages`, `stage_index`, `history[]`, `pr_dev`/`pr_qa`/`pr_master` (set as PRs open). |
| `MARKETLOCK#<MARKET_CODE>` | Per-market lock: `held_request_id`, `claimed_at`. |
| `LOCK#<market>#<branch>` | Per-branch promotion lock: `request_ids[]`, `lock_key`, `status`. |
| `PR#<pull_request_id>` | Lookup: PR id → the request id(s) riding it. |

**Attributes** (top-level, indexed): `request_id` (S, hash key), `submitted_by_id` (S), `createdAt` (S), `market_code` (S).

**Global Secondary Indexes** (both `ALL` projection):
- `submitted-by-created-at` — hash `submitted_by_id`, range `createdAt`. Powers `GET /dpc/listrequests`.
- `market-code-created-at` — hash `market_code`, range `createdAt`. Powers finding the oldest `QUEUED` request for a market when its lock releases.

## 9. Integration Patterns (Entra ID, Bitbucket/GitHub, SES)

### Entra ID (Azure AD)

Frontend-only today, via MSAL (`@azure/msal-browser` + `@azure/msal-react`): `AuthProvider` wraps the app, `ProtectedRoute` gates every page but `/login`. Login currently requests the Microsoft Graph `User.Read` scope — a real login, but the resulting token is not yet attached to API calls or verified by the backend (see [section 13](#13-known-issues--roadmap)). The ready-to-build plan for closing that loop — switching to a custom `access_as_user` scope and adding API Gateway's native JWT authorizer against the same Entra ID app registration — is documented separately in the project's SSO implementation plan doc; it requires no custom authorizer Lambda or JWT library, since API Gateway HTTP APIs validate Entra ID tokens natively against the tenant's OIDC discovery document.

### Bitbucket Server / GitHub

The GitOps Lambda is the only component that talks to either. It authenticates with a personal/service access token read fresh from Secrets Manager on every cold start (never cached in Terraform state or env vars). It uses each host's REST API for: getting the latest commit on a branch, creating a new branch from it, reading a file's current contents, committing an updated file, and opening a pull request. Every call goes through a shared retry wrapper (up to 3 attempts, backoff `[2, 5]` seconds) that retries on network errors and `429/500/502/503/504`, but deliberately not on other 4xx responses. Inbound, each host's webhook (PR opened/updated/approved/merged/declined) is normalized into one internal event-key vocabulary before being processed identically regardless of which git host sent it — the personal/GitHub stack's `handle_webhook` translates GitHub's `pull_request`/`pull_request_review` payloads into the same event keys the Bitbucket path already produces, so downstream status-mapping logic is shared rather than duplicated per host.

### Amazon SES

Both Lambdas hold `ses:SendEmail`/`ses:SendRawEmail` scoped to `identity/*`. The GitOps Lambda emails configured approvers when a request PR or promotion PR opens; the Main Lambda emails the requester on completion. Both are gated on a verified sending domain — if unset, the send is skipped with a log line rather than failing the surrounding operation, so email is additive, never a dependency the core pipeline can be blocked by.

## 10. Code Structure & Key Components

Rather than a directory listing, here's what each component owns:

- **Frontend SPA** — React 18 + TypeScript, MUI components, React Router, MSAL for Entra ID login. Lazy-loaded/code-split pages, each with its own local `Suspense` boundary (avoids a loading page-chunk unmounting the surrounding header/sidebar layout). Owns: all pages (Dashboard, Create Request, My Requests, Request Details, Current Whitelist, Settings, Help, Profile), client-side role gating (`AuthProvider.hasRole`/`hasAnyRole`), and the shared `StatusGroup`/`STATUS_CONFIG` abstractions that keep dashboard counts, filters, and status badges from drifting apart.
- **Main Lambda** (`request-api`) — the only component the frontend talks to. Owns the DynamoDB `requests` table, request submission/validation, queueing decisions, the admin recovery routes, and all webhook-driven status transitions. Never calls the git host directly.
- **GitOps Lambda** (`gitops`) — the only component that talks to source control. Owns branch/commit/PR creation, the dev→qa→master promotion mechanics, the scheduled stuck-item sweep, and approver email notifications. Invoked by the Main Lambda (sync for reads, async for writes) and by EventBridge on a schedule.
- **DynamoDB `requests` table** — the sole persistent state store and the sole concurrency primitive (via conditional writes), described in [section 8](#8-dynamodb-schema).
- **EventBridge sweep rule** — a scheduled trigger, not a code component of its own; its only job is invoking the GitOps Lambda with `{"action": "SWEEP"}`.
- **Secrets Manager** — holds the git host access token, read fresh by the GitOps Lambda on every cold start.

## 11. Local Development Setup

**Prerequisites:** Node.js ≥18 and npm ≥9 (per `package.json`'s `engines` field), plus access to a deployed backend stack to point the frontend at — there is no local/offline Lambda emulator (no SAM, no LocalStack) set up in this project today, so backend logic changes are developed by editing the Lambda source and deploying via `terraform apply` to a stack, most safely the personal/test stack rather than the org one (see the [Operations Runbook](./portal-operations-runbook.md) for deploy commands).

**Frontend, against the org stack:**
```bash
npm install
cp .env.example .env   # fill in VITE_API_BASE_URL, VITE_CLIENT_ID, VITE_TENANT_ID, etc.
npm run dev
```

**Frontend, against the personal/test stack:** the repo ships a second env file convention (`.env.personal`, overriding just `VITE_API_BASE_URL`/`VITE_REPOSITORY_NAME` — everything else, including Azure AD config, is inherited from `.env`) and a dedicated script:
```bash
npm run dev:personal
```

**Everyday scripts** (from `package.json`): `npm run lint` / `lint:fix` (ESLint, `--max-warnings 0`), `npm run format` / `format:check` (Prettier), `npm run type-check` (`tsc --noEmit`), `npm test` (Vitest — see [section 12](#12-testing--verification) for the important caveat that no test files currently exist), `npm run e2e` (Playwright, same caveat), `npm run build` (production build).

**Backend changes:** edit the relevant `handler.py`, validate syntax locally (`python3 -m py_compile handler.py` or `python3 -c "import ast; ast.parse(open('handler.py').read())"`), then `terraform apply` in the corresponding stack — the Lambda zip is rebuilt automatically from the local source directory via `data.archive_file`, so there's no separate packaging step.

**Spinning up a personal/test backend from scratch** (isolated from the org's live Bitbucket-backed stack, useful for testing the full promotion pipeline without any shared state): create an empty GitHub repo, run the provided `scaffold-config-repo.sh` to seed its `dev`/`qa`/`master` branches with empty per-market YAML files, create a GitHub PAT and store it in Secrets Manager, fill in `terraform-personal/terraform.tfvars`, then `terraform init && terraform apply`. Full step-by-step is in `terraform-personal/SETUP.md`.

## 12. Testing & Verification

**Current state: no automated test suite exists.** `package.json` declares `test`/`test:ui`/`test:coverage` (Vitest), `e2e`/`e2e:ui` (Playwright), and `prepare` (Husky) scripts — but as of this writing there are zero `*.test.*`/`*.spec.*` files anywhere in the repo, no `vitest.config.*`/`playwright.config.*`, and no `.husky/` directory. The tooling is scaffolded and would work if pointed at real tests; nothing has been built on top of it yet.

**What verification has actually been used** for changes made during this engineering effort: `tsc --noEmit` and `eslint --max-warnings 0` after every frontend change; `ast.parse()`/`py_compile` against both Lambdas after every backend change; manual scenario-based reasoning through specific code paths (e.g. lock-claim behavior for "free," "held," and "stale" cases); and direct file diffing to confirm the org and personal stacks stay functionally identical after a shared fix.

**Recommended path to real coverage**, none of it implemented yet: (1) Lambda unit tests with `moto` + `pytest` around the locking/retry/webhook-mapping logic — highest value, since that's where the subtlest bugs have historically lived; (2) frontend unit tests (Vitest, already a dependency) for the pure `StatusGroup`/`getStatusConfig` logic; (3) component tests (React Testing Library, not yet added) for the Create Request page's tab-switch/market-gating behavior; (4) a small Playwright E2E suite for the critical path (submit → track → view whitelist); (5) CI wiring once any of the above exist, restoring Husky pre-commit hooks for the fast checks.

## 13. Known Issues & Roadmap

Current, honest gap list — not a changelog.

1. **No real backend authentication (highest priority).** API Gateway has no authorizer on any route in either stack; every route, including both admin actions, is reachable directly with no identity verification. A complete, ready-to-build plan exists (API Gateway's native JWT authorizer against the existing Entra ID app registration — no new auth system, no custom authorizer Lambda) but is deliberately not yet implemented.
2. **No per-market authorization.** Even once callers are authenticated, there's no check on which markets a user may submit for. Intentionally undesigned pending a decision from the identity/platform team on where the market→user mapping should live.
3. **Webhook has no signature verification.** Anyone who can guess/obtain a `request_id` could forge a merge event today. A separate, smaller fix from #1 (HMAC signing, supported by both Bitbucket and GitHub).
4. **No automated test suite** — see [section 12](#12-testing--verification).
5. **Temporary admin-unlock mechanism should be retired** once real Azure AD ADMIN app-role assignment exists — today `isAdminUnlocked` is a client-side-only convenience, not a security boundary.
6. **No manual "retry sync" action** for `SYNC_FAILED` requests — the automatic sweep is the only recovery path today.
7. **Shared trunk branches can surface cross-market diffs in a promotion PR**, since `dev`/`qa`/`master` are shared across every market while each market owns its own YAML file. Fully isolating this would need per-market branches — a larger change, not yet scoped.

Minor/not scheduled: a few placeholder footer links; some dead entries in a breadcrumb name map; `@tanstack/react-query` wired up but unused.

---

## Related project documents

- `user-handbook.md` — a shorter, user-only version of Part 1 above.
- `portal-operations-runbook.md` — deployment, monitoring, PR review process, how requests complete, incident playbook, and rollback (kept separate from this document by design).
- `sso-backend-auth-implementation-plan.md` — the detailed, ready-to-build plan for closing the backend-authentication gap.
- `codebase-bug-audit-2026-09-04.md` — the point-in-time audit this document draws on for historical context.
- `portal-demo-script.md` — a spoken-style walkthrough for demoing the portal to a mixed audience.
