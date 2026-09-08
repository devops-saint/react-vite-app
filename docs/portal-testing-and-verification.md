# Testing & Verification

Part of the [Complete Portal Documentation](./portal-documentation-index.md).

## Current state: no automated test suite exists

This section is deliberately blunt, because `package.json` can give the opposite impression at a glance. It declares `test` (vitest), `test:ui`, `test:coverage`, `e2e` (playwright), `e2e:ui`, and `prepare` (husky) scripts, which reads like a project with unit tests, an E2E suite, and pre-commit hooks already in place. In practice, as of this writing:

- **Zero test files exist** anywhere in the repository — no `*.test.*` or `*.spec.*` files under `src/`, `terraform/lambda*`, or `terraform-personal/lambda*`.
- **No test configuration exists** — no `vitest.config.*`, no `playwright.config.*`.
- **No git hooks are installed** — no `.husky/` directory, so `prepare` has never actually wired anything up.

In short: the tooling is scaffolded (the dependencies and npm scripts are present and would work if pointed at real tests) but nothing has been built on top of it yet. Anyone relying on `npm test` passing as a quality gate today would find there is nothing for it to run.

## What verification has actually been used

For all backend and frontend changes made during this engineering effort, verification was manual and tool-assisted rather than automated:

- **TypeScript**: `tsc --noEmit` after every frontend change, to catch type errors before they'd surface at runtime.
- **ESLint**: `eslint --max-warnings 0` (or targeted subsets) after every frontend change, to catch both style issues and real bugs the linter is configured to flag (e.g. `@typescript-eslint/no-floating-promises` catching an unhandled async effect).
- **Python syntax validation**: `ast.parse()` against both Lambdas' `handler.py` files after every backend change, to catch syntax errors before deployment (there being no unit test to exercise the actual logic).
- **Manual / scenario-based testing**: reasoning through specific inputs and states against the actual code paths — e.g., confirming a fix to the market-lock claim logic behaves correctly for "lock free," "lock held by another request," and "lock stale and reclaimable" by reading the exact conditional branches, not by running an automated scenario.
- **Direct file diffing**: for every change intended to be identical across the org (`terraform/`) and personal (`terraform-personal/`) stacks, diffing the actual files after the change to confirm functional parity rather than assuming the same edit was applied correctly twice.

This has been sufficient to catch regressions during active development, but it does not substitute for a real test suite: it depends entirely on a human (or an AI assistant) re-deriving the correct behavior each time, has no way to catch a regression in code nobody happened to be looking at that day, and cannot run in CI.

## Recommended path to real coverage

None of this has been implemented — it's a roadmap, not a claim of what exists.

1. **Lambda unit tests** (highest value, lowest effort to start): both `handler.py` files are pure-ish functions around a mocked DynamoDB table and a mocked `requests`/boto3 client. `moto` (DynamoDB/SES/Secrets Manager mocking) plus `pytest` would let the core logic — market-lock claim/release, promotion-lock ride-along/merge, webhook status mapping, the sweep's staleness/retry-cap logic — be tested without touching real AWS or a real git host. This logic is exactly where the subtlest bugs have lived (see the `_link_promotion_pr` cross-market race described in the [GitOps Lambda Reference](./portal-gitops-lambda-reference.md)), which makes it the highest-value place to start.
2. **Frontend unit tests** (vitest, already a dependency): the `StatusGroup`/`matchesStatusGroup` bucketing logic and `getStatusConfig`'s fallback behavior (both in `src/types/request.types.ts`) are pure functions and good first targets — deterministic, no rendering required.
3. **Component tests** (React Testing Library, would need adding): the Create Request page's tab-switch draft-reset behavior and market-gating of resource inputs are exactly the kind of interaction bug (state leaking across tabs) that a component test catches immediately and a manual click-through can miss.
4. **E2E tests** (playwright, already a dependency): a small number of critical-path scenarios — submit a request, view it move through statuses, view the current whitelist — would catch integration-level regressions across the full frontend-to-mocked-API path.
5. **CI wiring**: once any of the above exist, running them on every PR (and restoring `husky` pre-commit hooks for the fast ones, like lint/type-check) turns this from "verification someone has to remember to do" into an enforced gate.

Given the size of both `handler.py` files (~1000–1300 lines each) and how much of the system's correctness lives in their locking/retry logic specifically, item 1 is the recommended starting point.
