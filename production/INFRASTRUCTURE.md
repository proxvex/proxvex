# Production Infrastructure Overview

> Architecture reference for the ohnewarum.de production deployment.
> For step-by-step setup instructions, see [README.md](README.md).

## 1. Cluster Topology

```mermaid
graph TB
    subgraph pve1["pve1.cluster - always-on, primary"]
        deployer[oci-lxc-deployer :3443]
        postgres[postgres :5432]
        nginx[nginx :1443]
        zitadel[zitadel :1443]
    end

    subgraph ubuntupve["ubuntupve - fast, not 24/7"]
        gitea[gitea :443]
    end

    subgraph pve2["pve2 - reserved"]
        future[future 700-799]
    end

    pve1 --- ubuntupve
    ubuntupve --- pve2
```

| Node | Role | VMID Range | Always On |
|------|------|------------|-----------|
| **pve1.cluster** | Primary -runs core services | 500-599 | Yes |
| **ubuntupve** | Secondary -runs dev/build workloads | 600-699 | No |
| **pve2** | Reserved for future expansion | 700-799 | -|

All containers are **unprivileged LXC** managed by oci-lxc-deployer. Shared volumes on ZFS (`subvol-999999-oci-lxc-deployer-volumes`).

## 2. Network & Public Access

```mermaid
graph LR
    subgraph WAN["Internet"]
        browser_wan["Browser"]
    end

    subgraph Router["OpenWrt Router"]
        dns[dnsmasq]
        wan_fwd[WAN Port Forward]
    end

    subgraph PVE["PVE Host"]
        dnat[iptables DNAT :443 to :1443]

        subgraph Containers
            nginx_c[nginx :1443 ACME]
            zitadel_c[zitadel :1443]
            gitea_c[gitea :443]
            deployer_c[deployer :3443]
            postgres_c[postgres :5432]
        end
    end

    subgraph LAN["LAN"]
        browser_lan["Browser / Apps"]
    end

    browser_wan -->|https| wan_fwd
    wan_fwd --> nginx_c
    nginx_c -->|proxy_pass| zitadel_c
    nginx_c -->|proxy_pass| gitea_c

    browser_lan -->|":443"| dnat
    dnat --> nginx_c
    dnat --> zitadel_c
    browser_lan -->|":3443"| deployer_c
```

### HTTPS Port Convention

Rootless LXC containers cannot bind port 443. All proxy-mode apps use **port 1443** for HTTPS (`https_port` default in addon-ssl).

| App | HTTPS Port | Mode |
|-----|-----------|------|
| nginx | :1443 | proxy - ACME SSL proxy |
| zitadel | :1443 | native - Traefik |
| gitea | :1443 | proxy |
| oci-lxc-deployer | :3443 | native - Node.js |
| postgres | :5432 | certs - TLS on app port |

URLs in LAN include the port: `https://auth.ohnewarum.de:1443`

### DNS (OpenWrt Router - dnsmasq)

| Domain | Resolves To | Flow |
|--------|-------------|------|
| `ohnewarum.de` | nginx IP | Direct to nginx |
| `auth.ohnewarum.de` | nginx IP | PVE DNAT :443 to :1443, nginx proxies to zitadel |
| `git.ohnewarum.de` | nginx IP | PVE DNAT :443 to :1443, nginx proxies to gitea |
| `nebenkosten.ohnewarum.de` | nginx IP | PVE DNAT :443 to :1443, static frontend |
| `postgres`, `zitadel`, ... | Container IPs | Internal, no DNAT needed |

## 3. Certificate Strategy

