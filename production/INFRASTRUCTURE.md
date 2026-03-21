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
        gitea[gitea :1443]
    end

    subgraph pve2["pve2 - reserved"]
        future[fallback 700-799]
    end

    pve1 --- ubuntupve
    ubuntupve --- pve2
```

| Node | Role | VMID Range | Always On |
|------|------|------------|-----------|
| **pve1.cluster** | Primary -runs core services | 500-599 | Yes |
| **ubuntupve** | Secondary -runs dev/build workloads | 600-699 | No |
| **pve2** | Fallback for pve1 | 700-799 | No |

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

    subgraph PVE["PVE Host - pve1.cluster"]
        subgraph Containers
            nginx_c[nginx :1443 ACME wildcard]
            zitadel_c[zitadel :1443]
            gitea_c[gitea :1443]
            deployer_c[deployer :3443]
            postgres_c[postgres :5432 TLS]
        end
    end

    subgraph LAN["LAN"]
        browser_lan["Browser / Apps"]
    end

    browser_wan -->|":443"| wan_fwd
    wan_fwd -->|":1443"| nginx_c
    nginx_c -->|proxy_pass| zitadel_c
    nginx_c -->|proxy_pass| gitea_c

    browser_lan -->|":1443"| nginx_c
    browser_lan -->|":3443"| deployer_c
```

### HTTPS Port Convention

Rootless LXC containers cannot bind port 443. All proxy-mode apps use **port 1443** for HTTPS (`https_port` default in addon-ssl).

| App | HTTPS Port | Mode |
|-----|-----------|------|
| nginx | :1443 | proxy - ACME SSL proxy |
| zitadel | :1443 | native - Traefik |
| gitea | :1443 | native - Gitea built-in |
| oci-lxc-deployer | :3443 | native - Node.js |
| postgres | :5432 | certs - TLS on app port |

URLs in LAN include the port: `https://auth.ohnewarum.de:1443`

### DNS (OpenWrt Router - dnsmasq)

| Domain | Resolves To | Flow |
|--------|-------------|------|
| `ohnewarum.de` | nginx IP | Direct to nginx |
| `auth.ohnewarum.de` | nginx IP | nginx :1443 proxies to zitadel :1443 |
| `git.ohnewarum.de` | nginx IP | nginx :1443 proxies to gitea :1443 |
| `nebenkosten.ohnewarum.de` | nginx IP | nginx :1443 serves static frontend |
| `postgres`, `zitadel`, ... | Container IPs | Internal, no DNAT needed |

## 3. Certificate Strategy

```mermaid
graph LR
    subgraph Nginx["nginx"]
        acme_cert["ACME server cert<br/>*.ohnewarum.de"]
        ca_client_n["Self-signed client cert"]
    end

    subgraph Others["zitadel, gitea, deployer, postgres"]
        ca_cert["Self-signed server cert"]
    end

    LE["Let's Encrypt<br/>via Cloudflare DNS-01"] -->|addon-acme| acme_cert
    CA["Global CA<br/>OCI-LXC-Deployer"] -->|addon-ssl| ca_client_n
    CA -->|addon-ssl| ca_cert

    acme_renewal["acme.sh in nginx<br/>every 60 days"] -.->|renews| acme_cert
    deployer_renewal["oci-lxc-deployer<br/>daily check"] -.->|renews| ca_cert

    style LE fill:#e8f5e9
    style CA fill:#fff3e0
```

**How it works:**

- **Nginx** has two certificates: an ACME wildcard (`*.ohnewarum.de`) as server cert for browsers, and a self-signed cert for mTLS/client verification with backend services
- **All other apps** have self-signed server certificates issued by the global CA
- **Nginx → backend**: `proxy_ssl_trusted_certificate chain.pem` validates backend certs
- **LAN browsers** must trust the global self-signed CA certificate. One-time install on 2 devices (Mac + iPad)

| | Server Cert | Issued By | Addon | Renewal |
|---|---|---|---|---|
| **nginx** | `*.ohnewarum.de` | Let's Encrypt | `addon-acme` | acme.sh (60 days) |
| **zitadel** | `zitadel.local` | Global CA | `addon-ssl` | deployer (daily) |
| **gitea** | `gitea.local` | Global CA | `addon-ssl` | deployer (daily) |
| **deployer** | `oci-lxc-deployer.local` | Global CA | `addon-ssl` | deployer (daily) |
| **postgres** | `postgres.local` | Global CA | `addon-ssl` | deployer (daily) |

