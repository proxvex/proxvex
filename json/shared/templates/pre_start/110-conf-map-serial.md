# Map Serial Device (110)

This template maps a serial / USB-serial device from the Proxmox host into an LXC container.

The goal is a stable device path inside the container (e.g. always `/dev/ttyUSB0`) even if the device shows up as a different `/dev/ttyUSB*` node on the host after a replug.

## Usage (stable + optional live replug)

1. **Set `host_device_path`**:
   - Choose a stable path like `/dev/serial/by-id/...` (often includes the USB serial number).
   - Benefit: mapping stays stable across replugs (at the latest after a container restart).

2. **Optional (Advanced): enable `Live Replug (Host Installation)`** (`install_replug_watcher=true`):
   - Installs a **udev rule** + a **systemd oneshot service** on the Proxmox host.
   - On replug, the currently resolved device node is automatically **bind-mounted again into the running container**.
   - Result: in practice, replug works without restarting the container.

Why is this needed?

- A USB-serial adapter often appears as a **different** `/dev/ttyUSBX` after a replug.
- The container typically uses a **fixed target path** (e.g. `/dev/ttyUSB0`) because applications are configured that way.
- To make that fixed path point to the new host device **while the container is running**, you need a host-side trigger that re-binds the mount.

Important: `install_replug_watcher=true` requires `host_device_path` (e.g. `/dev/serial/by-id/...`).

Downside / trade-off:

- This option installs things **on the Proxmox host** (udev rule + systemd unit). If you don't want host-side installation, the alternative is: restart the container after replug.

## USB Serial Port

Select the USB-serial adapter here.

- The `value` is a stable path like `/dev/serial/by-id/...`.
- The label is human-readable (vendor/model/serial), but the `value` is what matters.

If you leave this field empty, serial mapping will be skipped.

## Live Replug (Host Installation)

Enable this option if the device should keep working after a replug **without restarting the container**.

What happens technically?

- A udev rule + a systemd oneshot unit is installed on the Proxmox host.
- On every replug (`ACTION=add`), the currently resolved device node (from `host_device_path`) is bind-mounted again into the running container.
- The target is always `container_device_path` (e.g. `/dev/serial-by-id` or for legacy setups `/dev/ttyUSB0`).

Trade-off:

- Host-side installation (writes to `/etc/udev/rules.d` and `/etc/systemd/system`).

## ID of the VM

ID of the target container (Proxmox CT ID) into which the serial device will be mapped.

- Example: `114`
- Note: this mapping is currently intended for **LXC**.

## Security Notes

- `map_usb_bus_directory=true` grants **much broader access**: the container can potentially see and interact with **multiple USB devices** on the host (depending on kernel/driver situation).
- For “minimal access”, `host_device_path` is the better choice because it bind-mounts only a specific path into the container.
- Even in an **unprivileged LXC**, filesystem and UID/GID permissions are more restricted, but **device nodes are a separate security domain**. Only grant the access you actually need.

## Parameter Guide (Short)

- `host_device_path`: stable host path, e.g. `/dev/serial/by-id/...`.
- `install_replug_watcher`: live replug without container restart (udev + systemd rebind).

## Container Device Path (`container_device_path`)

This field controls **only the target path inside the container**.

- **Default:** `/dev/ttyUSB0`
   - This is a regular device node path that almost any app can open directly.
   - Stability comes from the host path `/dev/serial/by-id/...` (source) + optional live replug.

- **Legacy example:** `/dev/ttyUSB0`
   - Some older containers/apps expect a hard-coded `/dev/ttyUSB0`.
   - In that case set explicitly: `container_device_path=/dev/ttyUSB0`.

Important:

- The replug mechanism (`install_replug_watcher`) always bind-mounts again to **exactly this** target path.
   - That means if you choose `/dev/ttyUSB0` as the target, `/dev/ttyUSB0` stays stable after replug (without restart) as long as the host rebind is active.

## UID

- **Meaning**: container UID that should have access inside the container.
- **Default**: `0` (root).
- **Unprivileged container**: root inside the container is not root on the host.
   To avoid showing up as `nobody` inside the container, the script sets host ownership of the device node to the mapped host IDs (via `lxc.idmap` or Proxmox default).

## GID

- **Meaning**: container GID for access.
- **Default**: `20` (typically `dialout` on Debian/Ubuntu; on Alpine the group number may differ).
- **Example**: `gid=20` results in `root:dialout` inside the container (if the group exists).
- **Unprivileged container**: same idea—script maps/translates to a suitable host GID so it doesn't end up as `nobody`.

## Mapped UID (Host)

Optional: explicit host UID to set on the host for the device node.

- If empty, it will be mapped automatically (from `lxc.idmap` or Proxmox default `100000 + uid`).
- Only needed if you intentionally use a special ID mapping configuration.

## Mapped GID (Host)

Optional: explicit host GID to set on the host for the device node.

- If empty, it will be mapped automatically (from `lxc.idmap` or Proxmox default `100000 + gid`).
- Only needed if you intentionally use a special ID mapping configuration.

## Container Device Path

The target path inside the container to which the device is bind-mounted.

- **Default:** `/dev/ttyUSB0`
- Typical for apps/services that just need a fixed port path.
- For multiple adapters, choose a separate target path per adapter (e.g. `/dev/ttyUSB0`, `/dev/ttyUSB1`, ...).
