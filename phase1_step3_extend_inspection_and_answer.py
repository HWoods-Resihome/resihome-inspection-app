"""
Standalone auth check. Run this FIRST if any phase1 script gives an auth error.

It does the simplest possible authenticated request to HubSpot — fetches the
current user's info — and reports exactly what happened.

Usage:
    python phase1_step0_check_auth.py
"""

import json
import sys
import urllib.request
import urllib.error

from _hubspot_helpers import get_token, HUBSPOT_API_BASE


def main():
    print("=" * 70)
    print("Phase 1, Step 0: HubSpot auth check")
    print("=" * 70)

    token = get_token()
    masked = f"{token[:10]}...{token[-4:]}" if len(token) >= 14 else "(short)"

    print(f"\nToken loaded:")
    print(f"  Length:      {len(token)}")
    print(f"  Starts with: {token[:4]!r}")
    print(f"  Masked:      {masked}")
    if not token.startswith("pat-"):
        print(f"\n  WARNING: token does not start with 'pat-'. HubSpot private app tokens always do.")
        print(f"  This is almost certainly the problem. Re-copy the token from HubSpot.")

    # Try the simplest auth-required endpoint: list account info
    # /account-info/v3/details is small and gates on auth
    url = HUBSPOT_API_BASE + "/account-info/v3/details"
    print(f"\nMaking test request:")
    print(f"  GET {url}")

    req = urllib.request.Request(url, method="GET")
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Accept", "application/json")

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = resp.read().decode("utf-8")
            data = json.loads(body) if body else {}
            print(f"\n  HTTP 200 OK")
            print(f"  Portal ID:     {data.get('portalId')}")
            print(f"  Account type:  {data.get('accountType')}")
            print(f"  Time zone:     {data.get('timeZone')}")
            print(f"  Company name:  {data.get('companyName', '(not set)')}")
            print(f"\n[done] Auth works. Run the rest of the phase1 scripts.")
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8") if e.fp else ""
        print(f"\n  HTTP {e.code} {e.reason}")
        print(f"  Response: {body}")
        print(f"\n[FAIL] Auth check failed.")
        _diagnose(e.code, body, token)
        sys.exit(1)
    except urllib.error.URLError as e:
        print(f"\n  Network error: {e}")
        print(f"\n[FAIL] Could not reach HubSpot. Check your internet connection.")
        sys.exit(1)


def _diagnose(code: int, body: str, token: str):
    print()
    print("=" * 70)
    print("Likely causes:")
    print("=" * 70)
    if code == 401:
        print("HTTP 401 = HubSpot did not accept the token. Possible reasons:")
        print()
        print("  1) Token is for a DIFFERENT portal than expected (production vs. sandbox)")
        print("     - Verify which portal the token is from in HubSpot:")
        print("       Settings > Integrations > Private Apps")
        print("     - This phase 1 should run against sandbox 51415639 (ResiTest)")
        print()
        print("  2) Token has been deactivated or rotated")
        print("     - Open the private app in HubSpot, check Auth tab")
        print("     - Generate a new token if needed; update .env.local")
        print()
        print("  3) Token was copied with extra characters (whitespace, line breaks)")
        if len(token) < 30 or len(token) > 100:
            print(f"     - Your token length ({len(token)}) is unusual; HubSpot pat tokens are typically 40-60 chars")
        if not token.startswith("pat-"):
            print(f"     - Your token does not start with 'pat-'; this is almost certainly the problem")
        print()
        print("  4) .env.local has the wrong VARIABLE NAME")
        print("     - The app expects: HUBSPOT_SANDBOX_TOKEN=pat-...")
        print()
        print("Quick test from PowerShell:")
        print('  $env:HUBSPOT_SANDBOX_TOKEN="<paste fresh token here>"')
        print('  python phase1_step0_check_auth.py')
    elif code == 403:
        print("HTTP 403 = token is valid but lacks required scopes.")
        print()
        print("Required scopes for phase 1:")
        print("  - crm.objects.custom.read")
        print("  - crm.objects.custom.write")
        print("  - crm.schemas.custom.read")
        print("  - crm.schemas.custom.write")
        print()
        print("Open your private app in HubSpot, go to Scopes tab, add these,")
        print("save, copy the new token (token regenerates when scopes change),")
        print("update .env.local.")
    else:
        print(f"HTTP {code} is unusual. Full response above. Share with developer.")


if __name__ == "__main__":
    main()
