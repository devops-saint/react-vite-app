# Request-wise Flow: Frontend to Backend

This document follows **every request the portal makes**, from the button click in the browser to the last system it touches. For each request it names the **environment variables, Terraform variables, secrets, IAM permissions and DynamoDB items** that are used.

It describes the main stack in `terraform/` (Bitbucket Server, `$default` API stage). Differences in the other two stacks are in section 18.

---

## 1. The big picture

```
 Browser (React app)                                    AWS (one account, e.g. DEV)
 ┌──────────────────┐   HTTPS    ┌─────────────────┐   ┌────────────────────────────┐
 │ Pages            │──────────▶ │ API Gateway     │──▶│ Main Lambda  "request-api" │
 │ Services (axios) │  VITE_API_ │ HTTP API,       │   │ terraform/lambda/handler.py│
 │ MSAL sign-in     │  BASE_URL  │ $default stage  │   └──┬───────┬───────┬─────────┘
 └──────────────────┘            └─────────────────┘      │       │       │
        │ sign-in                                          │       │       │
        ▼                                                  │       │       └─ sts:AssumeRole ─▶ dpc-portal-validator role
 Microsoft Entra ID (Azure AD)                             │       │            (DEV / QA / PRD account) ─▶ IAM read
                                                           │       └─ invoke ─▶ Azure AD group-fetch Lambda (outside this repo)
                                          DynamoDB table ◀─┘
                                       "<project>-<env>-requests"
                                                           │ invoke (async "Event" or sync "RequestResponse")
                                                           ▼
                                             ┌───────────────────────────┐        ┌────────────────────┐
                                             │ GitOps Lambda             │──────▶ │ Bitbucket Server   │
                                             │ terraform/lambda-gitops/  │ REST   │ config repo        │
                                             └──────┬────────────────────┘        └─────────┬──────────┘
                                                    │ SES e-mail                             │ webhook
                                                    ▼                                        ▼
                                              approvers / requester          POST /dpc/bitbucket/webhook ─▶ Main Lambda

 EventBridge (every 10 min):  "SWEEP" ─▶ GitOps Lambda      "VALIDATE_SWEEP" ─▶ Main Lambda
```

**Two Lambdas, clear split:**

| Lambda | Terraform name | Job | Talks to Bitbucket? |
|---|---|---|---|
| Main (request-api) | `aws_lambda_function.request_api` = `<project>-<env>-request-api` | All HTTP routes, DynamoDB, queue/lock logic, webhook handling, AWS verification, Q&A, Confluence reader | **No** (only builds PR links) |
| GitOps | `aws_lambda_function.gitops` = `<project>-<env>-gitops` | Every Bitbucket call: branch, commit, pull request, read files, list markets | **Yes**, the only one |

`local.name` in Terraform is `<project_name>-<environment>`. Defaults: `dpc-whitelisting-dev`.

---

## 2. Shared plumbing used by every request

### 2.1 Frontend: how a call is made

| Item | Where | Details |
|---|---|---|
| Axios client | `src/api/apiGatewayAxios.ts` | `baseURL = VITE_API_BASE_URL` (fallback `/api`), `timeout = VITE_API_TIMEOUT` (default `30000` ms), header `Content-Type: application/json`. **No auth header is sent.** |
| Base URL value | `.env` / build arg | The Terraform output `api_base_url` is the bare API endpoint. Every frontend path is relative, for example `/request`, while the route in API Gateway is `/dpc/request`. So set `VITE_API_BASE_URL` to the endpoint **plus `/dpc`**. (In `terraform-org` the named stage `dpc` adds this prefix itself.) |
| User identity | `src/auth/AuthProvider.tsx` | From MSAL: `user.id = account.localAccountId`, `user.email = account.username`, `user.name = account.name`. These are sent as `userId`/`email`/`submitted_by` in the calls below. |
| Sign-in | `src/config/authConfig.ts`, `src/auth/msalInstance.ts` | `VITE_CLIENT_ID`, `VITE_TENANT_ID` (authority `https://login.microsoftonline.com/<tenant>`), `VITE_REDIRECT_URI`. Scope: `User.Read`. |

### 2.2 API Gateway

| Setting | Terraform | Value |
|---|---|---|
| API | `aws_apigatewayv2_api.requests` | HTTP API, name `<project>-<env>-requests` |
| Stage | `aws_apigatewayv2_stage.default` | `$default`, `auto_deploy = true` |
| Integration | `aws_apigatewayv2_integration.request_api` | Lambda proxy to the main Lambda |
| CORS | `cors_allow_origins`, `cors_allow_methods` (`GET, POST, OPTIONS`), `cors_allow_headers` | Browser origin must be in `cors_allow_origins` |
| Timeout | fixed by AWS | 30 s. The main Lambda timeout is `29` s so it never outlives the gateway. |

All routes are in `terraform/main.tf` (the Confluence and Markets routes are in their own sections near the end).

### 2.3 The main Lambda decides what to do

`lambda_handler(event)` in `terraform/lambda/handler.py`:
1. If `event.action == "VALIDATE_SWEEP"` it is the EventBridge job, run `handle_validation_sweep`.
2. Otherwise `handle_request(event)` reads `method`, `rawPath`, `headers.origin`, and `queryStringParameters.userId`, then matches the route.
3. Any uncaught error returns `500 {"message": "Unable to process the request"}`.

CORS reply header `access-control-allow-origin` is set only if the request `origin` is in `CORS_ALLOW_ORIGINS`.

### 2.4 The DynamoDB table (one table, several item types)

Table `<project>-<env>-requests`, hash key `request_id`, pay-per-request, encryption and point-in-time recovery on.

| GSI | Keys | Used for |
|---|---|---|
| `submitted-by-created-at` | `submitted_by_id` + `createdAt` | My Requests list (by user), Q&A list (partition `QNA`) |
| `market-code-created-at` | `market_code` + `createdAt` | Find the oldest `QUEUED` request of a market |

