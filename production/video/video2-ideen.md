# Video 2 — Production Setup (Ideen)

## Ausgangslage

Video 1 ist abgeschlossen. Es laufen:
- oci-lxc-deployer (HTTP, 1xx VM-ID, OIDC via internes Zitadel)
- Mosquitto, Postgres, Zitadel (alle 5xx VM-IDs)
- Proxmox OIDC aktiv

## Ziel

Aus dem einfachen Setup ein produktionsreifes machen:
- Öffentlicher Zugang über Nginx mit ACME-Wildcard
- DNS/NAT auf OpenWrt Router
- OIDC-Issuer-URL auf öffentliche Domain umstellen
- Deployer mit statischer IP und HTTPS neu installieren

## Ideen / Themen

### Aufräumen von Video 1
- OIDC vom Deployer wieder entfernen (Reconfigure ohne addon-oidc)
- Alle Container aus Video 1 löschen (Mosquitto, Postgres, Zitadel)
- Sauberer Neustart für Production-Setup

### Zitadel via CLI installieren
- deploy.sh zitadel — Postgres wird automatisch als Dependency mit installiert
- Zeigt den CLI-Weg (Gegenstück zur UI in Video 1)
- Dependency-Auflösung funktioniert auch hier automatisch

### project.sh (v2)
- oidc_issuer_url auf https://auth.ohnewarum.de setzen
- Erklären was vm_id_start und Mirrors bewirken (in Video 1 nur "kommt im nächsten Video")

### DNS und NAT auf OpenWrt
- dns.sh erklären und ausführen
- Alle *.ohnewarum.de → 192.168.1.1 (Hairpin-Vermeidung)
- NAT-Regeln: :443 → nginx:1443, :8883 → mosquitto:8883
- Zeigen dass interne Apps DHCP nutzen (keine manuellen DNS-Einträge)

### Production-Stack
- Stack in der UI erstellen (postgres + oidc + cloudflare)
- Cloudflare API Token eingeben
- Erklären: Stack verbindet Provider und Consumer

### Nginx
- deploy.sh nginx oder UI
- ACME-Wildcard (*.ohnewarum.de) via Cloudflare DNS-Challenge
- setup-nginx.sh: Virtual Hosts, Homepage, Reverse Proxy Configs
- Ergebnis: https://ohnewarum.de funktioniert öffentlich

### Deployer neu installieren
- Mit --vm-id-start 500, --static-ip, --https
- Alter 1xx Container verschwindet automatisch
- project.sh nochmal (jetzt mit oidc_issuer_url)

### Zitadel/Postgres umkonfigurieren?
- Statische IPs nötig? Nein — DHCP reicht (neue Strategie)
- oidc_issuer_url ändert sich → Reconfigure nötig?

### Gitea
- Erste App die komplett mit Production-Setup deployed wird
- addon-ssl + addon-oidc
- Zeigt dass der Stack alles automatisch verbindet

### Zertifikatsstrategie erklären
- ACME nur auf Nginx (ein Wildcard)
- Self-signed für alles interne (globale CA)
- CA auf Browser installieren (kurz zeigen)

### Möglicher Abschluss
- Alle Apps laufen, öffentlich erreichbar
- Login über auth.ohnewarum.de (OIDC überall gleich)
- Homepage zeigen

## Offene Fragen

- Reihenfolge der Schritte?
- Was wird im Zeitraffer gezeigt?
- Welche Schritte über UI, welche per Script?
- Wie viel Erklärung zur Architektur (Diagramme aus INFRASTRUCTURE.md)?
- DaVinci-Effekt wiederverwenden?
