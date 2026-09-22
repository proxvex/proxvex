#!/bin/sh
# Default OCI/Docker image version tags
# Override individual tags via environment: export DOCKER_zitadel_TAG=v4.13.0-rc1
#
# Format: <PREFIX>_<service>_TAG  # <image-url>
# The image URL comment can be parsed to pre-pull images for testing.

# --- Zitadel Stack ---
DOCKER_traefik_TAG="${DOCKER_traefik_TAG:-v3.7}"              # traefik
DOCKER_zitadel_TAG="${DOCKER_zitadel_TAG:-v4.16.1}"           # ghcr.io/zitadel/zitadel
DOCKER_zitadel_login_TAG="${DOCKER_zitadel_login_TAG:-v4.16.1}" # ghcr.io/zitadel/zitadel-login

# --- PostgREST ---
DOCKER_postgrest_TAG="${DOCKER_postgrest_TAG:-v14.15}"        # postgrest/postgrest
DOCKER_cloudflare_tunnel_TAG="${DOCKER_cloudflare_tunnel_TAG:-2026.7.1}" # cloudflare/cloudflared (remote-managed tunnel connector)

# --- OCI Image Apps ---
OCI_proxvex_TAG="${OCI_proxvex_TAG:-latest}"                 # ghcr.io/proxvex/proxvex
OCI_github_runner_TAG="${OCI_github_runner_TAG:-latest}"     # ghcr.io/proxvex/github-actions-runner
OCI_gptwol_TAG="${OCI_gptwol_TAG:-7.1.5}"                    # misterbabou/gptwol
OCI_node_red_TAG="${OCI_node_red_TAG:-5.0.1}"                # nodered/node-red
OCI_modbus2mqtt_TAG="${OCI_modbus2mqtt_TAG:-0.28.0}"           # ghcr.io/modbus2mqtt/modbus2mqtt
OCI_eclipse_mosquitto_TAG="${OCI_eclipse_mosquitto_TAG:-2}"   # eclipse-mosquitto
OCI_zigbee2mqtt_TAG="${OCI_zigbee2mqtt_TAG:-latest}"         # ghcr.io/koenkk/zigbee2mqtt
OCI_esphome_TAG="${OCI_esphome_TAG:-latest}"                 # ghcr.io/esphome/esphome
OCI_homebridge_TAG="${OCI_homebridge_TAG:-latest}"           # homebridge/homebridge
OCI_gitea_TAG="${OCI_gitea_TAG:-1.26.4}"                      # gitea/gitea
OCI_postgres_TAG="${OCI_postgres_TAG:-16-alpine}"             # postgres
OCI_pgadmin_TAG="${OCI_pgadmin_TAG:-9.16}"                    # dpage/pgadmin4
OCI_nginx_TAG="${OCI_nginx_TAG:-1-alpine}"                    # nginxinc/nginx-unprivileged
OCI_mariadb_TAG="${OCI_mariadb_TAG:-11}"                      # mariadb
OCI_phpmyadmin_TAG="${OCI_phpmyadmin_TAG:-5.2.3}"             # phpmyadmin
OCI_docker_registry_mirror_TAG="${OCI_docker_registry_mirror_TAG:-3.1.1}" # distribution/distribution
OCI_zot_mirror_TAG="${OCI_zot_mirror_TAG:-v2.1.5}"            # ghcr.io/project-zot/zot-linux-amd64 (paused: PVE 9.1.x OCI extractor bug, see memory project_zot_mirror_blocked)
OCI_playwright_TAG="${OCI_playwright_TAG:-v1.57.0-noble}"     # mcr.microsoft.com/playwright (synced from frontend/package.json)
OCI_oauth2_proxy_testbed_TAG="${OCI_oauth2_proxy_testbed_TAG:-alpine}" # nginx:alpine (testbed for addon-oauth2-proxy; shell-having image needed for on_start hook)
OCI_wolproxy_TAG="${OCI_wolproxy_TAG:-latest}"               # ghcr.io/proxvex/wolproxy (stable JSON API for WoL+ping)

# Export all tags so docker-compose subprocesses can resolve ${DOCKER_*_TAG} references
export DOCKER_traefik_TAG DOCKER_zitadel_TAG DOCKER_zitadel_login_TAG DOCKER_postgrest_TAG DOCKER_cloudflare_tunnel_TAG
export OCI_proxvex_TAG OCI_gptwol_TAG OCI_node_red_TAG OCI_modbus2mqtt_TAG OCI_eclipse_mosquitto_TAG OCI_zigbee2mqtt_TAG OCI_esphome_TAG OCI_homebridge_TAG OCI_gitea_TAG
export OCI_postgres_TAG OCI_pgadmin_TAG OCI_nginx_TAG OCI_mariadb_TAG OCI_phpmyadmin_TAG OCI_docker_registry_mirror_TAG
export OCI_zot_mirror_TAG OCI_playwright_TAG OCI_oauth2_proxy_testbed_TAG OCI_wolproxy_TAG