| Item `request_id` looks like | What it is | Written by |
|---|---|---|
| `REQ-1A2B3C4D` | A whitelist request (payload, status, history, `target_stages`, `stage_index`, `pr_dev/pr_qa/pr_master`) | Main Lambda; GitOps Lambda updates failure info |
| `MARKETLOCK#<MARKET>` | The per-market "one active request" lock (`held_request_id`, `claimed_at`) | Main Lambda |
| `LOCK#<MARKET>#<BRANCH>` | A promotion claim for a market to `QA` or `MASTER` (`request_ids`, `promotion_id`, `status`, `pr_id`) | Main creates, GitOps updates |
| `PR#<id>` | Lookup from a Bitbucket PR id to the requests riding on it | GitOps Lambda |
| `QNA#<uuid>` | A Q&A question with its comments (`submitted_by_id = "QNA"`) | Main Lambda |

### 2.5 Secrets (the complete list)

| Secret | Created where | Read by | Name comes from | Content | IAM that allows it |
|---|---|---|---|---|---|
| **Bitbucket token** | You create it in Secrets Manager; Terraform only looks it up (`data.aws_secretsmanager_secret.bitbucket_token`) | **GitOps Lambda**, at the start of **every** invocation | Terraform var `bitbucket_token_secret_name` (default `bitbucket-token`). **The Lambda code uses the literal `SecretId="bitbucket-token"`**, so the secret name must match it. | Plain string = Bitbucket HTTP access token, sent as `Authorization: Bearer <token>` | `aws_iam_role_policy.gitops_lambda`: `secretsmanager:GetSecretValue` on that secret ARN |
| **Confluence service account** | You create it | **Main Lambda**, only for `GET /dpc/troubleshoot/confluence` | Terraform var `confluence_secret_id` (name or full ARN) -> env `CONFLUENCE_SECRET_ID` | JSON `{"username","api_token"}` (Basic) or `{"token"}` / bare string (Bearer). Key aliases: `username/user/email`, `api_token/apiToken/token/pat/password` | `aws_iam_role_policy.confluence_secret_read` (only created when `confluence_secret_id != ""`). Add KMS decrypt if the secret uses a customer-managed key. |

Nothing else is a secret. In particular:
- **The main Lambda does not hold a Bitbucket token.**
- **Cross-account AWS access uses `sts:AssumeRole`**, so there are no stored AWS keys.
- **The Microsoft sign-in has no client secret** (it is a browser, public-client flow).
- The org's Azure AD group-fetch Lambda has its own credentials, but it lives outside this repo.

### 2.6 Environment variables of the two Lambdas

**Main Lambda (`request_api`)** set in `terraform/main.tf`:

| Env var | Terraform source | Used for |
|---|---|---|
| `DYNAMODB_TABLE` | `aws_dynamodb_table.requests.name` | The table (required, Lambda fails to start without it) |
| `CORS_ALLOW_ORIGINS` | `jsonencode(var.cors_allow_origins)` | Which browser origins get a CORS header |
| `GITOPS_LAMBDA_NAME` | `aws_lambda_function.gitops.function_name` | Which Lambda to invoke for Git work |
| `AZURE_AD_GROUP_FETCH_LAMBDA_NAME` | `var.azure_ad_group_fetch_lambda_name` (default `azure_ad_group_fetch`) | `GET /dpc/access`, Q&A admin check, market-admin check |
| `PORTAL_ADMIN_EMAILS` | `join(",", var.portal_admin_emails)` | The only list of real admins. An AD admin not on it becomes role `developer`. Empty = every AD admin stays admin. |
| `QNA_ADMIN_EMAILS` | `join(",", var.qna_admin_emails)` | Who gets e-mailed for new questions; also counts as admin when answering Q&A (but **not** for onboarding a market) |
| `PORTAL_BASE_URL` | `var.portal_base_url`, else first of `cors_allow_origins` | Link to the question thread in e-mails |
| `DOMAIN` | `var.domain` | SES sender is `noreply@<DOMAIN>`. Empty = no e-mails are sent. |
| `BITBUCKET_URL`, `PROJECT_KEY`, `REPO_NAME` | `var.bitbucket_url`, `var.project_key`, `var.repo_name` | **Only** to build the "view PR" link (`<url>/projects/<key>/repos/<repo>/pull-requests/<id>/overview`) |
| `MARKET_LOCK_STALE_SECONDS` | `var.market_lock_stale_seconds` (default 86400) | A market lock older than this is treated as abandoned |
| `AWS_ACCOUNT_ID_DEV/QA/PRD` | `var.aws_account_id_dev/qa/prd` | Build the agent role ARN to verify |
| `AWS_VALIDATION_ROLE_ARN_DEV/QA/PRD` | `local.validation_role_arn_*` (from `var.aws_validation_role_arn_*` or the same-account validator role in `validator_role.tf`) | Role assumed to read the agent role's IAM policy |
| `CONFLUENCE_PAGE_URLS` | `join(",", var.confluence_page_urls)` | Pages to read (https only) |
| `CONFLUENCE_SECRET_ID` | `var.confluence_secret_id` | Secret to read |
| `CONFLUENCE_API_BASE_URL` | `var.confluence_api_base_url` | Optional override of the REST base |
| `CONFLUENCE_CACHE_SECONDS` | `var.confluence_cache_seconds` (default 900, minimum 60 in code) | In-memory cache time |
| `MAX_VERIFICATION_ATTEMPTS` | not set by Terraform; code default `144` | Log warning after this many failed verifications |

**GitOps Lambda (`gitops`)**:

| Env var | Terraform source | Used for |
|---|---|---|
| `DYNAMODB_TABLE` | table name | Promotion locks, `PR#` items, failure marks |
| `BITBUCKET_URL` | `var.bitbucket_url` | Bitbucket base URL |
| `PROJECT_KEY` | `var.project_key` | Bitbucket project key |
| `REPO_NAME` | `var.repo_name` | Repository slug |
| `REPO_BASE_PATH` | `var.repo_base_path` | Folder in the repo that holds one folder per market |
| `PR_APPROVER_EMAILS` | `join(",", var.pr_approver_emails)` | Who is e-mailed when a PR needs review |
| `DOMAIN` | `var.domain` | SES sender `noreply@<DOMAIN>` |

Hard-coded in the GitOps code (not variables): `SOURCE_BRANCH = "dev"`, `ENV_TO_BRANCH = {dev: dev, qa: qa, prd: master}`, secret id `"bitbucket-token"`, AWS region `eu-west-1` for Secrets Manager/SES/DynamoDB clients, retry policy `3 attempts, back-off 2 s then 5 s, on HTTP 429/500/502/503/504`.

