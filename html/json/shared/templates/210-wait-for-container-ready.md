# Wait for LXC Container Ready

Wait until LXC container is ready (network + apk available)

**Execution Target:** ve

## Capabilities

This template provides the following capabilities:

- Polling lxc-attach for simple commands until success or timeout
- Checking hostname resolution
- Checking network connectivity
- Checking package manager availability (apk for Alpine, apt for Debian/Ubuntu)

## Used By Applications

This template is used by the following applications (usage examples):

- [mariadb](../../../mariadb.md)
- [proxvex](../../../proxvex.md)
- [mosquitto](../../../mosquitto.md)
- [node-red](../../../node-red.md)
- [phpmyadmin](../../../phpmyadmin.md)

<!-- GENERATED_START:PARAMETERS -->
## Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `vm_id` | string | Yes | - |  |

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
| 1 | Wait for Container | Script | `wait-for-container-ready.sh` | Poll host until the LXC container reports readiness (network up, apk reachable) |

<!-- GENERATED_END:COMMANDS -->
