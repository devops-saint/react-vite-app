#!/usr/bin/env python3
"""
fetch_ad_market_access.py

Standalone test script: sign in as yourself against Azure AD / Entra ID and
list the group memberships / app roles Microsoft Graph reports for your
account, then attempt to extract a "list of markets I have access to" from
them.

WHY THIS SCRIPT EXISTS
-----------------------
The portal's per-market authorization gap (see claude/portal-known-issues-
roadmap.md, item 2 & 3) is blocked on one question: where does "which
markets can this user touch" actually live? You said SIGA-granted market
access is synced into Azure AD as group memberships / roles attached to the
user's account - this script is the smallest possible thing that proves (or
disproves) that out, by logging in as yourself and printing exactly what
Graph reports for your own account. Nothing here talks to the portal, the
Lambdas, or DynamoDB - it's a pure exploration tool you run locally.

WHAT IT DOES
------------
1. Logs you in interactively via the device-code flow (you open a browser,
   enter a code, sign in with your normal work account - no password ever
   touches this script).
2. Calls Microsoft Graph's `/me/memberOf` (your direct group/role
   memberships) and, optionally, `/me/transitiveMemberOf` (also includes
   groups you belong to via nested group membership - worth checking in
   case a "market access" group is nested inside a parent group rather than
   assigned to you directly).
3. Optionally calls `/me/appRoleAssignments` - use this instead of/alongside
   the above if your org exposes market access as App Roles on a specific
   app registration rather than as plain security groups. This needs a
   higher-privilege scope that usually requires admin consent (see PREREQS
   below), so it's off by default and fails gracefully if not consented.
4. Prints every group/role name found, RAW AND UNFILTERED FIRST - so you can
   see the actual naming convention SIGA uses before trying to parse it.
5. Then attempts to extract market codes from those names using a regex
   pattern (MARKET_GROUP_REGEX below) and prints a deduplicated "markets you
   have access to" list. The pattern is a placeholder - after step 4 shows
   you the real names, adjust the regex (or pass --market-regex) to match.

PREREQUISITES
--------------
1. `pip install msal requests`
2. An Azure AD app registration to authenticate through. You can reuse the
   portal's own app registration (its VITE_CLIENT_ID / VITE_TENANT_ID from
   the frontend's .env - ask whoever owns those values) AS LONG AS its
   Authentication blade has "Allow public client flows" set to Yes -
   device-code flow is a public-client flow and will fail with an
   AADSTS7000218-style error otherwise. If you can't get that flag flipped
   on the existing app registration, register a small throwaway "internal
   testing" app registration instead (no client secret needed - public
   client, no redirect URI required for device code flow).
3. `User.Read` (used for /me, /memberOf, /transitiveMemberOf) does NOT
   require admin consent in most tenants - it's typically pre-consented.
   `AppRoleAssignment.ReadWrite.All` (needed only for --include-app-roles)
   DOES require admin consent by default - if you hit a consent error, ask
   your identity/platform team to grant it, or just skip that flag and use
   the group-membership path instead.

USAGE
-----
    export AZURE_CLIENT_ID=<app registration client id>
    export AZURE_TENANT_ID=<your tenant id>
    python3 fetch_ad_market_access.py

    # include nested/transitive group membership
    python3 fetch_ad_market_access.py --transitive

    # also try app-role assignments (needs admin-consented scope, see above)
    python3 fetch_ad_market_access.py --include-app-roles

    # once you've seen the real group names, tighten the extraction pattern
    python3 fetch_ad_market_access.py --market-regex "^SIGA-DPC-(?P<code>[A-Z]{2,3})-.*$"

This never writes anything back to Azure AD or the portal - every call here
is a read-only GET against Microsoft Graph.
"""

import argparse
import os
import re
import sys

try:
    import msal
    import requests
except ImportError:
    print(
        "Missing dependencies. Run:\n\n    pip install msal requests\n",
        file=sys.stderr,
    )
    sys.exit(1)

GRAPH_BASE = "https://graph.microsoft.com/v1.0"