### 2.7 IAM in short

| Role | Allowed |
|---|---|
| Main Lambda role `aws_iam_role.lambda` | DynamoDB (Put/Get/Query/Update/Delete/Scan on the table and both GSIs); `lambda:InvokeFunction` on the GitOps Lambda and on the Azure AD group-fetch Lambda; `sts:AssumeRole` on `arn:aws:iam::*:role/dpc-portal-validator`; SES send; CloudWatch logs; Confluence secret read (conditional) |
| GitOps role `aws_iam_role.gitops_lambda` | `secretsmanager:GetSecretValue` on the Bitbucket token secret; DynamoDB Get/Put/Update/Scan; SES send; CloudWatch logs; `sqs:SendMessage` on the DLQ (if `enable_gitops_dlq`) |

### 2.8 Status values you will see

| Status | Meaning | Set by |
|---|---|---|
| `QUEUED` | Another request for the same market is active | Main, on submit |
| `REQUEST_RECEIVED` | Saved, GitOps triggered | Main, on submit or when promoted from the queue |
| `SYNC_FAILED` | GitOps could not reach Bitbucket after retries | GitOps `_report_failure` |
| `PR_CREATED` / `PR_UPDATED` / `PR_APPROVED` / `PR_NEEDS_WORK` | Bitbucket events on the PR | Main, from webhook |
| `DEV_MERGED_AWAITING_QA`, `QA_MERGED_AWAITING_MASTER` | Merged at a stage, waiting for the next promotion | Main, on `pr:merged` |
| `PENDING_AWS_VERIFICATION` | Last PR merged; waiting for IAM proof | Main, on the final `pr:merged` |
| `COMPLETED` | IAM policy confirmed | Main, `VALIDATE_SWEEP` |
| `PR_DECLINED` / `PR_DELETED` | PR rejected or removed (ends the request) | Main, from webhook |
| `CANCELLED` | Requester cancelled before the dev merge | Main, `/cancel` |

---

## 3. Flow 1 - Sign-in

| | |
|---|---|
| **Trigger** | User opens the portal; `AuthProvider` runs `instance.loginRedirect(loginRequest)` |
| **Goes to** | Microsoft Entra ID (not the portal API) |
| **Frontend vars** | `VITE_CLIENT_ID`, `VITE_TENANT_ID`, `VITE_REDIRECT_URI` |
| **Backend vars / secrets** | None |

Steps:
1. MSAL redirects to `https://login.microsoftonline.com/<VITE_TENANT_ID>` with client `VITE_CLIENT_ID` and scope `User.Read`.
2. After sign-in, MSAL returns to `VITE_REDIRECT_URI`. `AuthProvider` builds the user object (`id`, `email`, `name`, token `roles`).
3. Right after, the access lookup in Flow 2 starts.

---

## 4. Flow 2 - Who am I? `GET /dpc/access`

| | |
|---|---|
| **Frontend** | `accessService.getAccess(email)` -> `GET {VITE_API_BASE_URL}/access?email=<email>` (called from `AuthProvider`) |
| **Route** | `GET /dpc/access` |
| **Env vars used** | `AZURE_AD_GROUP_FETCH_LAMBDA_NAME`, `PORTAL_ADMIN_EMAILS` |
| **Secrets** | None here (the called Lambda has its own, outside this repo) |
| **IAM** | `lambda:InvokeFunction` on the Azure AD group-fetch Lambda |
| **DynamoDB** | None |

Steps:
1. Main Lambda checks `email` is present, else `400`. If `AZURE_AD_GROUP_FETCH_LAMBDA_NAME` is empty, `503`.
2. It invokes that Lambda **synchronously** with `{"email": "<email>"}`.
3. The reply is a raw Lambda response `{"statusCode": 200, "body": "<json string>"}`. The main Lambda unwraps `body`, which looks like `{"email": "...", "access": {"role": "admin|user", "markets": ..., "environments": ...}}`.
4. **Admin allow-list** (`_apply_admin_allowlist`): if `PORTAL_ADMIN_EMAILS` is not empty and the role is `admin` but the e-mail is not in the list, the role is changed to **`developer`**. It can only demote, never promote.
5. Response `200` goes back. The frontend (`normalizeAccess`) converts it. `canMutate` is true only when this call succeeded (`accessStatus = loaded`). On failure the app is **read-only**.

Frontend uses of the result: `hasRole(ADMIN)`, `hasMarketAccess(market)`, `hasEnvironmentAccess(market, env)`, sidebar (Onboard Market is shown only to admins).

---

## 5. Flow 3 - Market list `GET /dpc/markets`

| | |
|---|---|
| **Frontend** | `useMarkets()` -> `marketService.getMarkets()` -> `GET /markets`. Used by Create Request, View Whitelist, Onboard Market |
| **Route** | `GET /dpc/markets` (Markets section of `main.tf`) |
| **Main env vars** | `GITOPS_LAMBDA_NAME` |
| **GitOps env vars** | `BITBUCKET_URL`, `PROJECT_KEY`, `REPO_NAME`, `REPO_BASE_PATH` |
| **Secret** | Bitbucket token (read by the GitOps Lambda) |
| **Frontend vars** | `VITE_AVAILABLE_MARKETS` (display names and fallback only) |

Steps:
1. Main Lambda has a 60 s in-memory cache (`MARKETS_CACHE_SECONDS`). If fresh, it answers at once.
2. Otherwise it invokes the GitOps Lambda **synchronously** with `{"action": "LIST_MARKETS"}`.
3. GitOps reads the token from Secrets Manager (`bitbucket-token`), then calls Bitbucket: `GET {BITBUCKET_URL}/rest/api/latest/projects/{PROJECT_KEY}/repos/{REPO_NAME}/files/{REPO_BASE_PATH}?at=refs/heads/dev` (paged). It keeps every direct sub-folder that holds a `values*.yaml` file.
4. Reply `{"markets": ["DE","UK", ...]}` (upper-case, sorted).
5. Frontend maps codes to names (`VITE_AVAILABLE_MARKETS` name, else country name for 2-letter ISO codes, else the code). On any error it **falls back** to `VITE_AVAILABLE_MARKETS` and shows a warning.

