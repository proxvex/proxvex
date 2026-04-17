#!/usr/bin/env python3
"""Create Cloudflare MX + SPF TXT records for the mail domain.

Idempotent: only creates records if they don't already exist with the
desired value. Designed to run non-interactively from a post_start template
during a Zitadel deploy.

Inputs (template variables):
  smtp_own_domain   - bool gate; when "true" the script runs, else skips
  smtp_mail_domain  - apex domain (e.g. example.com)
  smtp_mx_target    - MX hostname (e.g. mxext1.mailbox.org)
  smtp_spf_value    - TXT value (e.g. "v=spf1 include:mailbox.org ~all")
  CF_TOKEN          - Cloudflare API token with Zone:DNS:Edit on the zone

Output: JSON on stdout, log lines on stderr.
"""

import json
import sys
import urllib.request
import urllib.error

SMTP_OWN_DOMAIN = "{{ smtp_own_domain }}"
MAIL_DOMAIN = "{{ smtp_mail_domain }}"
MX_TARGET = "{{ smtp_mx_target }}"
SPF_VALUE = "{{ smtp_spf_value }}"
CF_TOKEN = "{{ CF_TOKEN }}"

# Normalize NOT_DEFINED sentinels
for name in ("SMTP_OWN_DOMAIN", "MAIL_DOMAIN", "MX_TARGET", "SPF_VALUE", "CF_TOKEN"):
    if locals()[name] == "NOT_DEFINED":
        locals()[name] = ""
# Re-bind after locals() mutation
SMTP_OWN_DOMAIN = locals()["SMTP_OWN_DOMAIN"]
MAIL_DOMAIN = locals()["MAIL_DOMAIN"]
MX_TARGET = locals()["MX_TARGET"]
SPF_VALUE = locals()["SPF_VALUE"]
CF_TOKEN = locals()["CF_TOKEN"]


def log(msg: str) -> None:
    print(msg, file=sys.stderr)


def cf_request(method: str, path: str, body: dict | None = None) -> dict:
    url = f"https://api.cloudflare.com/client/v4{path}"
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {CF_TOKEN}")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        error_body = e.read().decode() if e.fp else ""
        log(f"ERROR: Cloudflare API {method} {path} returned {e.code}: {error_body}")
        raise


def get_zone_id(domain: str) -> str:
    resp = cf_request("GET", f"/zones?name={domain}")
    results = resp.get("result", [])
    if not results:
        log(f"ERROR: No Cloudflare zone found for '{domain}'")
        log(f"       Response: {json.dumps(resp)}")
        sys.exit(1)
    return results[0]["id"]


def ensure_record(zone_id: str, record_type: str, name: str, content: str, priority: int | None = None) -> None:
    resp = cf_request("GET", f"/zones/{zone_id}/dns_records?type={record_type}&name={name}")
    existing = resp.get("result", [])

    if existing:
        rec = existing[0]
        existing_content = rec.get("content", "")
        existing_priority = rec.get("priority")
        if existing_content == content and (priority is None or existing_priority == priority):
            log(f"  {record_type} {name} already correct — skipping")
            return
        log(f"  ERROR: {record_type} {name} exists with different value:")
        log(f"    expected: {content}" + (f" (priority {priority})" if priority else ""))
        log(f"    found:    {existing_content}" + (f" (priority {existing_priority})" if existing_priority else ""))
        log(f"  Delete the existing record manually if you want to replace it.")
        raise SystemExit(1)

    payload: dict = {"type": record_type, "name": name, "content": content, "ttl": 300}
    if priority is not None:
        payload["priority"] = priority
    log(f"  Creating {record_type} {name}")
    cf_request("POST", f"/zones/{zone_id}/dns_records", payload)


# --- Gate ---
if SMTP_OWN_DOMAIN != "true":
    log("smtp_own_domain is not true — skipping mail DNS setup.")
    print("[]")
    sys.exit(0)

if not MAIL_DOMAIN or not MX_TARGET or not CF_TOKEN:
    log("ERROR: smtp_own_domain is true but required parameters are empty:")
    log(f"  smtp_mail_domain = '{MAIL_DOMAIN}'")
    log(f"  smtp_mx_target   = '{MX_TARGET}'")
    log(f"  smtp_spf_value   = '{SPF_VALUE}'")
    log(f"  CF_TOKEN          = '{'set (' + str(len(CF_TOKEN)) + ' chars)' if CF_TOKEN else 'empty'}'")
    sys.exit(1)

# --- Resolve zone ---
log(f"Looking up Cloudflare zone for {MAIL_DOMAIN}...")
zone_id = get_zone_id(MAIL_DOMAIN)
log(f"  Zone id: {zone_id}")

# --- MX record ---
log(f"Ensuring MX record: {MAIL_DOMAIN} -> {MX_TARGET} (priority 10)")
ensure_record(zone_id, "MX", MAIL_DOMAIN, MX_TARGET, priority=10)

# --- SPF TXT record ---
if SPF_VALUE:
    log(f"Ensuring SPF TXT: {MAIL_DOMAIN} = '{SPF_VALUE}'")
    ensure_record(zone_id, "TXT", MAIL_DOMAIN, SPF_VALUE)

log("Mail DNS setup complete.")
print(json.dumps([{"id": "mail_dns_zone_id", "value": zone_id}]))