```mermaid
graph TD
    subgraph ACME["ACME - Lets Encrypt"]
        cf[Cloudflare DNS-01]
        wildcard["*.ohnewarum.de"]
    end

    subgraph CA["Global CA - self-signed"]
        ca_gen[CA generated at install]
        auto_renew[Auto Renewal - daily check]
    end

    cf --> wildcard
    wildcard --> nginx_cert[nginx]

    ca_gen --> zitadel_cert[zitadel]
    ca_gen --> gitea_cert[gitea]
    ca_gen --> deployer_cert[deployer]
    ca_gen --> postgres_cert[postgres]

    auto_renew -.->|renews| zitadel_cert
    auto_renew -.->|renews| gitea_cert
    auto_renew -.->|renews| deployer_cert
    auto_renew -.->|renews| postgres_cert

    style ACME fill:#e8f5e9
    style CA fill:#fff3e0
```

| Cert Type | Where | Addon | Renewal |
|-----------|-------|-------|---------|
| **ACME Wildcard** | Nginx only | `addon-acme` | Automatic (acme.sh, 60 days) |
| **Self-signed** | All other apps | `addon-ssl` | Automatic (deployer, daily check) |

**LAN browsers** must trust the global CA (installed once on 2 devices).
Nginx trusts backend certs via `proxy_ssl_trusted_certificate chain.pem`.

## 4. OIDC Authentication

```mermaid
sequenceDiagram
    participant B as Browser
    participant App as App
    participant Z as Zitadel

    B->>App: Open protected page
    App->>B: 302 Redirect to Zitadel
    B->>Z: Login username/password
    Z->>B: 302 Redirect back with auth code
    B->>App: Auth code
    App->>Z: Exchange code for token
    Z->>App: Access token + ID token
    App->>B: Authenticated session
```

| App | OIDC | Flow | Issuer URL |
|-----|------|------|-----------|
| oci-lxc-deployer | `addon-oidc` | Authorization Code | `https://auth.ohnewarum.de` |
| Gitea | `addon-oidc` | Authorization Code | `https://auth.ohnewarum.de` |
| Nebenkosten | Client-side | PKCE (no secret) | `https://auth.ohnewarum.de` |
| Homepage | None | Public | -|

Server-to-server calls (token exchange, OIDC setup) go directly to `https://zitadel:1443` with a `Host: auth.ohnewarum.de` header. This avoids routing through Nginx for internal traffic.

## 5. Installation & Configuration

### oci-lxc-deployer

The management platform that deploys and configures all LXC containers. Runs on `pve1.cluster` as an unprivileged Alpine container.

- **UI**: `https://oci-lxc-deployer:3443` (LAN only)
- **Deploy**: `./production/deploy.sh <app|all>` (runs from PVE host or dev machine)
- **Config**: Shared volumes at `/rpool/data/subvol-999999-oci-lxc-deployer-volumes/`

### Nginx Configuration

Nginx serves as both **static host** and **reverse proxy**. Configuration via bind-mounted volume:

```
/etc/nginx/conf.d/          ← Volume mount (persisted)
├── default.conf            ← Reject unknown domains (444)
├── ohnewarum.conf          ← Static homepage
├── nebenkosten.conf        ← Frontend SPA (try_files)
├── auth.conf               ← Reverse proxy → zitadel:1443
└── git.conf                ← Reverse proxy → gitea:443
```

Managed by `setup-nginx.sh`. Nginx is rootless (uid 101), listens on port 8080. The ACME addon provides an SSL proxy on port 8443 (mapped to 443 via PVE DNAT).

### Stack System

Secrets and connection info are managed through **stacks** -shared credential stores per environment:

```
Stack "production" (stacktype: postgres + oidc + cloudflare)
├── entries (secrets):     POSTGRES_PASSWORD, ZITADEL_DB_PASSWORD, CF_TOKEN, ...
└── provides (connection): ZITADEL_URL, ZITADEL_PORT, POSTGRES_PORT, ...
```

Providers (postgres, zitadel) publish their connection info to the stack. Consumers read it automatically via template variables (`{{ ZITADEL_URL }}`).

---

*For detailed setup instructions, see [README.md](README.md).*
*For the Proxmox snapshot bug report, see [docs/pve-snapshot-bind-mount-bug.md](../docs/pve-snapshot-bind-mount-bug.md).*
