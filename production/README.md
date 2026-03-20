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

Das Install-Script wird **mit `--https`** ausgeführt. Self-signed Zertifikate werden automatisch generiert.

```bash
# Auf pve1.cluster:
curl -fsSL https://raw.githubusercontent.com/modbus2mqtt/oci-lxc-deployer/main/install-oci-lxc-deployer.sh | sh -s -- \
  --vm-id-start 500 \
  --static-ip 192.168.4.39/24 \
  --gateway 192.168.4.1 \
  --nameserver 192.168.4.1 \
  --https
```

Ab sofort läuft der Deployer auf HTTPS (Port 3443). `deploy.sh` erkennt das automatisch.

### 2b. Projekt-Defaults setzen

Auf dem PVE-Host das Projekt-Template ins Local-Verzeichnis des Deployers kopieren. Dieses eine Template setzt alle projektweiten Defaults (vm_id_start, OIDC, Mirrors):

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
    { "properties": { "id": "alpine_mirror", "default": "https://mirror1.hs-esslingen.de/Mirrors/alpine/" } },
    { "properties": { "id": "debian_mirror", "default": "http://mirror.23m.com/debian/" } }
  ]
}
EOF

# Validierung (optional)
curl -sk https://oci-lxc-deployer:3443/api/validate
```

Ein Beispiel mit Werten liegt unter `examples/shared/templates/create_ct/050-set-project-parameters.json`.

### 3. Production-Stack und CA einrichten

Das Script erstellt den Production-Stack mit Cloudflare-Credentials (für Nginx ACME-Wildcard), generiert die globale CA (für self-signed Zertifikate aller internen Apps) und setzt die Domain-Suffix.

Voraussetzungen:
- Cloudflare API Token mit Permission `Zone:DNS:Edit` für alle relevanten Domains ([Dashboard](https://dash.cloudflare.com/profile/api-tokens))
- Keine Zone ID nötig — `acme.sh` (`dns_cf`) löst die Zone automatisch auf

```bash
CF_TOKEN=xxx ./production/setup-acme.sh
```

Das Script:
- Setzt die Domain-Suffix
- Erstellt den Production-Stack mit `cloudflare` Stacktype + CF_TOKEN

Die globale CA wird automatisch beim Install-Script generiert (`--https`).

### 4. Nginx deployen (mit ACME-Wildcard + Homepage)

Nginx bekommt das einzige ACME-Zertifikat (Wildcard `*.ohnewarum.de`) plus die CA für Backend-Verifikation (`addon-ssl` mit `ssl.needs_ca_cert`).

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
- Konfiguriert `proxy_ssl_trusted_certificate` für self-signed Backends
- Reload nginx

**Zwischenergebnis:** Öffentlicher Zugang funktioniert — `https://ohnewarum.de` zeigt die Homepage.

### 5. Postgres und Zitadel deployen

Zitadel wird als OIDC-Provider benötigt, bevor die anderen Apps mit OIDC konfiguriert werden können.

```bash
./production/deploy.sh zitadel      # deployt postgres + zitadel (mit addon-ssl)
```

### 6. Zitadel Service User anlegen

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

### 7. oci-lxc-deployer auf OIDC umstellen

Reconfiguriert den Deployer mit `addon-oidc`. Das Addon erstellt automatisch einen OIDC-Client in Zitadel und konfiguriert die Umgebungsvariablen.

```bash
./production/setup-deployer-oidc.sh
```

Das Script reconfiguriert den Deployer mit `addon-ssl` + `addon-oidc` (beide aktiv).

### 8. Restliche Apps mit OIDC deployen

Sobald `production/.env` existiert und OIDC am Backend aktiv ist, werden alle weiteren Apps mit OIDC-Authentifizierung und self-signed Zertifikaten deployed:

```bash
./production/deploy.sh gitea        # gitea mit addon-oidc + addon-ssl
```

Oder alle auf einmal (bereits installierte werden übersprungen):

```bash
./production/deploy.sh all
```


## Zertifikatsstrategie

### Grundregel

Jede Verbindung wird verschlüsselt. ACME-Wildcard auf Nginx für öffentlichen Zugang, self-signed (globale CA) für alle internen Apps.

