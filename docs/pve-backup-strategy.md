# PVE Backup Strategy: Production ISO with Backup Infrastructure

## Context

The production Proxmox host (pve1.cluster) needs a reliable backup strategy. Instead of creating backup scripts in isolation, we build a **Production ISO** (analogous to the E2E ISO in `e2e/`) whose first-boot script fully configures the host — including backup. The ISO serves three purposes:

1. **Disaster Recovery** — boot the ISO, automatic restore from backup
2. **Proxmox Upgrade** — install on a new host, restore, immediately productive (flip-flop strategy)
3. **Backup Setup** — the first-boot script sets up everything; backup is a byproduct

### Flip-Flop Upgrade Strategy

On each Proxmox upgrade, the *other* host becomes the new production host:
1. Build recovery ISO with the new Proxmox version
2. Install on the currently non-productive host — automatic restore runs
3. New host becomes productive, old host becomes standby
4. Next upgrade flips again

After 5-6 iterations, the restore procedure is battle-tested and 100% reliable. Restore is routine, not an emergency.

## Why DIY (sanoid/syncoid + rsync) instead of Proxmox Backup Server

- ubuntupve is also Proxmox (PBS would be installable), but:
- PBS does not use ZFS send/receive — it dumps via vzdump, no ZFS advantage
- ZFS send/receive is more efficient (block-level increments directly to the USB ZFS pool)
- Fewer moving parts = more stable for production
- No additional daemon/service/datastore needed

**Tools:**
- **sanoid** — ZFS snapshot management with retention policy (`apt install sanoid`)
- **syncoid** — ZFS send/receive with resume support (part of sanoid)
- **rsync** — for non-ZFS directories
- **WOL via LXC container** — a gptwol container on pve1 provides a WOL API (called via `curl`). The same container also serves as a web-based GitHub Actions runner trigger. No `etherwake` needed on the host.
- **vzdump** — not needed (OCI containers are reproducible via oci-lxc-deployer)

## Architecture

```
pve1.cluster                           ubuntupve
+------------------------------+    +------------------------------+
| sanoid (every 6h)            |    | External USB ZFS drive       |
|   -> ZFS snapshots + pruning |    |   <- syncoid receives streams|
|                              |    |                              |
| syncoid (daily 02:00)        |    | /backup/pve1/non-zfs/        |
|   -> zfs send -> ubuntupve   |    |   <- rsync from /etc/pve etc.|
|                              |    |                              |
| rsync (daily 03:00)          |    | sanoid (local retention)     |
|   -> non-ZFS config backup   |    |   -> prune old snapshots     |
+------------------------------+    +------------------------------+
```

**Multi-host backup on the same ZFS pool:** Each host replicates to its own prefix:
```
macbackup/
+-- pve1/rpool/...     <- syncoid from pve1.cluster
+-- pve2/rpool/...     <- syncoid from pve2.cluster
```
No conflicts — independent snapshots. sanoid on ubuntupve prunes recursively.

## Reused Infrastructure

| File | Purpose |
|------|---------|
| `e2e/pve1-scripts/create-iso.sh` | ISO creation with `proxmox-auto-install-assistant` |
| `e2e/step0-create-iso.sh` | Orchestrates ISO creation from dev machine |
| `e2e/config.sh` + `e2e/config.json` | Configuration system with instances |
| `e2e/pve1-scripts/first-boot.sh.template` | First-boot template with `{{ }}` placeholders |

## New Files

### 1. `scripts/pve-backup/config.json`

Multi-host configuration (analogous to `e2e/config.json`):

```json
{
  "default": "pve1",
  "hosts": {
    "pve1": {
      "description": "Production PVE host",
      "fqdn": "pve1.cluster",
      "address": "192.168.4.21/24",
      "gateway": "192.168.4.1",
      "dns": "192.168.1.1",
      "bridge": "vmbr0",
      "bridgePorts": "eno1",
      "disk": "sda",
      "filesystem": "zfs"
    },
    "pve2": {
      "description": "Standby/Upgrade PVE host",
      "fqdn": "pve2.cluster",
      "address": "192.168.4.22/24",
      "gateway": "192.168.4.1",
      "dns": "192.168.1.1",
      "bridge": "vmbr0",
      "bridgePorts": "eno1",
      "disk": "sda",
      "filesystem": "zfs"
    }
  },
  "defaults": {
    "backupHost": "ubuntupve",
    "wolUrl": "http://wol:5000/api/wake/ubuntupve",
    "backupPool": "macbackup",
    "zfsPool": "rpool",
    "keyboard": "de",
    "country": "de",
    "timezone": "Europe/Berlin",
    "mailto": "admin@localhost"
  }
}
```

