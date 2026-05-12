# Playwright Browser Server

Internal application that runs a Playwright Browser Server in an LXC container.
It is controlled remotely via WebSocket and is used by Proxvex's own
end-to-end tests — not a user-installable service. Marked `hidden: true`.

## How it works

- Base image: `mcr.microsoft.com/playwright:v1.59.1-noble` (Ubuntu Noble with
  preinstalled Chromium, Firefox, WebKit and all system dependencies).
- The container's PID 1 is set via `lxc.init.cmd` (using the `initial_command`
  property), which directly starts `npx playwright run-server` — no systemd or
  service manager required.
- Listens on port `3000` for WebSocket connections (`ws://<container>:3000`).
- AppArmor unconfined + dropped capability restrictions are applied via
  `101-conf-configure-lxc-for-docker.json` (shared template) so Chromium's
  user namespaces work inside the LXC.
- Tests connect with `--no-sandbox` because the LXC has no host-level
  sandbox support; safe in the isolated nested test network.

## Key parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `hostname` | `playwright` | Container hostname |
| `oci_image_tag` | `v1.59.1-noble` | Must match the `@playwright/test` version in `package.json` |
| `playwright_port` | `3000` | TCP/WebSocket port inside the container |

## Version pinning

The image tag and the `@playwright/test` npm package version **must match
exactly**, otherwise the client library cannot find browser executables inside
the container. The build script `scripts/check-playwright-version.mjs`
enforces this (see Phase D of the rollout plan).
