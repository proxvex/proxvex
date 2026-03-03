# Create and Enable Service

Creates (if needed), enables, and starts a service inside the container. Supports Alpine Linux (OpenRC) and Debian/Ubuntu (systemd). If the service already exists, it will be enabled and started.

## Command
The command (binary or script) to run and the base for the service name. Use an absolute path if the executable is not on the `PATH`.

- Examples: `/usr/sbin/mosquitto`, `/usr/bin/node /opt/app/server.js`

## Username
The user account the service should run as.

- Default: `root`
- If a non-root user is desired, set a username (it will be created if needed).

## Command Line Arguments
Optional additional arguments passed to the command.

- You can use variables: `$HOME_DIR`, `$DATA_DIR`, `$SECURE_DIR`.
- Example: `--config $DATA_DIR/mosquitto.conf --log_dest file:$DATA_DIR/mosquitto.log`

## User ID
Optional numeric UID for the service user.

- Default: `0` (root)
- Leave empty unless you need a fixed UID for file ownership stability across restarts or shared mounts.
- In unprivileged containers the UID applies inside the container namespace. Mapping to the host is handled by the container runtime; you typically do not need to set a mapped UID here.

## Group Name
Optional group name for the service user.

- Will be created if it does not exist.
- Useful to align file access via group membership.

## Owned Paths
Space-separated list of files/directories that should be owned by the service user with read/write access.

- Ensure the paths exist before starting the service.
- Example: `/var/lib/mosquitto /etc/mosquitto`

## Bind Privileged Port
Allow binding to privileged ports (below 1024), e.g., `80` or `443`.

- When enabled, the capability `CAP_NET_BIND_SERVICE` is set for the service executable.
- Use only when strictly required, as it elevates privileges for network binding.
