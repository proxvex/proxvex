# Video 1 — Einfache Installation mit HTTPS und OIDC

## Überblick

| Aspekt | Detail |
|--------|--------|
| Ziel | proxvex installieren, Apps deployen, OIDC einrichten |
| Ergebnis | Deployer + Mosquitto + Postgres + Zitadel laufen, OIDC aktiv für Deployer und Proxmox |
| Voraussetzungen | Proxmox-Host erreichbar, DNS/NAT auf Router vorbereitet |

## Screen-Layout (ab Schritt 3)

```
┌──────────────────────────────────────────────┬─────────────────┐
│                                              │                 │
│         proxvex Web UI              │                 │
│              (70% Breite)                    │    Ablauf-      │
│              (70% Höhe)                      │    Panel        │
│                                              │   (30% Breite)  │
├──────────────────────────────────────────────┤                 │
│                                              │                 │
│    Proxmox UI — Ausschnitt (30% Höhe)        │                 │
│    (zeigt Container-Liste / Status)          │                 │
│                                              │                 │
└──────────────────────────────────────────────┴─────────────────┘
```

Schritte 1 und 2 sind terminal-basiert — Layout wird beim Schneiden festgelegt.

---

## Schritt 1: proxvex installieren

**Ablauf-Panel:** `video1-ablauf-01-installer.html`
**Darstellung:** Terminal (Vollbild oder mit Ablauf-Panel rechts)

### Talking Points

> "Wir starten mit der einfachsten möglichen Installation. Ein einziger Befehl — ohne Flags, ohne Konfiguration."

### Befehl

```bash
# Auf dem Proxmox-Host (pve1.cluster):
curl -fsSL https://raw.githubusercontent.com/proxvex/proxvex/main/install-proxvex.sh | sh
```

### Was passiert (Voice-Over während Installation)

- "Das Script lädt ein OCI-Image von GitHub herunter"
- "Erstellt einen unprivilegierten Alpine-Linux-Container"
- "Richtet Volumes ein und startet den Deployer"

### Direkt weiter: Projekt-Defaults setzen

> "Bevor wir die UI öffnen, setze ich noch ein paar projektspezifische Defaults. Die gelten dann automatisch für alle zukünftigen Installationen. Details dazu im nächsten Video."

```bash
./production/project-v1.sh
```

> "Drei Defaults: VM-IDs ab 500, und schnelle Package-Mirrors."

---

## Schritt 2: Ergebnis zeigen + erste App installieren

**Ablauf-Panel:** `video1-ablauf-02-template.html` → `video1-ablauf-03-mosquitto.html`
**Darstellung:** Split-Screen (Web UI + Proxmox + Ablauf-Panel)
**Tempo:** Echtzeit — das ist die Haupt-Demo

### Ergebnis zeigen (Split-Screen)

> "Der Deployer läuft — auf HTTP, Port 3080. Kein HTTPS, kein Login. Das kommt gleich."

1. **UI öffnen:** `http://proxvex:3080`
2. **Proxmox zeigen:** Container mit 1xx VM-ID sichtbar
3. **Kurz durch die UI klicken** — App-Liste, Parameter-Ansicht

### Eclipse Mosquitto installieren

> "Jetzt installieren wir die erste Anwendung. Eclipse Mosquitto — ein MQTT-Broker. Die Installation dauert nur ein bis zwei Minuten, deshalb zeige ich sie komplett."

### Ablauf in der UI

1. **App auswählen:** In der App-Liste "Eclipse Mosquitto" anklicken
2. **Parameter prüfen:** vm_id_start steht schon auf 500 (Projekt-Default!)
   > "Hier sehen wir: die vm_id_start steht bereits auf 500 — das kommt aus unserem Projekt-Template."
3. **Installation starten:** "Install" klicken
4. **Process Monitor erklären** (während Installation läuft):
   > "Der Process Monitor zeigt jeden Schritt in Echtzeit. Zuerst wird das OS-Template heruntergeladen, dann der Container erstellt, Netzwerk konfiguriert, und schließlich die Packages installiert."
5. **In Proxmox zeigen:** Container taucht auf mit 5xx ID

### Ergebnis

> "Fertig. Mosquitto läuft als unprivilegierter Container. In der Proxmox-Oberfläche sehen wir ihn mit der ID 500."

---

## Schritt 3: Zitadel — Fehler, Postgres, Erfolg

**Ablauf-Panel:** `video1-ablauf-03-zitadel.html`
**Darstellung:** Split-Screen
**Tempo:** Fehler in Echtzeit, Postgres im Zeitraffer, Zitadel im Zeitraffer

### Zitadel versuchen (scheitert)

> "Jetzt installieren wir Zitadel — unseren Login-Server. Das ist der OIDC-Provider für alle Anwendungen."

1. **App auswählen:** "Zitadel"
2. **Parameter setzen:** Addon `addon-ssl`
3. **Installation starten**
4. **Fehlermeldung abwarten** — Postgres fehlt!
   > "Das geht nicht — Zitadel braucht eine PostgreSQL-Datenbank, und die haben wir noch nicht installiert."

### PostgreSQL installieren

> "Also installieren wir zuerst Postgres."

1. **App auswählen:** "PostgreSQL"
2. **Parameter setzen:** Addon `addon-ssl`
   > "Postgres bekommt ein TLS-Zertifikat — die Datenbankverbindung ist damit verschlüsselt."
3. **Installation starten**

**→ ZEITRAFFER (DaVinci-Effekt) → Installation fertig**

> "Postgres läuft."

### Zitadel nochmal (klappt)