# --- Placeholder market-name extraction pattern -----------------------------
# This WILL NOT match anything until you've seen the real group/role names
# this script prints in the "RAW" section below and adjusted it to match
# your org's actual SIGA→AD naming convention. It must contain a named group
# called `code` - that's the piece treated as the market code. A few
# examples of what real patterns might look like, uncomment/adapt one you
# see in the raw output instead of guessing blind:
#
#   r"^SIGA[-_]MARKET[-_](?P<code>[A-Z]{2,3})$"
#   r"^DPC[-_]Whitelisting[-_](?P<code>[A-Z]{2,3})[-_]Access$"
#   r"^Market\.(?P<code>[A-Z]{2,3})\..*$"
#
DEFAULT_MARKET_GROUP_REGEX = r"^SIGA-MARKET-(?P<code>[A-Z]{2,3})$"


def get_access_token(client_id, tenant_id, scopes):
    """Interactive device-code sign-in as the current user. Returns a bearer
    token string, or exits with a clear message on failure."""
    authority = f"https://login.microsoftonline.com/{tenant_id}"
    app = msal.PublicClientApplication(client_id, authority=authority)

    flow = app.initiate_device_flow(scopes=scopes)
    if "user_code" not in flow:
        print(f"Failed to start device flow: {flow.get('error_description', flow)}", file=sys.stderr)
        sys.exit(1)

    # flow["message"] already contains the "go to microsoft.com/devicelogin
    # and enter this code" instructions - just show it verbatim.
    print(flow["message"])
    result = app.acquire_token_by_device_flow(flow)  # blocks until you sign in

    if "access_token" not in result:
        error = result.get("error")
        description = result.get("error_description", "")
        print(f"\nSign-in failed ({error}): {description}", file=sys.stderr)
        if "AADSTS65001" in description or "consent" in description.lower():
            print(
                "\nThis looks like a missing-admin-consent error for one of the "
                "requested scopes. If you passed --include-app-roles, try again "
                "without it (it needs AppRoleAssignment.ReadWrite.All, which "
                "usually needs an admin to grant consent first) - the plain "
                "group-membership path only needs User.Read, which is normally "
                "pre-consented.",
                file=sys.stderr,
            )
        if "AADSTS7000218" in description or "public client" in description.lower():
            print(
                "\nThis looks like the app registration doesn't allow public "
                "client flows. In the Azure Portal, open this app registration "
                "-> Authentication -> 'Allow public client flows' -> Yes. If you "
                "don't own that app registration, ask whoever does, or register "
                "a small throwaway app for this test instead.",
                file=sys.stderr,
            )
        sys.exit(1)

    return result["access_token"]


def graph_get_all(path, token):
    """GETs a Graph collection endpoint and follows @odata.nextLink until
    exhausted, returning the combined list of items. `path` is relative to
    GRAPH_BASE, e.g. '/me/memberOf'."""
    headers = {"Authorization": f"Bearer {token}"}
    url = f"{GRAPH_BASE}{path}"
    items = []

    while url:
        response = requests.get(url, headers=headers, timeout=30)
        if response.status_code == 403:
            print(
                f"\n403 Forbidden calling {path}. Your account/token doesn't have "
                "the permission this endpoint needs, or an admin hasn't granted "
                "consent for it yet. See the docstring at the top of this file "
                "for which scope each endpoint needs.",
                file=sys.stderr,
            )
            return items
        response.raise_for_status()
        payload = response.json()
        items.extend(payload.get("value", []))
        url = payload.get("@odata.nextLink")  # a full, ready-to-call URL, or None

    return items


def summarize_directory_objects(objects):
    """memberOf/transitiveMemberOf return a mix of object types (groups,
    directory roles, administrative units). Print enough to identify each
    one regardless of type."""
    rows = []
    for obj in objects:
        odata_type = obj.get("@odata.type", "").rsplit(".", 1)[-1]
        name = obj.get("displayName", "(no displayName)")
        description = obj.get("description") or ""
        rows.append((odata_type or "unknown", name, obj.get("id", ""), description))
    return rows


