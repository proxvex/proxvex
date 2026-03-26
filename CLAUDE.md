# OCI LXC Deployer Project Rules

## Project Overview

LXC container management system for Proxmox VE with template-based deployment.

**Important:** This project does NOT use Docker or Docker Swarm. The `docker-compose.yml` files are a configuration format that oci-lxc-deployer **parses and interprets** to create and configure LXC containers. There is no Docker daemon involved. Docker-specific features like `deploy.resources.limits`, `network_mode`, or Docker socket mounts are irrelevant.

## File Locations

- Shared templates: `json/shared/templates/`
- Application templates: `json/applications/<app>/templates/`
- Shared scripts: `json/shared/scripts/`
- Application scripts: `json/applications/<app>/scripts/`
- Schemas: `schemas/`
- Backend: `backend/`
- Frontend: `frontend/`

## Script Naming Conventions

Scripts are prefixed based on where/when they execute:

| Prefix | Execution Context | Example |
|--------|------------------|---------|
| `host-` | Runs on PVE host | `host-get-latest-os-template.sh` |
| `conf-` | Configures LXC before start | `conf-create-lxc-container.sh` |
| `post-` | Runs inside container after start | `post-install-apk-package.sh` |
| `svc-` | Service management in container | `svc-create-enable-service.sh` |

## Shell Scripts

- Scripts run inside Alpine Linux LXC containers (or Debian/Ubuntu)
- Use POSIX-compliant `/bin/sh`, not bash
- Template variables use `{{ variable }}` syntax
- stdout must only contain JSON output valid against `schemas/outputs.schema.json`
- All other output (logs, debug, errors) must go to stderr
- Never use `2>&1` in scripts - it violates the JSON-only stdout rule

## Libraries

Scripts can use shared libraries via the `library` property in templates:

```json
{
  "script": "post-install-apk-package.sh",
  "library": "pkg-common.sh"
}
```

**Library rules:**
- Libraries are prepended to scripts before execution
- Libraries must NOT contain `{{ }}` template variables
- Libraries contain only function definitions, no direct execution
- Existing libraries: `pkg-common.sh`, `usb-device-common.sh`, `map_device_lib.py`, `setup_lxc_idmap_common.py`

### pkg-common.sh Functions

Use for all package installation tasks:

| Function | Purpose |
|----------|---------|
| `pkg_wait_for_network` | Wait for DNS with retry (solves timing issues) |
| `pkg_detect_os` | Detect Alpine/Debian/Ubuntu |
| `pkg_update_cache` | Update cache (only once per session) |
| `pkg_install <pkgs>` | Install packages (auto-detects OS) |
| `pkg_add_alpine_community` | Enable Alpine community repo |

## Templates

- Templates must validate against `schemas/template.schema.json`
- Template outputs must conform to `schemas/output.template.schema.json`
- Scripts referenced in templates must exist in the corresponding `scripts/` directory

## Applications

- Application configs must conform to `schemas/application.schema.json`
- Applications can use inheritance via `extends`
- Create `set-parameters.json` for application-specific defaults

## Parameters

- Parameters pass between templates by name matching
- Parameters are auto-discovered across templates
- Output format `{ "id": "<id>", "default": "<value>" }` sets defaults

## Language

- All file content, variables, keys, strings in English
- German only in user-facing chat or UI localization

## Package Manager

This project uses **pnpm** (not npm or yarn).

```bash
pnpm install          # Install dependencies
pnpm run <script>     # Run scripts
```

## Testing and Quality

After significant **backend TypeScript** changes:

```bash
# Backend (only needed for .mts/.ts changes, NOT for json/ or scripts/)
cd backend && pnpm run lint:fix && pnpm run build && pnpm test

# Frontend
cd frontend && pnpm run lint:fix && pnpm run build && pnpm test
```

**Execution order:**
1. `pnpm run lint:fix` - Fix style issues
2. `pnpm run build` - Verify compilation
3. `pnpm test` - Run tests

**What to test:**
- Services with complex logic (parsing, validation, transformation)
- Critical user flows (create application, docker-compose setup)
- Error cases and edge cases

**What NOT to test:**
- Trivial getters/setters
- Simple template bindings
- Pure presentation components

## Live Integration Tests

When templates or scripts in `json/` are modified, suggest running the live integration tests:

```bash
# Run with default alpine-packages on pve1.cluster
./backend/tests/livetests/run-live-test.sh pve1.cluster

# Test specific application
./backend/tests/livetests/run-live-test.sh pve1.cluster node-red installation

# Keep container for debugging
KEEP_VM=1 ./backend/tests/livetests/run-live-test.sh pve1.cluster
```

The test creates a real container on a Proxmox host and verifies:
- Container creation and startup
- Notes contain `oci-lxc-deployer:managed` marker
- Notes contain log-url, icon-url, and Links section

## Import Resolution

If imports fail:
1. Manually correct based on file structure
2. Delete import, run `pnpm run lint:fix`
3. Use IDE Quick Fix (Cmd/Ctrl+.)