Errors: `503` if `GITOPS_LAMBDA_NAME` is empty; `502` if GitOps or Bitbucket fails.

---

## 6. Flow 4 - What is whitelisted now `GET /dpc/whitelist/{market}/{env}`

| | |
|---|---|
| **Frontend** | `requestService.getCurrentWhitelist(market, env)` -> `GET /whitelist/<market lower>/<env lower>`. Create Request fetches DEV, QA, PRD when a market is chosen; View Whitelist does the same |
| **Route** | `GET /dpc/whitelist/{market_code}/{environment}` |
| **Main env vars** | `GITOPS_LAMBDA_NAME` |
| **GitOps env vars** | `BITBUCKET_URL`, `PROJECT_KEY`, `REPO_NAME`, `REPO_BASE_PATH` |
| **Secret** | Bitbucket token |

Steps:
1. Main Lambda invokes GitOps **synchronously**: `{"action": "GET_WHITELIST", "market_code": "uk", "environment": "dev"}`.
2. GitOps maps environment to branch (`dev -> dev`, `qa -> qa`, `prd -> master`), reads the raw file `{REPO_BASE_PATH}/{market}/values.{env}.yaml` from that branch (`GET .../raw/<path>?at=refs/heads/<branch>`), parses the YAML.
3. A `404` (file does not exist) is **not an error**: it returns `exists: false` with four empty lists.
4. Reply: `{marketCode, environment, filePath, exists, buckets[], secrets[], kmsKeys[], functions[]}`.

Frontend use: Create Request shows these under each input with the cross mark, and blocks adding something already live. View Whitelist shows them side by side and builds the agent role ARN from `VITE_AWS_ACCOUNT_ID_DEV|QA|PRD` (`arn:aws:iam::<acct>:role/matillion-dpc-<env>-agent-<market>-irsa`).

---

## 7. Flow 5 - Submit a request `POST /dpc/request` (the main flow)

### 7.1 Browser side

| | |
|---|---|
| **Page** | `CreateRequestPage` -> `requestService.createRequest(form, submittedBy, requestType)` -> `apiGatewayService.submitRequest` -> `POST /request` |
| **Frontend vars** | `VITE_API_BASE_URL`, `VITE_API_TIMEOUT`; `VITE_POLICY_TEMPLATE_S3 / _SECRETS / _KMS / _LAMBDA` (policy preview only) |

The page checks: market chosen, justification not empty, at least one change. `requestType` is derived: only adds `WHITELIST`; only removals `DEWHITELIST`; both `COMBINED`.

Payload sent (`transformToApiGatewayPayload`):

```json
{
  "request_id": "REQ-1A2B3C4D",
  "market_code": "uk",
  "market_name": "United Kingdom",
  "business_justification": "...",
  "submitted_by": { "id": "<localAccountId>", "name": "...", "email": "..." },
  "request_type": "COMBINED",
  "environments": {
    "dev": {
      "buckets": ["new-bucket"],
      "secrets": ["arn:aws:secretsmanager:..."],
      "kmsKeys": [], "functions": [],
      "remove": { "buckets": ["old-bucket"] }
    },
    "qa": { "...": "..." }
  }
}
```
`request_type` is left out for a plain whitelist. Empty lists are removed. `remove` exists only for `COMBINED`.

### 7.2 Main Lambda (`handle_request`, route `POST /dpc/request`)

| | |
|---|---|
| **Env vars** | `DYNAMODB_TABLE`, `GITOPS_LAMBDA_NAME` |
| **DynamoDB** | `PutItem` on `MARKETLOCK#<MARKET>` (conditional), `PutItem` on the request (conditional) |
| **IAM** | DynamoDB, `lambda:InvokeFunction` on GitOps |

Steps:
1. Parse the body. Missing `request_id`, `submitted_by.id`, `market_code` or `environments` gives `400`.
2. `_validate_request_payload`: `request_type` must be `WHITELIST|DEWHITELIST|COMBINED`; `remove` only with `COMBINED` and only lists of strings; the same resource cannot be in add and remove (case-insensitive); `COMBINED` needs at least one removal. Else `400` with the reason.
3. `compute_target_stages`: from the environments asked: `dev` only -> `["dev"]`; with `qa` -> `["dev","qa"]`; with `prd` -> `["dev","qa","master"]`.
4. **Market lock**: conditional put of `MARKETLOCK#<MARKET>` (`held_request_id = request_id`). If it succeeded the status is `REQUEST_RECEIVED`, else `QUEUED`. A lock older than `MARKET_LOCK_STALE_SECONDS` is force-released and re-claimed.
5. Put the request item (condition `attribute_not_exists(request_id)`): `status`, `market_code` (upper), `payload`, `target_stages`, `stage_index = -1`, `history[0]`. A duplicate id gives `409` and the lock is released.
6. If the lock was claimed: `trigger_gitops` -> `lambda.invoke(InvocationType="Event")` with `{"request_id", "action": "CREATE_PR", "payload"}`. This is **fire-and-forget**. If queued, nothing is triggered now.
7. Reply `201 {"requestId", "status", "message"}`. The browser shows the new request.

### 7.3 GitOps Lambda - `CREATE_PR` (runs a few seconds later)

| | |
|---|---|
| **Env vars** | `BITBUCKET_URL`, `PROJECT_KEY`, `REPO_NAME`, `REPO_BASE_PATH`, `PR_APPROVER_EMAILS`, `DOMAIN`, `DYNAMODB_TABLE` |
| **Secret** | Bitbucket token (read at the start of every invocation; empty token is an error) |
| **Hard-coded** | source branch `dev`; branch name `gitops/<request_id>` |
| **IAM** | Secrets read, DynamoDB (failure marking), SES |

Steps and the Bitbucket REST call behind each:

