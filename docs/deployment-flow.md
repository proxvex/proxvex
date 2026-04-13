# Deployment Flow: From Installation to Running Containers

This guide covers the full deployment lifecycle of OCI LXC Deployer (OLD) — from installing the deployer itself through to managing applications on Proxmox VE hosts.

## Overview

OCI LXC Deployer creates **native LXC containers** on Proxmox VE. It is itself an LXC container that manages other containers via SSH.

```
┌─────────────────────────────────────────────────────────┐
│  Proxmox VE Host                                        │
│                                                         │
│  ┌─────────────────────┐     ┌────────────────────┐    │
│  │ OCI LXC Deployer    │────>│ App Container 1    │    │
│  │ (LXC, manages all)  │     │ (postgres, etc.)   │    │
│  │                      │────>│ App Container 2    │    │
│  │  Web UI + API        │     │ (zitadel, etc.)    │    │
│  │  SSH to PVE host     │────>│ App Container N    │    │
│  └─────────────────────┘     └────────────────────┘    │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

For a single PVE host, one OLD instance is sufficient. Hub/Spoke setups for multi-host environments are covered in the [Advanced: Hub/Spoke](#advanced-hubspoke-architecture) section.

---

## 1. Installing the Deployer

Install OLD on a Proxmox VE host:

```bash
curl -fsSL https://raw.githubusercontent.com/modbus2mqtt/oci-lxc-deployer/main/install-oci-lxc-deployer.sh | bash -s -- --vm-id 300
```

This creates an LXC container running the deployer with:
- **Config volume** (`/mnt/volumes/<hostname>/config/`) — persistent configuration, ZFS-protected
- **Secure volume** (`/mnt/volumes/<hostname>/secure/`) — SSH keys, certificates, secrets
- **Web UI** on port 3080 (HTTP) or 3443 (HTTPS after SSL setup)

---

## 2. Production Setup

A typical production installation follows this order. Each step depends on the previous ones.

### Step 1: Install Deployer

```bash
install-oci-lxc-deployer.sh --vm-id 300
```

### Step 2: Set Project Defaults

Configure project-specific parameters (VM ID range, mirrors, OIDC issuer URL). This writes a template into the deployer's config volume:

```bash
#!/bin/sh
# production/project.sh — Example for ohnewarum.de

CONFIG_VOL="/rpool/data/subvol-999999-oci-lxc-deployer-volumes/volumes/oci-lxc-deployer/config"
SHARED_VOL="${CONFIG_VOL}/shared/templates"

mkdir -p "${SHARED_VOL}/create_ct"
cat > "${SHARED_VOL}/create_ct/050-set-project-parameters.json" << 'EOF'
{
  "name": "Set Project Parameters",
  "description": "Project-specific defaults",
  "commands": [
    { "properties": { "id": "vm_id_start", "default": "500" } },
    { "properties": { "id": "oidc_issuer_url", "default": "https://auth.ohnewarum.de" } },
    { "properties": { "id": "alpine_mirror", "default": "https://mirror1.hs-esslingen.de/Mirrors/alpine/" } },
    { "properties": { "id": "debian_mirror", "default": "http://mirror.23m.com/debian/" } }
  ]
}
EOF

