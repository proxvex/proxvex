# Create and Configure LXC

Creates LXC container and applies optional configurations (templates 101-199).

This template creates the container and then applies all optional configuration templates in the correct order. Each optional template will be automatically skipped if its required parameters are missing (via skip_if_all_missing).

If username is provided, a user will be created on the VE host before the container is created (template 095). This ensures consistent UID/GID mapping between host and container.

Note: uid and gid parameters are used for volume permissions only, not for container idmap configuration. The container is created as unprivileged without automatic UID/GID mappings.

Templates included:
- 095: Create User on VE Host (if username provided)
- 100: Create LXC container (unprivileged, no idmap)
- 104: Compute Static IPs from prefixes
- 105: Set Static IP for LXC
- 106: Update /etc/hosts entries
- 110: Map Serial Device
- 120: Mount Disk on Host
- 121: Mount ZFS Pool on Host
- 160: Bind Multiple Volumes to LXC
- 170: Set Environment Variables in LXC

**Execution Target:** ve

## Capabilities

This template provides the following capabilities:

- Ensuring required UID/GID ranges are available for container creation
- Configuring /etc/subuid and /etc/subgid files
- Enabling bind mounts with specific UID/GID permissions
- Auto-selecting the best storage (prefers local-zfs, otherwise storage with most free space)
- Creating the LXC container with specified parameters
- Configuring container settings (hostname, ostype, etc.)
- References template: `104-lxc-static-ip-prefix.json`
- References template: `105-set-static-ip-for-lxc.json`
- References template: `106-update-etc-hosts-on-ve.json`
- References template: `110-map-serial.json`
- References template: `120-mount-disk-on-host.json`
- References template: `121-mount-zfs-pool-on-host.json`
- References template: `160-bind-multiple-volumes-to-lxc.json`
- References template: `170-set-environment-variables-in-lxc.json`

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
| `vm_id` | number | No |  | ID of the virtual machine ⚙️ Advanced |
| `template_path` | string | Yes | - | Path to the LXC template (e.g. local:vztmpl/alpine-3.19-default_20231107_amd64.tar.xz). Auto-selected by installer for Alpine. Must be provided by 010-get-latest-os-template.json template. |
| `disk_size` | string | No | 4 | Disk size for the container in GB ⚙️ Advanced |
| `memory` | number | No | 512 | Memory for the container in MB ⚙️ Advanced |
| `bridge` | string | No | vmbr0 | Network bridge to use ⚙️ Advanced |
| `hostname` | string | Yes | - | Hostname for the LXC container |
| `uid` | string | No | 1000 | UID for UID/GID mapping and permissions. If provided, will be mapped directly between host and container (1:1 mapping). ⚙️ Advanced |
| `gid` | string | No | 1000 | GID for UID/GID mapping and permissions. If provided, will be mapped directly between host and container (1:1 mapping). ⚙️ Advanced |
| `username` | string | No | - | Optional: Username to create on the VE host before container creation. This ensures consistent UID/GID mapping between host and container. If not provided, no user will be created on the host. ⚙️ Advanced |

<!-- GENERATED_END:PARAMETERS -->

<!-- GENERATED_START:OUTPUTS -->
## Outputs

| Output ID | Default | Description |
|-----------|---------|-------------|
| `undefined` | - | - |

<!-- GENERATED_END:OUTPUTS -->

<!-- GENERATED_START:COMMANDS -->
## Commands

This template executes the following commands in order:

| # | Command | Type | Details | Description |
|---|---------|------|---------|-------------|
| 1 | Configure subuid/subgid | Script | `configure-subuid-subgid.sh` | - |
| 2 | Create LXC container | Script | `create-lxc-container.sh` | - |
| 3 | Compute Static IPs | Template | [104-lxc-static-ip-prefix.json](templates/104-lxc-static-ip-prefix.md) | - |
| 4 | Set Static IP for LXC | Template | [105-set-static-ip-for-lxc.json](templates/105-set-static-ip-for-lxc.md) | - |
| 5 | Update /etc/hosts entries | Template | [106-update-etc-hosts-on-ve.json](templates/106-update-etc-hosts-on-ve.md) | - |
| 6 | Map Serial Device | Template | [110-map-serial.json](templates/110-map-serial.md) | - |
| 7 | Mount Disk on Host | Template | [120-mount-disk-on-host.json](templates/120-mount-disk-on-host.md) | - |
| 8 | Mount ZFS Pool on Host | Template | [121-mount-zfs-pool-on-host.json](templates/121-mount-zfs-pool-on-host.md) | - |
| 9 | Bind Multiple Volumes to LXC | Template | [160-bind-multiple-volumes-to-lxc.json](templates/160-bind-multiple-volumes-to-lxc.md) | - |
| 10 | Set Env Variables in LXC | Template | [170-set-environment-variables-in-lxc.json](templates/170-set-environment-variables-in-lxc.md) | - |

<!-- GENERATED_END:COMMANDS -->
