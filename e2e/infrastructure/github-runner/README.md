# Self-Hosted GitHub Actions Runner

Self-hosted GitHub Actions runner deployed as a Docker container on pve1 via the docker-compose framework. It runs template-tests and Playwright e2e tests against the nested Proxmox VM on ubuntupve, waking it via WOL if needed.

## Architecture

```
pve1 (24/7, always on, 8GB RAM)
└── Runner LXC (unprivileged, Docker via docker-compose framework)
    └── myoung34/github-runner container (3GB memory limit)
        ├── Runs template-tests and e2e-tests workflows
        └── Wakes ubuntupve via WOL (etherwake)

ubuntupve (may be sleeping, woken via WOL)
└── Nested Proxmox VM (QEMU, vmId: 9001, auto-starts on boot)
    ├── Deployer LXC (VMID 300, API on port 3080)
    └── Test containers (created by E2E tests)
```

## CI Workflow

The `ci-tests.yml` workflow runs 5 jobs:

| Job | Runner | Duration | Proxmox required |
|-----|--------|----------|-----------------|
| frontend-vitest | ubuntu-latest | ~1-2min | No |
| backend-vitest | ubuntu-latest | ~2-3min | No |
| wake-backend | self-hosted (pve1) | ~0-5min | No (wakes it) |
| template-tests | self-hosted (pve1) | ~2-5min | Yes |
| e2e-tests | self-hosted (pve1) | ~10-15min | Yes |

Fast tests (frontend/backend) run in parallel on GitHub-hosted runners for quick feedback. Slow tests run sequentially on the self-hosted runner after wake-backend ensures ubuntupve is available.

## Prerequisites

### On ubuntupve (WOL target)

1. **BIOS/UEFI:** Enable Wake-on-LAN (Power Management or Network Boot settings)

2. **Enable WOL on the NIC:**
   ```bash
   # Check current status (look for "Wake-on: g" = enabled)
   ethtool <interface> | grep Wake-on

   # Enable WOL
   ethtool -s <interface> wol g
   ```

3. **Persist WOL across reboots:**
   ```bash
   # systemd service (recommended for Proxmox/Debian)
   cat > /etc/systemd/system/wol@.service << 'EOF'
   [Unit]
   Description=Wake-on-LAN for %i
   Requires=network.target
   After=network.target

   [Service]
   ExecStart=/sbin/ethtool -s %i wol g
   Type=oneshot

   [Install]
   WantedBy=multi-user.target
   EOF
   systemctl enable wol@<interface>.service
   ```

4. **Determine MAC address** and update `e2e/config.json` (`wol.macAddress`):
   ```bash
   ip link show <interface> | grep ether
   ```

5. **Nested VM auto-start:**
   ```bash
   qm set 9001 --onboot 1 --startup order=2
   ```

6. **Port forwarding persistence:** Ensure iptables rules for deployer API and SSH survive reboots (e.g. via `/etc/network/interfaces` post-up or a systemd service).

### On pve1 (runner host)

7. Runner LXC must be on the **same network bridge** as ubuntupve (L2 connectivity required for WOL broadcast).

8. **GitHub PAT:** Create a fine-grained Personal Access Token with `Actions: Read and write` permission for the repository.

## Deployment

1. Build and push the runner image (or trigger the `runner-image-publish.yml` workflow):
   ```bash
   # Manual build (for testing)
   docker build -t github-actions-runner:test .

   # Verify tools are installed
   docker run --rm github-actions-runner:test which etherwake skopeo
   ```

2. Deploy via the frontend:
   - Go to **Create Application** and select the **docker-compose** framework
   - Upload `github-runner.docker-compose.yml`
   - Enter the GitHub PAT as `GITHUB_RUNNER_TOKEN`
   - Deploy to pve1

3. Verify the runner appears in **GitHub Settings > Actions > Runners** as "Online".

## Configuration

The runner uses the `github-action` instance from `e2e/config.json`:

```json
{
  "github-action": {
    "pveHost": "ubuntupve",
    "vmId": 9001,
    "portOffset": 1000,
    "wol": {
      "macAddress": "XX:XX:XX:XX:XX:XX"
    }
  }
}
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GITHUB_RUNNER_TOKEN` | (required) | GitHub PAT for runner registration |
| `RUNNER_NAME` | `lxc-manager-runner` | Runner display name in GitHub |
| `UBUNTUPVE_MAC` | from config.json | Override WOL MAC address |
| `WOL_WAIT` | `180` | Max seconds to wait for host wake |
| `API_WAIT` | `300` | Max seconds to wait for deployer API |

## Files

| File | Purpose |
|------|---------|
| `Dockerfile` | Custom runner image (etherwake, skopeo, Playwright deps) |
| `github-runner.docker-compose.yml` | Deployment definition for docker-compose framework |
| `appconf.json` | Application metadata |
| `../../scripts/ensure-backend.sh` | WOL + deployer health check script |
| `../../../.github/workflows/ci-tests.yml` | CI workflow with all 5 test jobs |
| `../../../.github/workflows/runner-image-publish.yml` | Runner image build + push to ghcr.io |
