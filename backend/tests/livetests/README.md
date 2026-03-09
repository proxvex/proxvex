# Live Integration Tests

These tests create real containers on a Proxmox VE host via `oci-lxc-cli` and verify functionality.

## Prerequisites

1. **Nested VM with Deployer** running (via `e2e/step1` + `e2e/step2`)
2. **Project is built** (incl. CLI): `cd $PROJECT_ROOT && pnpm run build`
3. **Deployer API** is reachable (checked automatically)

## Configuration

Tests use the central `e2e/config.json` for all settings (PVE host, ports, etc.).

## Usage

```bash
# Default test (alpine-packages)
./run-live-test.sh github-action

# Specific test definition
./run-live-test.sh github-action zitadel-ssl

# Keep containers for debugging
KEEP_VM=1 ./run-live-test.sh github-action zitadel
```

### Arguments

1. `instance` - Instance name from `e2e/config.json` (optional, uses default)
2. `test-name` - Test name from `test-definitions.json` or application name (default: alpine-packages)

## Test Definitions

Tests are defined in `test-definitions.json`. Each test has sequential steps:

```json
{
  "zitadel-ssl": {
    "description": "Zitadel with SSL and Postgres",
    "steps": [
      { "application": "postgres", "task": "installation", "addons": ["addon-ssl"],
        "verify": { "container_running": true, "lxc_log_no_errors": true } },
      { "application": "zitadel", "task": "installation", "addons": ["addon-ssl"],
        "wait_seconds": 60,
        "verify": { "container_running": true, "services_up": true, "tls_connect": 8080 } }
    ]
  }
}
```

### Verify Options

| Option | Description |
|--------|-------------|
| `container_running` | LXC container status is "running" |
| `notes_managed` | Notes contain `oci-lxc-deployer:managed` marker |
| `services_up` | All docker services show "Up" status |
| `lxc_log_no_errors` | No ERROR lines in LXC console log |
| `docker_log_no_errors` | No ERROR lines in docker container logs |
| `tls_connect` | TLS connection succeeds on given port |

## Cleanup

Containers are automatically destroyed after the test, unless `KEEP_VM=1` is set.
