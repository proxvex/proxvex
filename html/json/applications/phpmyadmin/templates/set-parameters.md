# MyPhpAdmin Parameters

Set application-specific parameters for phpMyAdmin

**Execution Target:** ve

## Capabilities

This template provides the following capabilities:

- Package configuration
- Volume management
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
| `hostname` | string | Yes | phpmyadmin | Hostname for the phpMyAdmin container |
| `http_port` | string | No | 80 | Port number for lighttpd HTTP server (default: 80) ⚙️ Advanced |

<!-- GENERATED_END:PARAMETERS -->

<!-- GENERATED_START:COMMANDS -->
## Properties

This template sets the following properties:

| Property ID | Value |
|-------------|-------|
| `ostype` | alpine |
| `packages` | lighttpd php fcgi php-cgi phpmyadmin |
| `volumes` | config=lighttpd<br>config=phpmyadmin |

<!-- GENERATED_END:COMMANDS -->
