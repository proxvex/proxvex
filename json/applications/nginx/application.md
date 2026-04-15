# Nginx

Nginx Unprivileged reverse proxy and web server. Runs as UID 101 (nginx user)
from the `nginxinc/nginx-unprivileged` image and cannot bind ports < 1024, so
TLS terminates on an unprivileged port (`1443` by convention).

## Installation

### Key Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `hostname` | `nginx` | Container hostname |
| `volumes` | `conf=/etc/nginx/conf.d` | Configuration directory |

## Configuration

Upload `.conf` files to the `conf` volume at `/etc/nginx/conf.d/`. These are
loaded automatically by the nginx `include` directive. A minimal `default.conf`
is written on first installation if the volume is empty.

To update configuration after deployment, either reconfigure (which re-runs
pre_start scripts with existing volumes), or edit files directly in the volume
and reload:

```sh
VMID=503
pct exec $VMID -- chown -R nginx:nginx /etc/nginx/conf.d
pct exec $VMID -- nginx -s reload
```

## Ports

| Port | Protocol | Description |
|------|----------|-------------|
| 8080 | HTTP | Default listener in bundled `default.conf` |
| 1443 | HTTPS | TLS listener when addon-acme and/or addon-ssl are enabled |

> **Rootless note:** `listen 443 ssl` would fail because UID 101 cannot bind
> privileged ports. Always terminate TLS on `1443`. Put a port-forward / DNAT
> at `443 → 1443` upstream (router or load balancer) if external clients
> expect standard `https://` URLs.

## Addons

| Addon | Purpose |
|-------|---------|
| `addon-oidc` | OpenID Connect authentication via Zitadel (callback `/oauth2/callback`) |
| `addon-ssl`  | Internal TLS: volume, capabilities, CA chain for upstream validation |
| `addon-acme` | Let's Encrypt certificates via Cloudflare DNS-01 challenge |

---

## TLS with addon-ssl and addon-acme

The two SSL-related addons solve **different** problems and are commonly used
**together** for a rootless nginx fronting internal upstream services:

- **addon-acme** obtains and renews publicly-trusted Let's Encrypt certificates
  for domains you own. It writes `privkey.pem`, `cert.pem`, and `fullchain.pem`
  into `/etc/ssl/addon/`. Renewal runs as a background loop inside the
  container and triggers `/etc/lxc-oci-deployer/reload_certificates` after each
  successful renewal.

- **addon-ssl** in `ssl_mode=certs` (with `ssl.needs_server_cert=false`) adds
  only the internal CA chain (`chain.pem`) to the same directory. That chain
  is used by nginx `proxy_ssl_trusted_certificate` to verify upstream services
  in the internal deployer CA (e.g. a zitadel or gitea container that uses the
  internal CA for its own certificates).

### File layout in `/etc/ssl/addon/`

| File | Written by | Used for |
|------|-----------|----------|
| `privkey.pem`   | addon-acme | `ssl_certificate_key` (frontend TLS) |
| `cert.pem`      | addon-acme | end-entity certificate |
| `fullchain.pem` | addon-acme | `ssl_certificate` (frontend TLS) |
| `chain.pem`     | addon-ssl  | `proxy_ssl_trusted_certificate` (upstream CA trust) |

### Bootstrap placeholder

`addon-acme` writes a 1-day self-signed placeholder to `/etc/ssl/addon/` in the
pre_start phase (host-side). This lets nginx start successfully on the very
first boot *before* the real Let's Encrypt certificate has been issued by the
on_start renewal script. Once acme issues the real cert, the `reload_certificates`
hook fires `nginx -s reload` and the live cert takes over. Subsequent starts
skip the placeholder because real cert files already exist.

### Required parameters

`addon-acme` requires:
- **`acme_san`** — comma-separated list of domain names (supports wildcards)
- A `cloudflare` stack providing `CF_TOKEN` (API token with `Zone:DNS:Edit`
  permission on the relevant zones)