| # | What | Bitbucket call (`{base}` = `{BITBUCKET_URL}/rest/api/latest/projects/{PROJECT_KEY}/repos/{REPO_NAME}`) |
|---|---|---|
| 1 | Get latest commit of `dev` | `GET {base}/branches?filterText=dev` |
| 2 | Create branch `gitops/<id>` from it (a `409 already exists` is treated as success) | `POST {base}/branches` |
| 3 | For each environment in the payload, read `{REPO_BASE_PATH}/{market}/values.{env}.yaml` from the new branch | `GET {base}/raw/<path>?at=refs/heads/gitops/<id>` |
| 4 | Apply the change in memory (`update_yaml_data`, ruamel keeps comments/format): `WHITELIST` appends missing values; `DEWHITELIST` removes the listed values; `COMBINED` appends the env lists and then removes `remove.*` | - |
| 5 | Commit each changed file (message `GitOps update for <id> (requested by <name> <email>)`) | `GET {base}/commits?path=<file>&until=...` for the file's last commit, then `PUT {base}/browse/<path>` |
| 6 | Open the PR into `dev`. Title: `GitOps Update gitops/<id>`, or `[De-whitelist] ...`, or `[Whitelist + De-whitelist] ...` | `POST {base}/pull-requests` (a `409` duplicate returns the existing PR) |
| 7 | E-mail `PR_APPROVER_EMAILS` the PR link (skipped if either `PR_APPROVER_EMAILS` or `DOMAIN` is empty) | SES `SendEmail` from `noreply@<DOMAIN>` |

Each Bitbucket call goes through `_request_with_retry`: 3 attempts, waits 2 s and 5 s, retries on network errors and HTTP 429/500/502/503/504.

**If it still fails:** the Lambda marks the request `SYNC_FAILED` (with `last_sync_error`, `sync_failure_count`), re-raises so Lambda's own async retries run, and an exhausted event goes to the DLQ (if `enable_gitops_dlq`). The scheduled sweep (Flow 11) retries it.

### 7.4 Bitbucket webhook comes back `POST /dpc/bitbucket/webhook`

Bitbucket must have a webhook on the repository pointing to `<api>/dpc/bitbucket/webhook` for pull-request events (opened, modified, reviewer approved, needs work, merged, declined, deleted).

| | |
|---|---|
| **Env vars** | `DYNAMODB_TABLE`, `GITOPS_LAMBDA_NAME`, `DOMAIN` (requester e-mail) |
| **Secrets** | None. The webhook is **not authenticated** (no shared secret), see section 19. |
| **DynamoDB** | Get/Update request items, delete/put lock items, `PR#<id>` lookups |

Steps (`handle_webhook` then `handle_stage_event`):
1. Read `eventKey` and the PR's source branch.
2. Branch `gitops/REQ-xxxx` -> it is a request's own PR into `dev`: the request id is taken from the branch name. Any other branch (a promotion PR) -> look up `PR#<pr id>` in DynamoDB to get the linked request ids. No match -> `200 ignored`. (Market onboarding PRs fall in this "ignored" group.)
3. Not a merge event: map to a status (`pr:opened -> PR_CREATED`, `pr:modified -> PR_UPDATED`, `pr:reviewer:approved -> PR_APPROVED`, `pr:reviewer:needs_work -> PR_NEEDS_WORK`, `pr:declined -> PR_DECLINED`, `pr:deleted -> PR_DELETED`), append to `history`, store the PR id (`pr_dev`, `pr_qa` or `pr_master`). A late event for a stage already merged does **not** move the status backwards. Declined or deleted ends the request and releases the market lock.
4. `pr:merged`: `advance_stage` increments `stage_index`.
   - **Not the last stage:** status `DEV_MERGED_AWAITING_QA` (or `QA_MERGED_AWAITING_MASTER`), then the promotion in section 7.5 starts.
   - **Last stage:** status `PENDING_AWS_VERIFICATION`; the **market lock is released** (the git side is finished) and the next queued request of that market starts (`_promote_next_queued` -> `trigger_gitops`).

### 7.5 Promotion to the next environment (`PROMOTE`)

Triggered by 7.4 after a non-final merge.

| | |
|---|---|
| **Main** | `trigger_promotion`: conditional put of `LOCK#<MARKET>#<QA or MASTER>`. If it already exists the request just joins it (no second PR). Else invoke GitOps (Event) with `{"action":"PROMOTE","promotion_id","from_branch","to_branch","lock_key"}` |
| **GitOps** | `handle_promote`: `POST {base}/pull-requests` from `dev` to `qa` (or `qa` to `master`), **no new commits**; writes/merges the `PR#<id>` item (`request_ids`, `lock_keys`); sets `pr_qa`/`pr_master` on each linked request; e-mails `PR_APPROVER_EMAILS` |
| **Same secret/vars as 7.3** | Bitbucket token, `BITBUCKET_URL`, `PROJECT_KEY`, `REPO_NAME`, `PR_APPROVER_EMAILS`, `DOMAIN` |

Because `dev`, `qa` and `master` are shared by all markets, Bitbucket allows only one open PR per branch pair, so several markets can ride on **one** promotion PR. The `PR#<id>` item lists all of them. When that PR merges or is declined, every linked request is updated and all their `LOCK#` items are removed.

### 7.6 AWS verification (end of the pipeline) - see Flow 10.

---

## 8. Flow 6 - My Requests and Dashboard `GET /dpc/listrequests`

| | |
|---|---|
| **Frontend** | `getAllRequests(user.id)`, `getDashboardStats(user.id)`, `getRecentRequests(user.id)` -> `GET /listrequests?userId=<id>` |
| **Env vars** | `DYNAMODB_TABLE`, `BITBUCKET_URL`, `PROJECT_KEY`, `REPO_NAME` (PR links) |
| **DynamoDB** | `Query` on GSI `submitted-by-created-at`, newest first, all pages |

Steps: `400` if `userId` is missing; `400` if it equals the reserved `QNA`; query the user's items; add `targetEnvironment`, `currentStage`, `prs`, `prUrls` (`stage_summary`) to each; reply `{count, requests}`. The Dashboard counts statuses in the browser.

## 9. Flow 7 - One request `GET /dpc/requests/{request_id}`

| | |
|---|---|
| **Frontend** | `getRequestById(id, user.id)` -> `GET /requests/<id>?userId=<id>` (also called again after cancel, release-lock and retry) |
| **Env vars / DynamoDB** | As above; plus `GetItem` on `MARKETLOCK#<MARKET>` when the request is `QUEUED` |