## 4. OIDC Authentication

| App | OIDC | Issuer URL |
|-----|------|-----------|
| oci-lxc-deployer | `addon-oidc` | `https://auth.ohnewarum.de:1443` |
| Gitea | `addon-oidc` | `https://auth.ohnewarum.de:1443` |
| Nebenkosten | Client-side PKCE | `https://auth.ohnewarum.de:1443` |
| Homepage | None (public) | — |

- **Zitadel** is the OIDC provider, running with `ZITADEL_EXTERNALDOMAIN=auth.ohnewarum.de`
- **Server-to-server** calls (token exchange, OIDC setup) go directly to `https://zitadel:1443`, bypassing Nginx
- **Browser redirects** go to `https://auth.ohnewarum.de:1443` (resolved to nginx by dnsmasq, proxied to zitadel)

## 5. Addons & Stack System

Cross-cutting concerns (HTTPS, authentication) are managed through **addons**, and shared credentials/connection info through **stacks**.

### Addons

```mermaid
graph LR
    subgraph Addons
        ssl[addon-ssl]
        acme[addon-acme]
        oidc[addon-oidc]
    end

    ssl -->|self-signed certs + renewal| deployer_a[deployer]
    ssl -->|self-signed certs + renewal| zitadel_a[zitadel]
    ssl -->|self-signed certs + renewal| gitea_a[gitea]
    ssl -->|self-signed certs + renewal| postgres_a[postgres]
    acme -->|ACME wildcard cert| nginx_a[nginx]
    ssl -->|CA chain for backends| nginx_a
    oidc -->|OIDC client registration| deployer_a
    oidc -->|OIDC client registration| gitea_a
```

| Addon | What it does |
|-------|-------------|
| **addon-ssl** | Generates self-signed server certs from global CA, configures TLS, auto-renewal via deployer (daily) |
| **addon-acme** | Obtains Let's Encrypt wildcard cert via Cloudflare DNS-01, auto-renewal via acme.sh (60 days) |
| **addon-oidc** | Registers OIDC client in Zitadel, configures app for SSO |

Addons are selected per app at install/reconfigure time via `selectedAddons: ["addon-ssl", "addon-oidc"]`.

### Stacks

Stacks are shared credential stores that connect providers and consumers within an environment:

```
Stack "production" (stacktype: postgres + oidc + cloudflare)
├── entries (secrets):     POSTGRES_PASSWORD, ZITADEL_DB_PASSWORD, CF_TOKEN, ...
└── provides (connection): ZITADEL_URL, ZITADEL_PORT, POSTGRES_PORT, ...
```

- **Providers** (postgres, zitadel) publish connection info to the stack after deployment
- **Consumers** read it automatically via template variables (`{{ ZITADEL_URL }}`)
- When a provider is reconfigured (e.g. SSL added), its provides update — consumers may need reconfiguration

## 6. Installation & Configuration

### oci-lxc-deployer

The management platform that deploys and configures all LXC containers. Runs on `pve1.cluster` as an unprivileged Alpine container.

- **UI**: `https://oci-lxc-deployer:3443` (LAN only)
- **Deploy**: `./production/deploy.sh <app|all>` (runs from PVE host or dev machine)
- **Config**: Shared volumes at `/rpool/data/subvol-999999-oci-lxc-deployer-volumes/`

### Nginx

Nginx serves as both **static host** and **reverse proxy**:

```
/etc/nginx/conf.d/          ← Volume mount (persisted)
├── default.conf            ← Reject unknown domains (444)
├── ohnewarum.conf          ← Static homepage
├── nebenkosten.conf        ← Frontend SPA (try_files)
├── auth.conf               ← Reverse proxy → zitadel:1443
└── git.conf                ← Reverse proxy → gitea:1443
```

Rootless (uid 101), listens on port 8080 (HTTP) and 1443 (HTTPS via ACME wildcard cert). WAN access via OpenWrt port forward `:443 → :1443`. Managed by `setup-nginx.sh`.

---

*For detailed setup instructions, see [README.md](README.md).*
*For the Proxmox snapshot bug report, see [docs/pve-snapshot-bind-mount-bug.md](../docs/pve-snapshot-bind-mount-bug.md).*
