# Proxvex Gateway

Proxvex Gateway from Modbus RTU/TCP to MQTT and vice versa

## Installation Templates

The following templates are executed in order during installation:

| Template | Description | Status |
|----------|-------------|--------|
| [set-parameters.json](json/applications/proxvex/templates/set-parameters.md) | Set application-specific parameters for Proxvex | ✓ Executed |
| [010-get-latest-os-template.json](json/shared/templates/010-get-latest-os-template.md) | Download latest operating system template for Proxmox | ✓ Executed |
| [100-create-configure-lxc.json](json/shared/templates/100-create-configure-lxc.md) | Creates LXC container and applies optional configurations (templates 101-199) | ✓ Executed |
| └─ [104-lxc-static-ip-prefix.json](json/shared/templates/104-lxc-static-ip-prefix.md) | Optional step: Derive static IPv4/IPv6 from prefixes and VMID, emit... | <span style="color: #ffa500; font-weight: bold;">⚙️ Conditional (requires parameters)</span> |
| └─ [105-set-static-ip-for-lxc.json](json/shared/templates/105-set-static-ip-for-lxc.md) | Edit LXC network settings for a container with static IPs | <span style="color: #ff6b6b; font-weight: bold;">⏭️ All Commands Skipped</span> |
| └─ [106-update-etc-hosts-on-ve.json](json/shared/templates/106-update-etc-hosts-on-ve.md) | Optional template to update /etc/hosts with hostname and static IP ... | <span style="color: #ff6b6b; font-weight: bold;">⏭️ All Commands Skipped</span> |
| └─ [110-map-serial.json](json/shared/templates/110-map-serial.md) | Map serial device to VM | <span style="color: #ff6b6b; font-weight: bold;">⏭️ All Commands Skipped</span> |
| └─ [120-mount-disk-on-host.json](json/shared/templates/120-mount-disk-on-host.md) | Mounts a block device (by UUID) on the Proxmox host | ✓ Executed |
| └─ [121-mount-zfs-pool-on-host.json](json/shared/templates/121-mount-zfs-pool-on-host.md) | Creates a subdirectory under a ZFS pool mountpoint on the Proxmox host | <span style="color: #ffa500; font-weight: bold;">⚙️ Conditional (requires parameters)</span> |
| └─ [160-bind-multiple-volumes-to-lxc.json](json/shared/templates/160-bind-multiple-volumes-to-lxc.md) | Binds multiple host directories to an LXC container | <span style="color: #ffa500; font-weight: bold;">⚙️ Conditional (requires parameters)</span> |
| └─ [170-set-environment-variables-in-lxc.json](json/shared/templates/170-set-environment-variables-in-lxc.md) | Sets environment variables in an LXC container configuration | <span style="color: #ffa500; font-weight: bold;">⚙️ Conditional (requires parameters)</span> |
| [200-start-lxc.json](json/shared/templates/200-start-lxc.md) | Start existing LXC container on Proxmox host | ✓ Executed |
| [210-wait-for-container-ready.json](json/shared/templates/210-wait-for-container-ready.md) | Wait until LXC container is ready (network + apk available) | ✓ Executed |
| [set-download-url.json](json/applications/proxvex/templates/set-download-url.md) | Sets default download URL and public key for Proxvex package and key for ... | ✓ Executed |
| [310-create-user.json](json/shared/templates/310-create-user.md) | Create a user inside the LXC container with specified username, optional uid,... | ✓ Executed |
| [305-set-pkg-mirror.json](json/shared/templates/305-set-pkg-mirror.md) | Configure package manager mirrors for Alpine Linux (apk) or Debian/Ubuntu (apt) | ✓ Executed |
| [300-download-and-install-apk-package.json](json/shared/templates/300-download-and-install-apk-package.md) | Download and install APK package on the LXC container | ✓ Executed |

<!-- GENERATED_START:PARAMETERS -->
## Parameters

