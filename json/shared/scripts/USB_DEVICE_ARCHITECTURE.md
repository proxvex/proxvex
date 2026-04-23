# USB Device Mapping Architecture

## Übersicht

Diese Architektur ermöglicht das Mapping verschiedener USB-Gerätetypen (tty, input, audio) zu LXC-Containern mit gemeinsamer Funktionalität.

## Dateistruktur

```
json/shared/scripts/
├── usb-device-common.sh          # Gemeinsame Library-Funktionen
├── map-serial-device.sh          # Spezifisch für TTY/Serial-Devices
├── map-input-device.sh           # Spezifisch für Input-Devices (Tastatur/Maus)
└── map-audio-device.sh            # Spezifisch für Audio-Devices

json/shared/templates/
├── 110-map-serial.json           # Template für Serial-Devices
├── 111-map-input.json            # Template für Input-Devices
└── 112-map-audio.json            # Template für Audio-Devices
```

## Gemeinsame Library: `usb-device-common.sh`

### Funktionen

#### 1. `parse_usb_bus_device(usb_bus_device)`
- **Input**: `bus:device` Format (z.B. `1:3`)
- **Output**: `USB_BUS`, `USB_DEVICE` Variablen
- **Validierung**: Prüft Format und Existenz
- **Rückgabe**: Exit-Code 0 bei Erfolg, 1 bei Fehler

#### 2. `get_usb_bus_path(bus, device)`
- **Input**: Bus-Nummer, Device-Nummer
- **Output**: `/dev/bus/usb/XXX/YYY` (formatiert mit führenden Nullen)
- **Rückgabe**: Pfad als String

#### 3. `find_usb_sysfs_path(bus, device)`
- **Input**: Bus-Nummer, Device-Nummer
- **Output**: Sysfs-Pfad (z.B. `/sys/bus/usb/devices/1-3`)
- **Sucht**: Base-Pfad und alle Interface-Pfade (z.B. `1-3:1.0`)
- **Rückgabe**: Ersten gefundenen Pfad

#### 4. `get_vendor_product_id(sysfs_path_or_device)`
- **Input**: Sysfs-Pfad oder Device-Pfad
- **Output**: `VENDOR_ID`, `PRODUCT_ID` Variablen
- **Methode**: Verwendet `udevadm info --attribute-walk`
- **Fallback**: Versucht beide Methoden (--path und --name)

#### 5. `add_cgroup_allow(config_file, device_path)`
- **Input**: Config-Datei, Device-Pfad
- **Funktion**: Fügt `lxc.cgroup2.devices.allow` Eintrag hinzu
- **Berechnung**: Major/Minor aus `stat -c "%t %T"`
- **Idempotent**: Prüft auf Existenz vor Hinzufügen

#### 6. `map_usb_bus_device(config_file, usb_bus_path, container_uid, container_gid)`
- **Input**: Config-Datei, USB-Bus-Pfad, Container UID/GID
- **Funktion**: 
  - Fügt `lxc.cgroup2.devices.allow` für USB-Bus-Device hinzu
  - Fügt `lxc.mount.entry` für USB-Bus-Device hinzu
  - Entfernt alte Einträge vorher
- **Idempotent**: Entfernt alte Einträge

#### 7. `set_device_permissions(device_path, container_uid, container_gid, mode)`
- **Input**: Device-Pfad, Container UID/GID, Mode (z.B. `0664`)
- **Funktion**: Setzt Permissions auf Host-Device
- **Mapping**: Host UID = Container UID + 100000

#### 8. `create_udev_rule(rule_file, vendor_id, product_id, subsystem, mapped_uid, mapped_gid, mode)`
- **Input**: Rule-Datei, Vendor/Product ID, Subsystem, Mapped UID/GID, Mode
- **Funktion**: Erstellt udev-Rule für automatische Permissions
- **Subsystem**: `tty`, `input`, `sound` (je nach Device-Typ)
- **Trigger**: Lädt Rules neu und triggert für aktuelles Device

#### 9. `check_container_stopped(vm_id)`
- **Input**: VM-ID
- **Funktion**: Prüft ob Container gestoppt ist
- **Rückgabe**: Exit-Code 1 wenn läuft, 0 wenn gestoppt

#### 10. `get_next_dev_index(config_file)`
- **Input**: Config-Datei
- **Funktion**: Findet nächsten freien `devX:` Index
- **Rückgabe**: `dev0`, `dev1`, `dev2`, etc.

#### 11. `resolve_symlink(symlink_path)`
- **Input**: Symlink-Pfad (z.B. `/dev/serial/by-id/usb-...`)
- **Output**: Aufgelöster Pfad (z.B. `/dev/ttyUSB0`)
- **Funktion**: Löst Symlinks auf (auch mehrstufig)
- **Methode**: Verwendet `readlink -f` mit Fallback auf manuelle Auflösung
- **Rückgabe**: Aufgelöster Pfad als String, leer bei Fehler

#### 12. `find_vendor_product_from_class_device(class_path, device_name)`
- **Input**: Class-Pfad (z.B. `/sys/class/tty/ttyUSB0`), Device-Name (z.B. `ttyUSB0`)
- **Output**: `VENDOR_ID`, `PRODUCT_ID` Variablen
- **Funktion**: Navigiert von `/sys/class/*/device` nach oben im Verzeichnisbaum
- **Methode**: 
  1. Liest `/sys/class/*/device` Symlink
  2. Navigiert bis zu 10 Ebenen nach oben
  3. Sucht nach `idVendor` und `idProduct` Dateien
- **Rückgabe**: Exit-Code 0 bei Erfolg, 1 bei Fehler

#### 13. `find_usb_device_by_vendor_product(vendor_id, product_id, device_name, device_pattern)`
- **Input**: Vendor-ID, Product-ID, Device-Name, Device-Pattern (z.B. `tty*`)
- **Output**: `USB_BUS`, `USB_DEVICE` Variablen
- **Funktion**: Findet USB-Device in `/sys/bus/usb/devices/` durch Matching
- **Methode**:
  1. Durchsucht alle `/sys/bus/usb/devices/*`
  2. Vergleicht `idVendor` und `idProduct`
  3. Prüft ob Device-Pattern in diesem USB-Device existiert
  4. Extrahiert Bus/Device aus Pfadnamen (z.B. `1-3` → Bus=1, Device=3)
- **Pfad-Formate**: Unterstützt `1-3`, `1-3:1.0`, `1-3.4:1.0`
- **Rückgabe**: Exit-Code 0 bei Erfolg, 1 bei Fehler

#### 14. `extract_bus_device_from_sysfs_path(sysfs_path)`
- **Input**: Sysfs-Pfad (z.B. `/sys/bus/usb/devices/1-3` oder `1-3:1.0`)
- **Output**: `USB_BUS`, `USB_DEVICE` Variablen
- **Funktion**: Extrahiert Bus- und Device-Nummer aus Pfadnamen
- **Regex**: 
  - Bus: `^([0-9]+)-` (erste Zahl vor `-`)
  - Device: `^[0-9]+-([0-9]+)[.:]` oder `^[0-9]+-([0-9]+)$`
- **Normalisierung**: Entfernt führende Nullen
- **Rückgabe**: Exit-Code 0 bei Erfolg, 1 bei Fehler

#### 15. `get_lsusb_description(bus, device)`
- **Input**: Bus-Nummer, Device-Nummer
- **Output**: lsusb-Beschreibung (z.B. `ID 1a86:7523 QinHeng Electronics CH340 serial converter`)
- **Funktion**: Ruft `lsusb` für spezifisches Bus/Device auf
- **Methode**:
  1. Formatiert Bus/Device mit führenden Nullen (`%03d`)
  2. Grept `lsusb` Output nach `Bus XXX Device YYY:`
  3. Extrahiert Beschreibung nach `ID`
