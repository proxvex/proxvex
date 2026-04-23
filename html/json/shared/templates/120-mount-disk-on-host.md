# Mount Disk on Host

Mounts a block device (by UUID) on the Proxmox host.

This template only mounts the device on the host. To bind mount it into a container, use the bind-host template afterwards.

This template can be called independently and is safe to call multiple times (idempotent).

**Execution Target:** ve

## Capabilities

This template provides the following capabilities:

- Finding the device by UUID
- Creating the mountpoint directory
- Mounting the device to the given mountpoint (without fstab, with nofail)
- Setting permissions and ownership (uid/gid)

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
| `storage_selection` | enum | Yes | - | Select storage to mount. Only filesystems prefixed with 'uuid:' are supported. |
| `uid` | string | No | - | Optional: UID to set for the mount directory. If not provided, default permissions will be used. ⚙️ Advanced |
| `gid` | string | No | - | Optional: GID to set for the mount directory. If not provided, default permissions will be used. ⚙️ Advanced |

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
| 1 | Unnamed Command | Script | `mount-disk.sh` | Executes the script to mount the disk by UUID on the host. |

<!-- GENERATED_END:COMMANDS -->
