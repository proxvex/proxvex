# Set Package Mirror

Configure package manager mirrors for Alpine Linux (apk) or Debian/Ubuntu (apt). If mirrors are not set, default repositories will be used.

**Execution Target:** lxc

<!-- GENERATED_START:PARAMETERS -->
## Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `ostype` | string | No | alpine | Operating system type: 'alpine' for Alpine Linux (apk) or 'debian'/'ubuntu' for Debian/Ubuntu (apt). ⚙️ Advanced |
| `alpine_mirror` | string | No |  | Alpine Linux APK mirror URL (e.g., 'http://dl-cdn.alpinelinux.org/alpine'). If empty, default repositories will be used. Should include base URL without version/repository path. ⚙️ Advanced |
| `debian_mirror` | string | No |  | Debian/Ubuntu APT mirror URL (e.g., 'http://deb.debian.org/debian'). If empty, default repositories will be used. ⚙️ Advanced |

<!-- GENERATED_END:PARAMETERS -->

## Features

This template implements the following features:

- Executes script: `set-pkg-mirror.sh`

## Commands