The following parameters can be configured for this application:

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `hostname` | string | Yes | proxvex | Hostname for the Proxvex OS |
| `username` | string | Yes | proxvex | Username for the Proxvex OS ⚙️ Advanced |
| `packageurl` | string | Yes |  | URL of the APK package to be installed |
| `packagerpubkeyurl` | string | Yes | - | URL of the public key for verifying the package |
| `uid` | string | No | 1000 | UID for the user and mount permissions. Will be used consistently on VE host and LXC container. ⚙️ Advanced |
| `gid` | string | No | 1000 | GID for the user and mount permissions. Will be used consistently on VE host and LXC container. ⚙️ Advanced |
| `usb_bus_device` | enum | No | - | Select USB serial port to map to the container. Format: bus:device (e.g., 1:3). The port will be mapped as /dev/ttyUSB0 in the container. |

<!-- GENERATED_END:PARAMETERS -->

<!-- GENERATED_START:COMMANDS -->
## Installation Commands

The following commands are executed during installation (in order):

| # | Command | Description | Status |
|---|---------|-------------|--------|
| 1 | `Proxvex Parameters` | - | ✓ Executed |
| 2 | `Latest OS Template` | - | ✓ Executed |
| 3 | `Configure subuid/subgid` | - | ✓ Executed |
| 4 | `Create LXC container` | - | ✓ Executed |
| 5 | `Compute Static IPs (skipped)` | Skipped: all required parameters missing | ⏭️ Skipped |
| 6 | `lxc-static-ip (skipped)` | Skipped: all required parameters missing | ⏭️ Skipped |
| 7 | `lxc-update-etc-hosts (skipped)` | Skipped: all required parameters missing | ⏭️ Skipped |
| 8 | `Map Serial Device (skipped)` | Skipped: all required parameters missing | ⏭️ Skipped |
| 9 | `Mount Disk on Host` | Executes the script to mount the disk by UUID on the host. | ✓ Executed |
| 10 | `Mount ZFS Pool on Host` | Executes the script to create a subdirectory under the ZFS pool mountpoint on the host. | ✓ Executed |
| 11 | `Bind Multiple Volumes to LXC` | Executes the script to bind multiple volumes in the container. | ✓ Executed |
| 12 | `Env Variables in LXC (skipped)` | Skipped: all required parameters missing | ⏭️ Skipped |
| 13 | `Start LXC Container` | - | ✓ Executed |
| 14 | `Wait for Container` | Poll host until the LXC container reports readiness (network up, apk reachable) | ✓ Executed |
| 15 | `Set download URLs` | - | ✓ Executed |
| 16 | `Create User on LXC Container` | Create a user inside the LXC container with specified username, optional uid, and optional gid. Calls create-user.sh with template variables. | ✓ Executed |
| 17 | `Set Package Mirror` | Configure package manager mirrors based on OS type | ✓ Executed |
| 18 | `Download and Install Package` | Download and install APK package on the LXC container | ✓ Executed |

<!-- GENERATED_END:COMMANDS -->

## Features

This application provides the following features (documented in individual template files):

- See [set-parameters.json](json/applications/proxvex/templates/set-parameters.md) for details
- See [010-get-latest-os-template.json](json/shared/templates/010-get-latest-os-template.md) for details
- See [100-create-configure-lxc.json](json/shared/templates/100-create-configure-lxc.md) for details
- See [200-start-lxc.json](json/shared/templates/200-start-lxc.md) for details
- See [210-wait-for-container-ready.json](json/shared/templates/210-wait-for-container-ready.md) for details
- See [set-download-url.json](json/applications/proxvex/templates/set-download-url.md) for details
- See [310-create-user.json](json/shared/templates/310-create-user.md) for details
- See [305-set-pkg-mirror.json](json/shared/templates/305-set-pkg-mirror.md) for details
- See [300-download-and-install-apk-package.json](json/shared/templates/300-download-and-install-apk-package.md) for details
