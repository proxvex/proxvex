# Bind Multiple Volumes to LXC

Binds multiple host directories to an LXC container.

For each volume entry (key=value format, one per line), creates a bind mount from <host_mountpoint>/<base_path>/<hostname>/<key> to /<value> in the container.

If host_mountpoint is provided (from 'Mount Disk on Host' (120) or 'Mount ZFS Pool on Host' (121)), volumes are created at <host_mountpoint>/<base_path>/<hostname>/<key>.
If host_mountpoint is not provided, volumes are created at /mnt/<base_path>/<hostname>/<key>.

This template can be called independently of the LXC container's state (running or stopped) and is safe to call multiple times (idempotent).

**Execution Target:** ve

## Capabilities

This template provides the following capabilities:

- Parsing volumes (key=value format, one per line)
- Creating host directories under <base_path>/<hostname>/<key>
- Creating bind mounts from host to container paths
- Setting proper ownership and permissions

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
| `vm_id` | string | Yes | - | ID of the LXC container to which the volumes will be bound. |
| `hostname` | string | Yes | - | Hostname of the LXC container. Used to create container-specific volume directories. |
| `host_mountpoint` | string | No |  | Mountpoint on the Proxmox host from 'Mount Disk on Host' (120) or 'Mount ZFS Pool on Host' (121). Volume directories will be created at <host_mountpoint>/<base_path>/<hostname>/<volume-key>. If not provided (empty), volumes will be created under /mnt/<base_path>/<hostname>/<volume-key>. ⚙️ Advanced |
| `base_path` | string | No | volumes | Base subdirectory name. Volume directories will be created at <host_mountpoint>/<base_path>/<hostname>/<volume-key>. Default is 'volumes'. If host_mountpoint is not set, /mnt/<base_path> will be used. ⚙️ Advanced |
| `volumes` | string | Yes | - | Volume mappings in key=value format, one per line. Each line creates a bind mount from <host_mountpoint>/<base_path>/<hostname>/<key> to /<value> in the container. Example:
volume1=/var/lib/myapp/data
volume2=/var/lib/myapp/logs |
| `username` | string | No |  | Optional: Username for setting permissions on volume directories. If provided, will be used for chown instead of numeric UID/GID. Should match the user created on the VE host (300-create-user-on-host.json). ⚙️ Advanced |
| `uid` | string | No | 1000 | UID for setting permissions on volume directories. Will be used consistently on VE host and LXC container. ⚙️ Advanced |
| `gid` | string | No | 1000 | GID for setting permissions on volume directories. Will be used consistently on VE host and LXC container. ⚙️ Advanced |

<!-- GENERATED_END:PARAMETERS -->

<!-- GENERATED_START:COMMANDS -->
## Commands

This template executes the following commands in order:

| # | Command | Type | Details | Description |
|---|---------|------|---------|-------------|
| 1 | Unnamed Command | Script | `bind-multiple-volumes-to-lxc.sh` | Executes the script to bind multiple volumes in the container. |

<!-- GENERATED_END:COMMANDS -->