Steps: `400` without `userId`; `GetItem`; the item must have `submitted_by_id == userId`, else `404` (a user can only read their own requests). The reply is `frontend_request(item)` (resources and, for combined requests, `removals`) + `stage_summary` + `history` + `blockedBy` (the request currently holding the market lock, when `QUEUED`).

## 10. Flow 8 - Cancel `POST /dpc/requests/{request_id}/cancel`

| | |
|---|---|
| **Frontend** | `cancelRequest(id, user.id, reason?)` -> `POST /requests/<id>/cancel?userId=<id>` body `{"reason"}` |
| **Env vars** | `DYNAMODB_TABLE`, `GITOPS_LAMBDA_NAME` |

Steps:
1. Owner check (`submitted_by_id == userId`, else `404`).
2. Refused with `400` if `stage_index >= 0` (already merged to dev) or the status is final.
3. `_update_item(... "CANCELLED")`. If the status changed meanwhile, `409`.
4. `_release_and_forward_market_lock` (the next queued request starts).
5. `trigger_cancel`: invoke GitOps (Event) `{"action": "CANCEL"}`. GitOps finds the open PR `gitops/<id> -> dev`, **declines** it, and **deletes the branch** (both are safe no-ops if they do not exist). Uses the Bitbucket token. A failure here is logged only; the request is already cancelled.

## 11. Flow 9 - Admin recovery actions

Both are shown only to admins in the UI. **The backend does not check the caller's role** for these two routes (see section 13).

| Action | Frontend | Route | What it does | Vars |
|---|---|---|---|---|
| Release market lock | `releaseMarketLock(id)` -> `POST /requests/<id>/release-lock` | `POST /dpc/requests/{request_id}/release-lock` | Force-delete `MARKETLOCK#<MARKET>` and start the next queued request | `DYNAMODB_TABLE`, `GITOPS_LAMBDA_NAME` |
| Retry promotion | `retryPromotion(id)` -> `POST /requests/<id>/retry-promotion` | `POST /dpc/requests/{request_id}/retry-promotion` | For a request stuck at `*_MERGED_AWAITING_*`: delete its dead `LOCK#<MARKET>#<BRANCH>` (and the `PR#<id>` lookup), then claim a clean lock and open a fresh promotion PR via GitOps | `DYNAMODB_TABLE`, `GITOPS_LAMBDA_NAME` |

## 12. Flow 10 - AWS verification (EventBridge `VALIDATE_SWEEP`)

| | |
|---|---|
| **Trigger** | EventBridge rule `<name>-aws-verification-sweep`, `schedule = var.verification_sweep_schedule_expression` (default `rate(10 minutes)`), input `{"action":"VALIDATE_SWEEP"}` |
| **Env vars** | `DYNAMODB_TABLE`, `AWS_ACCOUNT_ID_DEV/QA/PRD`, `AWS_VALIDATION_ROLE_ARN_DEV/QA/PRD`, `DOMAIN`, `MAX_VERIFICATION_ATTEMPTS` |
| **Secrets** | None. Uses `sts:AssumeRole` with a 900 s session named `dpc-portal-verify`. |
| **IAM** | Main role: `dynamodb:Scan`, `sts:AssumeRole` on `arn:aws:iam::*:role/dpc-portal-validator`, SES. Validator role in each account: `iam:GetRole`, `ListRolePolicies`, `ListAttachedRolePolicies`, `GetRolePolicy`, `GetPolicy`, `GetPolicyVersion` for `matillion-dpc-*-agent-*-irsa` (from `validator_role.tf` or `validator_role_cross_account/`) |

Steps (`handle_validation_sweep`):
1. Scan the table for `status = PENDING_AWS_VERIFICATION`.
2. For each request and each environment in its payload:
   - Role ARN: `arn:aws:iam::<AWS_ACCOUNT_ID_ENV>:role/matillion-dpc-<env>-agent-<market>-irsa`. No account id gives "skipped".
   - Assume `AWS_VALIDATION_ROLE_ARN_<ENV>`. Empty or failing gives "skipped".
   - Read every Allow `Resource` from the role's inline and attached policies.
   - `WHITELIST`: every requested ARN must be covered. `DEWHITELIST`: none may be covered. `COMBINED`: adds covered **and** removals not covered. (Bucket names are turned into `arn:aws:s3:::name` and `arn:aws:s3:::name/*`.)
3. All environments `True` -> status `COMPLETED`, history entry "AWS access verification confirmed", and the requester e-mail goes out (`notify_requester_merged`, from `noreply@<DOMAIN>`).
4. Otherwise the request stays pending; `verificationAttempts`, `lastVerificationAttemptAt` and `lastVerificationDetail` (per-environment true/false/null) are recorded so the cause is visible.

## 13. Flow 11 - Retry sweep (EventBridge `SWEEP`, GitOps Lambda)

| | |
|---|---|
| **Trigger** | Rule `<name>-gitops-sweep`, `var.sweep_schedule_expression` (default `rate(10 minutes)`), input `{"action":"SWEEP"}` |
| **Vars / secret** | Same as 7.3 (Bitbucket token, `BITBUCKET_URL`, `PROJECT_KEY`, `REPO_NAME`, `REPO_BASE_PATH`, `DYNAMODB_TABLE`) |

Steps: scan for `SYNC_FAILED` requests older than 10 minutes with fewer than 5 failures and run `handle_create_pr` again; scan for `LOCK#` items that are `FAILED`, or `CLAIMING` without a PR, and run the promotion again. It stops early when less than 30 s of Lambda time remains.

---

## 14. Flow 12 - Onboard a market `POST /dpc/markets` (admin)

| | |
|---|---|
| **Frontend** | `OnboardMarketPage` -> `marketService.onboardMarket(code, user.email)` -> `POST /markets` body `{"market_code","email"}` |
| **Main env vars** | `PORTAL_ADMIN_EMAILS`, `AZURE_AD_GROUP_FETCH_LAMBDA_NAME`, `GITOPS_LAMBDA_NAME` |
| **GitOps env vars** | `BITBUCKET_URL`, `PROJECT_KEY`, `REPO_NAME`, `REPO_BASE_PATH`, `PR_APPROVER_EMAILS`, `DOMAIN` |
| **Secret** | Bitbucket token |

