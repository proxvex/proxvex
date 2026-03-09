# Live Integration Tests

Diese Tests erstellen echte Container auf einem Proxmox VE Host via `oci-lxc-cli` und verifizieren die Funktionalität.

## Voraussetzungen

1. **Nested VM mit Deployer** muss laufen (via `e2e/step1` + `e2e/step2`)

2. **Projekt ist gebaut** (inkl. CLI)
   ```bash
   cd $PROJECT_ROOT && pnpm run build
   ```

3. **Deployer API** ist erreichbar (wird automatisch geprüft)

## Konfiguration

Die Tests nutzen die zentrale `e2e/config.json` für alle Einstellungen (PVE Host, Ports, etc.).

Umgebungsvariablen in `config.json` werden unterstützt:
```json
{
  "pveHost": "${PVE_HOST:-ubuntupve}"
}
```

## Verwendung

```bash
# Standard-Test mit alpine-packages (default Instance aus config.json)
./run-live-test.sh

# Spezifische Instance
./run-live-test.sh local-test

# Spezifische Applikation testen
./run-live-test.sh local-test node-red installation

# Container nach Test behalten (für Debugging)
KEEP_VM=1 ./run-live-test.sh local-test

# PVE Host per Umgebungsvariable überschreiben
PVE_HOST=pve2.cluster ./run-live-test.sh local-test
```

### Argumente

1. `instance` - Instance-Name aus `e2e/config.json` (optional, default aus config)
2. `application` - Name der zu testenden Applikation (optional, default: alpine-packages)
3. `task` - Task-Typ (optional, default: installation)

## Was wird getestet?

1. **Container-Erstellung** via `oci-lxc-cli remote`
   - Container wird erfolgreich erstellt
   - VM_ID wird korrekt zurückgegeben

2. **Notes-Generierung**
   - `oci-lxc-deployer:managed` Marker
   - `oci-lxc-deployer:log-url` für Log-Viewer
   - `oci-lxc-deployer:icon-url` für Icons
   - `**Links**` Abschnitt

3. **Container-Status**
   - Container läuft
   - Hat Netzwerkverbindung (optional)

## Cleanup

Container werden automatisch nach dem Test gelöscht, es sei denn `KEEP_VM=1` ist gesetzt.
