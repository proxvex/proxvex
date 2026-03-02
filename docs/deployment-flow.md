# Deployment Flow: From Application Selection to Running Container

This guide walks through the complete deployment process in OCI LXC Deployer, from selecting an application in the Web UI to having a running container on your Proxmox host.

## Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           OCI LXC Deployer                              │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌─────────────┐     ┌─────────────┐     ┌─────────────────────────┐   │
│  │   Web UI    │────>│   Backend   │────>│    Proxmox Host         │   │
│  │  (Angular)  │     │  (Node.js)  │     │    (SSH/pct)            │   │
│  └─────────────┘     └─────────────┘     └───────────┬─────────────┘   │
│                                                      │                  │
│                                                      v                  │
│                                          ┌─────────────────────────┐   │
│                                          │    LXC Container        │   │
│                                          │    (Alpine/Debian)      │   │
│                                          │    Running Application  │   │
│                                          └─────────────────────────┘   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

## What is an "Application"?

In OCI LXC Deployer, an **Application** is comparable to a `docker-compose.yml` file - it defines everything needed to deploy a service:

| docker-compose.yml | OCI LXC Deployer Application |
|--------------------|------------------------------|
| `image:` | OCI image reference or npm package |
| `volumes:` | Volume definitions in templates |
| `environment:` | Parameters and Stack entries |
| `ports:` | Network configuration |
| `depends_on:` | Template execution order |

The key difference: OCI LXC Deployer creates **native LXC containers** on Proxmox, not Docker containers. This provides better integration with the Proxmox environment and lower overhead.

---

## Example: Deploying Grafana from an OCI Image 
The example assumes, the Grafana Application does not exist yet.

Let's walk through deploying Grafana as a complete example.
### Step 1: Create an Application from docker-compose.yml
- Select **"OCI Image"** framework
- Enter the Docker image: `docker.io/grafana/grafana:latest`
- Configure basic settings (name, description)
  A docker container can optionally define this parameter already. In this case, the fields will be prefilled

### Step 2: Application Selection

1. Open the Web UI at `http://oci-lxc-deployer:3080`
2. Navigate to **"Applications"**
3. Find **Grafana**


### Step 3: Parameter Configuration

After selecting an application, the **Configuration Dialog** opens:

```
┌─────────────────────────────────────────────────────────┐
│  Configuration for Grafana                              │
│  "Open-source analytics and monitoring platform"        │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌─ Secrets ─────────────────────────────────────────┐  │
│  │  [production ▼]  [✏️ Manage secrets]              │  │
│  └───────────────────────────────────────────────────┘  │
│                                                         │
│  ┌─ Basic Settings ──────────────────────────────────┐  │
│  │  Hostname:     [grafana-prod    ]                 │  │
│  │  VM ID:        [auto            ]                 │  │
│  │  Memory (MB):  [512             ]                 │  │
│  └───────────────────────────────────────────────────┘  │
│                                                         │
│  ┌─ Optional Addons ─────────────────────────────────┐  │
│  │  [ ] USB Device Passthrough                       │  │
│  │  [ ] Additional Volumes                           │  │
│  └───────────────────────────────────────────────────┘  │
│                                                         │
│  [Cancel]                              [Install]        │
└─────────────────────────────────────────────────────────┘
```

#### Parameters

Parameters are values the user can configure:

| Parameter | Description | Example |
|-----------|-------------|---------|
| `hostname` | Container hostname | `grafana-prod` |
| `vm_id` | Proxmox VMID | `auto` or `200` |
| `memory` | Memory in MB | `512` |
| `cores` | CPU cores | `1` |

#### Stacks (Secrets)

Stacks (Secrets) are used to share secrets among several lxc containers.
Example: Postgres and PostgREST. Both need a postgres password. A stack can make sure, both containers will have the same settings(from the stack).

If the application uses a **stacktype**, you'll see a Secrets dropdown:

- **Stacks** contain environment-specific secrets (database passwords, API keys)
- Select an existing stack or create one
- A stack named **"default"** keeps the original hostname (no suffix added)
- Non-default stacks automatically append the stack ID to the hostname (e.g., `grafana-production`)

**Why Stacks?**
- Same application definition can be deployed to multiple environments
- Secrets stay separate from application code
- Easy to rotate credentials without changing the application
### Step 4: Template Resolution

When you click **Install**, the backend resolves which templates to execute:

```
Application: grafana
     │
     ├── grafana-parameters.json      (Application-specific: hostname, etc.)
     │
     └── extends: oci-image
            │
            ├── 011-host-get-oci-image.json       Download OCI image on host
            ├── 100-conf-create-configure-lxc.json   Create LXC container
            ├── 107-conf-oci-lxc-configuration.json  Configure OCI rootfs
            ├── 200-start-lxc.json                   Start container
            ├── 210-wait-for-container-ready.json    Wait for network
            └── 305-post-set-pkg-mirror.json         Configure package mirror
```

**Template Chain:**
1. Application templates are loaded (e.g., `grafana-parameters.json`)
2. If `extends` is defined, parent templates are inherited (from `oci-image`)
3. Templates are sorted by numeric prefix (011 → 100 → 107 → 200 → ...)
4. Application can insert templates using `before`/`after` directives

### Step 5: Variable Substitution

Before executing scripts, the backend replaces `{{variables}}`:

```sh
# Template content:
pct create {{vm_id}} {{template}} --hostname {{hostname}} --memory {{memory}}

# After substitution:
pct create 200 local:vztmpl/alpine-3.19.tar.xz --hostname grafana-prod --memory 512
```

