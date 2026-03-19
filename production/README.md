# Production Deployment

Reproduzierbares Setup für oci-lxc-deployer, postgres, nginx, zitadel und gitea auf `pve1.cluster`.

## VM-Zuordnung

VMs werden per `vm_id_start` ab einem Startwert automatisch vergeben (nächste freie ID).

| App              | vm_id_start | IP             | Hostname           |
|------------------|-------------|----------------|--------------------|
| oci-lxc-deployer | 300         | 192.168.4.39   | oci-lxc-deployer   |
| postgres         | 500         | 192.168.4.40   | postgres           |
| nginx            | 501         | 192.168.4.41   | nginx              |
| zitadel          | 502         | 192.168.4.42   | zitadel            |
| gitea            | 503         | 192.168.4.43   | gitea              |

## Step-by-Step Anleitung

### 1. DNS-Einträge auf OpenWrt Router anlegen (einmalig)

Statische DNS-Einträge für die Hostnamen auf dem OpenWrt Router konfigurieren:

```bash
scp production/dns.sh root@router:
ssh root@router sh dns.sh
```

### 2. oci-lxc-deployer installieren (auf PVE-Host)

Das Install-Script wird **ohne `--https`** ausgeführt. HTTPS wird in Schritt 3 per ACME eingerichtet.

```bash
# Auf pve1.cluster:
curl -fsSL https://raw.githubusercontent.com/modbus2mqtt/oci-lxc-deployer/main/install-oci-lxc-deployer.sh | sh -s -- \
  --vm-id-start 300 \
  --static-ip 192.168.4.39/24 \
  --gateway 192.168.4.1 \
  --nameserver 192.168.4.1
```

### 2b. Local Templates setzen

Auf dem PVE-Host die Default-Templates ins Local-Verzeichnis des Deployers schreiben:

```bash
# Auf pve1.cluster:
SHARED_VOL="/rpool/data/subvol-999999-oci-lxc-deployer-volumes/volumes/oci-lxc-deployer/config/shared/templates"

# vm_id_start auf 500 setzen (alle weiteren Apps ab VM-ID 500)
mkdir -p "${SHARED_VOL}/create_ct"
cat > "${SHARED_VOL}/create_ct/099-set-vm-id-start.json" << 'EOF'
{
  "name": "Set VM ID Start",
  "description": "Default start index for auto-assigned VM IDs. Override in local/shared/templates/create_ct/.",
  "commands": [
    {
      "properties": {
        "id": "vm_id_start",
        "default": "500"
      }
    }
  ]
}
EOF

# OIDC Issuer URL setzen (öffentliche URL, über lokalen DNS auf Zitadel-IP gemappt)
mkdir -p "${SHARED_VOL}/pre_start"
cat > "${SHARED_VOL}/pre_start/106-set-oidc-issuer-url.json" << 'EOF'
{
  "name": "Set OIDC Issuer URL",
  "commands": [
    {
      "properties": {
        "id": "oidc_issuer_url",
        "default": "https://auth.ohnewarum.de"
      }
    }
  ]
}
EOF
```

### 3. ACME einrichten und Deployer auf HTTPS umstellen

