# E2E Tests for proxvex

End-to-end tests using a nested Proxmox VM to test the full deployment workflow.

## Prerequisites

- SSH access to a Proxmox VE host (e.g., `ubuntupve`)
- SSH key authentication configured (`ssh-copy-id root@ubuntupve`)
- Sufficient resources on the host (4GB RAM, 32GB disk for test VM)
- `jq` installed locally (for config parsing)

### Initial config setup (local)

`e2e/config.json` contains infrastructure details (PVE host, subnets, IPs) and
is gitignored. Copy the template and fill in your values once:

```bash
cp e2e/config.json.example e2e/config.json
$EDITOR e2e/config.json    # replace YOUR_PVE_HOST / YOUR_UPSTREAM_DNS / CHANGE_ME
```

For CI runs: the `livetest-on-pr.yml` and `refresh-mirrors-on-main.yml` workflows
materialize `e2e/config.json` from the GitHub Actions repo secret
**`E2E_CONFIG`** (paste the full JSON blob as the secret value). Without that
secret the workflows fail fast with a clear error.

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
| Install CI runner LXC | `./install-ci.sh --runner-host ubuntupve --github-token <token>` | |
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
├── install-ci.sh                # Install the GitHub Actions runner LXC on a Proxmox host
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

Rolls back to `baseline` and prepares the nested VM for tests:
- Installs Docker inside the nested VM
- Pushes the proxvex CA from the PVE host into the nested-VM trust store, so
  TLS to the production Docker Hub mirror at `192.168.4.45` validates
- Starts the local `ghcr.io` pull-through mirror (`distribution/distribution:3.0.0`)
  on `10.0.0.2` (no Docker Hub mirror — that comes from production)
- Wires dnsmasq so LXC containers resolve `registry-1.docker.io`/`index.docker.io`
  to `192.168.4.45` and `ghcr.io` to `10.0.0.2`
- Pre-pulls all images referenced by `json/shared/scripts/library/versions.sh`
  through the mirrors (Docker Hub via the production cache, ghcr.io via the
  local cache)
- Creates the `mirrors-ready` snapshot, tagged with a schema version that
  forces a rebuild when the topology changes

Run once per environment; step2b requires `mirrors-ready` and aborts if missing.

**Prerequisites:**
- `production/setup-pve-host.sh <PVE_HOST>` must have run on the PVE host
  hosting the nested VM (places `/usr/local/share/ca-certificates/proxvex-ca.crt`
  for step2a to copy).
- `production/setup-production.sh --step 5` must have completed so the
  `docker-registry-mirror` LXC at `192.168.4.45` is up and reachable. The
  first cold pull through the production mirror will populate its cache from
  Docker Hub once — every subsequent pull (any instance) is a hit, which is
  the whole point.

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

Installs the GitHub Actions runner LXC on a Proxmox host from the
`ghcr.io/proxvex/github-actions-runner:latest` OCI image
(built by [runner-image-publish.yml](../.github/workflows/runner-image-publish.yml)).
The runner image already contains `docker`, `skopeo`, `git`, `openssh-client`
and `etherwake`; Node is installed per-workflow via `actions/setup-node@v4`
so the version stays pinned in each workflow file.

The script also appends the runner's SSH public key to the host's
`/root/.ssh/authorized_keys` so the runner can SSH to the PVE host for `qm`
commands against the nested VM.

Required arguments:
- `--runner-host <host>`: Proxmox host on which to install the runner LXC (e.g. `ubuntupve`)
- `--github-token <token>`: GitHub PAT with Actions + Administration read/write permission
  (classic PAT with `repo` scope works; fine-grained PAT must target the exact repository)

Run `./install-ci.sh --help` for all options.

**Install runner for a fork (example: `volkmarnissen/proxvex`):**

```
./install-ci.sh \
  --runner-host ubuntupve \
  --repo-url https://github.com/volkmarnissen/proxvex \
  --runner-name ubuntupve-fork \
  --labels "self-hosted,linux,x64,ubuntupve" \
  --github-token github_pat_1******
```

