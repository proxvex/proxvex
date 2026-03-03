# Wait for LXC Container Ready

Wait until LXC container is ready (network + apk available)

**Execution Target:** ve

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

## Features

This template implements the following features:

- Executes script: `wait-for-container-ready.sh`

## Commands

### Wait for Container

Poll host until the LXC container reports readiness (network up, apk reachable)