Das Script erstellt den Production-Stack mit Cloudflare-Credentials und reconfiguriert den Deployer mit addon-acme (Let's Encrypt).

Voraussetzungen:
- Cloudflare API Token mit Permission `Zone:DNS:Edit` ([Dashboard](https://dash.cloudflare.com/profile/api-tokens))
- Zone ID der Domain (Cloudflare Dashboard → Domain → Overview → rechte Seite)

```bash
CF_TOKEN=xxx CF_ZONE_ID=yyy ./production/setup-acme.sh
```

Das Script:
- Wartet auf die Deployer API (HTTP)
- Generiert CA-Zertifikat (für self-signed bei Postgres etc.)
- Setzt die Domain-Suffix
- Erstellt den Production-Stack mit `cloudflare` Stacktype + Credentials
- Reconfiguriert den Deployer mit `addon-acme` → HTTPS auf Port 3443

### 4. Postgres und Zitadel deployen

Zitadel wird als OIDC-Provider benötigt, bevor die anderen Apps mit OIDC konfiguriert werden können.

```bash
./production/deploy.sh zitadel      # deployt postgres + zitadel (mit addon-acme)
```

### 5. Zitadel Service User anlegen

Service User für CLI-Authentifizierung einrichten.
Das PAT wird automatisch aus dem laufenden Zitadel-Container gelesen.

```bash
./production/setup-zitadel-service-user.sh
```

Das Script erstellt:
- Machine User `deployer-cli` in Zitadel
- Projekt `oci-lxc-deployer` mit Rolle `admin`
- Client Credentials (client_id + client_secret)
- Datei `production/.env` mit den Credentials

### 6. oci-lxc-deployer auf OIDC umstellen

Reconfiguriert den Deployer mit `addon-oidc`. Das Addon erstellt automatisch einen OIDC-Client in Zitadel und konfiguriert die Umgebungsvariablen.

```bash
./production/setup-deployer-oidc.sh
```

Das Script reconfiguriert den Deployer mit `addon-acme` + `addon-oidc` (beide aktiv).

### 7. Restliche Apps mit OIDC deployen

Sobald `production/.env` existiert und OIDC am Backend aktiv ist, werden alle weiteren Apps mit OIDC-Authentifizierung und ACME-Zertifikaten deployed:

```bash
./production/deploy.sh nginx        # nginx mit addon-acme
./production/deploy.sh gitea        # gitea mit addon-oidc + addon-acme
```

Oder alle auf einmal (bereits installierte werden übersprungen):

```bash
./production/deploy.sh all
```


## Zertifikatsstrategie

### Grundregel

Jede Verbindung wird verschlüsselt. Es gibt zwei Zertifikatstypen:

| Zertifikatstyp | Einsatz | Addon |
|----------------|---------|-------|
| **ACME** (Let's Encrypt) | Jede App mit Browser-Zugang | `addon-acme` |
| **Self-signed** (interne CA) | Nur Nicht-HTTP-Dienste (DB, MQTT) | `addon-ssl` |

### ACME für alle Browser-Apps

Das ACME-Addon generiert und erneuert Zertifikate automatisch via Cloudflare DNS-Challenge. Da kein A-Record nötig ist (DNS-01 Challenge nutzt TXT-Records), können auch rein interne Apps ACME-Certs bekommen.

| App | Addon | SSL-Mode | Zugang |
|-----|-------|----------|--------|
| Nginx (Reverse Proxy) | `addon-acme` | `native` | Öffentlich |
| Zitadel | `addon-acme` | `native` | Öffentlich (via Nginx) + Lokal direkt |
| Gitea | `addon-acme` | `proxy` | Öffentlich (via Nginx) + Lokal direkt |
| oci-lxc-deployer | `addon-acme` | `native` | Nur Lokal |
| Node-RED | `addon-acme` | `proxy` | Nur Lokal |
| PostgREST | `addon-acme` | `proxy` | Nur Lokal |
| Weitere Browser-Apps | `addon-acme` | `proxy`/`native` | Je nach App |

**Vorteil:** Kein self-signed CA-Trust in Browsern nötig. Jeder Browser sieht ein vertrauenswürdiges Let's Encrypt Cert.

### Self-Signed nur für Nicht-HTTP-Dienste

| App | Protokoll | Addon | SSL-Mode |
|-----|-----------|-------|----------|
| Postgres | PostgreSQL TLS | `addon-ssl` | `certs` |
| MQTT (Mosquitto) | MQTT over TLS | `addon-ssl` | `certs` |

DB- und MQTT-Clients vertrauen der internen CA direkt (`chain.pem`). Kein Browser involviert.

### Datenfluss

```
Öffentlicher Zugang (nur ~5 Apps):
  Browser → Internet → [ACME] Nginx (:443)
    ├── auth.domain.com  → [ACME] Zitadel (:8443)
    ├── git.domain.com   → [ACME] Gitea (:443)
    └── ...

Lokaler Zugang (alle Apps, direkt ohne Nginx):
  Browser (LAN) → DNS: app.domain.com → lokale App-IP
    ├── deployer.domain.com → [ACME] oci-lxc-deployer (:3443)
    ├── nodered.domain.com  → [ACME] Node-RED (:443)
    └── auth.domain.com     → [ACME] Zitadel (:8443)

OIDC-Validierung (intern):
  App → DNS: auth.domain.com → lokale Zitadel-IP → [ACME-Cert]
  (Vertrauenswürdig, kein CA-Trust in Apps nötig)

DB/MQTT (kein Browser):
  Zitadel →[self-signed, sslmode=verify-ca]→ Postgres (:5432)
  IoT-Clients →[self-signed TLS, CA-Trust]→ Mosquitto (:8883)
```

### Nginx: Nur öffentlicher Reverse Proxy

Nginx mapped ausschließlich öffentliche Apps. Interne Apps sind nur über LAN direkt erreichbar.

```nginx
# Default: unbekannte Domains ablehnen
server {
    listen 443 ssl default_server;
    ssl_certificate /etc/ssl/acme/fullchain.pem;
    ssl_certificate_key /etc/ssl/acme/privkey.pem;
    return 444;
}

# Nur öffentliche Apps (max. 5)
server {
    server_name auth.domain.com;
    location / { proxy_pass https://zitadel-host:8443; }
}
server {
    server_name git.domain.com;
    location / { proxy_pass https://gitea-host:443; }
}
```

Nginx vertraut den Backend-ACME-Certs automatisch (Let's Encrypt CA ist im System-Trust-Store).

### Zugriffskontrolle

| App | Öffentlich (via Nginx) | Lokal (direkt) | Cert |
|-----|------------------------|----------------|------|
| Zitadel | ✓ auth.domain.com | ✓ direkt :8443 | ACME |
| Gitea | ✓ git.domain.com | ✓ direkt :443 | ACME |
| oci-lxc-deployer | ✗ | ✓ direkt :3443 | ACME |
| Node-RED | ✗ | ✓ direkt :443 | ACME |
| Postgres | ✗ | ✓ nur DB-Clients | Self-signed |
| MQTT | ✗ | ✓ nur MQTT-Clients | Self-signed |

**Schutz:**
1. **Nginx** mapped nur öffentliche Apps → interne Apps nicht von außen erreichbar
2. **Lokaler DNS** (`*.domain.com` → lokale IPs) → lokaler Direktzugriff auf alle Apps
3. **Firewall** (optional) → zusätzliche Absicherung auf Proxmox-Ebene

### ACME Voraussetzungen

1. **Cloudflare API Token** mit Permission `Zone:DNS:Edit` erstellen ([Cloudflare Dashboard](https://dash.cloudflare.com/profile/api-tokens))
2. **Zone ID** der Domain kopieren (Cloudflare Dashboard → Domain → Overview → rechte Seite)

Die Credentials werden per `setup-acme.sh` (Schritt 3) im Production-Stack hinterlegt. Ohne Cloudflare-Credentials im Stack wird das ACME-Addon übersprungen.

### Verworfene Alternativen

Vor der Entscheidung für "ACME überall" wurden zwei andere Ansätze evaluiert und verworfen:

**1. ACME-Wildcard nur auf Nginx, self-signed intern**

Idee: Ein einziges ACME-Wildcard-Zertifikat (`*.domain.com`) auf dem Nginx Reverse Proxy. Alle anderen Apps bekommen self-signed Certs aus einer internen CA. Browser sehen nur das ACME-Cert von Nginx, nie die self-signed Certs.

Verworfen weil:
- Alle Apps müssten über Nginx laufen (auch rein interne wie der Deployer), sonst sehen Browser im LAN self-signed Certs
- Die interne CA müsste auf allen Browsern im LAN installiert werden (2 Stück), sobald man doch mal direkt auf eine App zugreift
- Nginx müsste der internen CA vertrauen (`proxy_ssl_trusted_certificate`) — zusätzliche Konfiguration
- Mehr Komplexität (zwei Zertifikatssysteme, CA-Trust-Management) ohne Mehrwert gegenüber ACME auf jeder App

**2. ACME extern (Nginx), self-signed intern (alle anderen)**

Idee: Nur öffentliche Apps (hinter Nginx) bekommen ACME. Interne Apps bekommen self-signed und werden nur über Nginx angesprochen, nie direkt.

Verworfen weil:
- Erzwingt, dass ALLE Browser-Zugriffe über Nginx laufen — auch für Administration im LAN
- Kein direkter Zugriff auf interne Apps möglich (z.B. `https://deployer:3443`) ohne CA-Trust
- OIDC-Issuer-URL müsste immer über Nginx geroutet werden, da interne Apps sonst dem self-signed Cert nicht vertrauen
- Das ACME-Addon erledigt Generierung und Renewal automatisch — der Mehraufwand pro App ist minimal (nur `addon-acme` statt `addon-ssl` in der Config)

**Fazit:** ACME auf jeder Browser-App ist einfacher (ein Addon, kein CA-Trust-Management) und flexibler (direkter LAN-Zugriff mit vertrauenswürdigem Cert). Self-signed bleibt nur für Nicht-HTTP-Dienste (Postgres, MQTT), wo kein Browser involviert ist.

## Destroy

VMs werden in umgekehrter Dependency-Reihenfolge zerstört. Postgres-Datenbanken werden vorher aufgeräumt.

```bash
./production/destroy.sh             # alle Apps (reverse Order)
./production/destroy.sh gitea       # nur gitea (+ DB cleanup)
./production/destroy.sh zitadel     # nur zitadel (+ DB cleanup)
```

## Dateien

| Datei                            | Zweck                                      |
|----------------------------------|--------------------------------------------|
| `deploy.sh`                      | Deploy via oci-lxc-cli in Dep-Reihenfolge  |
| `destroy.sh`                     | Destroy VMs + Postgres DB cleanup          |
| `dns.sh`                         | DNS-Einträge auf OpenWrt (uci + dnsmasq)   |
| `setup-acme.sh`                  | ACME Setup: Cloudflare-Stack + Deployer HTTPS |
| `setup-deployer-oidc.sh`         | Deployer OIDC via addon-oidc aktivieren    |
| `setup-zitadel-service-user.sh`  | Zitadel Service User + Client Credentials  |
| `*.json`                         | CLI-Parameter pro App (addon-acme/addon-ssl) |
| `.env`                           | OIDC Credentials (git-ignored)             |