> "Jetzt nochmal Zitadel."

1. **Zitadel erneut installieren** — diesmal kein Fehler
2. **Installation starten**

**→ ZEITRAFFER (DaVinci-Effekt) → Installation fertig**

> "Zitadel läuft. Intern erreichbar unter https://zitadel:1443."

### DaVinci-Effekt für Zeitraffer

Beim Process-Monitor-Zeitraffer jedes Mal den gleichen visuellen Effekt verwenden:
- **Rennwagen-Transition:** Rennwagen fährt von links nach rechts durch den Bildschirm
- **Hintergrund-Crossfade:** Während der Wagen fährt, blendet der Hintergrund von "Installation gestartet" auf "Installation fertig" um
- **Audio:** Motorgeräusch oder Whoosh-Sound
- **Konsistenz:** Exakt gleicher Effekt bei Postgres und Zitadel — der Zuschauer lernt das Muster und weiß sofort: "Das wird jetzt übersprungen"
- **DaVinci Resolve:** Fusion-Page für die Animation, oder als vorgefertigtes Macro wiederverwenden

---

## Schritt 4: OIDC für proxvex

**Ablauf-Panel:** `video1-ablauf-04-oidc-deployer.html`
**Darstellung:** Split-Screen
**Tempo:** Echtzeit — das ist wieder spannend (neues Konzept: Reconfigure + Addon)

### Talking Points

> "Jetzt aktivieren wir die Authentifizierung für den Deployer selbst. Das ist kein neuer Container — wir reconfigurieren den bestehenden."

### Ablauf

1. **Parameter-Datei vorbereiten** (vorab, kurz zeigen):
   ```json
   {
     "application": "proxvex",
     "task": "reconfigure",
     "params": [
       { "name": "previouse_vm_id", "value": 100 }
     ],
     "selectedAddons": ["addon-ssl", "addon-oidc"],
     "stackId": "production"
   }
   ```
   > "Statt alles von Hand in der UI einzustellen, kann man auch eine Parameter-Datei hochladen. Das ist praktisch für reproduzierbare Setups."

2. **In der UI:** Parameter-Datei hochladen (Upload-Button)
   > "addon-ssl gibt dem Deployer ein HTTPS-Zertifikat. addon-oidc verbindet ihn mit Zitadel. Beides wird in einem Schritt konfiguriert."

3. **Reconfigure starten** → Deployer startet neu

### Ergebnis demonstrieren

1. **Browser öffnen:** `https://proxvex:3443`
2. **Redirect zu Zitadel:** Login-Seite erscheint
3. **Einloggen:** Mit Zitadel-Credentials
4. **Zurück im Deployer:** Eingeloggt!

> "Ab jetzt ist der Deployer nur noch über HTTPS erreichbar, und man muss sich über Zitadel anmelden."

---

## Schritt 5: OIDC für Proxmox

**Ablauf-Panel:** `video1-ablauf-05-oidc-proxmox.html`
**Darstellung:** Split-Screen (Deployer UI links, Proxmox UI unten/rechts)
**Tempo:** Echtzeit — starker Abschluss

### Talking Points

> "Und jetzt das Highlight: das gleiche Zitadel, das den Deployer absichert, kann auch Proxmox selbst absichern. Single Sign-On für die gesamte Infrastruktur."

### Ablauf

1. **In der Deployer-UI:**
   - Proxmox als Anwendung auswählen (oder Reconfigure des PVE-Hosts)
   - addon-oidc aktivieren
   > "Der Deployer registriert automatisch einen OIDC-Client in Zitadel für Proxmox."

2. **In der Proxmox-UI:**
   - Login-Seite öffnen
   - "Login with OpenID Connect" oder Realm-Auswahl zeigen
   - Einloggen über Zitadel
   > "Gleicher Login, gleicher Benutzer — für Proxmox und den Deployer."

### Abschluss

> "Das war's für heute. Wir haben aus einem leeren Proxmox-Host eine vollständige Infrastruktur aufgebaut:"
> - "Einen MQTT-Broker"
> - "Eine PostgreSQL-Datenbank"
> - "Einen OIDC-Provider"
> - "Und Single Sign-On für den Deployer und Proxmox selbst"

> "Im nächsten Video machen wir das Ganze produktionsreif: mit eigenem IP-Bereich, Nginx als Reverse Proxy, ACME-Zertifikaten, und öffentlichem Zugang."

---

## Schnitt-Hinweise

| Schritt | Dauer (geschätzt) | Schnitt |
|---------|-------------------|---------|
| 1. Installer + Defaults | 3-4 Min | Leicht gekürzt |
| 2. Mosquitto | 1-2 Min | **Echtzeit** |
| 3. Zitadel-Fehler + Postgres + Zitadel | 15-20 Min | **2x Zeitraffer (DaVinci-Effekt)** |
| 4. OIDC Deployer | 2-3 Min | Echtzeit |
| 5. OIDC Proxmox | 2-3 Min | Echtzeit |
| **Gesamt (nach Schnitt)** | **~15 Min** | |

## Ablauf-Panel Dateien

Beim Wechsel zwischen Schritten die entsprechende HTML-Datei im Browser-Tab öffnen:

| Schritt | Datei |
|---------|-------|
| 1 | `video1-ablauf-01-installer.html` |
| 2 | `video1-ablauf-02-mosquitto.html` |
| 3 | `video1-ablauf-03-zitadel.html` |
| 4 | `video1-ablauf-04-oidc-deployer.html` |
| 5 | `video1-ablauf-05-oidc-proxmox.html` |
