# Production Infrastructure Overview

> Architecture reference for the ohnewarum.de production deployment.
> For step-by-step setup instructions, see [README.md](README.md).

## 1. Cluster Topology

```mermaid
graph TB
    subgraph pve1["pve1.cluster - always-on, primary"]
        deployer[proxvex :3443]
        postgres[postgres :5432]
        nginx[nginx :443]
        zitadel[zitadel :1443]
        mosquitto[mosquitto :8883]
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

All containers are **unprivileged LXC** managed by proxvex. Shared volumes on ZFS (`subvol-999999-proxvex-volumes`).

## 2. Network & Public Access

### IP Strategy

| Type | Apps | IP | DNS Resolution |
|------|------|----|----------------|
| **DHCP** (internal) | deployer, postgres, zitadel, gitea | Automatic | dnsmasq learns hostname via DHCP |
| **Static** (external) | nginx, mosquitto, wireguard | Fixed | Manual DNS entries in dnsmasq |

Internal apps need no static IPs — dnsmasq on the OpenWrt router resolves their hostnames automatically from DHCP leases. External apps need static IPs because they are NAT targets or must be reachable from outside the subnet.

### Routing Overview

```mermaid
graph LR
    subgraph WAN["Internet"]
        browser_wan["Browser"]
        phone["Phone (mobile IPv6)"]
        cf["Cloudflare Tunnel edge"]
    end

    subgraph Fritz["FritzBox (DS-Lite, no public IPv4)"]
        fb_share["IPv6 share UDP 51820<br/>→ router-kg WAN ::5aea:1fff:fe1a:37b9"]
    end

    subgraph Router["OpenWrt router-kg"]
        dns["dnsmasq split DNS<br/>ohnewarum.de, git, auth → 192.168.4.41<br/>vpn → (public AAAA only)"]
        dnat_wg["DNAT wan:51820 → fd29:cd10:9a98::53"]
    end

    subgraph PVE["PVE Host - pve1.cluster (VLAN 4, 192.168.4.0/24)"]
        subgraph External["Static IP"]
            nginx_c["nginx :443<br/>192.168.4.41<br/>ACME wildcard"]
            mosquitto_c["mosquitto :8883<br/>192.168.4.44"]
            wireguard_c["wireguard (wg-easy)<br/>192.168.4.53 / ::53<br/>UDP 51820, UI :443"]
            cloudflared["cloudflare-tunnel<br/>(outbound only)"]
        end
        subgraph Internal["Internal (DHCP)"]
            zitadel_c["zitadel :1443"]
            gitea_c["gitea :1443"]
            deployer_c["deployer :3443"]
            postgres_c["postgres :5432"]
        end
    end

    subgraph LAN["LAN / WireGuard clients"]
        browser_lan["Browser"]
        iot["IoT / MQTT clients (VLAN 4)"]
    end

    browser_wan -->|"ohnewarum.de"| cf
    cloudflared -.->|"outbound"| cf
    cloudflared -->|":443"| nginx_c

    phone -->|"vpn.ohnewarum.de UDP 51820"| fb_share
    fb_share --> dnat_wg
    dnat_wg --> wireguard_c

    browser_lan -->|"git/auth.ohnewarum.de"| dns
    dns --> nginx_c
    nginx_c -->|proxy_pass| zitadel_c
    nginx_c -->|proxy_pass| gitea_c

    iot -->|"mqtt.ohnewarum.de:8883"| mosquitto_c

    browser_lan -->|"hostname:port"| deployer_c
```

### Access model

- **Public:** only `ohnewarum.de` (and `www`), via the Cloudflare Tunnel. cloudflared connects *outbound*; no inbound port is open for it on the FritzBox or the router.
- **Everything else** (gitea, zitadel, deployer, heimvio, …): LAN and **WireGuard** only. `git.ohnewarum.de` and `auth.ohnewarum.de` are no longer in the tunnel.
- **Inbound from the internet:** exactly one path — UDP 51820 (IPv6) for WireGuard. Details and the reasons for DNAT + `sourcefilter '0'`: `json/applications/wireguard/application.md`, section *IPv6 and DS-Lite*.

### Split DNS

LAN and WireGuard clients resolve the nginx-served names straight to nginx on 443 — no hairpin through the router. The ACME wildcard certificate (DNS-01) is valid for them, so `https://auth.ohnewarum.de` works identically for every client — required for OIDC issuer URL consistency.

