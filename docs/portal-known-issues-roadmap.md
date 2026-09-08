# Known Issues & Roadmap

Part of the [Complete Portal Documentation](./portal-documentation-index.md). This is the honest, current-state list of gaps — not a changelog. For historical detail on everything already fixed, see the project's `codebase-bug-audit-2026-09-04.md` doc; several of that audit's remaining open items (Dashboard market-code casing, the whitelist-page defaulting/label/ARN-truncation issues) have since been closed and are reflected as resolved here.

## 1. No real backend authentication (highest priority)

API Gateway has no authorizer on any route in either stack. Every route — including the two admin-only actions (force-release lock, retry-promotion) — is reachable by anyone who can reach the API directly (curl, Postman, browser devtools), with no verification of who's calling. Azure AD login on the frontend is genuine, but it's a client-side gate only: nothing stops a direct API call from skipping it entirely and supplying any `userId`/`submitted_by` it likes.

**A complete, ready-to-build implementation plan exists** for closing this using API Gateway's native JWT authorizer against the existing Entra ID app registration — see the project doc `sso-backend-auth-implementation-plan.md`. It requires no new auth system, no custom authorizer Lambda, and no JWT library: fixing two existing frontend bugs (wrong OAuth scope, wrong axios instance in use) plus one new Terraform resource and updating both Lambdas to read verified identity from the authorizer's injected claims instead of trusting client-supplied fields. Deliberately **not implemented** — this was scoped as a plan-only deliverable per explicit instruction.

## 2 & 3. No per-market authorization (blocked on a decision, not on effort)

Even once callers are authenticated, there's currently no check on *which markets* a given user is allowed to submit a request for — any authenticated (or today, any) caller can submit for any market. This is intentionally not yet designed: it depends on where the market→user mapping should live (Azure AD groups/App Roles, a table the portal owns, an existing system of record), which is under investigation with the identity/platform team and outside this engineering effort's scope to decide unilaterally. The SSO plan doc above describes how this becomes straightforward to wire in once authentication (item 1) lands — Entra ID app roles or group claims can ride in the same verified JWT.

## 4. Webhook has no signature verification

`POST /dpc/bitbucket/webhook` (and its GitHub equivalent) trusts any POST body with no shared-secret or signature check. Anyone who can guess or obtain a `request_id` can forge a merge event and drive that request straight to `COMPLETED`, bypassing PR review entirely. This is a separate, smaller fix from item 1 — both Bitbucket and GitHub support HMAC-signing webhook payloads with a shared secret — and is explicitly called out as such in the SSO plan doc so it doesn't get conflated with (or accidentally solved by) the JWT authorizer, which cannot apply to this route since the git host has no Entra ID identity to present.

## 5. No automated test suite

Vitest, Playwright, and Husky are all present as dependencies and npm scripts, but zero test files, test configs, or git hooks currently exist. See the [Testing & Verification](./portal-testing-and-verification.md) doc for the full picture and a recommended starting point (Lambda unit tests around the locking/retry logic, the highest-risk untested code in the system).

## 6. Temporary admin-unlock mechanism should be retired

`isAdminUnlocked` (a build-time access code, entered on the Settings page, stored in `sessionStorage`) currently stands in for real Azure AD ADMIN app-role assignment. It's explicitly not a security boundary today — it only toggles which buttons render, and the routes those buttons call have no server-side authorization check regardless (see item 1) — but it should be removed once real role-based ADMIN assignment is wired up, so admin-only UI is driven by an actual verified role rather than a shared code baked into the public JS bundle.

## 7. No manual "retry sync" action for `SYNC_FAILED` requests

The automatic sweep (every 10 minutes, up to 5 attempts per item) is the only retry mechanism for a request stuck at `SYNC_FAILED` today — there is no admin button to force an immediate retry the way there is for a queued or stuck-promotion request. This gap surfaced directly from a user question during this engineering effort and has been discussed as a candidate addition, but adding it has not yet been confirmed or scheduled.

## 8. Shared trunk branches can surface cross-market diffs in a promotion PR

Each market owns its own `values.<env>.yaml` file, but `dev`/`qa`/`master` are shared trunk branches across every market. A market-scoped promotion lock (`LOCK#<market>#<branch>`) stops duplicate/redundant promotion PRs for the same market, but a promotion PR's branch-to-branch diff can still include another market's unrelated pending changes if that market has also merged to `dev` but hasn't promoted yet. Fully isolating this would require per-market branches — a larger architectural change, noted but explicitly out of scope for the work done so far.

## Minor, low-priority, not scheduled

- `Footer.tsx`'s "Privacy Policy," "Terms of Service," and "Support" links are all placeholder (`href="#"`).
- `Breadcrumbs.tsx`'s `routeNameMap` carries a few entries that don't correspond to any real route in this app — harmless (falls back to auto-capitalizing) but dead weight.
- `@tanstack/react-query` is wired up at the app root but not actually used anywhere yet; several `src/components/common/*` components exist but are currently unused.

## Resolved since the last audit (for context)

The following were open in the prior codebase audit and have since been fixed during this engineering effort: Dashboard "Recent Requests" market-code casing; Current Whitelist page defaulting to a pre-selected market/DEV instead of requiring explicit selection; a label/placeholder visual-overlap bug on that same page; truncated ARN display on the whitelist page; Dashboard stat cards not being clickable/filterable; and several Create Request UX issues (resource inputs not gated on market selection, draft state leaking across environment tabs, market dropdown showing full names instead of just codes). See the relevant reference docs in this set for current behavior.