- **Fallback**: Verwendet `lsusb -d vendor:product` wenn Bus/Device nicht gefunden
- **Rückgabe**: Beschreibung als String, leer bei Fehler

#### 16. `format_json_device_entry(name, value, is_first)`
- **Input**: Name, Value, is_first Flag
- **Output**: JSON-String (z.B. `{"name":"...","value":"1:3"}`)
- **Funktion**: Formatiert Device-Eintrag für JSON-Array
- **Escape**: Escaped Anführungszeichen im Name
- **Komma**: Fügt Komma hinzu wenn nicht erstes Element
- **Rückgabe**: JSON-String

#### 17. `find_device_in_usb_interfaces(usb_device_path, device_name, device_pattern)`
- **Input**: USB-Device-Pfad, Device-Name, Device-Pattern
- **Output**: `FOUND` Variable (0 oder 1)
- **Funktion**: Sucht Device in Base-Pfad und allen Interface-Pfaden
- **Methode**:
  1. Prüft Base-Pfad: `$USB_DEVICE_PATH/*/pattern*` und `$USB_DEVICE_PATH/pattern*`
  2. Prüft Interface-Pfade: `$USB_DEVICE_PATH:*/*/pattern*` und `$USB_DEVICE_PATH:*/pattern*`
  3. Vergleicht gefundenen Device-Namen mit gesuchtem Namen
- **Rückgabe**: Exit-Code 0 wenn gefunden, 1 wenn nicht gefunden

## Device-spezifische Scripts

### `map-serial-device.sh` (TTY/Serial)

#### Spezifische Funktionen

##### `find_tty_device(bus, device)`
- **Input**: Bus-Nummer, Device-Nummer
- **Suche**:**
  1. `/sys/bus/usb/devices/X-Y/*/tty*`
  2. `/sys/bus/usb/devices/X-Y/tty*`
  3. `/sys/bus/usb/devices/X-Y:*/*/tty*`
  4. `/sys/bus/usb/devices/X-Y:*/tty*`
- **Output**: `/dev/ttyUSB0`, `/dev/ttyACM0`, etc.
- **Fehler**: Exit 1 wenn kein TTY-Device gefunden

#### Ablauf
1. Parse `usb_bus_device` Parameter
2. Finde TTY-Device in sysfs
3. Prüfe Container-Status
4. Entferne alte `dev0:` Einträge
5. Füge `dev0:` Mapping hinzu (mit cgroup allow)
6. Mappe USB-Bus-Device
7. Setze Permissions
8. Erstelle udev-Rule (`SUBSYSTEM=="tty"`)

#### Container-Device-Pfad
- **Standard**: `/dev/ttyUSB0` (automatisch basierend auf Host-Device)
- **Alternativ**: Parameter `container_device_path` für manuellen Pfad

---

### `map-input-device.sh` (Tastatur/Maus)

#### Spezifische Funktionen

##### `find_input_device(bus, device)`
- **Input**: Bus-Nummer, Device-Nummer
- **Suche**:
  1. `/sys/bus/usb/devices/X-Y/input/input*/event*`
  2. `/sys/class/input/event*` → Verknüpfung zu USB-Device prüfen
  3. `/sys/bus/usb/devices/X-Y:*/*/input/input*/event*`
- **Output**: Array von Devices (kann mehrere sein):
  - `/dev/input/event0`
  - `/dev/input/mouse0`
  - `/dev/input/kbd0`
- **Fehler**: Exit 1 wenn kein Input-Device gefunden

##### `get_input_device_type(device_path)`
- **Input**: Device-Pfad
- **Funktion**: Bestimmt Device-Typ aus sysfs
- **Output**: `keyboard`, `mouse`, `joystick`, `generic`
- **Methode**: Liest `/sys/class/input/eventX/device/name` und `/sys/class/input/eventX/device/uevent`

#### Ablauf
1. Parse `usb_bus_device` Parameter
2. Finde alle Input-Devices (kann mehrere sein)
3. Prüfe Container-Status
4. Für jedes Device:
   - Finde nächsten freien `devX:` Index
   - Entferne alte Einträge für diesen Index
   - Füge `devX:` Mapping hinzu
5. Mappe USB-Bus-Device (einmalig)
6. Setze Permissions für alle Devices
7. Erstelle udev-Rule (`SUBSYSTEM=="input"`)

#### Container-Device-Pfad
- **Standard**: Automatische Nummerierung (`/dev/input/event0`, `/dev/input/event1`, etc.)
- **Parameter**: `container_device_paths` (komma-separiert) für manuelle Pfade

#### Besonderheiten
- **Mehrere Devices**: Ein USB-Gerät kann mehrere Input-Devices erzeugen (z.B. Tastatur mit integriertem Touchpad)
- **Device-Namen**: Können `event*`, `mouse*`, `kbd*` sein
- **Permissions**: Meist `0666` (read/write für alle) statt `0664`

---

### `map-audio-device.sh` (Audio)

#### Spezifische Funktionen

##### `find_audio_device(bus, device)`
- **Input**: Bus-Nummer, Device-Nummer
- **Suche**:
  1. `/sys/bus/usb/devices/X-Y/sound/card*`
  2. `/sys/class/sound/card*` → Verknüpfung zu USB-Device prüfen
  3. `/sys/bus/usb/devices/X-Y:*/*/sound/card*`
- **Output**: Array von Audio-Devices:
  - `/dev/snd/controlC0`
  - `/dev/snd/pcmC0D0p` (Playback)
  - `/dev/snd/pcmC0D0c` (Capture)
  - `/dev/snd/timer`
- **Fehler**: Exit 1 wenn kein Audio-Device gefunden

##### `get_audio_card_number(device_path)`
- **Input**: Device-Pfad (z.B. `/dev/snd/controlC0`)
- **Funktion**: Extrahiert Card-Nummer (z.B. `0` aus `controlC0`)
- **Output**: Card-Nummer als String

#### Ablauf
1. Parse `usb_bus_device` Parameter
2. Finde Audio-Card-Nummer
3. Finde alle Audio-Devices für diese Card:
   - `controlC*` (Control-Interface)
   - `pcmC*D*p` (Playback)
   - `pcmC*D*c` (Capture)
   - `timer` (Timer)
4. Prüfe Container-Status
5. Für jedes Device:
   - Finde nächsten freien `devX:` Index
   - Entferne alte Einträge
   - Füge `devX:` Mapping hinzu
6. Mappe USB-Bus-Device (einmalig)
7. Setze Permissions für alle Devices
8. Erstelle udev-Rule (`SUBSYSTEM=="sound"`)

#### Container-Device-Pfad
- **Standard**: Automatische Pfade basierend auf Card-Nummer
- **Parameter**: `container_device_paths` (komma-separiert) für manuelle Pfade

#### Besonderheiten
- **Mehrere Devices**: Eine Audio-Card erzeugt mehrere Device-Dateien
- **Card-Nummer**: Wird aus Host-Device extrahiert
- **Permissions**: Meist `0666` für Audio-Devices
- **ALSA**: Container benötigt ALSA-Libraries für Audio-Funktionalität

---

## Template-Struktur

### Gemeinsame Parameter (alle Templates)

```json
{
  "id": "usb_bus_device",
  "type": "string",
  "required": true,
  "description": "USB bus and device number in format bus:device"
},
{
  "id": "vm_id",
  "type": "string",
  "required": true
},
{
  "id": "uid",
  "type": "string",
  "required": false,
  "advanced": true
},
{
  "id": "gid",
  "type": "string",
  "required": false,
  "advanced": true
}
```

### Device-spezifische Parameter

