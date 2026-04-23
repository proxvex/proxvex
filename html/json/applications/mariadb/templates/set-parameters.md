# Set Parameters

Set application-specific parameters for MariaDB

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
| `hostname` | string | Yes | mariadb | Hostname for the MariaDB container |
| `datadir` | string | No | /var/lib/mysql | Directory where MariaDB stores its data files ⚙️ Advanced |
| `root_password` | string | No | - | Password for the MariaDB root user. If not set, Unix socket authentication will be used. 🔒 Secure |
| `bind_address` | string | No | 0.0.0.0 | IP address to bind to. Use 0.0.0.0 to accept connections from all interfaces (required for remote access, e.g., from phpMyAdmin) ⚙️ Advanced |
| `allow_remote_root` | boolean | No | true | Allow root user to connect from remote hosts (not recommended for security) ⚙️ Advanced |
| `remove_anonymous_users` | boolean | No | true | Remove anonymous users created for socket authentication ⚙️ Advanced |
| `remove_test_database` | boolean | No | true | Remove the default test database |

<!-- GENERATED_END:PARAMETERS -->

<!-- GENERATED_START:COMMANDS -->
## Properties

This template sets the following properties:

| Property ID | Value |
|-------------|-------|
| `ostype` | alpine |
| `packages` | mariadb mariadb-client |
| `volumes` | data=mysql |

<!-- GENERATED_END:COMMANDS -->
