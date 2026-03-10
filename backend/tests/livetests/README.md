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
# Run all tests
npx tsx backend/tests/livetests/src/live-test-runner.mts local-test --all

# Run specific app (all scenarios + dependencies)
npx tsx backend/tests/livetests/src/live-test-runner.mts local-test postgres

# Run specific scenario (+ dependencies)
npx tsx backend/tests/livetests/src/live-test-runner.mts local-test zitadel/ssl

# Keep containers for debugging
KEEP_VM=1 npx tsx backend/tests/livetests/src/live-test-runner.mts local-test zitadel/ssl
```

### Arguments

1. `instance` - Instance name from `e2e/config.json` (optional, uses default)
2. `test-name` - `<app>`, `<app>/<scenario>`, or `--all`

## Test Definitions

Tests are defined per application in `json/applications/<app>/tests/test.json`.
Each scenario tests exactly one application. Dependencies are declared via `depends_on`.

```json
{
  "ssl": {
    "description": "Zitadel with SSL and Postgres with SSL",
    "depends_on": ["postgres/ssl"],
    "addons": ["addon-ssl"],
    "wait_seconds": 60,
    "verify": { "container_running": true, "services_up": true, "tls_connect": 8080 }
  }
}
```

### Params files

Optional `<scenario>.json` alongside `test.json` provides app-specific parameters:

```json
{
  "params": [
    { "name": "envs", "append": "PGADMIN_DEFAULT_EMAIL", "value": "admin@test.local" },
    { "name": "upload_config", "value": "file:config.conf" }
  ]
}
```

- **Set mode**: `{ "name": "key", "value": "val" }` — sets or overrides a parameter
- **Append mode**: `{ "name": "envs", "append": "VAR", "value": "val" }` — appends to multiline variable
- **File upload**: `"value": "file:relative-path"` — resolves relative to tests dir

### Verify Options

| Option | Description |
|--------|-------------|
| `container_running` | LXC container status is "running" |
| `notes_managed` | Notes contain `oci-lxc-deployer:managed` marker |
| `services_up` | All docker services show "Up" status |
| `lxc_log_no_errors` | No ERROR lines in LXC console log |
| `docker_log_no_errors` | No ERROR lines in docker container logs |
| `tls_connect` | TLS connection succeeds on given port |
| `pg_ssl_on` | Postgres SSL is enabled |
| `db_ssl_connection` | Client connection uses SSL |

## Cleanup

Containers are automatically destroyed after the test, unless `KEEP_VM=1` is set.
