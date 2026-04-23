# Mount ZFS Pool on Host

Creates a subdirectory under a ZFS pool mountpoint on the Proxmox host.

The ZFS pool must already be mounted (which is always the case in Proxmox). A subdirectory is created under the pool mountpoint.

This template only creates the directory on the host. To bind mount it into a container, use the bind-host template afterwards.

This template can be called independently and is safe to call multiple times (idempotent).

**Execution Target:** ve

## Capabilities

This template provides the following capabilities:

- Verifying that the ZFS pool exists and is mounted
- Creating a subdirectory under the pool mountpoint
- Setting proper permissions and ownership (uid/gid)

## Used By Applications

This template is used by the following applications (usage examples):

- [alpine-packages](../../../alpine-packages.md)
- [macbckpsrv](../../../macbckpsrv.md)
- [mariadb](../../../mariadb.md)
- [proxvex](../../../proxvex.md)
- [mosquitto](../../../mosquitto.md)
- [node-red](../../../node-red.md)
- [phpmyadmin](../../../phpmyadmin.md)

<!-- GENERATED_START:PARAMETERS -->
## Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `storage_selection` | enum | Yes | - | Select ZFS pool. Only pools prefixed with 'zfs:' are shown. |
| `uid` | string | No | - | Optional: UID to set for the directory. If not provided, default permissions will be used. ⚙️ Advanced |
| `gid` | string | No | - | Optional: GID to set for the directory. If not provided, default permissions will be used. ⚙️ Advanced |

<!-- GENERATED_END:PARAMETERS -->

<!-- GENERATED_START:OUTPUTS -->
## Outputs

| Output ID | Default | Description |
|-----------|---------|-------------|
| `host_mountpoint` | - | - |

<!-- GENERATED_END:OUTPUTS -->

<!-- GENERATED_START:COMMANDS -->
## Commands

This template executes the following commands in order:

| # | Command | Type | Details | Description |
|---|---------|------|---------|-------------|
| 1 | Unnamed Command | Script | `mount-zfs-pool.sh` | Executes the script to create a subdirectory under the ZFS pool mountpoint on the host. |

<!-- GENERATED_END:COMMANDS -->
