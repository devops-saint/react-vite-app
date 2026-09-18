# Minutes of Meeting — Self-Service Portal: UX Enhancement Feedback

**Date:** 2026-09-11
**Subject:** UX/enhancement feedback for the Self-Service Whitelisting Portal
**Status:** Feedback captured for review — **nothing below has been implemented**; this is a record for prioritization/discussion only.

## Feedback items

1. **Simplify the status taxonomy.** Current statuses are numerous and granular (Submitted, Request Received, Queued, Branch Created, PR Created, PR Updated, Pending Approval, PR Approved, Merged, PR Needs Work, PR Declined, PR Deleted, Rejected, Completed, Sync Failed). Proposal: collapse the user-facing display to a small fixed set — e.g. **Pending / In Progress / Completed** — with fixed colors per bucket. Specific concern raised: today "PR Approved" renders green, which can read as "the whole request is done" when it isn't — only that one stage's PR was approved, not merged, and possibly not the final stage.

2. **Add disclaimers near status, including at Completed.** Even when a request reaches `Completed`, there should be a visible statement clarifying that the whitelist change from this portal is one side of the integration — the client/consumer side still needs to apply/consume the whitelisted access itself. Proposal includes a link to documentation alongside the disclaimer.

3. **Current Whitelisted Resources page — layout.** Today this page uses a market dropdown plus an environment dropdown, showing one environment's resources at a time. Proposal: replace the environment dropdown with tabs (DEV / QAS / PRD), or alternatively show all three environments' resource lists stacked vertically on one page (one after another) instead of requiring a per-environment selection.

4. **Unify/rework the resource color scheme.** Resource type cards currently use AWS-category colors, including red for Secrets Manager and KMS. Concern: red/green in this context can be misread as a status indicator (blocked/broken) rather than a category label. Proposal: move away from a red/green-coded scheme and instead differentiate resource types primarily by **icon**, with a more neutral/unified color treatment.

## Decisions

None yet — no implementation decisions have been made. Items are recorded here for future prioritization.

## Next steps

- Review and prioritize against the existing [Known Issues & Roadmap](./portal-comprehensive-documentation.md#13-known-issues--roadmap).
- No implementation to begin until explicitly requested.