Optionally:
- `acme_email` — Let's Encrypt account email
- `acme_staging` — use LE staging for testing (no rate limits)
- `acme_needs_ca_cert` — also write LE's intermediate chain to `chain.pem`
  (usually **not** what you want if addon-ssl is also enabled, because
  addon-ssl's internal CA chain would be overwritten)

---

## Example: `ohnewarum.de` (production)

A rootless nginx reverse proxy that

- terminates public TLS for `ohnewarum.de`, `auth.ohnewarum.de`,
  `git.ohnewarum.de`, `nebenkosten.ohnewarum.de` via a wildcard LE certificate
- proxies `auth.*` to an internal zitadel using the internal CA for upstream
  TLS verification
- proxies `git.*` to an internal gitea the same way

### Deployment config

```json
{
  "application": "nginx",
  "task": "installation",
  "params": [
    { "name": "vm_id_start", "value": 501 },
    { "name": "static_ip",   "value": "192.168.4.41/24" },
    { "name": "static_gw",   "value": "192.168.4.1" },
    { "name": "nameserver4", "value": "192.168.4.1" },
    { "name": "volumes",     "value": "conf=/etc/nginx/conf.d\nhtml=/usr/share/nginx/html" },
    { "name": "ssl_mode",    "value": "certs" },
    { "name": "ssl.needs_server_cert", "value": false },
    { "name": "ssl.needs_ca_cert",     "value": true  },
    { "name": "acme_san",    "value": "ohnewarum.de,*.ohnewarum.de" }
  ],
  "selectedAddons": ["addon-acme", "addon-ssl"],
  "stackId": "cloudflare_production"
}
```

Key choices:
- `ssl_mode=certs` — addon-ssl only provides certs/volumes/capabilities, no
  internal reverse-proxy sidecar
- `ssl.needs_server_cert=false` — suppresses addon-ssl's self-signed server
  cert (acme provides the real one)
- `ssl.needs_ca_cert=true` — addon-ssl writes the internal CA `chain.pem` for
  upstream trust
- `acme_san` wildcard covers all subdomains with one certificate

### Vhost config (simplified)

```nginx
server {
    listen 1443 ssl;
    server_name ohnewarum.de;
    ssl_certificate     /etc/ssl/addon/fullchain.pem;
    ssl_certificate_key /etc/ssl/addon/privkey.pem;
    root /usr/share/nginx/html/ohnewarum;
    index index.html;
}

server {
    listen 1443 ssl;
    server_name auth.ohnewarum.de;
    ssl_certificate     /etc/ssl/addon/fullchain.pem;
    ssl_certificate_key /etc/ssl/addon/privkey.pem;
    location / {
        proxy_pass https://zitadel:1443;
        proxy_ssl_verify on;
        proxy_ssl_trusted_certificate /etc/ssl/addon/chain.pem;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
    }
}
```

Note:
- `ssl_certificate` / `ssl_certificate_key` → publicly-trusted LE cert
- `proxy_ssl_trusted_certificate` → internal CA chain

### Reload hook

When `addon-acme` is enabled on nginx, the application installs
`/etc/lxc-oci-deployer/reload_certificates` at pre_start (see
`conf-write-reload-hook.json`, gated by `skip_if_all_missing: ["acme_san"]`).
Its content is:

```sh
#!/bin/sh
exec nginx -s reload
```

The acme-renew loop calls this script after every successful issuance or
renewal, so nginx picks up the new certificate without manual intervention.

---

## Other useful combinations

### (1) Public-only TLS (no internal upstreams)

Plain nginx serving static content on a public domain — no need for an
internal CA chain.

```json
"params": [
  { "name": "acme_san", "value": "example.com,www.example.com" }
],
"selectedAddons": ["addon-acme"]
```

The application installs the LE cert and reload hook. No `addon-ssl` needed
because nothing needs upstream CA trust.

### (2) Internal-only reverse proxy (no public cert)

Nginx inside a LAN acting as a reverse proxy to internal services signed by
the deployer's internal CA. No public domain, no Let's Encrypt.

```json
"params": [
  { "name": "ssl_mode",              "value": "certs" },
  { "name": "ssl.needs_server_cert", "value": true  },
  { "name": "ssl.needs_ca_cert",     "value": true  }
],
"selectedAddons": ["addon-ssl"]
```

addon-ssl generates both a self-signed server cert (valid for the container's
internal FQDN) and writes the internal CA chain. Clients must trust the
internal CA out-of-band.

### (3) Public TLS frontend + internal upstream (production pattern)

Same as the `ohnewarum.de` example above. Both addons, `ssl_mode=certs`,
`ssl.needs_server_cert=false`, `ssl.needs_ca_cert=true`, `acme_san` set.

### (4) Testing with Let's Encrypt staging

Switch to the staging CA to avoid hitting rate limits while iterating on
cloudflare/DNS setup. Certificates will be untrusted by browsers.

```json
"params": [
  { "name": "acme_san",     "value": "example.com" },
  { "name": "acme_staging", "value": true }
],
"selectedAddons": ["addon-acme"]
```

### (5) Public TLS + OIDC gate

Combine addon-acme (public cert) with addon-oidc (Zitadel login) to protect
a public nginx behind SSO.

```json
"params": [
  { "name": "acme_san",      "value": "private.example.com" }
],
"selectedAddons": ["addon-acme", "addon-oidc"]
```

OIDC injects environment variables and uses `/oauth2/callback` as the
redirect URI. Make sure the zitadel app registration matches.

---

## Vhost generator (interactive)

Hand-writing reverse-proxy vhosts with all the right headers (`X-Forwarded-*`,
`Host`, SNI, upstream TLS verify) is repetitive and easy to get wrong. The
HTML snippet below lets you paste in three values — public domain, upstream
URL, optional extras — and produces a complete `server { … }` block ready to
drop into `/etc/nginx/conf.d/`.

Save the snippet as `vhost-generator.html` and open it in any browser. No
network, no dependencies.

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>nginx vhost generator</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 780px; margin: 2rem auto; padding: 0 1rem; }
  label { display: block; margin-top: 1rem; font-weight: 600; }
  input, textarea { width: 100%; box-sizing: border-box; font-family: ui-monospace, monospace; font-size: 13px; padding: .5rem; border: 1px solid #bbb; border-radius: 4px; }
  textarea { min-height: 20rem; }
  small { color: #666; }
</style>
</head>
<body>
<h1>nginx vhost generator</h1>
<p><small>For rootless nginx terminating TLS on :1443. Cert files expected in <code>/etc/ssl/addon/</code>.</small></p>

<label>Public domain<br><small>e.g. <code>auth.ohnewarum.de</code></small></label>
<input id="domain" value="auth.ohnewarum.de">

<label>Upstream URL<br><small>e.g. <code>https://zitadel:1443</code> or <code>http://app:8080</code></small></label>
<input id="upstream" value="https://zitadel:1443">

<label>Extras (optional, free-form, semicolon-terminated)<br><small>e.g. <code>client_max_body_size 512m;</code></small></label>
<input id="extras" value="">

<label>Generated vhost</label>
<textarea id="output" readonly></textarea>

<script>
function indent(s, n) { const pad = " ".repeat(n); return s.split("\n").map(l => l ? pad + l : l).join("\n"); }

function generate(domain, upstream, extras) {
  let url;
  try { url = new URL(upstream); } catch (e) { return "# invalid upstream URL"; }
  const isHttps = url.protocol === "https:";
  const upstreamHost = url.hostname;

  const sslLines = [
    "    ssl_certificate     /etc/ssl/addon/fullchain.pem;",
    "    ssl_certificate_key /etc/ssl/addon/privkey.pem;",
    "    ssl_protocols       TLSv1.2 TLSv1.3;",
    "    ssl_ciphers         HIGH:!aNULL:!MD5;",
  ].join("\n");

  const proxySsl = isHttps ? [
    "        proxy_ssl_verify on;",
    "        proxy_ssl_trusted_certificate /etc/ssl/addon/chain.pem;",
    "        proxy_ssl_server_name on;",
    "        proxy_ssl_name " + upstreamHost + ";",
  ].join("\n") : "";

  const extrasBlock = extras.trim() ? "    " + extras.trim() + "\n" : "";

  return `server {
    listen 1443 ssl;
    server_name ${domain};

${sslLines}

${extrasBlock}    location / {
        proxy_pass ${upstream};
        proxy_http_version 1.1;
${proxySsl ? proxySsl + "\n" : ""}        proxy_set_header Host \\$host;
        proxy_set_header X-Real-IP \\$remote_addr;
        proxy_set_header X-Forwarded-For \\$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-Host \\$host;
        proxy_set_header X-Forwarded-Port 443;
    }
}
`;
}

function update() {
  const d = document.getElementById("domain").value.trim();
  const u = document.getElementById("upstream").value.trim();
  const e = document.getElementById("extras").value;
  document.getElementById("output").value = generate(d, u, e);
}

["domain","upstream","extras"].forEach(id =>
  document.getElementById(id).addEventListener("input", update)
);
update();
</script>
</body>
</html>
```

The generated block already includes the production-grade defaults discussed
in the SSL section above:

- `listen 1443 ssl` (rootless-compatible)
- `ssl_certificate` / `ssl_certificate_key` from `/etc/ssl/addon/`
- For HTTPS upstreams: `proxy_ssl_verify on`, trusted CA chain, SNI
- All `X-Forwarded-*` headers including `X-Forwarded-Port 443` so apps behind
  the proxy emit URLs with the correct public port

For multi-domain wildcard SAN setups (the `ohnewarum.de` pattern), repeat the
generator per public domain and concatenate the outputs into one
`/etc/nginx/conf.d/*.conf` directory.

## Troubleshooting

**`/etc/ssl/addon/` contains only `chain.pem`, not server cert files** — acme
did not run or failed. Check the container hook log on the PVE host:

```sh
grep -aE "OCI_HOOK|acme|ERROR" /var/log/lxc/<vmid>.log
```

Typical causes:
- `acme_san` parameter not set → pre_start aborts with a validation error
- `CF_TOKEN` missing / wrong permissions → `Failed to issue certificate` in the hook log
- acme.sh defaulted to ZeroSSL (fixed — we pin `--server letsencrypt`)

**`nginx: [emerg] cannot load certificate`** — privkey/cert not yet written,
or wrong permissions. The bootstrap placeholder should prevent this on first
boot. If it persists, check `/etc/ssl/addon/` ownership matches UID 101.

**`HTTPS connection refused` from clients** — nginx may still listen on 8080
from an old vhost. Verify:

```sh
pct exec <vmid> -- ss -tln | grep -E ":(1443|8080)"
```

If only `:8080` shows up, your vhost config is stale — regenerate and reload.

**Reload hook not running** — check that `/etc/lxc-oci-deployer/reload_certificates`
exists inside the container and is executable. It's written by the
application's pre_start only when `acme_san` is set.

## Upgrade

Pulls the new nginx image. Configuration in the `conf` volume is preserved.
Certificates in `/etc/ssl/addon/` are preserved across upgrades because they
live in their own managed volume.
