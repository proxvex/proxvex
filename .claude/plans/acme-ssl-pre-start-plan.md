# Plan: ACME/SSL Addon — Alle Addon-Templates nach pre_start (universell)

## Context

ACME und SSL Addon-Templates sollen komplett in pre_start laufen — fuer ALLE App-Typen (oci-image UND docker-compose). Die Addon post_start Templates (332, 340, 342, 325) werden durch ein einziges pre_start Template (166) ersetzt, das alle Dateien host-seitig in den Bind-Mount `/etc/lxc-oci-deployer` schreibt.

- OCI-image reconfigure: clone -> pre_start -> replace_ct (kein start/post_start)
- Docker-compose: post_start bleibt fuer Base-App-Templates (320, 330), aber Addon-Templates sind pre_start
- oci-lxc-deployer wird sicher reconfigurierbar fuer SSL/ACME

**Kein `skip_addon_post_start`, kein CommandBuilder-Filtering noetig.**

---

## Step 1: Add `oci_deployer` volume to both addons

**Files:** `json/addons/addon-acme.json`, `json/addons/addon-ssl.json`

Change `addon_volumes` from:
```
certs=/etc/ssl/addon,0700,0:0
```
to:
```
certs=/etc/ssl/addon,0700,0:0\noci_deployer=/etc/lxc-oci-deployer,0755,0:0
```

Host-side: `<shared_volpath>/volumes/<hostname>/oci-deployer/` -> Container: `/etc/lxc-oci-deployer/`

Docker-compose apps nutzen ein Unterverzeichnis:
`/etc/lxc-oci-deployer/docker-compose/<project>/` fuer compose files.

---

## Step 2: Rename `acme.domain` -> `acme.san`

**File:** `json/addons/addon-acme.json`

Rename parameter:
```json
{
  "id": "acme.san",
  "name": "SAN (Subject Alternative Names)",
  "type": "string",
  "required": true,
  "description": "Domain(s) for the certificate. Comma-separated for multi-domain SAN (e.g. app.example.com or auth.example.com,api.example.com). Supports wildcards (*.example.com)."
}
```

Update all script references: `acme.domain` -> `acme.san`, `ACME_DOMAIN` -> `ACME_SAN`.

---

## Step 3: New pre_start template + script (replaces 332, 340, 342, 325)

### Template: `json/shared/templates/pre_start/166-conf-write-on-start-scripts.json`

- `execute_on: "ve"` (runs on host)
- Parameters: `shared_volpath`, `hostname`, `ssl.mode`, `http_port`, `https_port`, `acme.cf_api_token`, `acme.san`, `acme.email`, `acme.cert_dir`, `acme.needs_server_cert`, `acme.needs_ca_cert`, `alpine_mirror`, `debian_mirror`, `compose_project`, `compose_file`, `uid`, `gid`
- After: `150-conf-create-storage-volumes-for-lxc.json`

### Script: `json/shared/scripts/pre_start/conf-write-on-start-scripts.sh`

Runs on host. Computes `VOLUME_DIR="${SHARED_VOLPATH}/volumes/$(sanitize ${HOSTNAME})/oci-deployer"`. Writes:

1. **Dispatcher**: `${VOLUME_DIR}/on_start_container` (same content as current post-install-on-start-dispatcher.sh)
2. **ACME renewal** (if `acme.cf_api_token` set): `${VOLUME_DIR}/on_start.d/acme-renew.sh` — header with baked-in vars + embedded body from current post_start script
3. **SSL proxy** (if `ssl.mode == "proxy"`): `${VOLUME_DIR}/on_start.d/ssl-proxy.sh` — header with baked-in vars + embedded body
4. **Docker-compose SSL injection** (if `compose_project` set AND `ssl.mode == "proxy"`): Writes modified compose file with nginx-ssl-proxy service to `${VOLUME_DIR}/docker-compose/${COMPOSE_PROJECT}/docker-compose.yml`. Logic from current `post-inject-ssl-proxy-compose.sh`.

Permissions: dispatcher `0755`, scripts `0700`, compose dirs `0755`.

### Skip-Logik

| Skip-Bedingung | Wo gehandhabt | Details |
|---|---|---|
| `ssl.mode != proxy` | **Host-seitig** (166-Script) | `ssl-proxy.sh` + compose injection nicht geschrieben |
| `acme.cf_api_token` fehlt | **Host-seitig** (166-Script) | `acme-renew.sh` nicht geschrieben |
| `compose_project` fehlt | **Host-seitig** (166-Script) | Compose injection nicht geschrieben |
| Certs noch nicht vorhanden | **Container-intern** | Runtime check in `ssl-proxy.sh` Body |
| nginx schon laufend | **Container-intern** | Runtime check in `ssl-proxy.sh` Body |
| acme-renew-loop schon laufend | **Container-intern** | Runtime check in `acme-renew.sh` Body |

