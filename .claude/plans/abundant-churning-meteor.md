# Plan: Hookscript Log Monitoring — Marker-basierte Ausgabe nach Container-Start

## Context

On_start.d Scripts (ACME, SSL-Proxy) laufen im Hookscript nach Container-Start. Ihre Ausgabe geht nur nach `/var/log/lxc/{hostname}-{vmid}.log` und wird vom Backend nicht ueberwacht. Bei Installation/Reconfigure/Upgrade bemerkt man Fehler (z.B. ACME-Zertifikat fehlgeschlagen) nicht.

**Ziel:** Nach jedem Container-Start/-Restart die Hookscript-Ausgabe einsammeln und im Installations-Monitor anzeigen — inklusive Erfolg/Fehler-Status.

## Ansatz: Marker im LXC Console Log

### Ablauf

1. **Vor Container-Start** (pre_start oder start Template):
   - Log-Datei `/var/log/lxc/{hostname}-{vmid}.log` loeschen oder truncaten
   - START-Marker ins Log schreiben (z.B. `echo "===OCI_HOOK_START===" >> logfile`)

2. **Hookscript laeuft** (automatisch bei post-start):
   - on_start_container Dispatcher fuehrt on_start.d Scripts aus
   - Gesamte Ausgabe geht ins LXC Console Log
   - Am Ende: Dispatcher schreibt SUCCESS- oder ERROR-Marker

3. **Nach Container-Start** (neues Template nach start/replace_ct):
   - Script liest Log-Datei
   - Sucht nach START-Marker und SUCCESS/ERROR-Marker
   - Gibt alles dazwischen auf stderr aus (wird im Monitor angezeigt)
   - Meldet Erfolg oder Fehler als JSON-Output

### Marker-Format

```
===OCI_HOOK_START===
... on_start.d Ausgabe ...
===OCI_HOOK_SUCCESS===
```
oder bei Fehler:
```
===OCI_HOOK_START===
... on_start.d Ausgabe ...
===OCI_HOOK_ERROR===
```

---

## Step 1: Dispatcher mit Markern erweitern

**File:** `json/shared/scripts/pre_start/conf-write-on-start-scripts.sh` (der on_start_container Dispatcher)

Der Dispatcher schreibt Marker vor und nach der Ausfuehrung:

```sh
#!/bin/sh
APP_UID="${1:-0}"
APP_GID="${2:-0}"
DROPIN_DIR="/etc/lxc-oci-deployer/on_start.d"

echo "===OCI_HOOK_START===" >&2
HOOK_FAILED=0

for script in "$DROPIN_DIR"/*.sh; do
  [ -x "$script" ] || continue
  echo "Running: $script" >&2
  "$script" "$APP_UID" "$APP_GID" 2>&1 | while IFS= read -r line; do echo "  $line" >&2; done
  if [ $? -ne 0 ]; then
    HOOK_FAILED=1
  fi
done

if [ "$HOOK_FAILED" -eq 0 ]; then
  echo "===OCI_HOOK_SUCCESS===" >&2
else
  echo "===OCI_HOOK_ERROR===" >&2
fi
```

Die Marker landen ueber stderr im LXC Console Log (`lxc.console.logfile`).

---

## Step 2: Hookscript stderr nicht mehr unterdruecken

**File:** `json/shared/scripts/pre_start/conf-register-hookscript.sh` (Zeile 38)

Aktuell:
```sh
pct exec "$vmid" -- /etc/lxc-oci-deployer/on_start_container "${APP_UID:-0}" "${APP_GID:-0}" 2>/dev/null || true
```

Aendern zu:
```sh
pct exec "$vmid" -- /etc/lxc-oci-deployer/on_start_container "${APP_UID:-0}" "${APP_GID:-0}" || true
```

Ohne `2>/dev/null` — stderr geht ins Console Log.

---

## Step 3: Log vor Start loeschen/truncaten

Im Start-Script (`json/shared/scripts/start/lxc-start.sh`) oder in einem neuen pre_start Template:

```sh
LOG_PATH="/var/log/lxc/${HOSTNAME}-${VMID}.log"
: > "$LOG_PATH" 2>/dev/null || true
```

Das leert das Log vor dem Start, damit nur frische Hookscript-Ausgabe drin steht.

---

## Step 4: Neues Template — Log nach Start auslesen

### Template: `json/shared/templates/post_start/350-host-check-hook-log.json` (oder `replace_ct/`)

- `execute_on: "ve"` (laeuft auf PVE Host)
- Parameters: `vm_id`, `hostname`
- Muss nach `start` und nach `replace_ct` laufen

### Script: `json/shared/scripts/post_start/host-check-hook-log.sh`

