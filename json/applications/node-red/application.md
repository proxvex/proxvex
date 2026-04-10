# Node-RED

Flow-based programming tool for wiring together hardware devices, APIs, and online services.

## Installation

### Key Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `hostname` | `node-red` | Container hostname |
| `volumes` | `data=/data`, `certs` | Flow data and certificates |

## Configuration

### settings.js

Upload a custom `settings.js` file during installation to configure Node-RED behavior (authentication, editor settings, logging, etc.). The file is placed in the `data` volume at `/data/settings.js`.

The upload only runs during installation. To update `settings.js` after deployment, edit the file directly in the volume on the PVE host and restart the container.

### Serial/USB Devices

Node-RED supports serial device passthrough for hardware integration (e.g. Zigbee sticks, serial sensors). Use the `serial_tty` parameter to map a host device into the container.

## OIDC Authentication

Enable the `addon-oidc` addon to protect Node-RED with Zitadel authentication. The callback path is `/auth/strategy/callback`.

## Ports

| Port | Protocol | Description |
|------|----------|-------------|
| 1880 | HTTP | Node-RED editor and dashboard |

## Addons

| Addon | Description |
|-------|-------------|
| `addon-oidc` | OpenID Connect authentication via Zitadel |

## Upgrade

Pulls new Node-RED image. Flows and installed nodes in the data volume are preserved.