def extract_markets(names, pattern):
    """Applies `pattern` (must have a named group `code`) to each name in
    `names`, returning (matched_codes_sorted_deduped, unmatched_names)."""
    compiled = re.compile(pattern)
    matched = set()
    unmatched = []
    for name in names:
        match = compiled.match(name)
        if match and "code" in match.groupdict():
            matched.add(match.group("code").upper())
        else:
            unmatched.append(name)
    return sorted(matched), unmatched


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--client-id",
        default=os.environ.get("AZURE_CLIENT_ID"),
        help="Azure AD app registration client ID (or set AZURE_CLIENT_ID)",
    )
    parser.add_argument(
        "--tenant-id",
        default=os.environ.get("AZURE_TENANT_ID"),
        help="Azure AD tenant ID (or set AZURE_TENANT_ID)",
    )
    parser.add_argument(
        "--transitive",
        action="store_true",
        help="Also fetch /me/transitiveMemberOf (includes nested group membership)",
    )
    parser.add_argument(
        "--include-app-roles",
        action="store_true",
        help="Also fetch /me/appRoleAssignments (needs admin-consented AppRoleAssignment.ReadWrite.All)",
    )
    parser.add_argument(
        "--market-regex",
        default=DEFAULT_MARKET_GROUP_REGEX,
        help="Regex with a named group `code` used to extract a market code from a group/role display name",
    )
    args = parser.parse_args()

    if not args.client_id or not args.tenant_id:
        parser.error(
            "Need both a client ID and tenant ID. Pass --client-id/--tenant-id "
            "or set AZURE_CLIENT_ID / AZURE_TENANT_ID."
        )

    # User.Read alone is enough for /me, /memberOf, /transitiveMemberOf and is
    # normally pre-consented. appRoleAssignments needs a separate, usually
    # admin-consent-gated scope - only request it if actually asked for, so a
    # plain group-membership run never gets blocked by a scope it doesn't need.
    scopes = ["User.Read"]
    if args.include_app_roles:
        scopes.append("AppRoleAssignment.ReadWrite.All")

    token = get_access_token(args.client_id, args.tenant_id, scopes)

    me = requests.get(f"{GRAPH_BASE}/me", headers={"Authorization": f"Bearer {token}"}, timeout=30).json()
    print(f"\nSigned in as: {me.get('displayName')} <{me.get('userPrincipalName')}>\n")

    all_names = []

    print("=" * 70)
    print("Direct group / directory-role memberships (/me/memberOf)")
    print("=" * 70)
    direct = summarize_directory_objects(graph_get_all("/me/memberOf", token))
    for odata_type, name, obj_id, description in direct:
        print(f"  [{odata_type:14}] {name}   (id={obj_id})")
        if description:
            print(f"                   {description}")
        all_names.append(name)
    if not direct:
        print("  (none returned)")

    if args.transitive:
        print()
        print("=" * 70)
        print("Transitive (incl. nested) memberships (/me/transitiveMemberOf)")
        print("=" * 70)
        transitive = summarize_directory_objects(graph_get_all("/me/transitiveMemberOf", token))
        for odata_type, name, obj_id, description in transitive:
            print(f"  [{odata_type:14}] {name}   (id={obj_id})")
            all_names.append(name)
        if not transitive:
            print("  (none returned)")

    if args.include_app_roles:
        print()
        print("=" * 70)
        print("App role assignments (/me/appRoleAssignments)")
        print("=" * 70)
        app_roles = graph_get_all("/me/appRoleAssignments", token)
        for assignment in app_roles:
            role_name = assignment.get("appRoleId", "")
            resource_display_name = assignment.get("resourceDisplayName", "(unknown app)")
            print(f"  appRoleId={role_name}  on resource '{resource_display_name}'")
            # appRoleAssignments gives you the *ID* of the role, not its
            # human-readable name - that name lives on the service
            # principal's `appRoles` collection (GET
            # /servicePrincipals/{resourceId}/appRoles). If this section
            # matters for you, ask and this script can be extended to
            # resolve appRoleId -> a readable role name automatically.
        if not app_roles:
            print("  (none returned)")

    print()
    print("=" * 70)
    print(f"Attempting market extraction with pattern: {args.market_regex}")
    print("=" * 70)
    markets, unmatched = extract_markets(all_names, args.market_regex)

    if markets:
        print(f"\nMarkets detected for {me.get('userPrincipalName')}:")
        for code in markets:
            print(f"  - {code}")
    else:
        print(
            "\nNo names matched the current pattern. Look at the RAW group/role "
            "names printed above, find the ones that represent market access, "
            "and re-run with --market-regex set to match their actual shape."
        )

    if unmatched:
        print(f"\n{len(unmatched)} name(s) did not match the pattern (this is expected for non-market groups):")
        for name in unmatched:
            print(f"  - {name}")


if __name__ == "__main__":
    main()
