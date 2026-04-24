# E2E Tests for proxvex

End-to-end tests using a nested Proxmox VM to test the full deployment workflow.

## Prerequisites

- SSH access to a Proxmox VE host (e.g., `ubuntupve`)
- SSH key authentication configured (`ssh-copy-id root@ubuntupve`)
- Sufficient resources on the host (4GB RAM, 32GB disk for test VM)
- `jq` installed locally (for config parsing)

## Quick Start

```bash
cd e2e

# Defaults to the 'green' instance (vmId 9000 on ubuntupve). Pass 'yellow',
# 'github-action' or another instance name as the first argument to target
# a different one.

# Step 1: Create nested Proxmox VM (~2 min) — ends with snapshot 'baseline'
./step1-create-vm.sh

# Step 2a: Install Docker + fill registry mirrors (~15 min, once)
#          ends with snapshot 'mirrors-ready' on top of baseline
#          Idempotent: re-running with unchanged versions.sh exits immediately.
#          Pass --force for a full rebuild.
./step2a-setup-mirrors.sh

# Step 2b: Install proxvex via local docker build → skopeo → OCI archive → pct
#          ends with snapshot 'deployer-installed' on top of mirrors-ready
./step2b-install-deployer.sh

# Access deployer
open http://ubuntupve:13000
```

### green + yellow worktrees

The repo is typically checked out twice as parallel worktrees (`proxvex-green`
and `proxvex-yellow`). Each worktree runs its own local deployer on a different
port and targets its own nested VM on ubuntupve:

| Worktree | Instance | `DEPLOYER_PORT` | nested VM | PVE SSH port |
|---|---|---|---|---|
| proxvex-green  | `green`  | 3201 | 9000 | 1022 |
| proxvex-yellow | `yellow` | 3301 | 9002 | 1222 |

`DEPLOYER_PORT` is set by each worktree's VS Code workspace file. The livetest
skill (`.claude/commands/livetest.md`) derives the target instance from this
env var.

First-time bootstrap for a fresh instance (example: yellow):

```bash
./step1-create-vm.sh yellow        # VM 9002, baseline
./step2a-setup-mirrors.sh yellow   # mirrors-ready
./step2b-install-deployer.sh yellow  # deployer-installed
```

## Workflow

| Task | Command | Duration |
|------|---------|----------|
| Create nested VM | `./step1-create-vm.sh` | ~2 min |
| Fill registry mirrors (once) | `./step2a-setup-mirrors.sh` | ~15 min |
| Install / rebuild proxvex | `./step2b-install-deployer.sh` | ~2 min |
| Install CI infra | `./install-ci.sh --runner-host pve1 --worker-host ubuntupve --github-token <token>` | |
| Init template tests | `./script2a-template-tests.sh` | |
| Clean test containers | `./clean-test-containers.sh` | ~5s |
| Fresh proxvex on filled mirrors | `./step2b-install-deployer.sh` | ~2 min |
| Full wipe | `./step1-create-vm.sh && ./step2a-setup-mirrors.sh && ./step2b-install-deployer.sh` | ~20 min |

For fast code iteration without nested-VM involvement, use `docker/test.sh`
against the local Docker image (seconds).

## Files

```
e2e/
├── config.json                  # Instance configuration (ports, subnets, etc.)
├── config.sh                    # Shared config loader for all scripts
├── step0-create-iso.sh          # Create custom Proxmox ISO (one-time)
├── step1-create-vm.sh           # Create nested Proxmox VM → snapshot 'baseline'
├── step2a-setup-mirrors.sh      # Fill registry mirrors → snapshot 'mirrors-ready'
├── step2b-install-deployer.sh   # Install proxvex via docker build + skopeo + OCI archive
│                                #   → snapshot 'deployer-installed'
├── install-ci.sh                # Install CI infrastructure (runner + test-worker)
├── script2a-template-tests.sh   # Initialize nested VM for template tests
├── clean-test-containers.sh     # Remove test containers, keep deployer
├── applications/                # Application definitions for deployment tests
├── tests/                       # Playwright E2E test specs
├── utils/                       # Test utility functions
├── fixtures/                    # Playwright test fixtures
├── global-setup.ts              # Playwright global setup (build verification)
├── pve1-scripts/                # Scripts for Proxmox ISO customization
└── scripts/                     # Helper scripts (port forwarding, snapshots, cleanup)
```

## Configuration

### config.json

Central configuration for all E2E instances:

```jsonc
{
  "default": "green",
  "instances": {
    "green":  { "vmId": 9000, "portOffset":    0, "deployerPort": "${DEPLOYER_PORT:-3201}", ... },
    "yellow": { "vmId": 9002, "portOffset":  200, "deployerPort": "${DEPLOYER_PORT:-3301}", ... },
    "github-action": { "vmId": 9001, "portOffset": 1000, ... }
  }
}
```

### Multiple instances

Pass the instance name as the first positional argument to any step-script.
Every step is instance-aware; omitting the argument falls back to `default`.

```bash
./step1-create-vm.sh yellow
./step2a-setup-mirrors.sh yellow
./step2b-install-deployer.sh yellow

# Or via environment variable
E2E_INSTANCE=yellow ./step1-create-vm.sh
```

`portOffset` avoids host-port collisions when multiple instances share one
outer PVE host: `pveSsh` host port becomes `1022 + portOffset`, `pveWeb` is
`1008 + portOffset`, and so on.

