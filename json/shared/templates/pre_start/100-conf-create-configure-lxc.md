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

## Features

This template implements the following features:

- Configuration management
- Resource creation
- References template: `104-lxc-static-ip-prefix.json`
- References template: `105-set-static-ip-for-lxc.json`
- References template: `106-update-etc-hosts-on-ve.json`
- References template: `110-map-serial.json`
- References template: `120-mount-disk-on-host.json`
- References template: `121-mount-zfs-pool-on-host.json`
- References template: `160-bind-multiple-volumes-to-lxc.json`
- References template: `170-set-environment-variables-in-lxc.json`

## Commands

### Configure subuid/subgid
### Create LXC container
### Compute Static IPs
### Set Static IP for LXC
### Update /etc/hosts entries
### Map Serial Device
### Mount Disk on Host
### Mount ZFS Pool on Host
### Bind Multiple Volumes to LXC
### Set Env Variables in LXC