**Variable Sources (in priority order):**
1. **User input** - Values from the Configuration Dialog
2. **Template outputs** - Values produced by previous templates
3. **Defaults** - Default values defined in templates
4. **Stack entries** - Secrets from the selected stack (replace `{{STACK_VAR}}` markers)

### Step 6: Execution on Proxmox Host

Templates execute in order. Each template runs commands either on the **host** (before container exists) or inside the **container** (after start):

```
┌─────────────────────────────────────────────────────────────────┐
│  Template Execution                                              │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  [1] 011-host-get-oci-image.json                                │
│      └── execute_on: host                                       │
│      └── Action: Download OCI image, convert to LXC rootfs      │
│      └── Output: rootfs path on Proxmox storage                 │
│                                                                  │
│  [2] 100-conf-create-configure-lxc.json                         │
│      └── execute_on: host                                       │
│      └── Action: pct create {{vm_id}} with OCI rootfs           │
│      └── Output: vm_id = 200                                    │
│                                                                  │
│  [3] 107-conf-oci-lxc-configuration.json                        │
│      └── execute_on: host                                       │
│      └── Action: Configure LXC for OCI (volumes, user mapping)  │
│                                                                  │
│  [4] 200-start-lxc.json                                         │
│      └── execute_on: host                                       │
│      └── Action: pct start {{vm_id}}                            │
│                                                                  │
│  [5] 210-wait-for-container-ready.json                          │
│      └── execute_on: host                                       │
│      └── Action: Wait for container network connectivity        │
│                                                                  │
│  [6] 305-post-set-pkg-mirror.json                               │
│      └── execute_on: lxc                                        │
│      └── Action: Configure Alpine package mirror (if Alpine)    │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

**Execution Contexts:**
- `execute_on: host` - Runs on the Proxmox host via SSH
- `execute_on: lxc` - Runs inside the LXC container
- `execute_on: host:<hostname>` - Runs inside another container (e.g., for database setup)

### Step 7: Container Running

After all templates complete successfully:

```
┌─────────────────────────────────────────────────────────────────┐
│  Proxmox Container                                               │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  VMID: 200                                                       │
│  Hostname: grafana-prod                                          │
│  Status: running                                                 │
│                                                                  │
│  ┌─ Notes ──────────────────────────────────────────────────┐   │
│  │  oci-lxc-deployer:managed                                │   │
│  │                                                          │   │
│  │  ## Links                                                │   │
│  │  - [Web UI](http://grafana-prod:3000)                    │   │
│  │  - [Logs](http://grafana-prod:3000/logs)                 │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌─ Volumes (Host → Container) ─────────────────────────────┐   │
│  │  /var/lib/oci-lxc-deployer/data/grafana → /data          │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌─ Service ────────────────────────────────────────────────┐   │
│  │  grafana (OpenRC) - running                              │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

**What's Created:**
1. **LXC Container** on Proxmox with the configured resources
2. **Host volumes** mounted into the container for persistent data
3. **OpenRC/systemd service** that starts the application
4. **Notes** in Proxmox with links to the Web UI

---

## Step-by-Step: Creating Your Own Application

### Option 1: Use "Create Application" (Recommended)

1. Click **"Create Application"** in the Web UI
2. Select **"OCI Image"** framework
3. Enter the Docker image name (e.g., `docker.io/library/redis:latest`)
4. Fill in:
   - **Name**: Human-readable name (e.g., "Redis Cache")
   - **ID**: Unique identifier (e.g., `redis-cache`)
   - **Description**: What the application does
   - **Volumes**: Directories to persist (e.g., `data=/data`)
   - **UID/GID**: User inside the container (usually `1000:1000`)
5. Save → Application is ready to deploy

### Option 2: Create JSON Manually

Create `json/applications/my-app/application.json`:

```json
{
  "name": "My Application",
  "description": "Description of my application",
  "extends": "oci-image",
  "installation": [
    "set-parameters.json"
  ]
}
```

Create `json/applications/my-app/templates/set-parameters.json`:

```json
{
  "name": "My Application Parameters",
  "commands": [
    {
      "properties": [
        { "id": "hostname", "value": "my-app" },
        { "id": "oci_image", "value": "docker.io/library/my-image:latest" },
        { "id": "volumes", "value": "data=/data" },
        { "id": "uid", "value": "1000" },
        { "id": "username", "value": "app" }
      ]
    }
  ]
}
```

---

## Troubleshooting

### Template Execution Fails

1. Check the **Process Monitor** in the Web UI for error details
2. Look at `/tmp/oci-lxc-deployer-*.log` on the Proxmox host
3. Verify the container is created: `pct list`
4. Check container logs: `pct enter <vmid>` → `rc-status` or `journalctl`

### Stack/Secrets Not Applied

1. Verify the stack exists in the Stacks page
2. Check that the application defines a `stacktype`
3. Ensure marker syntax is correct: `{{MARKER_NAME}}`

### Container Starts but Application Doesn't

1. Enter the container: `pct enter <vmid>`
2. Check service status: `rc-service <app> status` or `systemctl status <app>`
3. Check logs: `/var/log/<app>/` or `journalctl -u <app>`
4. Verify volumes are mounted: `mount | grep /data`

---

## Next Steps

- **[Application Development Guide](application-development.md)** - Deep dive into templates, scripts, and frameworks
- **[README](../README.md)** - Installation and quick start
