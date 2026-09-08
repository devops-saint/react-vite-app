# DPC Self-Service Whitelisting Portal — User Handbook

This is the day-to-day guide for anyone requesting, tracking, or approving AWS resource whitelisting through the portal. For system internals, see the [Complete Portal Documentation](./portal-documentation-index.md) instead.

## What this portal does

Markets (regional business units) need specific AWS resources — S3 buckets, Secrets Manager secrets, KMS keys, Lambda functions — whitelisted per environment (DEV, QA, PRD) before their applications can use them. Historically this meant someone hand-editing a YAML config file and opening a pull request themselves.

This portal replaces that manual process with a form: you pick a market, pick an environment, list the resources you need whitelisted, and submit. Behind the scenes the portal creates a branch, commits the YAML changes, opens a pull request for a reviewer, and — once approved and merged — automatically promotes the same change through DEV → QA → PRD, opening a fresh pull request at each stage. You track all of this from the portal itself; you never need to touch the config repository directly.

## Signing in

The portal uses your organization's single sign-on (Azure AD / Entra ID). Signing in gets you into the app and identifies who you are for the requests you submit and view — see the [Known Issues & Roadmap](./portal-known-issues-roadmap.md) doc for the current limits of what that identity enforces on the backend today.

## Dashboard

The Dashboard is the landing page after login. It shows four summary cards — **Pending**, **Approved**, **Rejected**, **Completed** — each a count of your own requests in that bucket, and a Recent Requests table below them.

Each summary card is clickable: clicking **Pending**, for example, takes you to My Requests pre-filtered to exactly the statuses that card counted. This is guaranteed to stay in sync — the count and the filter are generated from the same underlying definition, so a card's number always matches what you see after clicking it.

| Card | Statuses included |
|---|---|
| Pending | Submitted, Request Received, Queued, Branch Created, PR Created, PR Updated, Pending Approval, Sync Failed (retrying) |
| Approved | PR Approved, Merged |
| Rejected | Rejected, PR Needs Work, PR Declined, PR Deleted |
| Completed | Completed |

## Creating a request

From **Create Request**:

1. **Select a market.** Nothing else on the page is usable until a market is selected — the environment tabs and resource inputs stay disabled with an explanatory hint until you do. The market dropdown shows only the market code (e.g. `AM`), not the full name, to keep the list scannable.
2. **Pick an environment tab** (DEV / QA / PRD). Each tab holds its own independent set of resource entries — switching tabs does not carry over anything you were mid-typing on another tab, and switching tabs clears any validation error message that was showing, since that error belonged to the tab you're leaving.
3. **Add resources.** For each resource type (S3 bucket, Secrets Manager secret, KMS key, Lambda function) type the identifier and click Add. Before it's added, the portal checks it against what's already live in the current whitelist for that market/environment — if it's already whitelisted, you'll get a message telling you so instead of a duplicate entry, since resubmitting something already whitelisted is a no-op that would only add noise to the review queue.
4. **Business justification** and submit.

### Why a market can only have one request in flight

If you or a teammate submits a second request for a market that already has one in progress, the new one is held as **Queued** rather than starting immediately. This isn't a bug — it prevents two requests for the same market from racing onto the same branches and conflicting with each other. The queued request starts automatically as soon as the one ahead of it reaches a finished state (Completed, Rejected, etc.).

## Tracking a request: status meanings

| Status | Meaning |
|---|---|
| Submitted / Request Received | Your request was accepted and the automated pipeline has started. |
| Queued | Held back because another request for the same market is already in progress (see above). Starts automatically. |
| Branch Created | The pipeline created a working branch for your change. |
| PR Created / PR Updated | A pull request is open for a reviewer against the DEV branch (or, once promoted, against QA/master). |
| Pending Approval | Waiting on a reviewer. |
| PR Approved | A reviewer approved it; it will be merged. |
| Merged | The change was merged into that stage's branch. If there's a next stage, promotion to it starts automatically. |
| PR Needs Work / PR Declined / PR Deleted | The reviewer sent it back, declined it, or the PR was removed — treat this as rejected for that stage. |
| Rejected | The request was rejected. |
| Completed | The change has been promoted all the way through and is live everywhere it needed to be. |
| Sync Failed (retrying) | See below. |
| Unknown | The portal doesn't recognize the status string the backend returned — shown as a fallback so the UI never breaks on an unrecognized value. |

### What does "Sync Failed" mean?

`Sync Failed` means an automated step (creating the branch, committing the change, or opening the pull request) couldn't reach the source-control host at the time it tried — typically because of a transient outage. **This is not a dead end and does not need manual re-submission.** A scheduled sweep runs automatically every 10 minutes and retries anything stuck in this state, up to 5 automatic attempts. In the large majority of cases it resolves itself on the next sweep without anyone doing anything.

There is currently no manual "retry now" button for this specific status in the admin UI — the automatic sweep is the only retry mechanism. If a request has been sitting at Sync Failed for an extended period (well beyond a few sweep cycles), that's worth flagging to the team maintaining the portal, since it likely means the automatic retries have already been exhausted for that item.

### "For admin, where is the retry button?"

Two different admin actions exist today, both surfaced only on the Request Details page, only to users with the ADMIN role, and only when the situation applies:

- **Force release market lock** — appears only on a request that is `Queued`. Lets an admin skip ahead of the normal wait if the request ahead of it in the queue is stuck or dead.
- **Retry promotion** — appears only on a request that merged into one stage but never got a pull request opened for the next stage (a stuck promotion). Re-claims a clean lock and opens a fresh promotion PR.

Neither of these is a general "retry sync" button, and there is currently no such button for `Sync Failed` items specifically — see above.

## Viewing the current whitelist

**View Whitelist** shows what's actually live right now for a chosen market and environment — this is a live read of the source-of-truth config, not a history of requests. Both a market and an environment must be explicitly selected; the page does not default to any pre-selected market or environment, since showing DEV for whatever market happened to be first in the list by default was misleading. Each resource section (Buckets, Secrets, KMS Keys, Functions) is color-coded to match AWS's own official console colors for that resource category, and full ARNs are shown in full rather than being cut off.

## Request Details

Opening a request from My Requests or the Dashboard shows its full detail: market code and market name as separate fields, the environments and resources requested, a status timeline, and (admin-only, when relevant) pull request links and the queue/promotion recovery actions described above.

## Roles

The portal recognizes four roles — Admin, User, Approver, Viewer — with ADMIN gating the queue/promotion recovery actions and pull-request links described above. See the [Frontend Reference](./portal-frontend-reference.md) for how role assignment currently works, including a temporary manual-unlock mechanism still in use while real Azure AD role assignment is being finished.

## Getting help

The **Help** page in the sidebar has in-app guidance. For anything not covered there or in this handbook, reach out to the team maintaining the portal.
