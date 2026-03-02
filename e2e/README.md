# E2E Tests for oci-lxc-deployer

End-to-end tests using a nested Proxmox VM to test the full deployment workflow.

## Prerequisites

- SSH access to a Proxmox VE host (e.g., `ubuntupve`)
- SSH key authentication configured (`ssh-copy-id root@ubuntupve`)
- Sufficient resources on the host (4GB RAM, 32GB disk for test VM)
- `jq` installed locally (for config parsing)

## Quick Start

```bash
cd e2e

# Step 1: Create nested Proxmox VM (~2 min)
./step1-create-vm.sh

# Step 2: Install deployer (~1.5 min)
./step2-install-deployer.sh

# Access deployer
open http://ubuntupve:13000
```

## Workflow

| Task | Command | Duration |
|------|---------|----------|
| Create nested VM | `./step1-create-vm.sh` | ~2 min |
| Install deployer | `./step2-install-deployer.sh` | ~92s |
| Update code only | `./step2-install-deployer.sh --update-only` | ~24s |
| Install CI infra | `./install-ci.sh --runner-host pve1 --worker-host ubuntupve --github-token <token>` | |
| Init template tests | `./script2a-template-tests.sh` | |
| Clean test containers | `./clean-test-containers.sh` | ~5s |
| Fresh start | `./step1-create-vm.sh && ./step2-install-deployer.sh` | ~3.5 min |

## Files

```
e2e/
├── config.json                  # Instance configuration (ports, subnets, etc.)
├── config.sh                    # Shared config loader for all scripts
├── step0-create-iso.sh          # Create custom Proxmox ISO (one-time)
├── step1-create-vm.sh           # Create nested Proxmox VM
├── step2-install-deployer.sh    # Install/update oci-lxc-deployer
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

```json
{
  "default": "dev",
  "pveHost": "ubuntupve",
  "ports": {
    "pveWeb": 18006,
    "pveSsh": 10022,
    "deployer": 13000
  },
  "instances": {
    "dev": {
      "vmid": 9000,
      "subnet": "10.99.0",
      "portOffset": 0
    }
  }
}
```

### Multiple Instances

Run multiple isolated test environments by adding instances to `config.json`:

```bash
# Use specific instance
./step1-create-vm.sh ci
./step2-install-deployer.sh ci

# Or via environment variable
E2E_INSTANCE=ci ./step1-create-vm.sh
```

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

### step2-install-deployer.sh

Installs oci-lxc-deployer in the nested VM:
- Creates deployer LXC container (VMID 300)
- Installs Node.js and dependencies
- Deploys local package with production dependencies
- Configures API and port forwarding

Options:
- `--update-only`: Skip container creation, just update code (~24s)

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
ssh -p 10022 root@ubuntupve "pct exec 300 -- cat /var/log/oci-lxc-deployer.log"

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