chown -R --reference="${CONFIG_VOL}" "${CONFIG_VOL}"
```

The template is picked up automatically by the deployer — all subsequent installations use these defaults.

### Step 3: Docker Registry Mirror

Install early to avoid Docker Hub rate limits for all subsequent container deployments.

### Step 4: Create Stacks

Stacks hold shared secrets (database passwords, OIDC credentials, API keys) that are reused across containers.

Create at minimum:
- **postgres** stack — database credentials shared by postgres and its consumers
- **oidc** stack — OIDC client credentials shared by Zitadel and OIDC-enabled applications

Additional stacks as needed (gitea, pgadmin, etc.).

### Step 5: Postgres + Zitadel

Install postgres first, then Zitadel for OIDC authentication:
1. **postgres** — database backend for Zitadel
2. **zitadel** — OIDC identity provider

### Step 6: Configure Zitadel for Deployer

In the Zitadel UI:
1. Create a deployer user with **IAM_ORG_OWNER** role
2. Assign the **oci-lxc-deployer** application to this user

### Step 7: Reconfigure Deployer with SSL + OIDC

Reconfigure the deployer itself to enable HTTPS and OIDC authentication:
- Select addons: **addon-ssl**, **addon-oidc**
- This creates a new container with SSL certificates and OIDC login

After this step, the deployer is fully secured and ready for production use.

---

## 3. Deploying Applications

### What is an "Application"?

An Application defines everything needed to deploy a service — comparable to a `docker-compose.yml`:

| Concept | OCI LXC Deployer |
|---------|-----------------|
| Image | OCI image reference or docker-compose.yml |
| Volumes | Volume definitions in templates |
| Environment | Parameters + Stack entries |
| Ports | Network configuration |
| Dependencies | Template execution order + Stack references |

### Configuration Dialog

When deploying an application, the Configuration Dialog opens:
- **Secrets** — Select or create a stack for shared credentials
- **Basic Settings** — Hostname, VM ID, memory, cores
- **Optional Addons** — SSL, OIDC, USB passthrough, etc.

### Template Execution

Clicking **Install** triggers template execution:

1. **Templates are resolved** — application templates + inherited templates from the framework (e.g., `oci-image` or `docker-compose`), sorted by numeric prefix
2. **Variables are substituted** — `{{ hostname }}`, `{{ vm_id }}`, stack entries
3. **Commands execute in order** on the PVE host (`execute_on: ve`) or inside the container (`execute_on: lxc`)

```
[1] Download OS template / OCI image          (execute_on: ve)
[2] Create LXC container                      (execute_on: ve)
[3] Configure LXC (volumes, user mapping)     (execute_on: ve)
[4] Start container                           (execute_on: ve)
[5] Wait for network                          (execute_on: ve)
[6] Install packages, configure services      (execute_on: lxc)
[7] Start application                         (execute_on: lxc)
```

### Variable Sources (priority order)

1. **User input** — values from the Configuration Dialog
2. **Template outputs** — values produced by previous templates
3. **Defaults** — default values defined in templates
4. **Stack entries** — secrets from the selected stack

### Execution Contexts

| Context | Where it runs | Example |
|---------|--------------|---------|
| `ve` | On the PVE host via SSH | `pct create`, `pct start` |
| `lxc` | Inside the LXC container | Package install, service config |
| `host:<hostname>` | Inside another container | Database setup on postgres container |

### Result

After successful deployment:
- **LXC container** running on Proxmox with configured resources
- **Persistent volumes** on the host filesystem (ZFS-backed)
- **Container notes** with `oci-lxc-deployer:managed` marker, web links, and version info
- **Service** running inside the container (OpenRC or systemd)

---

## 4. Shared Services

Several services are shared across containers and managed by the deployer.

### Certificate Authority (CA)

The deployer generates a self-signed CA and signs server certificates for containers with the SSL addon. The CA is stored encrypted in `storagecontext.json`.

- **CA generation**: automatic on first SSL container deployment
- **Server certs**: signed by the CA, stored per hostname
- **Domain suffix**: configurable (default: `.local`)

### Stacks (Secrets)

Stacks share secrets between containers. A postgres stack contains the database password used by both the postgres container and its consumers (Zitadel, PostgREST, etc.).

- **Stacktypes** define which variables a stack contains (e.g., `postgres` stacktype has `POSTGRES_PASSWORD`)
- **Auto-generated secrets**: non-external variables get random values automatically
- **Multiple stacks per type**: e.g., `postgres_default` and `postgres_production` with different passwords

### Docker Registry Mirror

A registry mirror avoids Docker Hub rate limits. Install it early — all subsequent Docker-based containers benefit from it.

### OIDC (Zitadel)

Zitadel provides OIDC authentication for the deployer UI and other applications. After Zitadel is running, applications can use the `addon-oidc` addon to protect their web interfaces.

---

## 5. Creating Custom Applications

### From the UI (Recommended)

1. Click **"Create Application"**
2. Select framework: **"OCI Image"** or **"Docker Compose"**
3. Enter the Docker image or paste a `docker-compose.yml`
4. Configure name, description, volumes, UID/GID
5. Save — ready to deploy

### From JSON

Create `json/applications/my-app/application.json`:

```json
{
  "name": "My Application",
  "description": "Description of my application",
  "extends": "oci-image",
  "installation": {
    "create_ct": ["set-parameters.json"]
  }
}
```

See [Application Development Guide](application-development.md) for details.

---

## 6. Troubleshooting

### Template Execution Fails

1. Check the **Process Monitor** in the Web UI for error details
2. Look at container logs: `pct enter <vmid>` then `rc-status` or `journalctl`
3. Verify container exists: `pct list` on the PVE host

### Stack/Secrets Not Applied

1. Verify the stack exists in the Stacks page
2. Check that the application defines a `stacktype`
3. Ensure the correct stack is selected in the Configuration Dialog

### Container Starts but Application Doesn't

1. Enter the container: `pct enter <vmid>`
2. Check service status: `rc-service <app> status`
3. For Docker Compose apps: `docker compose ps` and `docker compose logs`

---

## Advanced: Hub/Spoke Architecture

For environments with multiple PVE hosts or separate test/production domains, OLD supports a Hub/Spoke model.

### When You Need It

Hub/Spoke is designed for **test and development infrastructure**, not for production deployments. A single OLD instance on each PVE host is sufficient for production — even across multiple hosts.

The primary use case is automated testing with ephemeral environments:
- Nested PVE VMs that need a shared CA and stacks from a persistent host
- Separate test CA domain so test certificates never work against production
- CI/CD pipelines that spin up and destroy test environments

### Architecture

```
PRODUCTION (no Hub/Spoke needed):       TEST INFRASTRUCTURE:
┌──────────────────┐                   ┌──────────────────┐
│ pve1.cluster     │                   │ ubuntupve        │
│ OLD (standalone) │                   │ OLD (Hub)        │
│ Production CA    │                   │ Test CA          │
└──────────────────┘                   └───────┬──────────┘
                                               │
                                      ┌────────┼─────────┐
                                      │        │         │
                                   nested    nested    nested
                                   VM dev    VM CI     VM ...
                                   (Spoke)   (Spoke)   (Spoke)
