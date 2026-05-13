# Proxvex Project Rules

## Project Overview

LXC container management system for Proxmox VE with template-based deployment.

**Important:** This project does NOT use Docker or Docker Swarm. The `docker-compose.yml` files are a configuration format that proxvex **parses and interprets** to create and configure LXC containers. There is no Docker daemon involved. Docker-specific features like `deploy.resources.limits`, `network_mode`, or Docker socket mounts are irrelevant.

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

## On-Start Hooks

Container-Lifecycle-Hooks liegen auf dem Host in `${VOLUME_DIR}/on_start.d/*.sh` und werden via Bind-Mount unter `/etc/proxvex/on_start.d/` im Container sichtbar. Der Dispatcher `/etc/proxvex/on_start_container` wird von Proxmox bei jedem Container-Start aufgerufen.

**Erzeugung:**
- `pre_start/166-conf-write-on-start-scripts` schreibt Dispatcher, `ssl-proxy.sh`, `smbd.sh`
- `post_start/342-post-install-acme-renew-on-start` schreibt `acme-renew.sh`

Beide Templates überschreiben die Dateien bei jeder Ausführung.

**Update einer Hook nach Code-Änderung:**
Reconfigure der betroffenen Application auslösen. Addons mit `has_on_start_hooks` (`addon-ssl`, `addon-acme`) führen ihre Hook-erzeugenden Templates bei Reconfigure erneut aus und überschreiben die Dateien im managed Volume. Reines Upgrade reicht für `acme-renew.sh` nicht (addon-acmes Upgrade-Phase enthält 342 nicht).

**Variablen-Update ohne Hook-Rewrite:**
Stack-Refresh mit Methode `on-start-env` patcht eine einzelne Shell-Variable in einem bestehenden Hook-Skript, ohne das Skript neu zu schreiben.

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

**Livetests are the preferred validation tool for every script and template change.** They reproduce real deploy behavior in a controlled nested-VM environment and (since Extended Logging) produce a complete debug bundle for failure analysis.

**Workflow rule**: When a problem appears or a change needs validation, **always first consider whether it can be reproduced in livetest**. Production tests (against `pve1.cluster`) are only the right tool when:
- The problem demonstrably only occurs in the real cluster environment (network topology, external services, hardware specifics), or
- The cluster configuration itself is the subject of the change.

In all other cases: livetest first, production second.

**Invocation**: `/livetest` (no arguments → help text + interactive selection). Common patterns:

```
/livetest eclipse-mosquitto/default       # quick smoke test (~1 min)
/livetest --debug script <scenario>       # with set -x in shell scripts and full debug bundle
/livetest --fix <scenario>                # autonomous fix loop: analyzes bundle, iterates
/livetest --all                           # full suite
```

Each scenario run writes a debug bundle to `livetest-results/<runId>/<scenarioId>/` (`index.md`, per-script trace, JSON sidecars, `variables.md`, …). The first place to look for failure analysis is always that bundle's `livetest-index.md`.

What the tests verify:
- Container creation and startup
- Notes contain the `proxvex:managed` marker
- Notes contain log-url, icon-url, and Links section
- Per-scenario additionally: application-specific health checks (TLS, Postgres SSL, Docker services up, …)

## Import Resolution

If imports fail:
1. Manually correct based on file structure
2. Delete import, run `pnpm run lint:fix`
3. Use IDE Quick Fix (Cmd/Ctrl+.)
