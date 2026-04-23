# Proxvex Parameters

Set application-specific parameters for Proxvex

**Execution Target:** ve

## Capabilities

This template provides the following capabilities:

- Package configuration
- Volume management

## Used By Applications

This template is used by the following applications (usage examples):

- [macbckpsrv](../../../../macbckpsrv.md)
- [mariadb](../../../../mariadb.md)
- [proxvex](../../../../proxvex.md)
- [mosquitto](../../../../mosquitto.md)
- [node-red](../../../../node-red.md)
- [phpmyadmin](../../../../phpmyadmin.md)

<!-- GENERATED_START:PARAMETERS -->
## Parameters

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
## Properties

This template sets the following properties:

| Property ID | Value |
|-------------|-------|
| `ostype` | alpine |
| `volumes` | data=/data<br>config=/config<br>ssl=/ssl |
| `packages` | nodejs npm git openrc |

<!-- GENERATED_END:COMMANDS -->