#### Serial (110-map-serial.json)
```json
{
  "id": "container_device_path",
  "type": "string",
  "required": false,
  "description": "Optional: Container device path (default: auto-detect from host device)"
}
```

#### Input (111-map-input.json)
```json
{
  "id": "container_device_paths",
  "type": "string",
  "required": false,
  "description": "Optional: Comma-separated container device paths (default: auto-detect)"
}
```

#### Audio (112-map-audio.json)
```json
{
  "id": "container_device_paths",
  "type": "string",
  "required": false,
  "description": "Optional: Comma-separated container device paths (default: auto-detect based on card number)"
}
```

## Listing-Scripts

Die Listing-Scripts durchsuchen alle verfügbaren USB-Geräte eines bestimmten Typs und geben sie als JSON-Array zurück. Sie verwenden die gemeinsamen Library-Funktionen für USB-Device-Erkennung und Bus/Device-Extraktion.

### `list-host-usb-serial-ports.sh`

#### Komponenten

##### 1. **Device-Enumeration**
- **Quelle**: `/dev/serial/by-id/*` (stabile Symlinks)
- **Vorteil**: Symlinks bleiben stabil auch nach Re-Plug
- **Iteration**: Durchläuft alle Symlinks in `/dev/serial/by-id/`

##### 2. **Symlink-Auflösung**
- **Funktion**: `resolve_symlink()` (Library)
- **Input**: `/dev/serial/by-id/usb-1a86_USB_Serial-if00-port0`
- **Output**: `/dev/ttyUSB0` (tatsächliches Device)
- **Device-Name**: Extrahiert `ttyUSB0` aus aufgelöstem Pfad

##### 3. **Vendor/Product-ID-Extraktion**
- **Funktion**: `find_vendor_product_from_class_device()` (Library)
- **Pfad**: `/sys/class/tty/ttyUSB0/device`
- **Methode**: 
  1. Liest Symlink `/sys/class/tty/$DEVICE_NAME/device`
  2. Navigiert bis zu 10 Ebenen nach oben
  3. Sucht nach `idVendor` und `idProduct` Dateien
- **Output**: `VENDOR_ID`, `PRODUCT_ID` (z.B. `1a86`, `7523`)

##### 4. **USB-Device-Zuordnung**
- **Funktion**: `find_usb_device_by_vendor_product()` (Library)
- **Methode**:
  1. Durchsucht `/sys/bus/usb/devices/*`
  2. Vergleicht `idVendor` und `idProduct` mit gefundenen Werten
  3. Prüft ob TTY-Device in diesem USB-Device existiert:
     - Base-Pfad: `$USB_DEVICE_PATH/*/tty*` und `$USB_DEVICE_PATH/tty*`
     - Interface-Pfade: `$USB_DEVICE_PATH:*/*/tty*` und `$USB_DEVICE_PATH:*/tty*`
  4. Extrahiert Bus/Device aus Pfadnamen

##### 5. **Bus/Device-Extraktion**
- **Funktion**: `extract_bus_device_from_sysfs_path()` (Library)
- **Input**: `1-3`, `1-3:1.0`, `1-3.4:1.0`
- **Regex**:
  - Bus: `^([0-9]+)-` → `1`
  - Device: `^[0-9]+-([0-9]+)[.:]` oder `^[0-9]+-([0-9]+)$` → `3`
- **Normalisierung**: Entfernt führende Nullen, konvertiert zu Integer
- **Validierung**: Prüft auf numerische Werte (keine Dezimalzahlen, keine Buchstaben)

##### 6. **lsusb-Beschreibung**
- **Funktion**: `get_lsusb_description()` (Library)
- **Methode**:
  1. Formatiert Bus/Device: `printf "%03d"` → `001`, `003`
  2. Grept `lsusb` Output: `Bus 001 Device 003: ID 1a86:7523 ...`
  3. Extrahiert Beschreibung: `ID 1a86:7523 QinHeng Electronics CH340 serial converter`
- **Fallback**: 
  - Wenn Bus/Device nicht gefunden: `lsusb -d "1a86:7523"`
  - Wenn lsusb fehlschlägt: `ID ${VENDOR_ID}:${PRODUCT_ID}`
  - Letzter Fallback: Basename des Symlinks

##### 7. **JSON-Formatierung**
- **Funktion**: `format_json_device_entry()` (Library)
- **Format**: `{"name":"...","value":"bus:device"}`
- **Escape**: Escaped Anführungszeichen im Name
- **Komma-Handling**: Fügt Komma zwischen Einträgen hinzu
- **Output**: `[{"name":"...","value":"1:3"},{"name":"...","value":"1:5"}]`

#### Ablauf
1. Prüfe Verfügbarkeit von `lsusb` und `/dev/serial/by-id/`
2. Iteriere über alle `/dev/serial/by-id/*` Symlinks
3. Für jeden Symlink:
   - Löse Symlink auf → `ACTUAL_DEVICE`
   - Extrahiere Device-Name → `DEVICE_NAME`
   - Finde Vendor/Product-ID via `/sys/class/tty/`
   - Finde USB-Device durch Vendor/Product-Matching
   - Extrahiere Bus/Device aus Sysfs-Pfad
   - Hole lsusb-Beschreibung
   - Formatiere JSON-Eintrag
4. Gib JSON-Array aus

#### Besonderheiten
- **Stabile Pfade**: Verwendet `/dev/serial/by-id/` statt `/dev/ttyUSB*`
- **Robuste Extraktion**: Mehrere Fallback-Methoden für Vendor/Product-ID
- **Interface-Handling**: Prüft Base-Pfad und alle Interface-Pfade
- **Fehlerbehandlung**: Überspringt fehlerhafte Devices, gibt leeres Array zurück wenn keine Devices gefunden

---

### `list-host-usb-input-devices.sh` (neu)

#### Unterschiede zu Serial-Listing

##### 1. **Device-Enumeration**
- **Quelle**: `/sys/class/input/event*` (direkt aus sysfs)
- **Alternativ**: `/dev/input/event*` (wenn verfügbar)
- **Iteration**: Durchläuft alle Input-Devices

##### 2. **Vendor/Product-ID-Extraktion**
- **Pfad**: `/sys/class/input/event0/device/...`
- **Methode**: Gleiche wie Serial, aber über `/sys/class/input/`
- **Navigation**: Navigiert von `/sys/class/input/eventX/device` nach oben

##### 3. **USB-Device-Zuordnung**
- **Device-Pattern**: `input/input*/event*` statt `tty*`
- **Suche**: 
  - Base-Pfad: `$USB_DEVICE_PATH/input/input*/event*`
  - Interface-Pfade: `$USB_DEVICE_PATH:*/input/input*/event*`

##### 4. **Device-Typ-Erkennung**
- **Zusätzlich**: Liest `/sys/class/input/eventX/device/name`
- **Typen**: `keyboard`, `mouse`, `joystick`, `generic`
- **Name**: Kann Device-Typ in Beschreibung einbeziehen

#### Ablauf
1. Prüfe Verfügbarkeit von `/sys/class/input/`
2. Iteriere über alle `/sys/class/input/event*`
3. Für jedes Input-Device:
   - Finde Vendor/Product-ID via `/sys/class/input/eventX/device/`
   - Finde USB-Device durch Vendor/Product-Matching
   - Extrahiere Bus/Device
   - Bestimme Device-Typ (optional)
   - Hole lsusb-Beschreibung
   - Formatiere JSON-Eintrag (mit Device-Typ im Name)
4. Gib JSON-Array aus

#### Besonderheiten
- **Mehrere Devices**: Ein USB-Gerät kann mehrere Input-Devices erzeugen
- **Device-Typ**: Kann in Name eingebunden werden (z.B. "Logitech USB Keyboard (keyboard)")
- **Deduplizierung**: Optional: Gruppiere mehrere Input-Devices desselben USB-Geräts

