# Docker Compose Framework

The Docker Compose Framework enables deployment of Docker applications in LXC containers on Proxmox VE.

> **Important:** This document covers UID/GID configuration for **volume mounts only**.
>
> **No volume mounts = No UID configuration needed.**
>
> If your docker-compose file has no `volumes:` sections, or only uses Docker-managed named volumes without host persistence requirements, you can skip this entire document.

---

## Quick Reference: UID Configuration Decision Matrix

Use this matrix to determine what action is needed for your docker-compose setup:

| Scenario | `user:` in compose? | Action Required | Automatic? |
|----------|---------------------|-----------------|------------|
| Single service, UID known | Yes (`user: "500"`) | None | ✅ Yes |
| Single service, UID unknown | No | Find UID, add to compose or enter in UI | ❌ No |
| Multiple services, same UID | Yes (all same) | None | ✅ Yes |
| Multiple services, different UIDs | Yes (mixed) | Manual fix after deployment | ❌ No |
| Named volumes only | N/A | None (Docker manages permissions) | ✅ Yes |
| Root container (UID 0) | No or `user: "0"` | None | ✅ Yes |

### Decision Flowchart

```
Does your compose file have volumes that need write access?
│
├─ No  → No action needed
│
└─ Yes → Does the service specify `user: "NNN"` in compose?
         │
         ├─ Yes → Is it the only service with volumes, or do all share the same UID?
         │        │
         │        ├─ Yes → ✅ Automatic (deployer handles it)
         │        │
         │        └─ No  → ⚠️ Manual fix needed after deployment
         │
         └─ No  → Do you know the UID the container runs as?
                  │
                  ├─ Yes → Add `user: "NNN"` to compose, or enter in UI
                  │
                  └─ No  → Find UID first (see "Finding the UID" section)
```

### Quick Actions by Scenario

| If you have... | Do this... |
|----------------|------------|
| `user: "500"` in compose | Nothing - works automatically |
| No `user:` but know UID is 1000 | Add `user: "1000"` to compose file |
| No `user:` and don't know UID | Run `docker run --rm <image> id` to find it |
| Multiple services, different UIDs | Deploy first, then fix with `chown` on PVE host |
| Permission errors after deploy | Check UID, run `chown -R <mapped_uid> /rpool/volumes/<app>/` |

---

## UID/GID Coordination for Volume Mounts

When mounting volumes, three layers must be coordinated:

```
Proxmox VE Host (PVE)
    ↓ Bind Mount
LXC Container (unprivileged)
    ↓ Docker Volume Mount
Docker Container
```

### The Problem

Docker containers often run as non-root users (e.g., UID 500). When such a container needs to write to a mounted volume, file permissions must be correct on **all three layers**.

**Example:** Zitadel runs as `user: "500"` and writes to `/current-dir/login-client.pat`

| Layer | Path | Required UID |
|-------|------|--------------|
| Docker | `/current-dir` | 500 |
| LXC | `/rpool/volumes/app/_` | 500 (container view) |
| PVE Host | `/rpool/volumes/app/_` | 100500 (mapped) |

### UID Mapping in Unprivileged LXC

Proxmox uses UID mapping for unprivileged containers:

```
Container UID 0    → Host UID 100000
Container UID 500  → Host UID 100500
Container UID 1000 → Host UID 101000
```

The OCI LXC Deployer calculates these mappings automatically.

## UID Sources

The UID can come from different sources:

### 1. docker-compose.yaml (automatically detected)

```yaml
services:
  myapp:
    image: myimage
    user: "500"        # ← Automatically extracted
    volumes:
      - ./data:/app/data
```

The deployer extracts the first numeric `user:` value found and uses it for volume permissions.

### 2. Dockerfile (manual discovery required)

When the UID is defined in the Dockerfile:

```dockerfile
RUN useradd -u 500 appuser
USER appuser
```

This UID must be discovered manually (see below).

### 3. UI Input

In the deployment dialog, UID can be entered manually:
- **UID**: User ID for volume ownership
- **GID**: Group ID for volume ownership

