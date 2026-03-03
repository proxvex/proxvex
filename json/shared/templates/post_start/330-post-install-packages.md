# Install Packages

Install packages inside the LXC container. Supports both Alpine Linux (apk) and Debian/Ubuntu (apt) package managers.

**Execution Target:** lxc

<!-- GENERATED_START:PARAMETERS -->
## Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `packages` | string | Yes | - | Space-separated list of packages to install. For Alpine Linux, use APK package names. For Debian/Ubuntu, use apt package names. |
| `ostype` | string | No | alpine | Operating system type: 'alpine' for Alpine Linux (apk) or 'debian'/'ubuntu' for Debian/Ubuntu (apt). ⚙️ Advanced |

<!-- GENERATED_END:PARAMETERS -->

## Features

This template implements the following features:

- Package installation

## Commands