The `ubuntupve` label matches `runs-on: [self-hosted, linux, ubuntupve]` in
`livetest-on-pr.yml`. GitHub → Repository Settings → Actions → Runners shows
the runner as **Idle** after a few seconds.

**Prerequisite**: the runner image on GHCR must be public (proxvex org → Packages →
`github-actions-runner` → Visibility → Public). Without that, `skopeo copy`
inside the script fails with 401.

**Former test-worker LXC** (`ci-test-worker`): no longer installed. The
current `livetest-on-pr.yml` workflow invokes `e2e/step2b-install-deployer.sh`
directly from the runner — no pvetest worker-delegation hop needed.

#### CI nested-VM SSH key (automatic)

`step2b` inside the runner SSHs into the nested VM. The runner uses one SSH
key to reach the PVE host (generated by `install-ci.sh` and added to the
host's `authorized_keys`), and a second key — the **CI nested-VM key** — to
reach the nested VM through the port-forward. Both halves are set up
automatically:

1. **Keypair lives on the PVE host** at `/srv/proxvex-ci/nested-vm-key` (+ `.pub`).
   Created the first time either `step1-create-vm.sh` or `install-ci.sh` runs
   (whichever comes first — both check for existence before generating).
2. **Public key → nested VM's `authorized_keys`**: `step1-create-vm.sh`
   appends it immediately before taking the `baseline` snapshot, so it
   persists across any subsequent rollbacks.
3. **Private key → runner LXC**: `install-ci.sh` copies it into the host's
   shared secrets bind mount `/srv/gh-runner/secrets/` (one dir for all
   runners on this host). The dir and its contents are `chown`'d to
   `100000:100000` so the unprivileged LXC (whose container-root maps to host
   UID 100000) can read them. The runner's `entrypoint.sh` installs the key
   as `/root/.ssh/id_ed25519_nested` on every container start and configures
   `~/.ssh/config` to offer both identities (runner→ubuntupve key plus this
   nested-VM key).

**If an instance's nested VM was bootstrapped before this machinery existed**,
its `baseline` snapshot has no CI key in `authorized_keys`. To fix: re-run
`step1-create-vm.sh <instance>` for that instance (creates a fresh baseline
with the key embedded), then re-run `step2a-setup-mirrors.sh <instance>` and
`step2b-install-deployer.sh <instance>` to rebuild the mirrors-ready and
deployer-installed snapshots on top.

#### Nested-VM SSH key (operator step)

`step2b` inside the runner SSHs into the nested VM via the PVE host's port-forward.
Install-ci.sh generates one key for `runner -> ubuntupve`, but the runner also
needs a key the **nested VM** accepts. That key is delivered via a host-side
bind mount so it stays out of the runner image and can be rotated independently.

After running `install-ci.sh`:

```bash
# 1. Generate a dedicated key pair (on a trusted admin host)
ssh-keygen -t ed25519 -N '' -f /tmp/nested_vm_id_ed25519 -C 'runner->nested-vm'

# 2. Drop the private key into the runner's secrets mount
scp /tmp/nested_vm_id_ed25519 root@ubuntupve:/srv/gh-runner/<runner-vmid>/secrets/
ssh root@ubuntupve "chmod 600 /srv/gh-runner/<runner-vmid>/secrets/nested_vm_id_ed25519"

# 3. Authorize the public key on the nested VM — BEFORE the baseline snapshot
#    (or inject and re-shoot the snapshot chain afterwards)
cat /tmp/nested_vm_id_ed25519.pub
# SSH to the running nested VM via the port-forward and append to
# /root/.ssh/authorized_keys, then snapshot the VM (qm shutdown; qm snapshot baseline).

# 4. Restart the runner so the entrypoint picks up the key
ssh root@ubuntupve "pct stop <runner-vmid> && pct start <runner-vmid>"
```

The entrypoint copies `nested_vm_id_ed25519` to `/root/.ssh/id_ed25519_nested`
and configures `~/.ssh/config` so outbound SSH offers both keys: the install-ci
key for reaching `ubuntupve` and the nested-VM key for the port-forwarded hop.

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