---

### `list-host-usb-audio-devices.sh` (neu)

#### Unterschiede zu Serial-Listing

##### 1. **Device-Enumeration**
- **Quelle**: `/sys/class/sound/card*` (Audio-Cards)
- **Iteration**: Durchläuft alle Audio-Cards

##### 2. **Vendor/Product-ID-Extraktion**
- **Pfad**: `/sys/class/sound/card0/device/...`
- **Methode**: Navigiert von `/sys/class/sound/cardX/device` nach oben
- **Navigation**: Gleiche wie Serial/Input

##### 3. **USB-Device-Zuordnung**
- **Device-Pattern**: `sound/card*` statt `tty*`
- **Suche**: 
  - Base-Pfad: `$USB_DEVICE_PATH/sound/card*`
  - Interface-Pfade: `$USB_DEVICE_PATH:*/sound/card*`

##### 4. **Card-Nummer-Extraktion**
- **Zusätzlich**: Extrahiert Card-Nummer aus Pfad (z.B. `card0` → `0`)
- **Name**: Kann Card-Nummer in Beschreibung einbeziehen

#### Ablauf
1. Prüfe Verfügbarkeit von `/sys/class/sound/`
2. Iteriere über alle `/sys/class/sound/card*`
3. Für jede Audio-Card:
   - Finde Vendor/Product-ID via `/sys/class/sound/cardX/device/`
   - Finde USB-Device durch Vendor/Product-Matching
   - Extrahiere Bus/Device
   - Extrahiere Card-Nummer
   - Hole lsusb-Beschreibung
   - Formatiere JSON-Eintrag (mit Card-Nummer im Name)
4. Gib JSON-Array aus

#### Besonderheiten
- **Eine Card pro USB**: Eine USB-Audio-Card erzeugt eine Card-Nummer
- **Card-Nummer**: Wird in Name eingebunden (z.B. "USB Audio Device (card0)")
- **Deduplizierung**: Nicht nötig, da eine Card = ein USB-Device

---

## Gemeinsame Listing-Patterns

### Wiederverwendbare Komponenten

Alle Listing-Scripts folgen demselben Muster:

1. **Device-Enumeration**: Durchsuche `/sys/class/*/` oder `/dev/*/`
2. **Vendor/Product-ID**: Nutze `find_vendor_product_from_class_device()`
3. **USB-Device-Zuordnung**: Nutze `find_usb_device_by_vendor_product()`
4. **Bus/Device-Extraktion**: Nutze `extract_bus_device_from_sysfs_path()`
5. **lsusb-Beschreibung**: Nutze `get_lsusb_description()`
6. **JSON-Formatierung**: Nutze `format_json_device_entry()`

### Unterschiede zwischen Device-Typen

| Aspekt | Serial | Input | Audio |
|--------|--------|-------|-------|
| **Enumeration-Quelle** | `/dev/serial/by-id/*` | `/sys/class/input/event*` | `/sys/class/sound/card*` |
| **Device-Pattern** | `tty*` | `input/input*/event*` | `sound/card*` |
| **Zusätzliche Info** | - | Device-Typ (keyboard/mouse) | Card-Nummer |
| **Deduplizierung** | Nicht nötig | Optional (mehrere Devices) | Nicht nötig |

## Unterschiede zwischen Device-Typen

| Aspekt | TTY/Serial | Input | Audio |
|--------|------------|-------|-------|
| **Subsystem** | `tty` | `input` | `sound` |
| **Device-Pfad** | `/dev/ttyUSB*` | `/dev/input/event*` | `/dev/snd/*` |
| **Anzahl Devices** | 1 pro USB-Device | 1-n pro USB-Device | 4+ pro USB-Device |
| **Permissions** | `0664` | `0666` | `0666` |
| **Container-Pfad** | Auto (basierend auf Host) | Auto (event0, event1, ...) | Auto (basierend auf Card) |
| **Sysfs-Suche** | `*/tty*` | `*/input/input*/event*` | `*/sound/card*` |
| **udev-Subsystem** | `tty` | `input` | `sound` |
| **devX Index** | `dev0:` (fest) | `dev0:`, `dev1:`, ... (dynamisch) | `dev0:`, `dev1:`, ... (dynamisch) |

## Implementierungsreihenfolge

1. **Phase 1**: Gemeinsame Library erstellen
   - `usb-device-common.sh` mit allen gemeinsamen Funktionen
   - Tests mit bestehendem `map-serial-device.sh`

2. **Phase 2**: Serial-Device refactoren
   - `map-serial-device.sh` auf Library umstellen
   - Bestehende Funktionalität beibehalten

3. **Phase 3**: Input-Device implementieren
   - `map-input-device.sh` erstellen
   - `list-host-usb-input-devices.sh` erstellen
   - `111-map-input.json` Template erstellen

4. **Phase 4**: Audio-Device implementieren
   - `map-audio-device.sh` erstellen
   - `list-host-usb-audio-devices.sh` erstellen
   - `112-map-audio.json` Template erstellen

## Code-Beispiel: Verwendung der Library

### Mapping-Script Beispiel

```sh
#!/bin/sh
# map-input-device.sh
exec >&2

# Source common library
. "$(dirname "$0")/usb-device-common.sh"

# Parse USB bus:device
parse_usb_bus_device "{{ usb_bus_device }}" || exit 1

# Get USB bus path
USB_BUS_PATH=$(get_usb_bus_path "$USB_BUS" "$USB_DEVICE")

# Find input devices
INPUT_DEVICES=$(find_input_device "$USB_BUS" "$USB_DEVICE")
[ -z "$INPUT_DEVICES" ] && { echo "Error: No input device found"; exit 1; }

# Check container stopped
check_container_stopped "{{ vm_id }}" || exit 1

CONFIG_FILE="/etc/pve/lxc/{{ vm_id }}.conf"
CONTAINER_UID="${UID_VALUE:-1000}"
CONTAINER_GID="${GID_VALUE:-1000}"

# Map each input device
for DEVICE in $INPUT_DEVICES; do
  DEV_INDEX=$(get_next_dev_index "$CONFIG_FILE")
  add_cgroup_allow "$CONFIG_FILE" "$DEVICE"
  echo "$DEV_INDEX: $DEVICE,uid=$CONTAINER_UID,gid=$CONTAINER_GID,mode=0666" >> "$CONFIG_FILE"
done

# Map USB bus device (once)
map_usb_bus_device "$CONFIG_FILE" "$USB_BUS_PATH" "$CONTAINER_UID" "$CONTAINER_GID"

# Set permissions
for DEVICE in $INPUT_DEVICES; do
  set_device_permissions "$DEVICE" "$CONTAINER_UID" "$CONTAINER_GID" "0666"
done

# Create udev rule
SYSFS_PATH=$(find_usb_sysfs_path "$USB_BUS" "$USB_DEVICE")
get_vendor_product_id "$SYSFS_PATH"
MAPPED_UID=$((CONTAINER_UID + 100000))
MAPPED_GID=$((CONTAINER_GID + 100000))
RULE_FILE="/etc/udev/rules.d/99-lxc-input-{{ vm_id }}-${VENDOR_ID}-${PRODUCT_ID}.rules"
create_udev_rule "$RULE_FILE" "$VENDOR_ID" "$PRODUCT_ID" "input" "$MAPPED_UID" "$MAPPED_GID" "0666"

exit 0
```

### Listing-Script Beispiel

