# Production Deployment

Reproduzierbares Setup für oci-lxc-deployer, postgres, nginx, zitadel und gitea auf `pve1.cluster`.

## VM-Zuordnung

VMs werden per `vm_id_start` ab einem Startwert automatisch vergeben (nächste freie ID).

| App              | vm_id_start | Node      | IP             | Hostname           |
|------------------|-------------|-----------|----------------|--------------------|
| oci-lxc-deployer | 500         | pve1      | 192.168.4.39   | oci-lxc-deployer   |
| postgres         | 500         | pve1      | 192.168.4.40   | postgres           |
| nginx            | 500         | pve1      | 192.168.4.41   | nginx              |
| zitadel          | 500         | pve1      | 192.168.4.42   | zitadel            |
| gitea            | 600         | ubuntupve | 192.168.4.43   | gitea              |

## Step-by-Step Anleitung

### 0. Proxmox-Cluster einrichten (einmalig)

Voraussetzung: SSH-Verbindung zwischen den Nodes funktioniert ohne Passwort.

```bash
# SSH-Keys austauschen (von jedem Node zu jedem anderen)
ssh-copy-id root@pve1
ssh-copy-id root@pve2
ssh-copy-id root@ubuntupve
```

Cluster erstellen und Nodes joinen:

```bash
# Auf pve1:
pvecm create production

# Auf pve2:
pvecm add <pve1-IP>

# Auf ubuntupve:
pvecm add <pve1-IP>

# Status prüfen:
pvecm status
pvecm nodes
```

VMID-Bereiche pro Node:

| Node      | vm_id_start | Bereich |
|-----------|-------------|---------|
| pve1      | 500         | 500–599 |
| ubuntupve | 600         | 600–699 |
| pve2      | 700         | 700–799 |

### 1. DNS-Einträge auf OpenWrt Router anlegen (einmalig)

Statische DNS-Einträge für die Hostnamen auf dem OpenWrt Router konfigurieren:

```bash
scp production/dns.sh root@router:
ssh root@router sh dns.sh
```

### 2. oci-lxc-deployer installieren (auf PVE-Host)

Das Install-Script wird **ohne `--https`** ausgeführt. HTTPS wird in Schritt 5 per ACME eingerichtet.

```bash
# Auf pve1.cluster:
curl -fsSL https://raw.githubusercontent.com/modbus2mqtt/oci-lxc-deployer/main/install-oci-lxc-deployer.sh | sh -s -- \
  --vm-id-start 500 \
  --static-ip 192.168.4.39/24 \
  --gateway 192.168.4.1 \
  --nameserver 192.168.4.1
```

### 2b. Projekt-Defaults setzen

Auf dem PVE-Host das Projekt-Template ins Local-Verzeichnis des Deployers kopieren. Dieses eine Template setzt alle projektweiten Defaults (vm_id_start, OIDC, ACME, Mirrors):

```bash
# Auf pve1.cluster:
SHARED_VOL="/rpool/data/subvol-999999-oci-lxc-deployer-volumes/volumes/oci-lxc-deployer/config/shared/templates"

mkdir -p "${SHARED_VOL}/create_ct"
cat > "${SHARED_VOL}/create_ct/050-set-project-parameters.json" << 'EOF'
{
  "name": "Set Project Parameters",
  "description": "Project-specific defaults for ohnewarum.de",
  "commands": [
    { "properties": { "id": "vm_id_start", "default": "500" } },
    { "properties": { "id": "oidc_issuer_url", "default": "https://auth.ohnewarum.de" } },
    { "properties": { "id": "acme_san", "default": "{{ hostname }}.ohnewarum.de" } },
    { "properties": { "id": "alpine_mirror", "default": "https://mirror1.hs-esslingen.de/Mirrors/alpine/" } },
    { "properties": { "id": "debian_mirror", "default": "http://mirror.23m.com/debian/" } }
  ]
}
EOF

# Validierung (optional)
curl -s http://oci-lxc-deployer:3080/api/validate
```

Ein Beispiel mit Werten liegt unter `examples/shared/templates/create_ct/050-set-project-parameters.json`.

### 3. ACME-Voraussetzungen einrichten

Das Script erstellt den Production-Stack mit Cloudflare-Credentials, generiert das CA-Zertifikat und setzt die Domain-Suffix. Der Deployer selbst bleibt auf HTTP — HTTPS wird erst später eingerichtet.

