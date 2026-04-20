#!/bin/sh
# Default OCI/Docker image version tags
# Override individual tags via environment: export DOCKER_zitadel_TAG=v4.13.0-rc1
#
# Format: <PREFIX>_<service>_TAG  # <image-url>
# The image URL comment can be parsed to pre-pull images for testing.

# --- Zitadel Stack ---
DOCKER_traefik_TAG="${DOCKER_traefik_TAG:-v3.6}"              # traefik
DOCKER_zitadel_TAG="${DOCKER_zitadel_TAG:-v4.12.3}"           # ghcr.io/zitadel/zitadel
DOCKER_zitadel_login_TAG="${DOCKER_zitadel_login_TAG:-v4.12.3}" # ghcr.io/zitadel/zitadel-login

# --- Docker Registry Mirror ---
DOCKER_distribution_TAG="${DOCKER_distribution_TAG:-3.0.0}"   # distribution/distribution

# --- PostgREST ---
DOCKER_postgrest_TAG="${DOCKER_postgrest_TAG:-v14.10}"        # postgrest/postgrest

# --- OCI Image Apps ---
OCI_oci_lxc_deployer_TAG="${OCI_oci_lxc_deployer_TAG:-latest}" # ghcr.io/modbus2mqtt/oci-lxc-deployer
OCI_gptwol_TAG="${OCI_gptwol_TAG:-7.1.5}"                    # misterbabou/gptwol
OCI_node_red_TAG="${OCI_node_red_TAG:-4.1.8}"                # nodered/node-red
OCI_eclipse_mosquitto_TAG="${OCI_eclipse_mosquitto_TAG:-2}"   # eclipse-mosquitto
OCI_gitea_TAG="${OCI_gitea_TAG:-1.25.5}"                      # gitea/gitea
OCI_postgres_TAG="${OCI_postgres_TAG:-16-alpine}"             # postgres
OCI_pgadmin_TAG="${OCI_pgadmin_TAG:-9.14}"                    # dpage/pgadmin4
OCI_nginx_TAG="${OCI_nginx_TAG:-1-alpine}"                    # nginxinc/nginx-unprivileged
OCI_mariadb_TAG="${OCI_mariadb_TAG:-11}"                      # mariadb
OCI_phpmyadmin_TAG="${OCI_phpmyadmin_TAG:-5.2.3}"             # phpmyadmin

# Export all tags so docker-compose subprocesses can resolve ${DOCKER_*_TAG} references
export DOCKER_traefik_TAG DOCKER_zitadel_TAG DOCKER_zitadel_login_TAG DOCKER_distribution_TAG DOCKER_postgrest_TAG
export OCI_oci_lxc_deployer_TAG OCI_gptwol_TAG OCI_node_red_TAG OCI_eclipse_mosquitto_TAG OCI_gitea_TAG
export OCI_postgres_TAG OCI_pgadmin_TAG OCI_nginx_TAG OCI_mariadb_TAG OCI_phpmyadmin_TAG