## Finding the UID (when unknown)

### Method 1: Check Image Documentation

Many images document their user:
- Docker Hub description
- GitHub README
- Official Helm Chart / Compose examples

### Method 2: Start Container and Inspect

```bash
# Start container temporarily
docker run --rm -it --entrypoint sh <image-name>

# Inside container: show current user's UID
id
# Output: uid=500(appuser) gid=500(appuser) groups=500(appuser)

# Or: check process user
docker run -d --name temp <image-name>
docker exec temp ps aux
docker rm -f temp
```

### Method 3: Analyze Dockerfile

```bash
# Pull image and search for USER directive
docker pull <image-name>
docker history --no-trunc <image-name> | grep -i user
```

### Common UIDs for Popular Images

| Image | UID | GID | Note |
|-------|-----|-----|------|
| postgres | 999 | 999 | `postgres` user |
| nginx | 101 | 101 | `nginx` user |
| node | 1000 | 1000 | `node` user |
| zitadel | 500 | 500 | Documented |
| redis | 999 | 999 | `redis` user |
| grafana | 472 | 0 | `grafana` user |

## Configuration Examples

### Example 1: UID in docker-compose.yaml

```yaml
services:
  app:
    image: myapp:latest
    user: "1000:1000"    # UID:GID explicitly set
    volumes:
      - ./config:/app/config
      - app-data:/app/data

volumes:
  app-data:
```

→ The deployer detects UID 1000 automatically.

### Example 2: UID Only in Dockerfile

When the image has a fixed user but `user:` is not in the compose file:

1. Discover UID (see above)
2. Enter in deployment dialog under "Advanced":
   - UID: `1000`
   - GID: `1000`

### Example 3: Root Container (UID 0)

```yaml
services:
  app:
    image: myapp:latest
    # No user: → runs as root
    volumes:
      - ./data:/data
```

→ No special configuration needed (default UID 0).

## Troubleshooting

### "Permission denied" When Writing

**Symptom:**
```
Error: open /app/data/file.txt: permission denied
```

**Causes:**
1. UID not set correctly
2. Volume directory has wrong ownership

**Solution:**
```bash
# Check in LXC container
ls -la /rpool/volumes/<app>/

# Fix ownership (as root in LXC)
chown -R <UID>:<GID> /opt/docker-compose/<app>/
```

### Container Starts but Cannot Write

**Check:**
```bash
# Docker logs
docker compose logs <service>

# Process user in running container
docker exec <container> id
docker exec <container> ls -la /app/data
```

### Volume Directory Owned by "nobody"

**Cause:** UID mapping mismatch between host and LXC.

**Solution:** Verify that the mapped UID (100000 + container UID) is correctly set on the PVE host:

```bash
# On PVE host
ls -lan /rpool/volumes/<app>/
# Should show e.g. 100500:100500 for container UID 500
```

## Current Limitations

### Multiple Services with Different UIDs

**Problem:** The deployer only extracts the **first** numeric `user:` value found in the compose file. If multiple services run as different users, only one UID is used for all volume permissions.

```yaml
services:
  frontend:
    user: "1000"      # ← This UID is used
    volumes:
      - ./frontend:/app

  backend:
    user: "500"       # ← This UID is IGNORED
    volumes:
      - ./backend:/app
```

**Workaround:** Manually fix permissions after deployment:

```bash
# On PVE host (for unprivileged LXC)
chown -R 100500:100500 /rpool/volumes/<app>/backend
chown -R 101000:101000 /rpool/volumes/<app>/frontend

# Or inside LXC container
chown -R 500:500 /opt/docker-compose/<app>/backend
chown -R 1000:1000 /opt/docker-compose/<app>/frontend
```

### UID Only in Dockerfile (not in compose)

**Problem:** If the image uses a non-root user defined only in the Dockerfile (no `user:` in compose), the deployer cannot detect it automatically.

```yaml
services:
  app:
    image: someimage:latest   # Image runs as UID 1000 internally
    # No user: specified!
    volumes:
      - ./data:/app/data      # Will be owned by root (UID 0)
```