```sh
#!/bin/sh
# list-host-usb-input-devices.sh
# List all USB input devices on the VE host
# Outputs JSON array: [{"name":"...","value":"bus:device"}, ...]

set -e

# Source common library
. "$(dirname "$0")/usb-device-common.sh"

# Check prerequisites
if [ ! -d "/sys/class/input" ]; then
  echo "Error: /sys/class/input directory not found." >&2
  exit 1
fi

FIRST=true
printf '['

# Process all input devices
for INPUT_DEVICE in /sys/class/input/event*; do
  [ ! -e "$INPUT_DEVICE" ] && continue
  
  DEVICE_NAME=$(basename "$INPUT_DEVICE")
  
  # Find vendor/product ID from class device
  find_vendor_product_from_class_device "/sys/class/input" "$DEVICE_NAME" || continue
  
  # Find USB device by vendor/product ID
  find_usb_device_by_vendor_product "$VENDOR_ID" "$PRODUCT_ID" "$DEVICE_NAME" "input/input*/event*" || continue
  
  # Get lsusb description
  USB_INFO=$(get_lsusb_description "$USB_BUS" "$USB_DEVICE")
  
  # Create name (with device type if available)
  if [ -n "$USB_INFO" ]; then
    NAME_TEXT="$USB_INFO"
  else
    NAME_TEXT="ID ${VENDOR_ID}:${PRODUCT_ID}"
  fi
  
  # Format and output JSON entry
  format_json_device_entry "$NAME_TEXT" "${USB_BUS}:${USB_DEVICE}" "$FIRST"
  FIRST=false
done

printf ']'
exit 0
```

## Integration der Listing-Komponenten in die Library

Die Funktionen aus `list-host-usb-serial-ports.sh` werden in die gemeinsame Library integriert, damit sie von allen Listing-Scripts (Serial, Input, Audio) wiederverwendet werden können.

### Vorteile der Integration

1. **Code-Wiederverwendung**: Gleiche Logik für alle Device-Typen
2. **Konsistenz**: Einheitliche Fehlerbehandlung und Validierung
3. **Wartbarkeit**: Änderungen an einer Stelle wirken sich auf alle aus
4. **Testbarkeit**: Funktionen können isoliert getestet werden

### Migration von `list-host-usb-serial-ports.sh`

Die folgenden Code-Blöcke aus dem bestehenden Script werden zu Library-Funktionen:

#### Vorher (im Script):
```sh
# Symlink-Auflösung
ACTUAL_DEVICE=$(readlink -f "$SERIAL_LINK" 2>/dev/null || echo "")

# Vendor/Product-ID-Extraktion
CURRENT_DIR="$DEVICE_LINK"
while [ $LEVEL -lt $MAX_LEVELS ]; do
  if [ -f "$CURRENT_DIR/idVendor" ] && [ -f "$CURRENT_DIR/idProduct" ]; then
    VENDOR_ID=$(cat "$CURRENT_DIR/idVendor" 2>/dev/null | tr -d '\n\r' || echo "")
    PRODUCT_ID=$(cat "$CURRENT_DIR/idProduct" 2>/dev/null | tr -d '\n\r' || echo "")
    break
  fi
  # ... navigation logic ...
done

# USB-Device-Zuordnung
for USB_DEVICE_PATH in /sys/bus/usb/devices/*; do
  # ... matching logic ...
done

# Bus/Device-Extraktion
USB_BUS=$(echo "$DEVICE_BASENAME" | sed -n 's/^\([0-9]*\)-.*/\1/p' | sed 's/^0*//' || echo "")
USB_DEVICE=$(echo "$DEVICE_BASENAME" | sed -n 's/^[0-9]*-\([0-9]*\)[.:].*/\1/p' | sed 's/^0*//' || echo "")

# lsusb-Beschreibung
BUS_FORMATTED=$(printf "%03d" "$USB_BUS" 2>/dev/null || echo "")
LSUSB_LINE=$(lsusb | grep "^Bus $BUS_FORMATTED Device $DEV_FORMATTED:" || echo "")
USB_INFO=$(echo "$LSUSB_LINE" | sed 's/^Bus [0-9]* Device [0-9]*: ID //' || echo "")
```

#### Nachher (Library-Funktionen):
```sh
# Symlink-Auflösung
ACTUAL_DEVICE=$(resolve_symlink "$SERIAL_LINK")

# Vendor/Product-ID-Extraktion
find_vendor_product_from_class_device "/sys/class/tty" "$DEVICE_NAME" || continue

# USB-Device-Zuordnung
find_usb_device_by_vendor_product "$VENDOR_ID" "$PRODUCT_ID" "$DEVICE_NAME" "tty*" || continue

# Bus/Device-Extraktion (automatisch in find_usb_device_by_vendor_product)

# lsusb-Beschreibung
USB_INFO=$(get_lsusb_description "$USB_BUS" "$USB_DEVICE")
```

### Anpassungen für verschiedene Device-Typen

Die Library-Funktionen sind generisch und akzeptieren Parameter für verschiedene Device-Typen:

```sh
# Serial: Device-Pattern "tty*"
find_usb_device_by_vendor_product "$VENDOR_ID" "$PRODUCT_ID" "$DEVICE_NAME" "tty*"

# Input: Device-Pattern "input/input*/event*"
find_usb_device_by_vendor_product "$VENDOR_ID" "$PRODUCT_ID" "$DEVICE_NAME" "input/input*/event*"

# Audio: Device-Pattern "sound/card*"
find_usb_device_by_vendor_product "$VENDOR_ID" "$PRODUCT_ID" "$DEVICE_NAME" "sound/card*"
```

## Fehlerbehandlung

- **Gemeinsam**: Alle Funktionen geben Exit-Codes zurück (0=Erfolg, 1=Fehler)
- **Validierung**: Jede Funktion validiert ihre Inputs
- **Debug-Output**: Alle Debug-Meldungen gehen nach stderr
- **Idempotenz**: Scripts können mehrfach ausgeführt werden ohne Fehler
- **Robustheit**: Listing-Scripts überspringen fehlerhafte Devices und geben leeres Array zurück wenn keine Devices gefunden

## Testing

- **Unit-Tests**: Für jede Library-Funktion
- **Integration-Tests**: Für jedes Device-spezifische Script
- **End-to-End**: Vollständiger Ablauf mit echten USB-Geräten

---

## Library-Integration: Lösungsvorschläge

### Problemstellung

Aktuell werden Scripts über stdin an SSH gepiped (`spawnAsync` mit `input`). Libraries können nicht einfach per `source` eingebunden werden, da:
1. Scripts als einzelne Dateien übertragen werden
2. Kein gemeinsames Dateisystem zwischen Backend und VE-Host
3. Libraries müssen vor dem Script verfügbar sein

### Option 1: Library-Übertragung vor Script-Ausführung

#### Konzept

Die Library wird als separater Schritt vor dem eigentlichen Script übertragen und auf dem VE-Host in einem temporären Verzeichnis gespeichert.

#### Implementierung

##### A) Library als separater Command

**Template-Struktur:**
```json
{
  "execute_on": "ve",
  "name": "Setup USB Device Library",
  "description": "Uploads USB device library to VE host",
  "skip_if_all_missing": ["usb_library_version"],
  "parameters": [
    {
      "id": "usb_library_version",
      "type": "string",
      "required": false,
      "default": "latest"
    }
  ],
  "commands": [
    {
      "name": "Setup Library",
      "script": "setup-usb-device-library.sh"
    }
  ]
}
```

**Script `setup-usb-device-library.sh`:**
```sh
#!/bin/sh
# Setup USB device library on VE host
exec >&2

LIBRARY_VERSION="{{ usb_library_version }}"
LIBRARY_DIR="/tmp/proxvex-libs"
LIBRARY_FILE="$LIBRARY_DIR/usb-device-common.sh"

# Create library directory
mkdir -p "$LIBRARY_DIR"

# Library content wird hier eingefügt (via heredoc oder cat)
cat > "$LIBRARY_FILE" << 'LIBRARY_EOF'
# USB Device Common Library
# ... Library-Funktionen hier ...
LIBRARY_EOF

# Set permissions
chmod 755 "$LIBRARY_FILE"

echo "Library installed to $LIBRARY_FILE" >&2
```