```

Production hosts run standalone OLD instances. Hub/Spoke is only used for the test environment where ephemeral nested VMs need CA and stacks from the persistent test host.

### Modes

| Mode | Stacks | CA | When |
|------|--------|-----|------|
| **Hub** (default) | Local | Local | Single deployer, or CA authority in a cluster |
| **Spoke** | Via Hub API | Via Hub API | Additional deployers connecting to a Hub |

Every deployer is a Hub by default. It becomes a Spoke when `HUB_URL` is set and server certificates are present.

### Spoke Configuration

Install the deployer normally, then configure Spoke mode:

```bash
# Environment variable on the Spoke deployer container
HUB_URL=https://hub-deployer.example:3443
```

The Spoke uses its own HTTPS server certificate as an mTLS client certificate to authenticate with the Hub. Both certificates must be signed by the same CA.

If `HUB_URL` is set but certificates are missing, the deployer logs a warning and continues as Hub.

### Hub API Endpoints

Every deployer exposes Hub endpoints (used by Spokes):

| Endpoint | Purpose |
|----------|---------|
| `POST /api/hub/ca/sign` | Sign a certificate (mTLS required) |
| `GET /api/hub/ca/cert` | Get CA public certificate |
| `GET /api/hub/stacks` | List stacks (mTLS required) |
| `POST /api/hub/stacks` | Create stack (mTLS required) |
| `GET /api/hub/stack/:id` | Get stack (mTLS required) |
| `DELETE /api/hub/stack/:id` | Delete stack (mTLS required) |

---

## Next Steps

- **[Application Development Guide](application-development.md)** — Templates, scripts, frameworks
- **[README](../README.md)** — Installation and quick start
