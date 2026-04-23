# Create User on LXC Container

Create a user inside the LXC container with specified username, optional uid, and optional gid. If uid/gid are not provided, the system will assign them automatically. Calls create-user.sh with template variables.

**Execution Target:** lxc

## Capabilities

This template provides the following capabilities:

- Creating group with optional GID
- Creating user with optional UID
- Setting up home directory
- Configuring user without password and login shell

## Used By Applications

This template is used by the following applications (usage examples):

- [macbckpsrv](../../../macbckpsrv.md)
- [proxvex](../../../proxvex.md)

<!-- GENERATED_START:PARAMETERS -->
## Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `username` | string | Yes | - | The username to create inside the LXC container. |
| `uid` | string | No | - | Optional: The UID for the user. If not provided, the system will assign one automatically. ⚙️ Advanced |
| `gid` | string | No | - | Optional: The GID for the user. If not provided, the system will assign one automatically. ⚙️ Advanced |

<!-- GENERATED_END:PARAMETERS -->

<!-- GENERATED_START:COMMANDS -->
## Commands

This template executes the following commands in order:

| # | Command | Type | Details | Description |
|---|---------|------|---------|-------------|
| 1 | Unnamed Command | Script | `create-user.sh` | Create a user inside the LXC container with specified username, optional uid, and optional gid. C... |

<!-- GENERATED_END:COMMANDS -->
