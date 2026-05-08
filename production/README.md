# Production Deployment

Reproduzierbares Setup für proxvex, postgres, nginx, zitadel, gitea, eclipse-mosquitto, docker-registry-mirror und github-runner auf einem PVE-Cluster (`pve1.cluster` als default, weitere Nodes per Override).

## Quick Start

Der gesamte Ablauf wird durch [`setup-production.sh`](setup-production.sh) orchestriert. **Wo ausführen:** auf einem Control-Host (typischerweise dein Mac/Laptop), **nicht** auf einem PVE-Host selbst — das Skript ist ein Orchestrator, der per SSH auf `router-kg` und die Ziel-PVE-Host(s) zugreift. Auf pve1 ausgeführt würde er `ssh root@pve1.cluster` aufrufen und an der Self-Loop scheitern.

Voraussetzung: SSH-Zugang als root auf den Router (`router-kg`) und auf alle Ziel-PVE-Host(s) ohne Passwort. Bei Fresh-Setup zusätzlich `--bootstrap`, sonst muss ein Deployer bereits laufen.

```bash
# Hilfe und Step-Liste anzeigen
./production/setup-production.sh --help

# Fresh setup von Null: tabula rasa + Deployer installieren + alle Steps
./production/setup-production.sh --bootstrap

# Alle Steps von 1 bis Ende ausführen
./production/setup-production.sh --all

# Einzelnen Step gezielt wiederholen (nur stateless: 5/8/13)
./production/setup-production.sh --retry 5 --force-docker-registry-mirror

# Nur ab Step N
./production/setup-production.sh --from-step 7
```

Steps in der aktuellen Reihenfolge (siehe `--help` für die kanonische Liste):

| #  | Step                                       | Hinweis                                          |
|----|--------------------------------------------|--------------------------------------------------|
| 1  | DNS + NAT auf OpenWrt-Router               | siehe [`dns.sh`](dns.sh)                          |
| 2  | Verify deployer is reachable               | erwartet HTTPS:3443 oder HTTP:3080                |
| 3  | Register PVE-Hosts + Production-Dateien kopieren | per [`setup-pve-host.sh`](setup-pve-host.sh)      |
| 4  | Project defaults v1 (ohne OIDC-Issuer)     | [`project-v1.sh`](project-v1.sh)                  |
| 5  | Deploy `docker-registry-mirror`            | Pull-through Cache, vermeidet Hub-Rate-Limits     |
| 6  | ACME + Production-Stack (Cloudflare)       | braucht `CF_TOKEN`, `SMTP_PASSWORD`               |
| 7  | Deploy `postgres`                          |                                                  |
| 8  | Deploy `nginx` + vhosts                    | + [`setup-nginx.sh`](setup-nginx.sh) (idempotent) |
| 9  | Project defaults v2 (mit OIDC-Issuer)      | [`project.sh`](project.sh)                        |
| 10 | Deploy `zitadel`                           | erzeugt automatisch Deployer-OIDC-Credentials     |
| 11 | Reconfigure Deployer mit OIDC              | [`setup-deployer-oidc.sh`](setup-deployer-oidc.sh) |
| 12 | Deploy `gitea`                             |                                                  |
| 13 | Deploy `eclipse-mosquitto`                 |                                                  |
| 14 | Deploy `github-runner`                     | default target: `ubuntupve`                       |

## VM-Zuordnung

VMs werden per `vm_id_start` ab einem Startwert automatisch vergeben (nächste freie ID). Die App↔Host-Zuordnung steuerst du in [`setup-production.sh`](setup-production.sh) über die `APP_HOST`-Map (am Kopf der Datei). Apps ohne Eintrag laufen auf `$PVE_HOST` (default `pve1.cluster`).

| App                     | vm_id_start | Node       | IP             | Hostname                 |
|-------------------------|-------------|------------|----------------|--------------------------|
| proxvex                 | 500         | pve1       | 192.168.4.51   | proxvex                  |
| docker-registry-mirror  | 500         | pve1       | 192.168.4.45   | docker-registry-mirror   |
| postgres                | 500         | pve1       | DHCP           | postgres                 |
| zitadel                 | 500         | pve1       | DHCP           | zitadel                  |
| nginx                   | 500         | pve1       | 192.168.4.41   | nginx                    |
| eclipse-mosquitto       | 500         | pve1       | 192.168.4.44   | eclipse-mosquitto        |
| gitea                   | 500         | pve1       | DHCP           | gitea                    |
| github-runner           | 600         | ubuntupve  | DHCP           | github-runner            |