```sh
#!/bin/sh
VMID="{{ vm_id }}"
HOSTNAME="{{ hostname }}"
LOG_PATH="/var/log/lxc/${HOSTNAME}-${VMID}.log"
TIMEOUT=60

# Warte auf Marker (Hookscript braucht Zeit, z.B. acme.sh Installation)
ELAPSED=0
while [ $ELAPSED -lt $TIMEOUT ]; do
  if grep -q "===OCI_HOOK_SUCCESS===" "$LOG_PATH" 2>/dev/null; then
    break
  fi
  if grep -q "===OCI_HOOK_ERROR===" "$LOG_PATH" 2>/dev/null; then
    break
  fi
  sleep 2
  ELAPSED=$((ELAPSED + 2))
done

# Log-Inhalt zwischen Markern ausgeben
if [ -f "$LOG_PATH" ]; then
  sed -n '/===OCI_HOOK_START===/,/===OCI_HOOK_\(SUCCESS\|ERROR\)===/p' "$LOG_PATH" |
    grep -v "===OCI_HOOK_" >&2
fi

# Ergebnis pruefen
if grep -q "===OCI_HOOK_SUCCESS===" "$LOG_PATH" 2>/dev/null; then
  echo "Hookscript completed successfully" >&2
  printf '[{"id":"hook_status","value":"success"}]\n'
elif grep -q "===OCI_HOOK_ERROR===" "$LOG_PATH" 2>/dev/null; then
  echo "ERROR: Hookscript reported errors" >&2
  printf '[{"id":"hook_status","value":"error"}]\n'
  exit 1
else
  echo "WARNING: Hookscript did not complete within ${TIMEOUT}s" >&2
  # Zeige was bisher im Log steht
  cat "$LOG_PATH" >&2 2>/dev/null || true
  printf '[{"id":"hook_status","value":"timeout"}]\n'
fi
```

---

## Step 5: Template in Base-Apps einbinden (universell)

Das Log-Check-Template wird in den **Base-Apps** (`oci-image`, `docker-compose`) eingebunden — nicht in einzelnen Addons. So steht es allen zukuenftigen Hooks zur Verfuegung.

### Skip via `skip_if_all_missing` (sichtbar im Monitor)

Template 166 (`conf-write-on-start-scripts`) setzt bereits den Output `on_start_scripts_written`. Template 350 nutzt diesen als Skip-Bedingung:

```json
"skip_if_all_missing": ["on_start_scripts_written"]
```

- Kein Addon mit Hooks → Template 166 laeuft nie → `on_start_scripts_written` fehlt → Template 350 zeigt **(skipped)** im Monitor
- Addon aktiv → Template 166 setzt `on_start_scripts_written` → Template 350 laeuft

Kein Self-Skip noetig. Der bestehende Skip-Mechanismus zeigt den Status klar im Monitor an.

### Einbindung:

**`oci-image/application.json`:**
- `installation.post_start`: Template 350 hinzufuegen (nach 305)
- `upgrade.post_start`: Template 350 hinzufuegen (nach 305)
- `reconfigure`: Template 350 nach replace_ct (oder in `replace_ct` Phase nach 900)

**`docker-compose/application.json`:**
- `installation.post_start`: Template 350 hinzufuegen (nach 330)
- `upgrade.post_start`: Template 350 hinzufuegen (nach 330)
- `reconfigure.post_start`: Template 350 hinzufuegen (nach 330)

---

## Welche Tasks brauchen das?

| Task | Start-Methode | Log-Check noetig? |
|------|--------------|-------------------|
| Installation | `start` Phase | Ja — nach start |
| Reconfigure | `replace_ct` (restart) | Ja — nach replace_ct |
| Upgrade | `replace_ct` (restart) | Ja — nach replace_ct |

---

## Critical files

| File | Change |
|------|--------|
| `json/shared/scripts/pre_start/conf-write-on-start-scripts.sh` | Dispatcher mit START/SUCCESS/ERROR Markern |
| `json/shared/scripts/pre_start/conf-register-hookscript.sh` | `2>/dev/null` entfernen |
| `json/shared/scripts/start/lxc-start.sh` | Log truncaten vor Start |
| **New:** `json/shared/templates/post_start/350-host-check-hook-log.json` | Template |
| **New:** `json/shared/scripts/post_start/host-check-hook-log.sh` | Log-Check Script |
| `json/applications/oci-image/application.json` | Template 350 in post_start/replace_ct |
| `json/applications/docker-compose/application.json` | Template 350 in post_start |

---

## Verification

1. `cd backend && pnpm run lint:fix && pnpm run build && pnpm test`
2. Livetest: nginx mit ACME Addon installieren → Hookscript-Ausgabe im Monitor sichtbar
3. Livetest: Fehlerfall simulieren (falscher CF_TOKEN) → Fehler im Monitor angezeigt
4. Reconfigure testen → Log-Check nach replace_ct
