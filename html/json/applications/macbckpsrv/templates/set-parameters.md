# Backup Share Parameters

Set application-specific parameters for Mac OS Time Machine Backup Server

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
| `hostname` | string | Yes | macbckpsrv | Hostname for the Mac OS Time Machine Backup Server container |
| `username` | string | Yes | macbckpsrv | Username for the Mac OS Time Machine Backup Server container |
| `password` | string | Yes | - | The password for the Samba user. 🔒 Secure |
| `uid` | string | No | 1000 | UID for the user and mount permissions. Will be used consistently on VE host and LXC container. ⚙️ Advanced |
| `gid` | string | No | 1000 | GID for the user and mount permissions. Will be used consistently on VE host and LXC container. ⚙️ Advanced |
| `share_name` | string | No | backup | Name of the Samba share for Time Machine backups. ⚙️ Advanced |

<!-- GENERATED_END:PARAMETERS -->

<!-- GENERATED_START:COMMANDS -->
## Properties

This template sets the following properties:

| Property ID | Value |
|-------------|-------|
| `ostype` | debian |
| `volumes` | timemachine=timemachine |
| `envs` | USERNAME={{username}}<br>PASSWORD={{password}}<br>SHARE_NAME={{share_name}} |
| `packages` | samba avahi-daemon |

<!-- GENERATED_END:COMMANDS -->
