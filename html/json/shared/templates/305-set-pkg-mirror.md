# Set Package Mirror

Configure package manager mirrors for Alpine Linux (apk) or Debian/Ubuntu (apt). If mirrors are not set, default repositories will be used.

**Execution Target:** lxc

## Capabilities

This template provides the following capabilities:

- Detecting OS type (Alpine or Debian/Ubuntu)
- Configuring appropriate mirror repositories
- Updating package manager cache

## Used By Applications

This template is used by the following applications (usage examples):

- [macbckpsrv](../../../macbckpsrv.md)
- [proxvex](../../../proxvex.md)
- [mosquitto](../../../mosquitto.md)

<!-- GENERATED_START:PARAMETERS -->
## Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `ostype` | string | No | alpine | Operating system type: 'alpine' for Alpine Linux (apk) or 'debian'/'ubuntu' for Debian/Ubuntu (apt). ⚙️ Advanced |
| `alpine_mirror` | string | No |  | Alpine Linux APK mirror URL (e.g., 'http://dl-cdn.alpinelinux.org/alpine'). If empty, default repositories will be used. Should include base URL without version/repository path. ⚙️ Advanced |
| `debian_mirror` | string | No |  | Debian/Ubuntu APT mirror URL (e.g., 'http://deb.debian.org/debian'). If empty, default repositories will be used. ⚙️ Advanced |

<!-- GENERATED_END:PARAMETERS -->

<!-- GENERATED_START:COMMANDS -->
## Commands

This template executes the following commands in order:

| # | Command | Type | Details | Description |
|---|---------|------|---------|-------------|
| 1 | Unnamed Command | Script | `set-pkg-mirror.sh` | Configure package manager mirrors based on OS type |

<!-- GENERATED_END:COMMANDS -->