**Verwendung in Scripts:**
```sh
#!/bin/sh
# map-serial-device.sh
exec >&2

# Source library from known location
. /tmp/proxvex-libs/usb-device-common.sh

# Use library functions
parse_usb_bus_device "{{ usb_bus_device }}" || exit 1
# ...
```

##### B) Library als Base64-encoded String

**Vorteil**: Library wird direkt im Script eingebettet, kein separater Upload-Schritt.

**Script `map-serial-device.sh`:**
```sh
#!/bin/sh
# map-serial-device.sh
exec >&2

# Extract and source library
LIBRARY_DIR="/tmp/proxvex-libs"
mkdir -p "$LIBRARY_DIR"
echo "{{ usb_library_base64 }}" | base64 -d > "$LIBRARY_DIR/usb-device-common.sh"
chmod 755 "$LIBRARY_DIR/usb-device-common.sh"
. "$LIBRARY_DIR/usb-device-common.sh"

# Use library functions
parse_usb_bus_device "{{ usb_bus_device }}" || exit 1
# ...
```

**Backend-Änderungen:**
- `TemplateProcessor`: Liest Library-Datei und encodiert sie als Base64
- `VariableResolver`: Fügt `{{ usb_library_base64 }}` als Variable hinzu
- Library wird automatisch in alle Scripts injiziert, die sie benötigen

##### C) Library via SSH-SCP vor Script

**Backend-Änderungen:**
- Neue Methode `uploadLibrary()` in `VeExecutionSshExecutor`
- Library wird per SCP auf VE-Host hochgeladen
- Scripts können Library danach sourcen

**Vorteil**: Library wird nur einmal übertragen, nicht bei jedem Script

**Nachteil**: Erfordert SCP-Zugriff, zusätzliche Abhängigkeit

#### Vor- und Nachteile Option 1

**Vorteile:**
- ✅ Keine externe Abhängigkeit (GitHub)
- ✅ Funktioniert offline
- ✅ Versionierung über Template-Parameter möglich
- ✅ Library kann pro Execution aktualisiert werden

**Nachteile:**
- ❌ Library wird bei jeder Execution übertragen (Overhead)
- ❌ Temporäres Verzeichnis auf VE-Host nötig
- ❌ Cleanup nötig (oder `/tmp` wird automatisch bereinigt)
- ❌ Bei Option A: Zusätzlicher Template-Schritt nötig
- ❌ Bei Option B: Base64-Encoding erhöht Script-Größe

---

### Option 2: Library von GitHub downloaden

#### Konzept

Die Library wird von einem GitHub-Repository beim ersten Bedarf heruntergeladen und auf dem VE-Host gecacht.

#### Implementierung

##### A) Download-on-Demand im Script

**Script `map-serial-device.sh`:**
```sh
#!/bin/sh
# map-serial-device.sh
exec >&2

# Download and source library if not exists
LIBRARY_DIR="/tmp/proxvex-libs"
LIBRARY_FILE="$LIBRARY_DIR/usb-device-common.sh"
LIBRARY_VERSION="{{ usb_library_version }}"
LIBRARY_URL="https://raw.githubusercontent.com/owner/repo/${LIBRARY_VERSION}/usb-device-common.sh"

if [ ! -f "$LIBRARY_FILE" ] || [ "$(cat "$LIBRARY_FILE.version" 2>/dev/null)" != "$LIBRARY_VERSION" ]; then
  mkdir -p "$LIBRARY_DIR"
  if command -v wget >/dev/null 2>&1; then
    wget -q -O "$LIBRARY_FILE" "$LIBRARY_URL" || {
      echo "Error: Failed to download library from $LIBRARY_URL" >&2
      exit 1
    }
  elif command -v curl >/dev/null 2>&1; then
    curl -s -o "$LIBRARY_FILE" "$LIBRARY_URL" || {
      echo "Error: Failed to download library from $LIBRARY_URL" >&2
      exit 1
    }
  else
    echo "Error: Neither wget nor curl available for library download" >&2
    exit 1
  fi
  echo "$LIBRARY_VERSION" > "$LIBRARY_FILE.version"
  chmod 755 "$LIBRARY_FILE"
fi

. "$LIBRARY_FILE"

# Use library functions
parse_usb_bus_device "{{ usb_bus_device }}" || exit 1
# ...
```

##### B) Download als separater Template-Schritt

**Template `000-setup-usb-library.json`:**
```json
{
  "execute_on": "ve",
  "name": "Download USB Device Library",
  "description": "Downloads USB device library from GitHub",
  "skip_if_all_missing": ["usb_library_version"],
  "parameters": [
    {
      "id": "usb_library_version",
      "type": "string",
      "required": false,
      "default": "main"
    }
  ],
  "commands": [
    {
      "name": "Download Library",
      "script": "download-usb-device-library.sh"
    }
  ]
}
```

**Script `download-usb-device-library.sh`:**
```sh
#!/bin/sh
# Download USB device library from GitHub
exec >&2

LIBRARY_VERSION="{{ usb_library_version }}"
LIBRARY_DIR="/tmp/proxvex-libs"
LIBRARY_FILE="$LIBRARY_DIR/usb-device-common.sh"
LIBRARY_URL="https://raw.githubusercontent.com/owner/repo/${LIBRARY_VERSION}/usb-device-common.sh"

mkdir -p "$LIBRARY_DIR"

if command -v wget >/dev/null 2>&1; then
  wget -q -O "$LIBRARY_FILE" "$LIBRARY_URL" || exit 1
elif command -v curl >/dev/null 2>&1; then
  curl -s -o "$LIBRARY_FILE" "$LIBRARY_URL" || exit 1
else
  echo "Error: Neither wget nor curl available" >&2
  exit 1
fi

echo "$LIBRARY_VERSION" > "$LIBRARY_FILE.version"
chmod 755 "$LIBRARY_FILE"
echo "Library downloaded to $LIBRARY_FILE" >&2
```

#### Vor- und Nachteile Option 2

**Vorteile:**
- ✅ Library wird nur einmal heruntergeladen (Caching)
- ✅ Zentrale Wartung (ein Repository)
- ✅ Versionierung über Git-Tags/Branches
- ✅ Keine Backend-Änderungen nötig (bei Option A)
- ✅ Library-Updates ohne Backend-Deployment

**Nachteile:**
- ❌ Erfordert Internet-Zugriff auf VE-Host
- ❌ GitHub als Single Point of Failure
- ❌ Rate-Limiting bei vielen Downloads
- ❌ Sicherheit: Code von externer Quelle
- ❌ Bei Option A: Download-Logik in jedem Script

---

### Empfohlene Lösung: Hybrid-Ansatz

#### Konzept

Kombination beider Optionen mit Fallback-Mechanismus:

1. **Primär**: Library von GitHub downloaden (Option 2B)
2. **Fallback**: Library als Base64-encoded String einbetten (Option 1B)

#### Implementierung

**Template `000-setup-usb-library.json`:**
```json
{
  "execute_on": "ve",
  "name": "Setup USB Device Library",
  "description": "Downloads or installs USB device library",
  "skip_if_all_missing": ["usb_library_version"],
  "parameters": [
    {
      "id": "usb_library_version",
      "type": "string",
      "required": false,
      "default": "main"
    },
    {
      "id": "usb_library_fallback",
      "type": "string",
      "required": false,
      "advanced": true,
      "description": "Base64-encoded library as fallback if download fails"
    }
  ],
  "commands": [
    {
      "name": "Setup Library",
      "script": "setup-usb-device-library.sh"
    }
  ]
}
```

