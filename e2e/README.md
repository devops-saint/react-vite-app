# E2E tests (Playwright)

Automated, triggerable end-to-end tests that exercise the portal's real
regular-user flows against a real, deployed stack (e.g. your personal/test
stack) - not mocks, not a component test harness. Each run validates:

- **Dashboard** - the three summary cards, and that no raw backend status
  (e.g. `PR_APPROVED`, `SYNC_FAILED`) ever leaks into the UI (idea #2).
- **Current Whitelist** - the DEV/QA/PRD Tabs switcher (idea #6), Agent
  Role ARN with copy action per environment (idea #9), the shared neutral
  resource-card color (idea #3), and that removing a resource opens a
  confirm dialog rather than deleting immediately.
- **My Requests** - the list loads, dashboard status-group filtering
  works and can be cleared, and status chips never show a raw backend
  value.
- **Create Request: Whitelist mode** - a full real lifecycle: stage a
  resource, preview its cross-account policy (idea #18), submit, confirm
  it lands `Pending` with its Agent Role ARN, then cancel it.
- **Create Request: De-whitelist mode** - confirms Policy Preview is
  hidden in this mode (per the "preview policy is not required for
  de-whitelisting" fix), and - if the target market already has a live
  whitelisted KMS key in DEV - runs a full de-whitelist create-and-cancel
  cycle against it.

## Why real login, not a bypass

The portal only supports real Azure AD (MSAL) login - `AuthProvider.tsx`
calls `loginRedirect`, and there is no test-only auth bypass anywhere in
the app (the `VITE_ADMIN_ACCESS_CODE` unlock only gates the ADMIN-role UI
client-side; it does not get you past the sign-in screen). So this suite
uses Playwright's standard pattern for that: sign in once by hand in a
real browser window, save the resulting session (`storageState`) to disk,
and reuse it for every subsequent automated run. No credentials are ever
stored in code or in the repo.

## One-time setup

1. Have the portal's frontend running and pointed at the stack you want
   to test (for example `npm run dev:personal` for a personal/test
   stack), and know its URL (defaults to `http://localhost:5173`).
2. Capture a login session:

   ```bash
   npm run e2e:login
   ```

   This opens a real, visible browser window. Sign in with your
   Microsoft account exactly as you normally would, including any MFA
   prompt. Once you land back inside the app (off the `/login` page),
   the script saves your session to `e2e/.auth/user.json` and closes the
   browser automatically. **This file is a live, reusable, signed-in
   session - it is already git-ignored (`e2e/.auth/`) and must never be
   committed or shared.**

   Re-run `npm run e2e:login` any time `npm run e2e` starts failing at
   the login screen again (the saved session/token has expired).

## Running the suite

```bash
npm run e2e        # headless run, single worker, HTML report on failure
npm run e2e:ui     # interactive UI mode - step through and re-run tests
```

Point at a non-default stack with `E2E_BASE_URL`:

```bash
E2E_BASE_URL=https://your-personal-stack.example.com npm run e2e
```

`npm run e2e:login` respects the same variable, so set it before
capturing the login session if you're not testing against
`http://localhost:5173`.

## Design notes

- **Single worker, no retries** (`playwright.config.ts`): tests hit a
  real deployed backend with real per-market locking
  (`MARKETLOCK#<MARKET_CODE>` in `lambda/handler.py`). Running tests in
  parallel or retrying a failure could race two tests against the same
  market's lock, or retry on top of a half-applied real side effect.
  Correctness over speed here.
- **Every test that creates a real request cancels it** before finishing
  (via the Cancel Request feature, pre-merge). The suite is meant to be
  run repeatedly without accumulating open PRs/branches on the target
  stack.
- **Nothing is hardcoded that differs between stacks.** Market codes
  differ between the org stack and a personal/test stack
  (`VITE_AVAILABLE_MARKETS`), so tests pick whichever market is first in
  the list (`selectFirstMarket` in `e2e/tests/helpers.ts`) rather than a
  fixed code. The de-whitelist lifecycle test similarly discovers an
  existing KMS key live from Current Whitelist rather than assuming one
  exists, and skips itself cleanly with a clear reason if the target
  stack has nothing whitelisted yet.
- **Regular user flows only** - this suite does not test admin-gated
  actions (force-release lock, retry promotion, PR links), which require
  a real ADMIN Azure AD role rather than the client-side
  `VITE_ADMIN_ACCESS_CODE` unlock.

## Files

```
playwright.config.ts     Test runner config: baseURL, storageState, single worker
e2e/global-setup.ts       Fails fast with instructions if no login session exists yet
e2e/login.mjs             One-time manual login capture (npm run e2e:login)
e2e/tests/helpers.ts      selectFirstMarket, test justification text, a synthetic test KMS ARN
e2e/tests/dashboard.spec.ts
e2e/tests/my-requests.spec.ts
e2e/tests/current-whitelist.spec.ts
e2e/tests/whitelist-request-lifecycle.spec.ts
e2e/tests/dewhitelist-mode.spec.ts
```