### Multi-Domain SAN Support

`acme.san` supports comma-separated domains (e.g. `auth.ohnewarum.de,gitea.ohnewarum.de`). Script splits on comma and builds multiple `-d` flags:

```sh
ACME_ARGS="--dns dns_cf"
IFS=','
for d in $ACME_SAN; do
  ACME_ARGS="$ACME_ARGS -d $d"
done
unset IFS
PRIMARY_DOMAIN=$(echo "$ACME_SAN" | cut -d',' -f1)
```

### Simplified cert writing

Certs volume is bind-mounted r/w. `acme-renew.sh` writes directly to `/etc/ssl/addon/` (= host-side `certs/` volume). No extra copy step.

---

## Step 4: New pre_start disable script

### Template: `json/shared/templates/pre_start/167-conf-remove-on-start-scripts.json`

- `execute_on: "ve"`
- Parameters: `shared_volpath`, `hostname`

### Script: `json/shared/scripts/pre_start/conf-remove-on-start-scripts.sh`

Removes from `${VOLUME_DIR}/on_start.d/`: `acme-renew.sh`, `ssl-proxy.sh`
Removes from `${VOLUME_DIR}/docker-compose/`: compose SSL injection files

---

## Step 5: Update addon JSON files — remove post_start, add pre_start

### `addon-acme.json`

```json
"installation": {
  "pre_start": [
    { "name": "150-conf-create-storage-volumes-for-lxc.json", "after": "100-conf-create-configure-lxc.json" },
    { "name": "166-conf-write-on-start-scripts.json", "after": "150-conf-create-storage-volumes-for-lxc.json" },
    { "name": "159-conf-enable-ssl-app.json", "after": "150-conf-create-storage-volumes-for-lxc.json" },
    { "name": "170-conf-add-ssl-capabilities.json", "after": "100-conf-create-configure-lxc.json" },
    { "name": "165-conf-register-hookscript.json", "after": "100-conf-create-configure-lxc.json" }
  ]
  // NO post_start section
},
"reconfigure": {
  "pre_start": [ /* same as installation */ ]
  // NO post_start section
},
"disable": {
  "pre_start": [
    "158-conf-disable-ssl-app.json",
    "167-conf-remove-on-start-scripts.json"
  ]
  // NO post_start section
},
"upgrade": [
  "166-conf-write-on-start-scripts.json"
]
```

### `addon-ssl.json` — same pattern (with 156-conf-generate-certificates.json)

---

## Step 6: Handle upgrade task in AddonCommandBuilder

**File:** `backend/src/webapp/webapp-ve-addon-command-builder.mts`

Currently `upgrade` is flat and maps to `post_start` only (line 73-75):
```typescript
if (addonKey === "upgrade") {
  templateRefs = phase === "post_start" ? addon.upgrade : undefined;
}
```

Change to also support `pre_start` for upgrade:
```typescript
if (addonKey === "upgrade") {
  // upgrade is flat — load for pre_start (new) or post_start (legacy)
  templateRefs = (phase === "pre_start" || phase === "post_start") ? addon.upgrade : undefined;
}
```

Since addon-acme/ssl upgrade list now contains only template 166 (pre_start), the AddonCommandBuilder loads it. Template 166 is in `pre_start/` category, so the resolver needs to look there.

**Fix:** The category is currently determined by `phase` parameter. For upgrade templates that are pre_start templates but loaded via upgrade, we need to resolve the template from the correct category. The simplest fix: check both `pre_start` and `post_start` categories when resolving upgrade templates.

---

## Step 7: Docker-compose integration

Docker-compose apps use the new pre_start approach identically:
1. Template 166 writes dispatcher + on_start.d scripts + compose SSL injection to host volume
2. Docker-compose `post_start` templates (320-upload, 330-start) still run as base app templates
3. The compose files from template 320 go to `/opt/docker-compose/<project>/`
4. The SSL-injected compose from template 166 goes to `/etc/lxc-oci-deployer/docker-compose/<project>/`

**Simplest approach:** The ssl-proxy.sh on_start.d script, for docker-compose apps, copies the injected compose file from `/etc/lxc-oci-deployer/docker-compose/<project>/` to `/opt/docker-compose/<project>/` and runs `docker compose up -d`.

---

## Step 8: Addon-Dokumentation (.md Dateien)

### `json/addons/addon-acme.md` (neu)

Inhalt:
- **Use Cases** am Anfang:
  - Einzelne App mit eigenem Let's Encrypt Zertifikat (z.B. Gitea)
  - Zentraler Reverse Proxy mit Wildcard-Cert (`*.example.com`)
  - Multi-Domain SAN fuer mehrere Subdomains in einem Cert