## Network Architecture

```
Developer Machine
       │
       ▼ (Port Forwarding)
┌──────────────────────────────────────────┐
│ PVE Host (ubuntupve)                     │
│   Port 18006 → nested:8006 (Web UI)      │
│   Port 10022 → nested:22 (SSH)           │
│   Port 13000 → nested:3080 (Deployer)    │
│                                          │
│   ┌────────────────────────────────────┐ │
│   │ Nested PVE VM (10.99.0.10)         │ │
│   │   vmbr1: 10.99.0.1/24 (NAT)        │ │
│   │                                    │ │
│   │   ┌──────────────────────────────┐ │ │
│   │   │ Deployer LXC (10.99.0.100)   │ │ │
│   │   │   Port 3080 (API)            │ │ │
│   │   └──────────────────────────────┘ │ │
│   │                                    │ │
│   │   ┌──────────────────────────────┐ │ │
│   │   │ Test Containers              │ │ │
│   │   │   (created by E2E tests)     │ │ │
│   │   └──────────────────────────────┘ │ │
│   └────────────────────────────────────┘ │
└──────────────────────────────────────────┘
```

## Scripts

### step1-create-vm.sh

Creates a nested Proxmox VM from the custom ISO:
- Downloads/uses existing Proxmox ISO
- Creates QEMU VM with nested virtualization
- Waits for unattended installation
- Configures NAT networking (vmbr1)
- Sets up persistent port forwarding

### step2a-setup-mirrors.sh

Rolls back to `baseline` and fills the Docker Hub + ghcr.io pull-through
caches on the nested VM:
- Installs Docker inside the nested VM
- Starts two `distribution/distribution:3.0.0` mirrors bound to 10.0.0.1 / 10.0.0.2
- Pre-pulls all images referenced by `json/shared/scripts/library/versions.sh`
- Wires dnsmasq so LXC containers resolve registry hostnames to the mirrors
- Creates the `mirrors-ready` snapshot

Run once per environment; step2b requires `mirrors-ready` and aborts if missing
(re-filling mirrors on every run hits Docker Hub rate limits).

### step2b-install-deployer.sh

Rolls back to `mirrors-ready` and installs proxvex via the same OCI path the
production install uses:
- `pnpm build` + `npm pack` + `docker build -f docker/Dockerfile.npm-pack`
- `skopeo copy docker-daemon:proxvex:local oci-archive:…` to get a pct-createable tarball
- `scp` tarball to `/var/lib/vz/template/cache/proxvex-local.tar` on the nested VM
- `install-proxvex.sh --use-existing-image <tar>` creates the deployer LXC
- Sets up iptables port forwarding
- Creates the `deployer-installed` snapshot (what livetests roll back to)

No `--update-only` mode — for fast code iteration use `docker/test.sh` against
the local image instead (seconds, no nested-VM roundtrip).

### install-ci.sh

Installs CI infrastructure on Proxmox hosts (runner + test-worker):
- Creates a GitHub Actions runner LXC on the runner host (from OCI image)
- Creates a CI test-worker LXC on the worker host (from OCI image)
- Generates an SSH key pair for inter-container communication
- Configures environment variables for `pvetest` integration

Required arguments:
- `--runner-host <host>`: Proxmox host for GitHub runner (e.g., `pve1.cluster`)
- `--worker-host <host>`: Proxmox host for test-worker (e.g., `ubuntupve`)
- `--github-token <token>`: GitHub PAT with repository Administration read/write permission

Run `./install-ci.sh --help` for all options.
Example:
```
install-ci.sh --runner-host pve1.cluster --worker-host  ubuntupve --github-token github_pat_1******
```

### script2a-template-tests.sh

Initializes the nested VM for template tests:
- Checks SSH connectivity to nested VM
- Verifies Proxmox tools and storage
- Downloads OS templates (Alpine + Debian)
- Runs a smoke test (create, start, readiness-check, destroy)
- Cleans up leftover test containers (VMID 9900-9999)

### clean-test-containers.sh

Removes test containers while preserving the deployer:
- Stops and destroys all LXC containers except VMID 300
- Cleans up associated volumes in `/mnt/pve-volumes/*/volumes/`
- Use between test runs to reset state quickly

## Troubleshooting

### SSH connection fails

```bash
# Ensure SSH key is copied to PVE host
ssh-copy-id root@ubuntupve

# Test connection
ssh root@ubuntupve "pveversion"
```

### Port forwarding not working after reboot

The port forwarding service should persist across reboots. Check status:

```bash
ssh root@ubuntupve systemctl status e2e-port-forwarding
ssh root@ubuntupve journalctl -u e2e-port-forwarding
```

### Deployer API not responding

```bash
# Check container status
ssh -p 10022 root@ubuntupve "pct status 300"

# Check logs
ssh -p 10022 root@ubuntupve "pct exec 300 -- cat /var/log/proxvex.log"

# Restart container
ssh -p 10022 root@ubuntupve "pct stop 300 && pct start 300"
```

### Container has no network

```bash
# Re-activate network manually
ssh -p 10022 root@ubuntupve "pct exec 300 -- sh -c '
  ip link set lo up
  ip link set eth0 up
  ip addr add 10.99.0.100/24 dev eth0
  ip route add default via 10.99.0.1
'"
```
