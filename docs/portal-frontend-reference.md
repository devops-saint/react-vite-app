# Frontend Reference

Part of the [Complete Portal Documentation](./portal-documentation-index.md). Covers `src/`, the single React application shared by both backend stacks (which stack it talks to is purely a matter of which API base URL it's configured with).

## Stack

React 18 + TypeScript, MUI (Material UI) for components, React Router for routing, Azure AD (Entra ID) login via MSAL. Lazy-loaded, code-split pages (`React.lazy` + `Suspense`), each layout owning its own local `Suspense` boundary around its routed content rather than one boundary around the whole `<Routes>` tree — this specifically avoids a page's lazy chunk still loading (e.g. right after a hard refresh) unmounting the surrounding layout (header/sidebar) and discarding whatever state update React 18 had batched into that same navigation.

## Pages and routes

| Route (via `config.routes.*`, backed by `VITE_ROUTE_*`) | Page | Notes |
|---|---|---|
| `/login` | LoginPage | Public |
| `/dashboard` | DashboardPage | Summary cards + Recent Requests |
| `/requests/create` | CreateRequestPage | New request form |
| `/requests` | MyRequestsPage | List + filter (supports `?statusGroup=` from Dashboard cards) |
| `/requests/:id` | RequestDetailsPage | Full detail, admin actions |
| `/help` | HelpPage | In-app guidance |
| `/whitelist` | CurrentWhitelistPage | Live read of current whitelist ("View Whitelist" in the sidebar) |
| `/profile` | ProfilePage | — |
| `/settings` | SettingsPage | Includes the temporary admin-unlock control (see below) |
| `/404` | NotFoundPage | — |

All except `/login` sit behind `ProtectedRoute` (must be authenticated) inside `DashboardLayout` (header + sidebar chrome). `/` redirects to `/dashboard`; any unmatched path renders `NotFoundPage`.

## Roles and authorization (client-side)

`UserRole` enum: `ADMIN`, `USER`, `APPROVER`, `VIEWER` (`src/types/auth.types.ts`). `AuthProvider` exposes `hasRole`/`hasAnyRole`, checked wherever the UI needs to gate something — currently the Request Details page's admin actions (force-release market lock, retry promotion, PR links) are the only ADMIN-gated UI.

**Temporary admin-unlock mechanism.** Real Azure AD app-role-based ADMIN assignment is not wired up yet (see [Known Issues & Roadmap](./portal-known-issues-roadmap.md)). As a stand-in, `AuthProvider` holds an `isAdminUnlocked` boolean (`sessionStorage`-scoped, so it clears when the tab closes) that a user can set from the Settings page by entering a build-time code (`VITE_ADMIN_ACCESS_CODE`). When set, `hasRole(UserRole.ADMIN)` and `hasAnyRole([...ADMIN...])` return `true` regardless of the user's real role. This is explicitly **not a security boundary**: the code is baked into the public JS bundle, and unlocking only toggles which buttons *render* client-side — the backend routes those buttons call have no authorization check of their own today (see the Main Lambda Reference), so this mechanism grants a UI convenience, not a real permission. It should be removed once real Azure AD role assignment is in place.

## Dashboard stat cards → filtered My Requests

Each of the four Dashboard summary cards (Pending/Approved/Rejected/Completed) is wrapped in a MUI `CardActionArea` and navigates to `/requests?statusGroup=<group>` on click. `StatusGroup` (`'pending' | 'approved' | 'rejected' | 'completed'`) is defined once in `src/types/request.types.ts` — along with `STATUS_GROUPS`, `STATUS_GROUP_LABELS`, and `matchesStatusGroup(status, group)` — and used by **both** `requestService.getDashboardStats` (to compute each card's count) and `MyRequestsPage` (to read the `statusGroup` query param and filter the list to the same set, shown as a dismissible "Filtered from Dashboard" chip). Keeping one definition means the count on a card and the results after clicking it can never quietly drift apart.

## Status display

`STATUS_CONFIG` (`src/types/request.types.ts`) maps every `RequestStatus` value to a display label and an MUI color (e.g. `SYNC_FAILED` → "Sync Failed (retrying)" / error). `getStatusConfig(status)` is the safe lookup used everywhere a status renders — it falls back to a generic `{ label: status, color: 'default' }` entry instead of throwing if the backend ever reports a status string the frontend doesn't know about yet, since status values are owned by the backend and this map is not guaranteed exhaustive.

## Create Request page behavior

- Market must be selected before anything else on the page is usable — resource inputs and environment tabs are `disabled` with an explanatory hint (`"Select a market first"`) until then.
- Each environment tab (DEV/QA/PRD) has independent draft state; switching tabs resets both the in-progress draft text and any validation error message, so neither carries over to a tab it doesn't belong to.
- Before adding a resource, an effect fetches the live current whitelist for the selected market/environment (`requestService.getCurrentWhitelist`, cached per market+environment in `whitelistCache` to avoid refetching) and checks the new entry against it (`isAlreadyWhitelisted`); a match blocks the add with an explanatory message instead of creating a duplicate.
- The market dropdown shows only the market code (e.g. `AM`), not `AM — Armenia`.
- Resource type cards use icon + color per type: S3 buckets (green `#7AA116`, `StorageOutlinedIcon`), Secrets Manager secrets (red `#DD344C`, `VpnKeyOutlinedIcon`), KMS keys (red `#DD344C`, `LockOutlinedIcon`), Lambda functions (orange `#ED7100`, `FunctionsOutlinedIcon`) — matching AWS's own official Architecture Icons category colors (Storage / Security-Identity-Compliance / Compute) rather than an arbitrary palette; Secrets Manager and KMS intentionally share a color because AWS's own category scheme puts both under "Security, Identity & Compliance."

## Current Whitelist page behavior

- Both market and environment selects start empty (`displayEmpty` + `InputLabelProps={{ shrink: true }}`, the latter needed specifically because an empty-value `displayEmpty` select does not auto-shrink its floating label, which otherwise visually overlaps the placeholder) — there is no default market/environment shown until the user picks both.
- Each resource section (Buckets/Secrets/KMS Keys/Functions) carries the same AWS-category color as the Create Request cards above, with a colored top border and a colored count chip.
- ARNs render as full-width, word-broken text rows rather than MUI `Chip`s, specifically because `Chip`'s built-in `text-overflow: ellipsis` truncates long ARNs — full ARNs are needed here, so truncation had to be replaced with wrapping.

## Request Details page

Shows `Market Code` and `Market Name` as two separate fields (previously one combined field). Two conditional admin panels: a `QUEUED`-status panel with "Force release market lock," and a `*_MERGED_AWAITING_*`-status panel with "Retry promotion" — both ADMIN-gated and both call the corresponding Main Lambda admin route (see [Main Lambda Reference](./portal-main-lambda-reference.md)). PR links are also ADMIN-only.

## Configuration (`.env` / `VITE_*`)

| Variable | Purpose |
|---|---|
| `VITE_API_BASE_URL`, `VITE_API_TIMEOUT` | Backend API Gateway base URL and request timeout |
| `VITE_CLIENT_ID`, `VITE_TENANT_ID`, `VITE_REDIRECT_URI` | Azure AD (MSAL) app registration |
| `VITE_REPOSITORY_NAME`, `VITE_AWS_REGION` | Display-only context |
| `VITE_APP_NAME`, `VITE_APP_VERSION`, `VITE_ENVIRONMENT` | Branding/build metadata |
| `VITE_ROUTE_*` (HOME, LOGIN, DASHBOARD, REQUESTS, REQUESTS_CREATE, REQUEST_DETAILS, HELP, NOT_FOUND, PROFILE, SETTINGS, WHITELIST) | Every client-side route path, resolved through `config.routes.*` rather than hardcoded strings |
| `VITE_ADMIN_ACCESS_CODE` | The temporary admin-unlock code described above |
| `VITE_AVAILABLE_MARKETS` | `CODE:Name,CODE:Name,...` — populates the market dropdown |
| `VITE_ENABLE_DEVTOOLS` | Dev-only tooling toggle |

`.env.example` is the template; `.env` (gitignored) is the actual local configuration and must mirror every key in `.env.example`, including the full `VITE_ROUTE_*` block — this was previously missing `VITE_ROUTE_WHITELIST` and several other route entries were hardcoded as fallbacks rather than sourced from the environment.