Voraussetzungen:
- Cloudflare API Token mit Permission `Zone:DNS:Edit` für alle relevanten Domains ([Dashboard](https://dash.cloudflare.com/profile/api-tokens))
- Keine Zone ID nötig — `acme.sh` (`dns_cf`) löst die Zone automatisch auf

```bash
CF_TOKEN=xxx ./production/setup-acme.sh
```

Das Script:
- Wartet auf die Deployer API (HTTP)
- Generiert CA-Zertifikat (für self-signed bei Postgres etc.)
- Setzt die Domain-Suffix
- Erstellt den Production-Stack mit `cloudflare` Stacktype + CF_TOKEN

### 4. Nginx deployen (mit ACME + Homepage)

Nginx wird als erstes deployed, um den öffentlichen Zugang zu verifizieren. Der Deployer läuft noch auf HTTP — `deploy.sh` erkennt das automatisch.

```bash
./production/deploy.sh nginx
```

Danach Virtual Hosts und Homepage einrichten:

```bash
# Auf pve1.cluster:
./production/setup-nginx.sh
```

Das Script:
- Schreibt pro Site eine nginx-Config nach `conf.d/` (ohnewarum, nebenkosten, auth, git)
- Kopiert die Homepage in den Container
- Setzt Ownership (uid 101 für nginx-unprivileged)
- Reload nginx

**Zwischenergebnis:** Öffentlicher Zugang funktioniert — `https://ohnewarum.de` zeigt die Homepage.

### 5. Deployer auf HTTPS umstellen (ACME)

Jetzt den Deployer mit addon-acme reconfigurieren:

```bash
./production/setup-deployer-acme.sh
```

Ab hier läuft der Deployer auf HTTPS (Port 3443). `deploy.sh` erkennt das automatisch.

### 6. Postgres und Zitadel deployen

Zitadel wird als OIDC-Provider benötigt, bevor die anderen Apps mit OIDC konfiguriert werden können.

```bash
./production/deploy.sh zitadel      # deployt postgres + zitadel (mit addon-acme)
```

### 7. Zitadel Service User anlegen

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

### 8. oci-lxc-deployer auf OIDC umstellen

Reconfiguriert den Deployer mit `addon-oidc`. Das Addon erstellt automatisch einen OIDC-Client in Zitadel und konfiguriert die Umgebungsvariablen.

```bash
./production/setup-deployer-oidc.sh
```

Das Script reconfiguriert den Deployer mit `addon-acme` + `addon-oidc` (beide aktiv).

### 9. Restliche Apps mit OIDC deployen

Sobald `production/.env` existiert und OIDC am Backend aktiv ist, werden alle weiteren Apps mit OIDC-Authentifizierung und ACME-Zertifikaten deployed:

```bash
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
| Nginx (Static-Host + Reverse Proxy) | `addon-acme` | `native` | Öffentlich |
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
Öffentlicher Zugang:
  Browser → Internet → [ACME: *.ohnewarum.de] Nginx (:443)
    ├── ohnewarum.de              → Statische Homepage (nginx lokal)
    ├── nebenkosten.ohnewarum.de  → Frontend-App (nginx lokal, OIDC client-seitig)
    ├── auth.ohnewarum.de         → [ACME] Zitadel (:8443)
    ├── git.ohnewarum.de          → [ACME] Gitea (:443)
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

### Nginx: Static-Host + öffentlicher Reverse Proxy

Nginx hat zwei Rollen:
1. **Static-Host**: Hostet statische Websites direkt (Homepage, nebenkosten)
2. **Reverse Proxy**: Leitet öffentliche Apps an Backend-Container weiter (Zitadel, Gitea)

Wildcard-Zertifikat: `acme_san = ohnewarum.de,*.ohnewarum.de`

Interne Apps sind nur über LAN direkt erreichbar.

#### Gehostete Sites

| Site | Domain | Typ | OIDC |
|------|--------|-----|------|
| Homepage | `ohnewarum.de` | Statische HTML-Seite | Nein (öffentlich) |
| Nebenkosten | `nebenkosten.ohnewarum.de` | Frontend-App (PostgREST) | Ja (client-seitig, PKCE → Zitadel) |

OIDC für nebenkosten läuft client-seitig: Das Frontend-JS leitet beim Öffnen zu Zitadel weiter (PKCE Flow, kein Client-Secret). JWT-Token werden als Bearer-Header an PostgREST gesendet. PostgREST validiert JWT + Row-Level Security. Nginx selbst braucht kein OIDC — es liefert nur statische Dateien aus.

Weitere Domains (z.B. `carcam360.de`) bekommen eigene Container mit eigenem ACME-Zertifikat.

#### Konfiguration pro Site (conf.d/)

Pro gehostete Site eine eigene Datei im `conf`-Volume (`/etc/nginx/conf.d`). Nginx ist rootless und lauscht auf Port 8080 (ohne SSL). Das ACME-Addon (`ssl_mode: proxy`) stellt einen SSL-Proxy davor, der auf Port 443 terminiert und an 8080 weiterleitet.

```nginx
# default.conf — unbekannte Domains ablehnen
server {
    listen 8080 default_server;
    return 444;
}

# ohnewarum.conf — öffentliche Homepage
server {
    listen 8080;
    server_name ohnewarum.de;
    root /usr/share/nginx/html/ohnewarum;
    index index.html;
}

# nebenkosten.conf — Frontend-App (OIDC client-seitig)
server {
    listen 8080;
    server_name nebenkosten.ohnewarum.de;
    root /usr/share/nginx/html/nebenkosten;
    index index.html;
    try_files $uri $uri/ /index.html;
}

# auth.conf — Reverse Proxy zu Zitadel
server {
    listen 8080;
    server_name auth.ohnewarum.de;
    location / { proxy_pass https://zitadel:8443; }
}

# git.conf — Reverse Proxy zu Gitea
server {
    listen 8080;
    server_name git.ohnewarum.de;
    location / { proxy_pass https://gitea:443; }
}
```

Nginx vertraut den Backend-ACME-Certs automatisch (Let's Encrypt CA ist im System-Trust-Store).

### Zugriffskontrolle

| App | Öffentlich (via Nginx) | Lokal (direkt) | Cert | OIDC |
|-----|------------------------|----------------|------|------|
| Homepage | ✓ ohnewarum.de | — | Nginx-ACME | Nein |
| Nebenkosten | ✓ nebenkosten.ohnewarum.de | — | Nginx-ACME | Client-seitig (PKCE) |
| Zitadel | ✓ auth.ohnewarum.de | ✓ direkt :8443 | ACME | — |
| Gitea | ✓ git.ohnewarum.de | ✓ direkt :443 | ACME | addon-oidc |
| oci-lxc-deployer | ✗ | ✓ direkt :3443 | ACME | addon-oidc |
| Node-RED | ✗ | ✓ direkt :443 | ACME | — |
| Postgres | ✗ | ✓ nur DB-Clients | Self-signed | — |
| MQTT | ✗ | ✓ nur MQTT-Clients | Self-signed | — |

**Schutz:**
1. **Nginx** mapped nur öffentliche Apps → interne Apps nicht von außen erreichbar
2. **Lokaler DNS** (`*.domain.com` → lokale IPs) → lokaler Direktzugriff auf alle Apps
3. **Firewall** (optional) → zusätzliche Absicherung auf Proxmox-Ebene

### ACME Voraussetzungen

1. **Cloudflare API Token** mit Permission `Zone:DNS:Edit` für alle relevanten Domains erstellen ([Cloudflare Dashboard](https://dash.cloudflare.com/profile/api-tokens))

Keine Zone ID nötig — `acme.sh` (`dns_cf`) löst die Zone automatisch anhand des Domainnamens auf. Ein Token mit Zugriff auf mehrere Zonen reicht für beliebig viele Domains.

Das CF_TOKEN wird per `setup-acme.sh` (Schritt 3) im Production-Stack hinterlegt. Ohne Cloudflare-Credentials im Stack wird das ACME-Addon übersprungen.

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
| `setup-acme.sh`                  | ACME-Voraussetzungen: Cloudflare-Stack + CA + Domain-Suffix |
| `setup-nginx.sh`                 | Nginx Virtual Hosts + Homepage einrichten  |
| `setup-deployer-acme.sh`         | Deployer auf HTTPS umstellen (addon-acme)  |
| `setup-deployer-oidc.sh`         | Deployer OIDC via addon-oidc aktivieren    |
| `ohnewarum_startseite.html`      | Homepage für nginx                         |
| `setup-zitadel-service-user.sh`  | Zitadel Service User + Client Credentials  |
| `*.json`                         | CLI-Parameter pro App (addon-acme/addon-ssl) |
| `.env`                           | OIDC Credentials (git-ignored)             |