### HTTPS Port Convention

| App | HTTPS Port | Mode |
|-----|-----------|------|
| nginx | :443 | certs - ACME wildcard; binds 443 as uid 101 via the init wrapper (`unprivileged_port_start: 443`) |
| wireguard | :443 | proxy - addon-ssl nginx in front of wg-easy :51821 |
| zitadel | :1443 | native - Traefik |
| gitea | :1443 | native - Gitea built-in |
| proxvex | :3443 | native - Node.js |
| postgres | :5432 | certs - TLS on app port |
| mosquitto | :8883 | certs - TLS on MQTTS port |

Direct LAN URLs include the port where it is not 443 (e.g. `https://zitadel:1443`).

### DNS (OpenWrt Router - dnsmasq)

| Domain | Resolves To | Flow |
|--------|-------------|------|
| `ohnewarum.de`, `www.ohnewarum.de` | 192.168.4.41 | nginx :443 → static homepage (public via Cloudflare Tunnel) |
| `auth.ohnewarum.de` | 192.168.4.41 | nginx :443 → zitadel :1443 (internal only) |
| `git.ohnewarum.de` | 192.168.4.41 | nginx :443 → gitea :1443 (internal only) |
| `mqtt.ohnewarum.de` | 192.168.4.44 | mosquitto :8883 directly (clients in VLAN 4) |
| `wireguard` | 192.168.4.53 | wg-easy web UI :443 |
| `vpn.ohnewarum.de` | public AAAA only | router-kg WAN address, kept by DDNS `vpn_ipv6` |
| Internal hostnames | DHCP IP | dnsmasq auto-resolves from DHCP leases |

### Router rules (OpenWrt)

| Rule | From | Port | To | Purpose |
|------|------|------|----|---------|
| `lan-cluster-allow-https-443` | lan | tcp 443 | nginx 192.168.4.41 | LAN reaches nginx directly |
| `wan-cluster-dnat-wireguard-udp-51820` | wan (IPv6) | udp 51820 | DNAT → `fd29:cd10:9a98::53` | WireGuard |
| `mqtts-to-mosquitto` (legacy) | lan → 192.168.1.1 | tcp 8883 | mosquitto | old hairpin path, unused once all clients use 192.168.4.44 |

No WAN DNAT for HTTPS exists anymore; `wan6` has `option sourcefilter '0'` (see wireguard docs).

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
    CA["Global CA<br/>Proxvex"] -->|addon-ssl| ca_client_n
    CA -->|addon-ssl| ca_cert

    acme_renewal["acme.sh in nginx<br/>every 60 days"] -.->|renews| acme_cert
    deployer_renewal["proxvex<br/>daily check"] -.->|renews| ca_cert

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
| **zitadel** | `zitadel` | Global CA | `addon-ssl` | deployer (daily) |
| **gitea** | `gitea` | Global CA | `addon-ssl` | deployer (daily) |
| **deployer** | `proxvex` | Global CA | `addon-ssl` | deployer (daily) |
| **postgres** | `postgres` | Global CA | `addon-ssl` | deployer (daily) |

## 4. OIDC Authentication

| App | OIDC | Issuer URL |
|-----|------|-----------|
| proxvex | `addon-oidc` | `https://auth.ohnewarum.de` |
| Gitea | `addon-oidc` | `https://auth.ohnewarum.de` |
| Nebenkosten | Client-side PKCE | `https://auth.ohnewarum.de` |
| Homepage | None (public) | — |

- **Zitadel** is the OIDC provider, running with `ZITADEL_EXTERNALDOMAIN=auth.ohnewarum.de` and `ZITADEL_EXTERNALPORT=443`
- **Server-to-server** calls (token exchange, OIDC setup) go directly to `https://zitadel:1443`, bypassing Nginx
- **Browser redirects** go to `https://auth.ohnewarum.de` (port 443 — resolved to nginx 192.168.4.41 by dnsmasq, proxied to zitadel)

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

### proxvex

The management platform that deploys and configures all LXC containers. Runs on `pve1.cluster` as an unprivileged Alpine container.

- **UI**: `https://proxvex:3443` (LAN only)
- **Deploy**: `./production/deploy.sh <app|all>` (runs from PVE host or dev machine)
- **Config**: Shared volumes at `/rpool/data/subvol-999999-proxvex-volumes/`

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