**IP-Strategie:** Interne Apps (postgres, zitadel, gitea, github-runner) nutzen DHCP — dnsmasq auf dem Router löst Hostnamen automatisch auf. Externe Apps (nginx, mosquitto) und Mirror-/Deployer-Hosts (proxvex, docker-registry-mirror) brauchen statische IPs, weil sie NAT-Ziele oder DNS-Aliase sind, die zur Setup-Zeit erreichbar sein müssen — der `docker-registry-mirror`-Eintrag in [`dns.sh`](dns.sh) wird vom Pull-Through-Code ausgewertet.

**DNS-Setup pro App-Config (`production/<app>.json`):** Jede App, die `nameserver4` setzt, sollte zusätzlich `nameserver6` mitliefern (z. B. `2606:4700:4700::1111`). Sobald IPv6 im Container konfiguriert oder per SLAAC verfügbar ist, dient der v6-Resolver als Fallback, wenn der IPv4-Pfad zum Gateway klemmt — sonst hängt `apk`/`apt`/`curl` mit „transient DNS error" obwohl IPv6-Konnektivität besteht. Für Container, die schon vor dieser Regel deployed wurden: `pct stop && pct set <vmid> --nameserver "<v4> <v6>" && pct start`.

## Voraussetzungen

### Proxmox-Cluster (einmalig, falls Multi-Node)

SSH zwischen allen Nodes ohne Passwort, dann Cluster bilden:

```bash
ssh-copy-id root@pve1
ssh-copy-id root@pve2
ssh-copy-id root@ubuntupve

# Auf pve1:
pvecm create production

# Auf weiteren Nodes:
pvecm add <pve1-IP>

pvecm status
```

VMID-Bereiche pro Node (in `setup-production.sh` per `APP_HOST`-Map konfiguriert):

| Node      | vm_id_start | Bereich |
|-----------|-------------|---------|
| pve1      | 500         | 500–599 |
| ubuntupve | 600         | 600–699 |
| pve2      | 700         | 700–799 |

### Cloudflare API Token (für Step 6)

