<div align="center">

<img alt="Proxvex Logo" src="docs/assets/proxvex-logo.svg" height="120" />

# Proxvex

Deploy containerized applications to Proxmox LXC containers. Supports Docker/OCI images, npm packages, and custom configurations with a simple Web UI.
</div>

## Quick Install
Run this on your Proxmox host:

```sh
curl -fsSL https://raw.githubusercontent.com/proxvex/proxvex/main/install-proxvex.sh | sh
```

This installs proxvex with DHCP networking. For static IP configuration, see options below.

## Installation Options

### Basic Options
- `--vm-id <id>`: Specific VMID; if omitted, next free VMID is used
- `--disk-size <GB>`: Rootfs size (default: `1`)
- `--memory <MB>`: Memory (default: `512`)
- `--bridge <name>`: Network bridge (default: `vmbr0`)
- `--hostname <name>`: Hostname (default: `proxvex`)
- `--config-volume <path>`: Host path for /config volume (default: auto-detected)
- `--secure-volume <path>`: Host path for /secure volume (default: auto-detected)
- `--storage <name>`: Proxmox storage for OCI image (default: `local`)

### Network Options (Static IP)

**IPv4:**
```sh
curl -fsSL https://raw.githubusercontent.com/proxvex/proxvex/main/install-proxvex.sh \
  | sh -s -- --static-ip 192.168.4.100/24 --static-gw 192.168.4.1
```
- `--static-ip <ip/prefix>`: IPv4 address in CIDR (e.g., `192.168.4.100/24`)
- `--static-gw <ip>`: IPv4 gateway (e.g., `192.168.4.1`)
- `--static-dns <ip>`: DNS server (optional, e.g., `192.168.4.1`)

**IPv6:**
```sh
curl -fsSL https://raw.githubusercontent.com/proxvex/proxvex/main/install-proxvex.sh \
  | sh -s -- --static-ip6 fd00::50/64 --static-gw6 fd00::1
```
- `--static-ip6 <ip/prefix>`: IPv6 address in CIDR (e.g., `fd00::50/64`)
- `--static-gw6 <ip>`: IPv6 gateway (e.g., `fd00::1`)
- `--static-dns6 <ip>`: IPv6 DNS server (optional)

**Dual Stack (IPv4 + IPv6):**
```sh
curl -fsSL https://raw.githubusercontent.com/proxvex/proxvex/main/install-proxvex.sh \
  | sh -s -- \
    --static-ip 192.168.4.100/24 --static-gw 192.168.4.1 \
    --static-ip6 fd00::50/64 --static-gw6 fd00::1
```
## Internal HTTPS — Certificate Authority Setup

`proxvex` automatically issues HTTPS certificates for all deployed containers
using an internal Certificate Authority (CA). This is a one-time setup.

### On the server

During initial setup, `proxvex` generates a CA certificate and private key.
The public CA certificate is available for download at the web UI under **Settings → Certificate Authority → Download CA**.

### On every client machine

To make your browser and local tools trust the internal certificates,
install [mkcert](https://github.com/FiloSottile/mkcert) and register the CA:

```bash
# 1. Download the CA certificate
curl -o rootCA.pem https://<your-deployer>/api/ca/cert

# 2. Point mkcert to the downloaded certificate
export CAROOT=$(pwd)

# 3. Install into the system trust store
mkcert -install
```

For installation instructions per platform (macOS, Linux, Windows) and further details,
refer to the [official mkcert documentation](https://github.com/FiloSottile/mkcert).

> **Note for Node.js:** Node.js does not use the system trust store.
> Set the following environment variable in addition to `mkcert -install`:
> 
> ```bash
> export NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"
> ```
## Access the Web UI
- Open `http://proxvex:3080` from your network (or replace `proxvex` with the container's IP/hostname you configured).
- If Proxmox VE is behind a firewall, ensure port `3080/tcp` is reachable from the browser.

## Key Concepts

### Applications
An **Application** in Proxvex is similar to a `docker-compose.yml` - it defines how to deploy a containerized service. Applications can be:
- **OCI Images**: Any Docker/OCI image (e.g., `docker.io/nodered/node-red:latest`)
- **npm packages**: Node.js applications installed via npm
- **Custom configurations**: Your own templates and scripts

### Stacks (Secrets Management)
**Stacks** store environment-specific secrets (database passwords, API keys) that are injected into applications during deployment. This keeps sensitive data separate from application definitions.

- Create stacks in the Web UI under "Stacks"
- A stack named "default" keeps the original hostname during deployment
- Stacks without external entries are auto-generated

### Addons
**Addons** extend applications with optional features:
- USB device passthrough
- Serial port mapping
- Additional volumes
- Custom scripts

## Documentation

| Document | Description |
|----------|-------------|
| [Deployment Flow](docs/deployment-flow.md) | End-to-end guide: from application selection to running container |
| [Application Development](docs/application-development.md) | Creating custom applications, templates, and scripts |
| [Installation Details](docs/INSTALL.md) | Advanced installation options |

## File Locations

```
json/
├── applications/          # Application definitions
│   └── <app-name>/
│       ├── application.json
│       ├── templates/
│       └── scripts/
├── shared/
│   ├── templates/         # Reusable templates
│   └── scripts/           # Reusable scripts
├── frameworks/            # Application frameworks
├── addons/                # Optional addons
└── stacktypes.json        # Stack type definitions
```

## Why Proxvex?

- **Deploy docker-compose.yml to LXC** - Use familiar Docker images without running Docker
- **Data persistence outside container** - Volumes on host make updates and migrations easy
- **Automatic permission management** - User mapping for volumes and devices handled automatically
- **Persistent log files** - Logs survive container restarts and updates
- **Shared secrets across containers** - Stacks let multiple containers use the same passwords (e.g., Postgres + PostgREST)
- **Flexible inheritance** - Extend existing applications with custom templates
- **Simple Web UI** - Deploy without command-line knowledge