> **Note:** The actual `config.json` is in `.gitignore`. Only `config.json.example` with placeholder values is committed.

### 2. `scripts/pve-backup/answer-production.toml.template`

Answer file dynamically generated from config.json (like E2E):

```toml
[global]
keyboard = "{{KEYBOARD}}"
country = "{{COUNTRY}}"
fqdn = "{{HOST_FQDN}}"
mailto = "{{MAILTO}}"
timezone = "{{TIMEZONE}}"
root-password = "PLACEHOLDER_ROOT_PASSWORD"
root-ssh-keys = ["PLACEHOLDER_SSH_KEY"]

[network]
source = "from-answer"
cidr = "{{HOST_ADDRESS}}"
dns = "{{HOST_DNS}}"
gateway = "{{HOST_GATEWAY}}"

[disk-setup]
filesystem = "{{FILESYSTEM}}"
disk-list = ["{{DISK}}"]

[disk-setup.zfs]
raid = "raid0"

[first-boot]
source = "from-iso"
ordering = "network-online"
```

Network uses `source = "from-answer"` with static IP — the host has the correct IP immediately.

### 3. `scripts/pve-backup/first-boot.sh.template`

The core piece — extended incrementally. Handles both setup and restore modes:

**Phases:**
1. Configure repositories (remove enterprise, add no-subscription)
2. Run `apt dist-upgrade` — Proxmox is immediately up-to-date
3. Install sanoid
4. Deploy sanoid configuration (ZFS snapshot retention policy)
5. Deploy backup scripts (syncoid, rsync)
6. Install cron jobs
7. Setup/Restore mode detection (see below)

### 4. `scripts/pve-backup/create-production-iso.sh`

Orchestration script (runs on dev machine, analogous to `e2e/step0-create-iso.sh`):

1. SSH connection to build host (pve1.cluster or ubuntupve)
2. Render `first-boot.sh.template` with config variables
3. Fill `answer-production.toml` with SSH keys and password
4. Copy files to build host
5. Run `create-iso.sh` (reuse from `e2e/`)
6. Store ISO on ubuntupve

**Security:** Root password is prompted interactively at build time (`read -s -p`). SSH keys are read from the local system. The answer file is generated temporarily and deleted after ISO build. The finished ISO contains secrets and must be stored securely.

## Two Modes in First-Boot Script

The first-boot script detects whether it runs as **Setup** (first host, no backup exists) or **Restore** (backup exists on ubuntupve):

```sh
if ssh root@ubuntupve "zfs list macbackup/pve1/rpool" 2>/dev/null; then
    echo "Backup found -> RESTORE mode"
else
    echo "No backup found -> SETUP mode"
fi
```

**Setup mode** (on pve1, first time):
1. Repos + dist-upgrade
2. Install sanoid + backup scripts + cron
3. Setup SSH key to ubuntupve
4. Run first `sanoid --cron` + `syncoid` + `rsync` — creates initial backup

**Restore mode** (on pve2, or new pve1 after total loss):
1. Repos + dist-upgrade
2. Receive ZFS datasets from ubuntupve (`zfs receive`)
3. Rsync non-ZFS config from ubuntupve
4. Install sanoid + backup scripts + cron
5. Start containers

## ZFS Snapshot Retention

| Interval | Count | Coverage |
|----------|-------|----------|
| 6-hourly | 28 | 7 days at 6h granularity |
| Daily | 7 | 7 daily snapshots |
| Weekly | 4 | 4 weekly snapshots |
| Monthly | 6 | 6 monthly snapshots |

## Non-ZFS Directories to Back Up

