# Start LXC Container

Start existing LXC container on Proxmox host

**Execution Target:** ve

## Capabilities

This template provides the following capabilities:

- Checking if container exists
- Starting the container if it's not already running

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
| `vm_id` | number | No | - | ID of the virtual machine |

<!-- GENERATED_END:PARAMETERS -->

<!-- GENERATED_START:COMMANDS -->
## Commands

This template executes the following commands in order:

| # | Command | Type | Details | Description |
|---|---------|------|---------|-------------|
| 1 | Unnamed Command | Script | `lxc-start.sh` | - |

<!-- GENERATED_END:COMMANDS -->
