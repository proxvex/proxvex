# ACME/Let's Encrypt Addon

Provision trusted TLS certificates via Let's Encrypt using acme.sh with Cloudflare DNS challenge.

## Use Cases

### Single App with own Let's Encrypt Certificate

Each application container gets its own certificate. The ACME addon runs inside the container and handles issuance + renewal automatically.

```
acme_san = gitea.example.com
ssl_mode = proxy
```

### Central Reverse Proxy with Wildcard Certificate

A single nginx container acts as reverse proxy for multiple backends. One wildcard certificate covers all subdomains.

```
acme_san = *.example.com
ssl_mode = proxy
```

The central proxy uses TLS pass-through (SNI routing) or re-encrypt to reach the individual app containers.

### Multi-Domain SAN Certificate

A single certificate covering multiple specific domains:

```
acme_san = auth.example.com,api.example.com,admin.example.com
ssl_mode = certs
```

## Parameters

### `acme_san` (required)

Domain(s) for the certificate (Subject Alternative Names). Supports:

- **Single domain:** `app.example.com`
- **Multiple domains:** `auth.example.com,api.example.com` (comma-separated)
- **Wildcard:** `*.example.com`
- **Template variables:** `{{hostname}}.example.com`

The first domain in the list is used as the primary domain for acme.sh operations.

### `CF_TOKEN` (required)

Cloudflare API token with **DNS:Edit** permission for the target zone(s).

**How to create:**
1. Go to Cloudflare Dashboard > My Profile > API Tokens
2. Create Token > Edit zone DNS template
3. Select the zone(s) containing your domain(s)
4. Create Token and copy it

**Multi-zone SAN:** If your SAN contains domains from different Cloudflare zones (e.g. `app.example.com,api.otherdomain.com`), the token needs DNS:Edit permission for **all** zones involved. Subdomains of the same zone (e.g. `auth.example.com,gitea.example.com`) only need permission for that one zone.

### `acme_email` (optional)

Email address for Let's Encrypt registration and certificate expiry notifications. Recommended for production use.

### `ssl_mode`

| Mode | Description | Recommendation |
|------|-------------|----------------|
| `proxy` | nginx reverse proxy handles HTTPS, app runs on HTTP | Best for most apps |
| `native` | App configures HTTPS itself using the certificates | For apps with built-in TLS (PostgreSQL, Gitea) |
| `certs` | Only provision certificates, no proxy or ports | For custom setups |

### `http_port` / `https_port` (advanced)

Only relevant for `proxy` mode. The HTTP port of the application to proxy, and the HTTPS port to expose.

## Architecture

```
Container Start
  -> Proxmox Hookscript
    -> /etc/lxc-oci-deployer/on_start_container
      -> on_start.d/acme-renew.sh  (install acme.sh, issue/renew cert, background loop)
      -> on_start.d/ssl-proxy.sh   (install nginx, configure proxy, iptables)
```

The on_start.d scripts are prepared on the PVE host during pre_start and placed into a bind-mounted volume at `/etc/lxc-oci-deployer/`. When the container starts, the hookscript executes them automatically.

Certificate files are written to `/etc/ssl/addon/` (also bind-mounted). A background loop checks renewal every 24 hours.