Steps:
1. Main validates the code (`^[a-z0-9][a-z0-9_-]{0,31}$`, stored lower-case) -> `400`.
2. **Admin check** `_is_portal_admin(email)`: on `PORTAL_ADMIN_EMAILS`, or the group-fetch Lambda says admin (after the allow-list). `QNA_ADMIN_EMAILS` does **not** count. Else `403`.
3. Invoke GitOps **synchronously** `{"action":"ONBOARD_MARKET","market_code","requested_by":{"email"}}`.
4. GitOps lists the market folders on `dev`, `qa` and `master` in parallel. Where the market is missing it (in parallel, per branch): creates `gitops/onboard-<market>-<branch>` from that branch, commits `<REPO_BASE_PATH>/<market>/values.yaml`, `values.dev.yaml`, `values.qa.yaml`, `values.prd.yaml` (empty `buckets/secrets/kmsKeys/functions`), opens a PR `[Onboard market] <CODE> -> <branch>`, then e-mails `PR_APPROVER_EMAILS`.
5. Replies: `201` with the PR links; `409` if the market exists everywhere; `502` if a branch failed (the other PRs are still returned). Re-running is safe.

## 15. Flow 13 - Troubleshooting page with Confluence `GET /dpc/troubleshoot/confluence`

| | |
|---|---|
| **Frontend** | `knowledgeService.getConfluencePages()` -> `GET /troubleshoot/confluence`. Merged into the built-in articles and the `VITE_TROUBLESHOOTING_*` entries by URL; search is in the browser (`fuzzySearch`). |
| **Frontend vars** | `VITE_TROUBLESHOOTING_CONFLUENCE_PAGES`, `VITE_TROUBLESHOOTING_INTERNAL_DOCS`, `VITE_TROUBLESHOOTING_MATILLION_DOCS`, `VITE_SUPPORT_TICKET_URL`, `VITE_SUPPORT_TICKET_LABEL` |
| **Main env vars** | `CONFLUENCE_PAGE_URLS`, `CONFLUENCE_SECRET_ID`, `CONFLUENCE_API_BASE_URL`, `CONFLUENCE_CACHE_SECONDS` |
| **Secret** | Confluence service account (Secrets Manager) |
| **Network** | Main Lambda is not in a VPC; it needs internet reach to the Confluence host |

Steps:
1. If `CONFLUENCE_PAGE_URLS` or `CONFLUENCE_SECRET_ID` is empty: `200 {"configured": false, "pages": []}`.
2. Serve from the in-memory cache while fresh (`CONFLUENCE_CACHE_SECONDS`, minimum 60); on failure serve the stale copy and retry after 60 s.
3. Read the secret (`secretsmanager:GetSecretValue`, cached 5 minutes) and build the header: `Basic base64(user:token)` or `Bearer token`.
4. For up to 20 configured URLs (5 threads, 6 s each, 20 s total) call the Confluence REST API: Cloud `https://<host>/wiki/rest/api/content/<id>?expand=body.storage`; Data Center uses the context path from the URL (`<host>/<context>/rest/api`). For `/display/<SPACE>/<Title>` links it looks the page up by `spaceKey` and `title` first. **Redirects are not followed**, so the credential never leaves the configured host.
5. Convert the HTML to plain text (max 8000 characters per page). Reply `{"configured": true, "pages": [{url, title, text}]}`. No credential is ever in the response.

## 16. Flow 14 - Q&A forum

| Frontend (`qnaService`) | Route | What it does |
|---|---|---|
| `list()` | `GET /dpc/qna` | Query GSI partition `QNA`, newest first (max 300) |
| `get(id)` | `GET /dpc/qna/{question_id}` | One thread with comments |
| `ask({title, body}, askedBy)` | `POST /dpc/qna` | Create `QNA#<uuid>` (title max 200, body max 5000). E-mails `QNA_ADMIN_EMAILS` with the link `PORTAL_BASE_URL/qna/<id>` |
| `addComment(id, body, author)` | `POST /dpc/qna/{question_id}/comments` | Append a comment (max 200). If the author is an admin (`_qna_is_admin`: in `QNA_ADMIN_EMAILS`, or admin from the group-fetch Lambda) the question becomes answered and the asker is e-mailed |

Env vars: `DYNAMODB_TABLE`, `QNA_ADMIN_EMAILS`, `PORTAL_ADMIN_EMAILS`, `AZURE_AD_GROUP_FETCH_LAMBDA_NAME`, `PORTAL_BASE_URL`, `DOMAIN`. No secrets. The admin lookup is cached 5 minutes per e-mail.

---

## 17. Route and variable cheat sheet