**Workaround Options:**

1. **Add `user:` to compose file** (recommended):
   ```yaml
   services:
     app:
       image: someimage:latest
       user: "1000"           # Add explicit user
   ```

2. **Specify UID in deployment dialog** under "Advanced" settings

3. **Fix manually after deployment** (see above)

### Named Volumes vs. Bind Mounts

**Problem:** Docker named volumes are managed by Docker itself and don't require host-side permission setup. However, the deployer creates LXC bind mounts for all volumes, which may be unnecessary for named volumes.

```yaml
volumes:
  - postgres-data:/var/lib/postgresql/data  # Named volume
  - ./config:/app/config                     # Bind mount
```

For named volumes, Docker handles permissions internally. The LXC bind mount is only needed if you want data persistence outside the Docker volume system.

### Shared Volumes Between Services

**Problem:** When multiple services share the same volume but run as different users:

```yaml
services:
  writer:
    user: "1000"
    volumes:
      - shared-data:/data

  reader:
    user: "2000"
    volumes:
      - shared-data:/data:ro

volumes:
  shared-data:
```

**Workaround:** Use a common group or set world-readable permissions:

```bash
# Make readable by all
chmod -R 755 /rpool/volumes/<app>/shared-data

# Or use common group (requires group setup in containers)
chgrp -R 1000 /rpool/volumes/<app>/shared-data
chmod -R g+rw /rpool/volumes/<app>/shared-data
```

## Technical Details

### Template Chain

```
310-post-extract-volumes-from-compose.json
    ├── Extracts: volumes, uid, gid
    ↓
121-conf-mount-zfs-pool-on-host.json
    ├── Determines: host_mountpoint (e.g., /rpool)
    ↓
150-conf-create-storage-volumes-for-lxc.json
    ├── Creates managed Proxmox subvolumes on PVE host
    ├── Calculates mapped_uid = 100000 + uid
    └── Sets chown $mapped_uid:$mapped_gid
```

### Relevant Files

- `conf-create-storage-volumes-for-lxc.sh`: Creates managed volumes with correct ownership
- `host-extract-volumes-from-compose.py`: Extracts volumes and UID from docker-compose
- `post-upload-docker-compose-files.sh`: Uploads compose files, sets LXC-internal permissions

---

# Log-Zugriff & Notes Konzept

## Übersicht

HTTP-basierter Log-Zugriff für Docker-Container in LXC und Optimierung der Proxmox Notes.

## Problemstellung

1. **Keine Log-Einsicht:** Docker-Container-Logs können nicht per HTTP gelesen werden
2. **Notes zu früh:** Notes werden in Template 100 geschrieben, bevor alle Infos verfügbar sind
3. **Fehlende Service-Infos:** Service-Namen aus docker-compose.yaml fehlen in Notes

## Lösungsarchitektur

### Phase 1: Backend Log API (Aktuelle Implementierung)

#### API Endpunkte

```
GET /api/:veContext/ve/logs/:vmId
    Query: ?lines=100
    → Liest LXC Console Log vom Host
    → Für alle Anwendungen (oci-image, docker-compose)

GET /api/:veContext/ve/logs/:vmId/docker
    Query: ?lines=100&service=nextcloud
    → Führt aus: lxc-attach -n VMID -- docker logs [SERVICE]
    → Ohne service: docker-compose logs (alle Services)
    → Nur für docker-compose Anwendungen
```

#### Implementierung

Die Log-API nutzt die bestehende VeExecution-Infrastruktur:

```
Browser → Backend API → SSH → Proxmox Host → lxc-attach → docker logs
```

**LXC Console Logs:**
- Pfad: `/var/log/lxc/{hostname}-{vmid}.log`
- Wird direkt vom Host gelesen via SSH + cat/tail

**Docker Logs:**
- Befehl: `lxc-attach -n {vmId} -- docker logs [--tail {lines}] {service}`
- Oder: `lxc-attach -n {vmId} -- docker-compose logs [--tail {lines}]`

### Phase 2: Template-Umstrukturierung (Später)

#### Neue Reihenfolge

