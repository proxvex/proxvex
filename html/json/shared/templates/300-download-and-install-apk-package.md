# Download/Install APK Package

Download and install APK package on the LXC container

**Execution Target:** lxc

## Capabilities

This template provides the following capabilities:

- Package installation

## Used By Applications

This template is used by the following applications (usage examples):

- [proxvex](../../../proxvex.md)

<!-- GENERATED_START:PARAMETERS -->
## Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `packageurl` | string | Yes | - | URL of the APK package to be installed |
| `packagerpubkeyurl` | string | Yes | - | URL of the public key for verifying the package |

<!-- GENERATED_END:PARAMETERS -->

<!-- GENERATED_START:OUTPUTS -->
## Outputs

| Output ID | Default | Description |
|-----------|---------|-------------|
| `undefined` | - | - |
| `undefined` | - | - |

<!-- GENERATED_END:OUTPUTS -->

<!-- GENERATED_START:COMMANDS -->
## Commands

This template executes the following commands in order:

| # | Command | Type | Details | Description |
|---|---------|------|---------|-------------|
| 1 | Download and Install Package | Script | `300-download-and-install-apk-package.sh` | Download and install APK package on the LXC container |

<!-- GENERATED_END:COMMANDS -->
