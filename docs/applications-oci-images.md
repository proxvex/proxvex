# Proxvex Applications - OCI Images

This document lists all applications in Proxvex and their available OCI images from Docker Hub or GitHub Container Registry (ghcr.io).

## Applications OCI Images Table

| Application | Name | oci_image |
|-------------|------|-----------|
| mariadb | MariaDB | `mariadb` |
| mosquitto | Mosquitto | `eclipse-mosquitto` |
| node-red | Node-RED | `nodered/node-red` |
| phpmyadmin | phpMyAdmin | `phpmyadmin` |
| proxvex | Proxvex Gateway | `ghcr.io/mazocode/proxvex` |
| alpine-packages | Alpine APK Build Environment | `alpine` |
| macbckpsrv | Mac OS Time Machine Backup Server | `willtho/samba-timemachine` |

## Alternative Images

Some applications have alternative images available:

- **Node-RED**: Also available as `ghcr.io/node-red/node-red` (GHCR)
- **Proxvex**: Also available as `004helix/proxvex` (Docker Hub, community)
- **Samba Time Machine**: Alternative: `timjdfletcher/samba-timemachine` (Docker Hub)

## Usage Notes

### Docker Hub Images
- Pull command: `docker pull <image-name>`
- Example: `docker pull mariadb`

### GitHub Container Registry (GHCR) Images
- Pull command: `docker pull <ghcr.io/image-name>`
- Example: `docker pull ghcr.io/node-red/node-red`

### Image Selection Priority
1. Official images from Docker Hub are preferred when available
2. GHCR images are listed as alternatives when available
3. Community images are listed when no official image exists

## Notes

- **MariaDB**: Official image from Docker Hub
- **Mosquitto**: Official Eclipse Mosquitto image from Docker Hub
- **Node-RED**: Available on both Docker Hub and GHCR
- **phpMyAdmin**: Official image from Docker Hub
- **Proxvex**: Available on both Docker Hub (community) and GHCR (mazocode)
- **Alpine**: Official Alpine Linux base image
- **Samba Time Machine**: Community images available (no official image)









