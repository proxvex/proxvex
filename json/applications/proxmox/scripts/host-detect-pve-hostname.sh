#!/bin/sh
# Emit the PVE host's actual short hostname so addon-ssl signs the web UI
# certificate for the right SAN. Without this, downstream cert signing would
# use the scenario name (e.g. proxmox-oidc-ssl) instead of the real host.
HOST=$(uname -n | cut -d. -f1)
printf '[{"id":"hostname","value":"%s"}]' "$HOST"
