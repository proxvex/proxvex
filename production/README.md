# Production Deployment

Reproduzierbares Setup für postgres, nginx, zitadel und gitea auf `pve1.cluster`.

## Voraussetzungen

- DNS-Einträge auf OpenWrt Router (einmalig): `scp dns.sh root@router: && ssh root@router sh dns.sh`
- Stack "production" wird automatisch beim ersten Deploy erstellt

## VM-Zuordnung

| App      | VM ID | IP             |
|----------|-------|----------------|
| postgres | 500   | 192.168.4.40   |
| nginx    | 501   | 192.168.4.41   |
| zitadel  | 502   | 192.168.4.42   |
| gitea    | 503   | 192.168.4.43   |

## Deploy

```bash
./production/deploy.sh              # alle Apps
./production/deploy.sh postgres     # nur postgres
./production/deploy.sh zitadel      # postgres + zitadel (Dependencies)
./production/deploy.sh gitea        # postgres + zitadel + gitea
```

## Destroy

```bash
./production/destroy.sh             # alle Apps (reverse Order)
./production/destroy.sh gitea       # nur gitea (+ DB cleanup)
./production/destroy.sh zitadel     # nur zitadel (+ DB cleanup)
```

## Dateien

| Datei          | Zweck                                    |
|----------------|------------------------------------------|
| `deploy.sh`    | Deploy via oci-lxc-cli in Dep-Reihenfolge |
| `destroy.sh`   | Destroy VMs + Postgres DB cleanup         |
| `dns.sh`       | DNS-Einträge auf OpenWrt (uci + dnsmasq)  |
| `*.json`       | CLI-Parameter pro App                     |