**Script `setup-usb-device-library.sh`:**
```sh
#!/bin/sh
# Setup USB device library with download fallback
exec >&2

LIBRARY_VERSION="{{ usb_library_version }}"
LIBRARY_DIR="/tmp/proxvex-libs"
LIBRARY_FILE="$LIBRARY_DIR/usb-device-common.sh"
LIBRARY_URL="https://raw.githubusercontent.com/owner/repo/${LIBRARY_VERSION}/usb-device-common.sh"

mkdir -p "$LIBRARY_DIR"

# Try download first
DOWNLOAD_SUCCESS=0
if command -v wget >/dev/null 2>&1; then
  wget -q -O "$LIBRARY_FILE" "$LIBRARY_URL" 2>/dev/null && DOWNLOAD_SUCCESS=1
elif command -v curl >/dev/null 2>&1; then
  curl -s -o "$LIBRARY_FILE" "$LIBRARY_URL" 2>/dev/null && DOWNLOAD_SUCCESS=1
fi

# Fallback to embedded library if download failed
if [ $DOWNLOAD_SUCCESS -eq 0 ]; then
  if [ -n "{{ usb_library_fallback }}" ]; then
    echo "Download failed, using embedded library" >&2
    echo "{{ usb_library_fallback }}" | base64 -d > "$LIBRARY_FILE" 2>/dev/null || {
      echo "Error: Failed to extract embedded library" >&2
      exit 1
    }
  else
    echo "Error: Library download failed and no fallback provided" >&2
    exit 1
  fi
fi

echo "$LIBRARY_VERSION" > "$LIBRARY_FILE.version"
chmod 755 "$LIBRARY_FILE"
echo "Library installed to $LIBRARY_FILE" >&2
```

**Backend-Änderungen:**
- `TemplateProcessor`: Liest Library-Datei und encodiert als Base64
- Fügt `{{ usb_library_fallback }}` automatisch hinzu wenn Library-Datei existiert
- Optional: Library-Version aus Git-Tag extrahieren

#### Vorteile Hybrid-Ansatz

- ✅ **Offline-Fähigkeit**: Funktioniert auch ohne Internet (Fallback)
- ✅ **Performance**: Download nur bei Bedarf, Caching auf VE-Host
- ✅ **Wartbarkeit**: Zentrale Library auf GitHub, aber nicht abhängig davon
- ✅ **Sicherheit**: Fallback-Library wird vom Backend kontrolliert
- ✅ **Flexibilität**: Kann für verschiedene Umgebungen angepasst werden

#### Implementierungsreihenfolge

1. **Phase 1**: Option 1B (Base64-embedded) implementieren
   - Einfachste Lösung, funktioniert sofort
   - Keine externen Abhängigkeiten

2. **Phase 2**: GitHub-Download hinzufügen (Option 2B)
   - Reduziert Script-Größe
   - Ermöglicht zentrale Wartung

3. **Phase 3**: Hybrid-Ansatz
   - Kombiniert Vorteile beider Optionen
   - Robuste Lösung für Produktion

---

### Alternative: Library als Git Submodule

Falls die Library in einem separaten Repository verwaltet wird:

**Struktur:**
```
json/shared/
├── scripts/
│   ├── usb-device-common.sh  # Git Submodule
│   ├── map-serial-device.sh
│   └── ...
```

**Vorteile:**
- ✅ Library wird mit Codebase versioniert
- ✅ Keine Runtime-Downloads nötig
- ✅ Einfache Integration in bestehenden Workflow

**Nachteile:**
- ❌ Git Submodule Management-Overhead
- ❌ Library-Updates erfordern Backend-Deployment
- ❌ Scripts müssen trotzdem übertragen werden (wie aktuell)

**Empfehlung**: Nur wenn Library sehr stabil und selten geändert wird.

---

### Option 3: Library über stdin vor Script (Empfohlen)

#### Konzept

Die Library wird direkt über stdin vor dem Script gesendet. Beide werden in einem einzigen SSH-Befehl übertragen, ohne temporäre Dateien oder externe Abhängigkeiten.

#### Implementierung

##### A) Template-Schema-Erweiterung

**Schema `template.schema.json`:**
```json
{
  "type": "object",
  "properties": {
    "commands": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "name": { "type": "string" },
          "script": { "type": "string" },
          "command": { "type": "string" },
          "library": { "type": "string" },
          // ... weitere Properties
        }
      }
    }
  }
}
```

**Interface `ICommand` (TypeScript):**
```typescript
export interface ICommand {
  name: string;
  command?: string;
  script?: string;
  library?: string;  // Neues Feld: Pfad zur Library-Datei
  template?: string;
  properties?: IOutputObject | IOutputObject[];
  description?: string;
  execute_on?: string;
}
```

##### B) Template-Definition

**Template `110-map-serial.json`:**
```json
{
  "execute_on": "ve",
  "name": "Map Serial Device",
  "commands": [
    {
      "name": "Map Serial Device",
      "script": "map-serial-device.sh",
      "library": "usb-device-common.sh"
    }
  ]
}
```

##### C) Backend-Änderungen

**`VeExecutionCommandProcessor.loadCommandContent()`:**
```typescript
loadCommandContent(cmd: ICommand): string | null {
  if (cmd.script !== undefined) {
    const scriptContent = fs.readFileSync(cmd.script, "utf-8");
    
    // Wenn Library angegeben, lade und prepende
    if (cmd.library !== undefined) {
      const libraryPath = this.findInPathes(opts.scriptPathes, cmd.library);
      if (libraryPath) {
        const libraryContent = fs.readFileSync(libraryPath, "utf-8");
        // Library zuerst, dann Script
        return `${libraryContent}\n\n# --- Script starts here ---\n${scriptContent}`;
      }
    }
    
    return scriptContent;
  }
  // ... rest
}
```

**Alternativ: Separater Library-Block (sauberer):**
```typescript
loadCommandContent(cmd: ICommand): string | null {
  if (cmd.script !== undefined) {
    const scriptContent = fs.readFileSync(cmd.script, "utf-8");
    
    if (cmd.library !== undefined) {
      const libraryPath = this.findInPathes(opts.scriptPathes, cmd.library);
      if (libraryPath) {
        const libraryContent = fs.readFileSync(libraryPath, "utf-8");
        // Library in separatem Block, dann Script
        return `# Library: ${cmd.library}\n${libraryContent}\n\n# Script: ${cmd.script}\n${scriptContent}`;
      }
    }
    
    return scriptContent;
  }
  // ... rest
}
```

##### D) Script-Struktur

**Script `map-serial-device.sh`:**
```sh
#!/bin/sh
# map-serial-device.sh
# NOTE: Library wird automatisch vor diesem Script eingefügt
exec >&2

# Library-Funktionen sind bereits verfügbar
parse_usb_bus_device "{{ usb_bus_device }}" || exit 1

# Rest des Scripts...
```

**Library `usb-device-common.sh`:**
```sh
#!/bin/sh
# usb-device-common.sh
# USB Device Common Library
# Wird automatisch vor Scripts eingefügt, die "library": "usb-device-common.sh" angeben

# Funktionen (keine direkte Ausführung)
parse_usb_bus_device() {
  # ... Funktion-Implementierung
}

get_usb_bus_path() {
  # ... Funktion-Implementierung
}

