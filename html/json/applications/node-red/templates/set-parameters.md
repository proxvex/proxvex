# Set Parameters

Set application-specific parameters for Node-RED

**Execution Target:** ve

## Capabilities

This template provides the following capabilities:

- User management
- Package configuration
- Volume management
- Service configuration
- Network configuration

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
| `hostname` | string | Yes | node-red | Hostname for the Node-RED container |
| `http_port` | string | No | 1880 | Port number for Node-RED HTTP server (default: 1880) ⚙️ Advanced |

<!-- GENERATED_END:PARAMETERS -->

<!-- GENERATED_START:COMMANDS -->
## Properties

This template sets the following properties:

| Property ID | Value |
|-------------|-------|
| `ostype` | alpine |
| `packages` | nodejs npm |
| `command` | node-red |
| `command_args` | --userDir $DATA_DIR --port {{http_port}} |
| `package` | node-red |
| `owned_paths` |  |
| `uid` |  |
| `group` |  |
| `username` | node-red |
| `volumes` | data=node-red |

<!-- GENERATED_END:COMMANDS -->
