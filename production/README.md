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

Das Install-Script wird direkt auf dem Proxmox-Host ausgeführt:

```bash
# Auf pve1.cluster:
curl -fsSL https://raw.githubusercontent.com/modbus2mqtt/oci-lxc-deployer/main/install-oci-lxc-deployer.sh | sh -s -- \
  --vm-id-start 300 \
  --static-ip 192.168.4.39/24 \
  --gateway 192.168.4.1 \
  --nameserver 192.168.4.1 \
  --https
```

### 3. Postgres und Zitadel deployen

Zitadel wird als OIDC-Provider benötigt, bevor die anderen Apps mit OIDC konfiguriert werden können.

```bash
./production/deploy.sh zitadel      # deployt postgres + zitadel
```

### 4. Zitadel Service User anlegen

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

### 5. oci-lxc-deployer auf OIDC umstellen

Das Backend mit OIDC-Umgebungsvariablen neu konfigurieren:

```
OIDC_ENABLED=true
OIDC_ISSUER_URL=http://zitadel:8080
OIDC_CLIENT_ID=<backend-client-id>
OIDC_CLIENT_SECRET=<backend-client-secret>
OIDC_CALLBACK_URL=https://deployer:3443/api/auth/callback
```

### 6. Restliche Apps mit OIDC deployen

Sobald `production/.env` existiert und OIDC am Backend aktiv ist, werden alle weiteren Apps mit OIDC-Authentifizierung deployed:

```bash
./production/deploy.sh nginx        # nginx (ohne OIDC-Dependency)
./production/deploy.sh gitea        # gitea (mit addon-oidc)
```

Oder alle auf einmal (bereits installierte werden übersprungen):

```bash
./production/deploy.sh all
```

## OIDC Issuer URL anpassen

Die externe OIDC Issuer URL (z.B. `https://auth.ohnewarum.de`) wird zentral über ein Template gesteuert und gilt für alle OIDC-fähigen Apps.

Das Template `106-set-oidc-issuer-url.json` liegt im Local-Verzeichnis des Deployers (`/config/shared/templates/pre_start/`). Dort wird der Default für `oidc_issuer_url` gesetzt, den alle Apps beim OIDC-Setup verwenden.

Um die URL zu ändern, die Datei auf dem PVE-Host bearbeiten:

```bash
# Pfad: <shared_volpath>/volumes/oci-lxc-deployer/config/shared/templates/pre_start/106-set-oidc-issuer-url.json
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
```

Ohne diese Datei wird automatisch die interne Zitadel-URL (`http://zitadel:8080`) verwendet.

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
| `setup-zitadel-service-user.sh`  | Zitadel Service User + Client Credentials  |
| `*.json`                         | CLI-Parameter pro App                      |
| `.env`                           | OIDC Credentials (git-ignored)             |