| Zertifikatstyp | Einsatz | Addon |
|----------------|---------|-------|
| **ACME** (Let's Encrypt) | Nur Nginx (Wildcard `*.ohnewarum.de`) | `addon-acme` |
| **Self-signed** (globale CA) | Alle internen Apps | `addon-ssl` |

### ACME nur auf Nginx

Ein einziges ACME-Wildcard-Zertifikat (`ohnewarum.de, *.ohnewarum.de`) auf dem Nginx Reverse Proxy. Renewal alle 60 Tage via Cloudflare DNS-Challenge — ein API-Call statt pro App.

### Self-Signed für alle internen Apps

Alle anderen Apps bekommen self-signed Zertifikate aus der globalen CA. Der Deployer erneuert diese automatisch (Auto Certificate Renewal).

| App | Addon | Zugang |
|-----|-------|--------|
| Nginx (Reverse Proxy + Static-Host) | `addon-acme` | Öffentlich |
| Zitadel | `addon-ssl` | Öffentlich (via Nginx) + Lokal direkt |
| Gitea | `addon-ssl` | Öffentlich (via Nginx) + Lokal direkt |
| oci-lxc-deployer | `addon-ssl` | Nur Lokal |
| Node-RED | `addon-ssl` | Nur Lokal |
| PostgREST | `addon-ssl` | Nur Lokal |
| Postgres | `addon-ssl` | Nur DB-Clients |
| MQTT (Mosquitto) | `addon-ssl` | Nur MQTT-Clients |

**Voraussetzung:** Die globale CA muss auf den LAN-Browsern installiert sein (2 Geräte, einmalig).

### Datenfluss

```
Öffentlicher Zugang:
  Browser → Internet → [ACME: *.ohnewarum.de] Nginx (:443)
    ├── ohnewarum.de              → Statische Homepage (nginx lokal)
    ├── nebenkosten.ohnewarum.de  → Frontend-App (nginx lokal, OIDC client-seitig)
    ├── auth.ohnewarum.de         → [self-signed] Zitadel (:8443)
    ├── git.ohnewarum.de          → [self-signed] Gitea (:443)
    └── ...
    (Nginx proxy_ssl_verify off — vertraut self-signed Backends)

Lokaler Zugang (LAN, CA auf Browser installiert):
  Browser (LAN) → DNS: hostname → lokale App-IP
    ├── oci-lxc-deployer → [self-signed] oci-lxc-deployer (:3443)
    ├── nodered           → [self-signed] Node-RED (:443)
    └── zitadel           → [self-signed] Zitadel (:8443)

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

# auth.conf — Reverse Proxy zu Zitadel (self-signed Backend)
server {
    listen 8080;
    server_name auth.ohnewarum.de;
    location / {
        proxy_pass https://zitadel:8443;
        proxy_ssl_verify on;
        proxy_ssl_trusted_certificate /etc/ssl/addon/chain.pem;
    }
}

# git.conf — Reverse Proxy zu Gitea (self-signed Backend)
server {
    listen 8080;
    server_name git.ohnewarum.de;
    location / {
        proxy_pass https://gitea:443;
        proxy_ssl_verify on;
        proxy_ssl_trusted_certificate /etc/ssl/addon/chain.pem;
    }
}
```

Backends nutzen self-signed Zertifikate. Nginx verifiziert sie gegen die globale CA (`chain.pem` via `addon-ssl` mit `ssl.needs_ca_cert = true`).

### Zugriffskontrolle

| App | Öffentlich (via Nginx) | Lokal (direkt) | Cert | OIDC |
|-----|------------------------|----------------|------|------|
| Homepage | ✓ ohnewarum.de | — | Nginx-ACME | Nein |
| Nebenkosten | ✓ nebenkosten.ohnewarum.de | — | Nginx-ACME | Client-seitig (PKCE) |
| Zitadel | ✓ auth.ohnewarum.de | ✓ direkt :8443 | Self-signed | — |
| Gitea | ✓ git.ohnewarum.de | ✓ direkt :443 | Self-signed | addon-oidc |
| oci-lxc-deployer | ✗ | ✓ direkt :3443 | Self-signed | addon-oidc |
| Node-RED | ✗ | ✓ direkt :443 | Self-signed | — |
| Postgres | ✗ | ✓ nur DB-Clients | Self-signed | — |
| MQTT | ✗ | ✓ nur MQTT-Clients | Self-signed | — |

**Schutz:**
1. **Nginx** mapped nur öffentliche Apps → interne Apps nicht von außen erreichbar
2. **Lokaler DNS** (Hostnamen → lokale IPs) → lokaler Direktzugriff auf alle Apps
3. **CA auf LAN-Browsern** (2 Geräte, einmalig) → self-signed Certs vertrauenswürdig
4. **Firewall** (optional) → zusätzliche Absicherung auf Proxmox-Ebene

### ACME Voraussetzungen

1. **Cloudflare API Token** mit Permission `Zone:DNS:Edit` für alle relevanten Domains erstellen ([Cloudflare Dashboard](https://dash.cloudflare.com/profile/api-tokens))

Keine Zone ID nötig — `acme.sh` (`dns_cf`) löst die Zone automatisch anhand des Domainnamens auf. Ein Token mit Zugriff auf mehrere Zonen reicht für beliebig viele Domains.

Das CF_TOKEN wird per `setup-acme.sh` (Schritt 3) im Production-Stack hinterlegt. Ohne Cloudflare-Credentials im Stack wird das ACME-Addon übersprungen.

### Alternative: ACME-Wildcard auf Nginx, self-signed intern

Ein ACME-Wildcard-Zertifikat (`*.ohnewarum.de`) nur auf Nginx. Alle internen Apps bekommen self-signed Certs aus der globalen CA. Browser im LAN vertrauen der CA (einmalig auf 2 Geräten installiert).

| Aspekt | ACME überall | Wildcard + self-signed |
|--------|-------------|----------------------|
| ACME-Zertifikate | Pro App | Nur Nginx |
| Cloudflare-API-Calls | Pro App alle 60 Tage | Einmal alle 60 Tage |
| CA auf Browsern installieren | Nein | Ja (2 Geräte, einmalig) |
| Direkter LAN-Zugriff | Vertrauenswürdig (ACME) | Vertrauenswürdig (CA installiert) |
| DNS-Einträge (dnsmasq) | Pro App (`app.ohnewarum.de`) | Nicht nötig (kurze Hostnamen reichen) |
| Cert-Renewal intern | Nicht nötig (ACME) | Automatisch (Auto-Renewal im Deployer) |
| Setup-Aufwand pro App | `addon-acme` | `addon-ssl` (kein Cloudflare nötig) |

Seit der Implementierung des automatischen Certificate Renewals im Deployer sind beide Ansätze gleichwertig wartungsfrei. **Gewählt: Wildcard + self-signed** — weniger Cloudflare-API-Calls, einfacheres Setup pro App.

### Verworfene Alternative: ACME extern, self-signed intern, kein direkter Zugriff

Idee: Nur öffentliche Apps (hinter Nginx) bekommen ACME. Interne Apps bekommen self-signed und werden ausschließlich über Nginx angesprochen, nie direkt.

Verworfen weil:
- Erzwingt, dass ALLE Browser-Zugriffe über Nginx laufen — auch für Administration im LAN
- Kein direkter Zugriff auf interne Apps möglich (z.B. `https://deployer:3443`) ohne CA-Trust
- OIDC-Issuer-URL müsste immer über Nginx geroutet werden, da interne Apps sonst dem self-signed Cert nicht vertrauen

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
| `setup-deployer-ssl.sh`          | Deployer auf HTTPS umstellen (addon-ssl)   |
| `setup-deployer-oidc.sh`         | Deployer OIDC via addon-oidc aktivieren    |
| `ohnewarum_startseite.html`      | Homepage für nginx                         |
| `setup-zitadel-service-user.sh`  | Zitadel Service User + Client Credentials  |
| `*.json`                         | CLI-Parameter pro App (addon-ssl)          |
| `.env`                           | OIDC Credentials (git-ignored)             |