Ein Token mit Permission `Zone:DNS:Edit` für alle relevanten Domains erstellen ([Dashboard](https://dash.cloudflare.com/profile/api-tokens)). Keine Zone-ID nötig — `acme.sh` (`dns_cf`) löst die Zone anhand des Domainnamens auf, ein Token deckt beliebig viele Domains ab.

Übergabe: `CF_TOKEN=xxx ./production/setup-production.sh --step 6` (oder interaktiver Prompt, wenn nicht gesetzt). Wenn der `cloudflare_production`-Stack bereits im Deployer existiert, wird der Prompt übersprungen.

### SMTP-Passwort (für Step 6)

Zitadel verschickt Verifikations-Mails über SMTP. Das Passwort kommt analog zum CF_TOKEN per `SMTP_PASSWORD=xxx ./production/setup-production.sh --step 6` oder interaktivem Prompt; bereits gespeicherte Werte im `oidc_production`-Stack werden wiederverwendet.

## Single-Step-Operations

Während der Master-Lauf alles in einem Aufwasch macht, gibt es ein paar Eingriffe, die du gezielt brauchst:

```bash
# Mirror-Container neu deployen (state-frei, Cache geht verloren!)
./production/setup-production.sh --retry 5 --force-docker-registry-mirror

# Nginx neu deployen ohne ACME-Rate-Limit-Risiko
./production/setup-production.sh --retry 8 --force-nginx

# Nur die Nginx-vhost-Config nachziehen, Container behalten
./production/setup-production.sh --step 8     # ohne --force, vhosts werden idempotent neu geschrieben

# Lokale json/-Änderungen in den laufenden Deployer pushen + reload
./production/setup-production.sh --json-dev-sync --step <N>
```

`--retry` ist nur für stateless, dependency-freie Steps (5/8/13) zugelassen — alles andere lehnt das Skript ab, weil ein blindes Destroy-and-Redeploy Daten oder Folgeschritte zerstören würde.


## Nach der Installation: Zitadel-Konfiguration

Step 10/11 richtet Zitadel automatisch so ein, dass Deployer-CLI **und** Browser-Login funktionieren. Was der Bootstrap ([`post-setup-deployer-in-zitadel.sh`](../json/applications/zitadel/scripts/post-setup-deployer-in-zitadel.sh)) anlegt:

| Objekt in Zitadel             | Zweck                                                              |
|-------------------------------|--------------------------------------------------------------------|
| Project `proxvex`             | Hält Rollen + OIDC-App                                             |
| Role `admin`                  | Vom Deployer als Required-Role geprüft                             |
| OIDC-App `proxvex` (Web)      | Browser-Login (Auth-Code-Flow), Client-ID/Secret in `deployer-oidc.json` |
| Machine-User `deployer-cli`   | CLI-Login (Client-Credentials-Flow), `machine_client_*` in `deployer-oidc.json`, `admin`-Rolle gegrantet |
| Token-Settings auf der App    | `idTokenRoleAssertion`, `accessTokenRoleAssertion`, `idTokenUserinfoAssertion` aktiviert |

Was du **manuell** machen musst, sobald Step 11 durch ist:

### 1. Eigenen User die `admin`-Rolle granten

Der Bootstrap legt nur die Rolle an — vergibt sie an keinen Menschen. Erster Browser-Login auf `https://proxvex:3443` bekommt sonst „missing role 'admin'" (HTTP 403).

```
auth.ohnewarum.de → Authorization → User Grants → + Authorization
  User: <dein Zitadel-User>
  Project: proxvex
  Role: admin
```

Erst danach lässt dich der Deployer rein.

### 2. Weitere Operatoren

Pro Person dasselbe Grant. Revoke = Authorization löschen, sofortige Wirkung beim nächsten JWT-Refresh.

### 3. Sicherheits-Hinweis: `deployer-cli` Machine-User

`deployer-oidc.json` auf der Zitadel-LXC enthält ein Client-Secret, das den Deployer mit `admin`-Rolle steuern kann. Speicherort:
- LXC: `/bootstrap/deployer-oidc.json` (chmod 0600, root)
- PVE-Host (ZFS-Subvolume): `/rpool/data/subvol-<vmid>-zitadel-bootstrap/deployer-oidc.json`

Wer Root auf der Zitadel-LXC hat oder das ZFS-Subvolume lesen kann, kann sich als Deployer-Admin authentifizieren. Threat-Model entsprechend einplanen — separate, langlebige Credential statt PAT war ein bewusster Trade-off (Komfort + Hardening-Überleben gegen geteiltes Secret).

Rotieren des Machine-User-Secrets: nur möglich, solange der Admin-PAT noch existiert (vor Hardening). Danach: User in Zitadel-UI löschen + Bootstrap auf einer frischen Zitadel-Instanz neu laufen lassen.

### 4. Hardening (Template 360)

`post-harden-zitadel-compose.sh` läuft beim Zitadel-Deploy automatisch und entfernt `/bootstrap/admin-client.pat`. Konsequenzen:

- Kein erneuter Bootstrap-Lauf möglich (würde fehlen: Authentifizierung gegen die Zitadel-Management-API).
- `deployer-oidc.json` bleibt intakt, CLI- und Browser-Login funktionieren weiter.
- Reihenfolge ist wichtig: **alle Bootstrap-Korrekturen vor Hardening anwenden**. Wenn ein Code-Bug am Bootstrap später gefunden wird, hilft nur: Zitadel-DB droppen + Step 10 neu (siehe Repair-Recipe in [`setup-production.sh`](setup-production.sh) Schritt 10).


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
| proxvex | `addon-ssl` | Nur Lokal |
| Node-RED | `addon-ssl` | Nur Lokal |
| PostgREST | `addon-ssl` | Nur Lokal |
| Postgres | `addon-ssl` | Nur DB-Clients |
| MQTT (Mosquitto) | `addon-ssl` | Nur MQTT-Clients |

**Voraussetzung:** Die globale CA muss auf den LAN-Browsern installiert sein (2 Geräte, einmalig).

### Datenfluss

```
Öffentlicher Zugang (WAN):
  Browser → Internet → WAN Port Forward :443 → Nginx :1443
    ├── ohnewarum.de              → Statische Homepage (nginx lokal)
    ├── nebenkosten.ohnewarum.de  → Frontend-App (nginx lokal, OIDC client-seitig)
    ├── auth.ohnewarum.de         → [self-signed] Zitadel (:1443)
    ├── git.ohnewarum.de          → [self-signed] Gitea (:1443)
    └── ...
    (Nginx vertraut self-signed Backends via proxy_ssl_trusted_certificate)

Lokaler Zugang (LAN, alle *.ohnewarum.de über gleichen Pfad):
  Browser (LAN) → DNS → 192.168.1.1 → NAT :443 → Nginx :1443
    ├── ohnewarum.de              → Statische Homepage
    ├── auth.ohnewarum.de         → Zitadel (:1443)
    ├── git.ohnewarum.de          → Gitea (:1443)
    └── nebenkosten.ohnewarum.de  → Frontend-App

Lokaler Direktzugang (LAN, CA auf Browser installiert):
  Browser (LAN) → DNS (DHCP-Hostname) → Container-IP
    ├── proxvex:3443   → [self-signed] proxvex
    ├── zitadel:1443            → [self-signed] Zitadel (direkt)
    └── nodered:1443            → [self-signed] Node-RED

MQTT (LAN only):
  IoT-Clients → DNS → 192.168.1.1 → NAT :8883 → Mosquitto :8883
  mqtt.ohnewarum.de:8883 → [self-signed TLS, CA-Trust]

DB (intern):
  Zitadel →[self-signed, sslmode=verify-ca]→ Postgres (:5432)
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
        proxy_pass https://zitadel:1443;
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
| Zitadel | ✓ auth.ohnewarum.de | ✓ direkt :1443 | Self-signed | — |
| Gitea | ✓ git.ohnewarum.de | ✓ direkt :1443 | Self-signed | addon-oidc |
| proxvex | ✗ | ✓ direkt :3443 | Self-signed | addon-oidc |
| Node-RED | ✗ | ✓ direkt :1443 | Self-signed | — |
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

| Datei                            | Zweck                                                  |
|----------------------------------|--------------------------------------------------------|
| `setup-production.sh`            | Master-Orchestrator (Steps 1..14, `--bootstrap`, `--retry`, `--json-dev-sync`) |
| `setup-pve-host.sh`              | Per-Host: SSH-Config registrieren, Production-Files kopieren, Trust-CA  |
| `dns.sh`                         | DNS-Einträge + NAT auf OpenWrt                          |
| `project-v1.sh`                  | Project-Defaults v1 (vm_id_start, Mirrors)              |
| `project.sh`                     | Project-Defaults v2 (+ oidc_issuer_url, nach Nginx-Setup) |
| `setup-acme.sh`                  | Production-Stack: Cloudflare + Domain-Suffix + OIDC-Stack |
| `setup-nginx.sh`                 | Nginx Virtual Hosts + Homepage einrichten              |
| `setup-deployer-oidc.sh`         | Deployer auf OIDC umstellen (Step 11)                   |
| `upload-nginx-content.sh`        | Statische HTML-Inhalte ins Nginx-Volume kopieren        |
| `deploy.sh`                      | Wrapper für einzelne App-Deployments via Deployer-API   |
| `destroy.sh`                     | App-spezifischer Destroy + Postgres-DB-Cleanup          |
| `destroy-all.sh`                 | Tabula rasa: alle Apps + Volumes + Stacks destroyen     |
| `create-proxmox-iso.sh`          | Custom Proxmox-ISO bauen (selten gebraucht)             |
| `docker-registry-mirror.json`, `nginx.json`, `postgres.json`, `zitadel.json`, `gitea.json`, `eclipse-mosquitto.json` | CLI-Parameter pro App (addon-Liste, Properties)         |
| `github-runner.json`             | Optional, von Step 14 erwartet — Template im Skript     |
| `.env`                           | OIDC Credentials (git-ignored, von Step 11 gefüllt)     |
