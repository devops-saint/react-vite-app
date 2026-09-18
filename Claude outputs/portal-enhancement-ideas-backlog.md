# Self-Service Portal — Enhancement Ideas Backlog

Consolidated from two rounds of feedback: the earlier [UX Enhancement Feedback MOM](./portal-ux-enhancement-feedback-mom.md) (4 items, 2026-09-11) and a follow-up, more detailed list ("Suggested Improvements for the Self Service Portal," same day). Overlapping items from both rounds have been merged below into single ideas. **Nothing below has been implemented — this is a backlog for review/prioritization only.**

## Idea #1 — Simplify & declutter the user-facing status display

Collapse the many granular backend statuses (Submitted, Request Received, Queued, Branch Created, PR Created, PR Updated, Pending Approval, PR Approved, Merged, PR Needs Work, PR Declined, PR Deleted, Rejected, Completed, Sync Failed) into a small, fixed set of user-facing states — e.g. **Pending / In Progress / Completed** — instead of exposing raw workflow/git states. Specific concern raised: `PR Approved` currently renders green and can read as "access is already available," when only one stage's PR has been approved — not merged, and possibly not the final requested stage.

*Sources: MOM #1; "Simplify request statuses…"; "Avoid exposing technical workflow states such as PR Approved…"*

## Idea #2 — Standardize colors and icons app-wide (status badges + resource types)

Move away from red/green coding wherever it could be misread as success/failure — both for status badges and for resource-type cards, which today use AWS category colors (including red for Secrets Manager and KMS). Use a consistent icon per resource type as the primary way to distinguish them, with a more neutral color treatment overall.

*Sources: MOM #4; "Standardize colors and visual cues…"; "Use icons consistently across resource types."*

## Idea #3 — Validate real AWS resource access before marking a request Completed

Today, `Completed` reflects only that the final promotion PR merged into the last requested branch — it does not confirm the resource access is actually live in AWS. Proposal: add a validation step (via AWS APIs) that checks the real state of each resource (bucket policy, secret resource policy, IAM role/permissions, etc.) and surface that real access state to the user, rather than only the pipeline/workflow status.

*Sources: "Validate resource access directly through AWS APIs before marking a request as completed."; "Show the real access state of resources… rather than only infrastructure workflow status."*

## Idea #4 — Progress/loading indicators during resource validation

Show visible progress or loading indicators while the portal is checking a request's resources (per the validation in Idea #3), rather than a silent wait. Depends on Idea #3 existing first.

*Source: "Add validation progress indicators and loading/status icons when showing all resources of a particular node."*

## Idea #5 — Consolidated environment view on the Current Whitelist page

Replace the environment dropdown on the Current Whitelist page with tabs (or a single consolidated view) showing DEV/QA/PRD resources together, so a user can see what's already whitelisted across all environments without repeated dropdown selection.

*Sources: MOM #3; "Show all environments (DEV, QA, PRD) simultaneously through tabs or consolidated views…"; "Allow users to see what resources are already whitelisted."*

## Idea #6 — Reduce clicks / simplify overall navigation

General navigation-simplification ask, not yet scoped to specific pages or flows — needs follow-up to identify which flows feel heaviest before this can be sized.

*Source: "Reduce clicks and simplify navigation across the portal."*

## Idea #7 — Disclaimer that portal-side whitelisting may not be sufficient alone, with documentation links

Add a persistent disclaimer — including at `Completed` — stating that whitelisting done through the portal is one side of the integration and that client/consumer-side configuration may also be required, with a link to relevant documentation alongside it.

*Sources: MOM #2; "Clearly explain that portal-side whitelisting alone may not be sufficient…"; "Provide links to relevant documentation directly from the portal."*

## Idea #8 — Expose the AWS agent role/ARN in the UI with one-click copy

Surface the relevant AWS role/ARN directly in the UI with a copy button, to simplify client-side setup.

*Source: "Expose the AWS agent role/ARN in the UI with a one-click copy function to simplify setup."*

## Idea #9 — Direct PR links for administrators

**Note:** the Request Details page already shows admin-only PR links per stage today (see the Frontend Reference doc), so this may be about surfacing PR links more prominently or in more places (e.g. the requests list, not only the detail page) rather than adding the capability from scratch — worth clarifying scope.

*Source: "Add direct links to related PRs for administrators."*

## Idea #10 — Duplicate-request validation

**Note:** distinct from two things that already exist — the per-resource "already whitelisted" check shown when adding a resource on Create Request, and the per-market queuing that already serializes concurrent requests for the same market. Worth clarifying exact scope: e.g., blocking a second request outright when one for the same market/resources is already in flight, vs. today's accept-and-queue behavior.

*Source: "Implement duplicate-request validation."*

## Idea #11 — Include requester identity and business justification in notification emails

Add the requester's identity and the request's business justification into the SES notification emails sent to approvers/requesters.

*Source: "Include requester identity and business justification in generated notifications/emails."*

## Idea #12 — Revisit the locking/concurrency model

Today, locking is per-market (`MARKETLOCK#<MARKET_CODE>`) — any two requests for the same market serialize regardless of whether they touch different resources. Proposal: consider finer-grained (e.g., per-resource/node) locking to reduce unnecessary queuing, and explicitly review behavior when the same user submits multiple requests concurrently.

*Sources: "Review handling of multiple simultaneous requests from the same user."; "Revisit locking logic (e.g., node-level locking rather than broader locks) to reduce conflicts and improve scalability."*

---

## Status

All 12 ideas are unscoped/unprioritized — captured for review, not yet estimated or scheduled. No implementation has started on any item.