| Directory | Content |
|-----------|---------|
| `/etc/pve/` | Cluster config, container .conf, certs, storage.cfg |
| `/var/lib/vz/snippets/` | Hook scripts (lxc-oci-deployer-hook.sh) |
| `/etc/udev/rules.d/` | USB device mapping rules |
| `/usr/local/bin/map-*-device-replug.sh` | USB replug handlers |
| `/etc/cron.d/` | Backup cron jobs |
| `/etc/network/interfaces` | Network configuration |
| `/root/.ssh/` | SSH keys (for syncoid) |
| `/mnt/pve-volumes/` | Non-ZFS volumes (if any) |

**Not needed:**
- `/etc/lxc-oci-deployer/` — inside containers, covered by ZFS snapshots
- Logs — in ZFS snapshots or expendable
- Container rootfs — covered by ZFS snapshots + syncoid
- vzdump — OCI containers are reproducible via oci-lxc-deployer templates

**Critical data:** The shared volume (`subvol-999999-oci-lxc-deployer-volumes`) contains databases and persistent application data. It is a ZFS subvolume and fully covered by sanoid snapshots + syncoid replication.

## Cron Schedule

| When | What | Where |
|------|------|-------|
| `0 0,6,12,18 * * *` | sanoid snapshots | pve1.cluster |
| `0 1,50 * * *` | WOL: wake ubuntupve | pve1.cluster |
| `0 2 * * *` | syncoid -> ubuntupve | pve1.cluster |
| `0 3 * * *` | rsync non-ZFS | pve1.cluster |
| `0 5 * * *` | sanoid pruning | ubuntupve |

## Recovery Procedures

### Single file from ZFS snapshot
```sh
zfs list -t snapshot -r rpool
cp /rpool/.zfs/snapshot/autosnap_2026-03-09_00:00:00_daily/path/to/file /restore/target/
```

### ZFS dataset rollback
```sh
pct stop <vmid>
zfs rollback rpool/data/subvol-<vmid>-disk-0@autosnap_2026-03-09_00:00:00_daily
pct start <vmid>
```

### Shared volume (database) rollback
```sh
pct stop <vmid1> <vmid2> ...
zfs rollback rpool/data/subvol-999999-oci-lxc-deployer-volumes@autosnap_2026-03-09_00:00:00_daily
pct start <vmid1> <vmid2> ...
```

### Full restore from ubuntupve
See "Two Modes in First-Boot Script" above — the restore mode handles this automatically via the production ISO.

### Single dataset from ubuntupve
```sh
pct stop <vmid1> <vmid2> ...
ssh root@ubuntupve "zfs send macbackup/pve1/rpool/data/subvol-999999-oci-lxc-deployer-volumes@<snapshot>" \
  | zfs receive -F rpool/data/subvol-999999-oci-lxc-deployer-volumes
pct start <vmid1> <vmid2> ...
```

## Incremental Development

1. **V1:** First-boot with repos + dist-upgrade + sanoid install
2. **V2:** + Backup scripts + cron deployment
3. **V3:** + SSH key setup to ubuntupve + first backup (setup mode)
4. **V4:** + Restore logic (ZFS receive + rsync) (restore mode)
5. **V5:** + Container auto-start after restore

Each version can be built as an ISO and verified on a test host.

## Secrets Protection

- `config.json.example` in repo (placeholder values) — committed
- `config.json` in `.gitignore` — real values, NOT committed
- Root password prompted interactively at ISO build time (`read -s -p`)
- SSH keys read from local system at build time (`~/.ssh/id_ed25519.pub`)
- Answer file generated temporarily and deleted after ISO build
- The finished ISO contains secrets — store securely (not publicly accessible)

## File Structure

```
scripts/pve-backup/
+-- config.json.example            # committed (placeholder values)
+-- config.json                    # .gitignore (real values)
+-- config.sh                      # Shell helper for loading config
+-- answer-production.toml.template # Answer file template with {{ }} placeholders
+-- first-boot.sh.template         # First-boot script template
+-- create-production-iso.sh       # ISO creation orchestration (dev machine)
+-- wake-backup-host.sh             # WOL via curl to gptwol container + wait for SSH
+-- restore-from-backup.sh         # Restore script (optional, later)
```

## Verification

1. Build ISO on ubuntupve (E2E pattern: nested VM)
2. Boot into nested VM — check first-boot log
3. Run `sanoid --cron` manually — verify snapshots
4. Test backup scripts manually
5. Test restore on a second nested VM