# ... weitere Funktionen
```

**Wichtig**: Library enthält nur Funktions-Definitionen, keine direkte Ausführung (kein Code außerhalb von Funktionen).

##### E) Variable-Substitution

**Reihenfolge:**
1. Library wird geladen (ohne Variable-Substitution)
2. Script wird geladen
3. Variable-Substitution auf kombiniertem Content
4. Über stdin an SSH gesendet

**Grund**: Library-Funktionen sollten keine Template-Variablen enthalten, nur das Script.

#### Vor- und Nachteile Option 3

**Vorteile:**
- ✅ **Einfachheit**: Minimal-invasive Änderung am bestehenden System
- ✅ **Keine temporären Dateien**: Alles über stdin, kein `/tmp` nötig
- ✅ **Keine externen Abhängigkeiten**: Kein GitHub, kein wget/curl
- ✅ **Offline-Fähigkeit**: Funktioniert komplett offline
- ✅ **Performance**: Library wird nur einmal übertragen (pro Command)
- ✅ **Versionierung**: Library wird mit Codebase versioniert
- ✅ **Sicherheit**: Keine Code-Downloads von externen Quellen
- ✅ **Konsistenz**: Library und Script werden zusammen übertragen
- ✅ **Debugging**: Einfacher zu debuggen (alles in einem Stream)

**Nachteile:**
- ⚠️ **Script-Größe**: Kombiniertes Script ist größer (aber immer noch über stdin)
- ⚠️ **Library-Änderungen**: Erfordern Backend-Deployment (aber das ist auch bei anderen Optionen so, außer GitHub)
- ⚠️ **Variable-Substitution**: Library sollte keine Template-Variablen enthalten (Design-Constraint)

#### Vergleich mit anderen Optionen

| Aspekt | Option 3 | Option 1B | Option 2B | Hybrid |
|--------|----------|-----------|-----------|--------|
| **Komplexität** | ⭐ Niedrig | ⭐ Niedrig | ⭐⭐ Mittel | ⭐⭐⭐ Hoch |
| **Backend-Änderungen** | Minimal (Schema + Loader) | Minimal (Base64) | Keine | Mittel |
| **Temporäre Dateien** | ❌ Keine | ✅ Benötigt | ✅ Benötigt | ✅ Benötigt |
| **Externe Abhängigkeiten** | ❌ Keine | ❌ Keine | ✅ GitHub | ✅ GitHub |
| **Offline-Fähigkeit** | ✅ Ja | ✅ Ja | ❌ Nein | ✅ Ja (Fallback) |
| **Performance** | ✅ Gut | ⚠️ Script-Größe | ✅ Caching | ✅ Caching |
| **Wartbarkeit** | ✅ Gut | ⚠️ In Script | ✅ Sehr gut | ✅ Sehr gut |
| **Sicherheit** | ✅ Hoch | ✅ Hoch | ⚠️ Externe Quelle | ⚠️ Externe Quelle |

#### Implementierungsdetails

##### 1. Schema-Validierung

**`schemas/template.schema.json`:**
```json
{
  "definitions": {
    "command": {
      "type": "object",
      "properties": {
        "name": { "type": "string" },
        "script": { "type": "string" },
        "command": { "type": "string" },
        "library": {
          "type": "string",
          "description": "Optional: Path to library file (relative to scripts directory)"
        },
        // ... weitere Properties
      },
      "anyOf": [
        { "required": ["script"] },
        { "required": ["command"] },
        { "required": ["template"] }
      ]
    }
  }
}
```

##### 2. Script-Validator-Erweiterung

**`ScriptValidator.validateScript()`:**
```typescript
if (cmd.library !== undefined) {
  const libraryPath = this.findInPathes(scriptPathes, cmd.library);
  if (!libraryPath) {
    errors.push(new JsonError(
      `Library file not found: ${cmd.library} (for script: ${cmd.script})`
    ));
  }
}
```

##### 3. Library-Pfad-Auflösung

**`TemplateProcessor.findInPathes()`:**
- Sucht Library in denselben Pfaden wie Scripts
- `json/shared/scripts/` → `json/applications/*/scripts/` → `local/shared/scripts/`

##### 4. Variable-Substitution-Strategie

**Option A: Library ohne Substitution (Empfohlen)**
- Library wird geladen, aber nicht durch Variable-Resolver verarbeitet
- Nur Script wird durch Variable-Resolver verarbeitet
- **Vorteil**: Library bleibt unverändert, keine unerwarteten Substitutionen

**Option B: Beide mit Substitution**
- Library und Script werden zusammen durch Variable-Resolver verarbeitet
- **Nachteil**: Library könnte unerwartete Variablen enthalten

**Empfehlung**: Option A - Library sollte keine Template-Variablen enthalten.

#### Beispiel: Vollständiger Ablauf

**Template:**
```json
{
  "commands": [
    {
      "name": "Map Serial Device",
      "script": "map-serial-device.sh",
      "library": "usb-device-common.sh"
    }
  ]
}
```

**Backend-Verarbeitung:**
1. Liest `usb-device-common.sh` → Library-Content
2. Liest `map-serial-device.sh` → Script-Content
3. Kombiniert: `Library-Content + "\n\n" + Script-Content`
4. Variable-Substitution nur auf Script-Teil (oder gesamter Content)
5. Sendet über stdin an SSH

**Auf VE-Host:**
```sh
# Library-Funktionen (automatisch eingefügt)
parse_usb_bus_device() { ... }
get_usb_bus_path() { ... }
# ... weitere Funktionen

# Script (automatisch eingefügt)
#!/bin/sh
exec >&2
parse_usb_bus_device "1:3" || exit 1
# ... rest
```

#### Migration bestehender Scripts

**Vorher:**
```json
{
  "commands": [
    {
      "name": "Map Serial Device",
      "script": "map-serial-device.sh"
    }
  ]
}
```

**Nachher:**
```json
{
  "commands": [
    {
      "name": "Map Serial Device",
      "script": "map-serial-device.sh",
      "library": "usb-device-common.sh"
    }
  ]
}
```

**Rückwärtskompatibilität**: Wenn `library` nicht angegeben, verhält sich alles wie bisher.

---

### Zusammenfassung

| Lösung | Komplexität | Offline | Performance | Wartbarkeit | Temporäre Dateien | Externe Deps |
|--------|------------|---------|-------------|-------------|-------------------|--------------|
| **Option 1A** (Separater Command) | Mittel | ✅ | ⚠️ (jedes Mal) | ✅ | ❌ Benötigt | ✅ Keine |
| **Option 1B** (Base64-embedded) | Niedrig | ✅ | ⚠️ (große Scripts) | ⚠️ | ❌ Benötigt | ✅ Keine |
| **Option 1C** (SCP-Upload) | Hoch | ✅ | ✅ | ✅ | ❌ Benötigt | ✅ Keine |
| **Option 2A** (Download im Script) | Niedrig | ❌ | ✅ (Caching) | ✅ | ❌ Benötigt | ❌ Benötigt |
| **Option 2B** (Separater Download) | Mittel | ❌ | ✅ (Caching) | ✅ | ❌ Benötigt | ❌ Benötigt |
| **Hybrid** | Mittel | ✅ | ✅ | ✅ | ❌ Benötigt | ❌ Benötigt |
| **Git Submodule** | Niedrig | ✅ | ✅ | ⚠️ | ✅ Keine | ✅ Keine |
| **Option 3** (stdin Library) | ⭐ Niedrig | ✅ | ✅ | ✅ | ✅ Keine | ✅ Keine |

**Empfehlung**: **Option 3** ist die eleganteste Lösung:
- ✅ Minimal-invasive Änderungen
- ✅ Keine temporären Dateien
- ✅ Keine externen Abhängigkeiten
- ✅ Funktioniert komplett offline
- ✅ Einfach zu implementieren und zu warten
- ✅ Rückwärtskompatibel

**Alternative**: Option 3 als Basis, mit Option 2B als Erweiterung für zentrale Wartung (falls gewünscht).