- **Parameter-Hilfe:**
  - `acme.san`: Kommaseparierte Domain-Liste oder einzelne Domain. Unterstuetzt Template-Variablen (`{{hostname}}.example.com`). Beispiele: `app.example.com`, `auth.example.com,api.example.com`, `*.example.com`
  - `acme.cf_api_token`: Wie man einen Cloudflare API Token mit DNS-Edit-Berechtigung erstellt. Hinweis: Bei SAN-Domains aus verschiedenen Zonen muss der Token Berechtigung fuer alle Zonen haben.
  - `acme.email`: Optional, fuer Let's Encrypt Ablaufbenachrichtigungen
  - `ssl.mode`: Erklaerung der drei Modi (proxy/native/certs) mit Empfehlungen
- **Cloudflare Zonen und SAN:**
  - Subdomains derselben Zone (z.B. `auth.example.com, gitea.example.com`) → ein Token, eine Zone
  - Domains verschiedener Zonen (z.B. `app.example.com, api.otherdomain.com`) → Token braucht DNS:Edit fuer alle Zonen
  - Wildcard (`*.example.com`) → eine Zone
- **Architektur:** Kurzerklaerung Hookscript -> Dispatcher -> on_start.d

### `json/addons/addon-ssl.md` (aktualisieren)

Bestehende Datei erweitern:
- **Use Cases:**
  - Internes SSL mit selbstsignierten CA-Zertifikaten
  - Proxy-Modus: nginx terminiert TLS, App laeuft auf HTTP
  - Native-Modus: App konfiguriert HTTPS selbst (PostgreSQL, Gitea)
  - Certs-only: Nur Zertifikate bereitstellen
- **Parameter-Hilfe** fuer `ssl.mode`, `http_port`, `https_port`

---

## Flow comparison

### OCI-image installation/reconfigure (new):
1. `create_ct`: Create/clone container
2. `pre_start`: Volumes (150), on_start scripts to host volume (166), SSL app (159), hookscript (165), caps (170)
3. `start`: Skipped for reconfigure (look-ahead: no post_start). Runs for installation.
4. `post_start`: None from addons. Base app 305 (pkg mirror) runs for installation only.
5. `replace_ct`: Swap (reconfigure/upgrade)
6. Hookscript fires -> dispatcher -> acme-renew.sh / ssl-proxy.sh

### Docker-compose installation/reconfigure (new):
1. `create_ct`: Create/clone container
2. `pre_start`: Volumes (150), on_start scripts + compose injection to host volume (166), SSL app (159), hookscript (165), caps (170)
3. `start`: Container starts
4. `post_start`: Base app templates only: pkg mirror (305), docker install (307), compose upload (320), compose start (330). **No addon post_start.**
5. `replace_ct`: Swap (reconfigure/upgrade)
6. Hookscript fires -> dispatcher -> acme-renew.sh / ssl-proxy.sh (copies injected compose + restarts)

---

## Critical files to modify

| File | Change |
|------|--------|
| `json/addons/addon-acme.json` | `oci_deployer` volume, template 166/167, remove post_start, rename domain->san |
| `json/addons/addon-ssl.json` | `oci_deployer` volume, template 166/167, remove post_start |
| `backend/src/webapp/webapp-ve-addon-command-builder.mts` | Support pre_start templates in upgrade task |
| **New:** `json/addons/addon-acme.md` | Dokumentation mit Use Cases, Parameter-Hilfe, SAN |
| **Update:** `json/addons/addon-ssl.md` | Use Cases und Parameter-Hilfe erweitern |
| **New:** `json/shared/templates/pre_start/166-conf-write-on-start-scripts.json` | Template |
| **New:** `json/shared/scripts/pre_start/conf-write-on-start-scripts.sh` | Host-side script writer |
| **New:** `json/shared/templates/pre_start/167-conf-remove-on-start-scripts.json` | Disable template |
| **New:** `json/shared/scripts/pre_start/conf-remove-on-start-scripts.sh` | Disable script |

Old post_start templates (332, 340, 342, 325) remain in codebase but are no longer referenced by addon JSON.

---

## Verification

1. `cd backend && pnpm run lint:fix && pnpm run build && pnpm test` — Schema validation, template loading
2. `cd frontend && pnpm run lint:fix && pnpm run build && pnpm test`
3. Livetest oci-image + ACME: `npx tsx backend/tests/livetests/src/live-test-runner.mts local-test nginx`
4. Livetest docker-compose + SSL: verify compose injection + proxy work
5. Manual check: verify files in `<shared_volpath>/volumes/<hostname>/oci-deployer/`