```
VORHER:                              NACHHER:
010 - OS Template                    010 - OS Template
095 - Kernel Module prüfen           095 - Kernel Module prüfen
096 - Kernel Module laden            096 - Kernel Module laden
100 - LXC erstellen ← Notes!         097 - Compose analysieren (NEU)
101 - LXC für Docker                 100 - LXC erstellen ← Notes mit ALLEN Infos!
200 - LXC starten                    101 - LXC für Docker
305 - Package Mirror                 121 - ZFS Pool mounten
307 - Docker installieren            160 - Volumes binden
310 - Volumes extrahieren ← ZU SPÄT  200 - LXC starten
121 - ZFS Pool mounten               305 - Package Mirror
160 - Volumes binden                 307 - Docker installieren
320 - Compose hochladen              320 - Compose hochladen
330 - Compose starten                330 - Compose starten
```

#### Template-Umbenennung

| Alt | Neu |
|-----|-----|
| `310-post-extract-volumes-from-compose.json` | `097-host-analyze-compose.json` |
| `host-extract-volumes-from-compose.py` | `host-analyze-compose.py` |

#### Service-Extraktion (Erweiterung)

```python
# host-analyze-compose.py - Zusätzlicher Output
services = list(compose_data.get("services", {}).keys())
output.append({"id": "compose_services", "value": ",".join(services)})
```

### Phase 3: Notes-Erweiterung (Später)

#### Neue Notes-Struktur

```markdown
<!-- lxc-manager:managed -->
<!-- lxc-manager:application-id docker-compose -->
<!-- lxc-manager:compose-services nextcloud,db,redis -->

# LXC Manager

Managed by **lxc-manager**.

Application: Nextcloud (docker-compose)

## Services
- nextcloud
- db
- redis

## Links
- [Logs](http://deployer:3000/logs/105)
```

#### Neue Parameter für conf-create-lxc-container.sh

- `compose_services` (optional) - Komma-separierte Service-Namen
- `deployer_base_url` (optional) - URL für Log-Links

---

## API Spezifikation

### GET /api/:veContext/ve/logs/:vmId

Liest LXC Console Logs.

**Parameter:**
- `vmId` (path, required): VM ID des LXC Containers
- `veContext` (path, required): VE Context ID
- `lines` (query, optional): Anzahl Zeilen (default: 100, max: 10000)

**Response:**
```json
{
  "success": true,
  "vmId": 105,
  "logType": "console",
  "lines": 100,
  "content": "... log content ..."
}
```

**Errors:**
- 400: Ungültige Parameter
- 404: Container nicht gefunden
- 500: SSH/Ausführungsfehler

### GET /api/:veContext/ve/logs/:vmId/docker

Liest Docker Container Logs.

**Parameter:**
- `vmId` (path, required): VM ID des LXC Containers
- `veContext` (path, required): VE Context ID
- `service` (query, optional): Docker Service Name (ohne = alle Services)
- `lines` (query, optional): Anzahl Zeilen (default: 100, max: 10000)

**Response:**
```json
{
  "success": true,
  "vmId": 105,
  "logType": "docker",
  "service": "nextcloud",
  "lines": 100,
  "content": "... docker log content ..."
}
```

**Errors:**
- 400: Ungültige Parameter
- 404: Container oder Service nicht gefunden
- 500: SSH/Docker-Ausführungsfehler

---

## Implementierungsdetails

### Backend Dateien

```
backend/src/
├── webapp/
│   ├── webapp-ve-logs-routes.mts      # Route-Handler
│   └── webapp-routes.mts              # Route-Registrierung
├── ve-execution/
│   └── ve-logs-service.mts            # Log-Service Logik
└── tests/
    ├── ve-logs-service.test.mts       # Unit Tests
    └── ve-logs-integration.test.mts   # Integration Tests
```

### Sicherheit

- Validierung der vmId (nur numerisch)
- Validierung des service-Namens (alphanumerisch + Bindestriche/Unterstriche)
- Lines-Limit (max 10000)
- Nutzung bestehender VE-Context Authentifizierung