| Frontend call | Route | Lambda path | Reads these env vars | Secret |
|---|---|---|---|---|
| `GET /access` | `/dpc/access` | Main -> AD group-fetch Lambda | `AZURE_AD_GROUP_FETCH_LAMBDA_NAME`, `PORTAL_ADMIN_EMAILS` | - |
| `GET /markets` | `/dpc/markets` | Main -> GitOps -> Bitbucket | `GITOPS_LAMBDA_NAME`; GitOps: `BITBUCKET_URL`, `PROJECT_KEY`, `REPO_NAME`, `REPO_BASE_PATH` | Bitbucket token |
| `POST /markets` | `/dpc/markets` | Main -> GitOps -> Bitbucket, SES | + `PORTAL_ADMIN_EMAILS`, `AZURE_AD_GROUP_FETCH_LAMBDA_NAME`; GitOps: `PR_APPROVER_EMAILS`, `DOMAIN` | Bitbucket token |
| `GET /whitelist/{m}/{e}` | `/dpc/whitelist/{market_code}/{environment}` | Main -> GitOps -> Bitbucket | as `GET /markets` | Bitbucket token |
| `POST /request` | `/dpc/request` | Main -> DynamoDB -> GitOps (async) -> Bitbucket, SES | Main: `DYNAMODB_TABLE`, `GITOPS_LAMBDA_NAME`; GitOps: all Bitbucket vars, `PR_APPROVER_EMAILS`, `DOMAIN` | Bitbucket token |
| Bitbucket webhook | `/dpc/bitbucket/webhook` | Main -> DynamoDB (-> GitOps async for promotion, SES) | `DYNAMODB_TABLE`, `GITOPS_LAMBDA_NAME`, `DOMAIN` | none |
| `GET /listrequests` | `/dpc/listrequests` | Main -> DynamoDB | `DYNAMODB_TABLE`, `BITBUCKET_URL`, `PROJECT_KEY`, `REPO_NAME` | - |
| `GET /requests/{id}` | `/dpc/requests/{request_id}` | Main -> DynamoDB | same | - |
| `POST /requests/{id}/cancel` | `/dpc/requests/{request_id}/cancel` | Main -> DynamoDB -> GitOps (async) -> Bitbucket | `DYNAMODB_TABLE`, `GITOPS_LAMBDA_NAME` | Bitbucket token (GitOps) |
| `POST /requests/{id}/release-lock` | `/dpc/requests/{request_id}/release-lock` | Main -> DynamoDB (-> GitOps) | `DYNAMODB_TABLE`, `GITOPS_LAMBDA_NAME` | - |
| `POST /requests/{id}/retry-promotion` | `/dpc/requests/{request_id}/retry-promotion` | Main -> DynamoDB -> GitOps | same | Bitbucket token (GitOps) |
| `GET /troubleshoot/confluence` | `/dpc/troubleshoot/confluence` | Main -> Secrets Manager -> Confluence | `CONFLUENCE_*` | Confluence service account |
| Q&A (4 routes) | `/dpc/qna...` | Main -> DynamoDB, SES, AD Lambda | `QNA_ADMIN_EMAILS`, `PORTAL_ADMIN_EMAILS`, `PORTAL_BASE_URL`, `DOMAIN` | - |
| EventBridge `VALIDATE_SWEEP` | - | Main -> DynamoDB, STS, IAM | `AWS_ACCOUNT_ID_*`, `AWS_VALIDATION_ROLE_ARN_*` | - (AssumeRole) |
| EventBridge `SWEEP` | - | GitOps -> DynamoDB, Bitbucket | Bitbucket vars | Bitbucket token |

---

## 18. Differences in the other two stacks

| Stack | Difference |
|---|---|
| `terraform/` | This document. Bitbucket Server, `$default` stage, Lambda zips built by Terraform. |
| `terraform-org/` | Named API stage `dpc`, so route keys have **no** `/dpc` prefix (`POST /request`), and `VITE_API_BASE_URL` already ends in `/dpc`. Uses the same handler code, but from a pre-built zip (`lambda_filename`) so rebuild the zip after code changes. Variables are named with `var.tags`, `var.account_id`. Some variables may carry your organisation's own prefix. |
| `terraform-personal/` | Personal test stack. The GitOps Lambda talks to **GitHub** instead of Bitbucket: env vars `GITHUB_API_URL`, `GITHUB_OWNER`, `GITHUB_REPO`, `REPO_BASE_PATH`; the secret holds a GitHub token (`Authorization: Bearer`); the webhook route is `POST /dpc/github/webhook` (GitHub pull-request events mapped to the same statuses); the main Lambda uses `GITHUB_OWNER`, `GITHUB_REPO` (and optional `GITHUB_URL`) only for PR links. Everything else is the same. |

---

## 19. Things to know (honest list)

1. **The API has no server-side authentication.** The browser sends `userId`/`email` and the backend trusts it. Ownership checks (`/requests/{id}`, `/cancel`) compare against the `userId` the browser sent. A caller who knows another user's id can read that user's requests.
2. **Admin-only routes are gated in the UI, not on the server**: `release-lock` and `retry-promotion` do not check the role. The market onboarding route (`POST /markets`) and the Q&A admin answer **do** check the role on the server, but from the e-mail the browser sends.
3. **The Bitbucket webhook is not authenticated.** Anyone who knows the URL can send events. Restrict it with a network rule or add a shared-secret check later.
4. **The Bitbucket secret name is hard-coded** in the GitOps code as `bitbucket-token`. If you change `bitbucket_token_secret_name`, change the code too.
5. **The GitOps Lambda uses region `eu-west-1`** in code for Secrets Manager, SES and DynamoDB clients, regardless of `var.aws_region`.
6. **E-mails need `DOMAIN`** (and a verified SES identity). Without it, approvers and requesters get no e-mail; the flow still works.
7. **The AWS verification stays pending** if `AWS_ACCOUNT_ID_<ENV>` or `AWS_VALIDATION_ROLE_ARN_<ENV>` is empty for an environment the request targets.
8. **Confluence text is readable by anyone who can call the API**, since the endpoint is open. Keep the page list limited to content that is fine for portal users.

## 20. Quick debugging map

| Symptom | Look at |
|---|---|
| Market list shows a warning / old list | CloudWatch log of the GitOps Lambda for `LIST_MARKETS`; `BITBUCKET_URL`, `PROJECT_KEY`, `REPO_NAME`, `REPO_BASE_PATH`; the Bitbucket token secret |
| Request stays `REQUEST_RECEIVED` | GitOps log for `CREATE_PR`; `GITOPS_LAMBDA_NAME`; token secret; wait for `SYNC_FAILED` + sweep |
| `SYNC_FAILED` | `last_sync_error` on the item; Bitbucket availability; token expiry |
| `QUEUED` for long | Another request of the same market is active (`blockedBy`); admin can release the lock |
| Never reaches `PR_CREATED` | Webhook not configured or blocked; check Bitbucket webhook delivery log and the main Lambda log |
| Stuck at `*_MERGED_AWAITING_*` | `LOCK#<MARKET>#<BRANCH>` item and GitOps `PROMOTE` log; admin "Retry promotion" |
| Stuck at `PENDING_AWS_VERIFICATION` | `lastVerificationDetail` on the item; `AWS_ACCOUNT_ID_*`, `AWS_VALIDATION_ROLE_ARN_*`; trust policy of `dpc-portal-validator`; whether the agent has picked up the new config |
| No e-mails | `DOMAIN`, SES verified identity, `PR_APPROVER_EMAILS`, `QNA_ADMIN_EMAILS` |
| Everybody is read-only | `GET /access` failing: `AZURE_AD_GROUP_FETCH_LAMBDA_NAME` |
| Developer sees admin (or the opposite) | `PORTAL_ADMIN_EMAILS` |
| Troubleshoot shows no Confluence text | `confluence_page_urls`, `confluence_secret_id`, secret format, Lambda internet access, CloudWatch `[CONFLUENCE]` lines |
