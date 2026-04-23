# Map Serial Device (Proxvex)

This variant is intended for Proxvex and makes `host_device_path` **required**, so the UI always asks for the serial port.

## USB Serial Port

Select the host serial port (stable path, typically under `/dev/serial/by-id/...`).

## Live Replug (Host Installation)

If enabled, a udev+systemd replug mechanism is installed on the Proxmox host so unplug/replug works again without restarting the container.

## ID of the VM

CT ID of the target container (Proxmox LXC ID).

## UID

UID **inside the container** that should own the device (default: `0`).

## GID

GID **inside the container** that should own the device (default: `20`).

## Mapped UID (Host)

Optional: explicit host UID (numeric) for unprivileged containers.

## Mapped GID (Host)

Optional: explicit host GID (numeric) for unprivileged containers.

## Container Device Path

Target path inside the container (default: `/dev/ttyUSB0`).
