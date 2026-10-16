# WireGuard (wg-easy)

WireGuard VPN server with the **wg-easy** web UI (`ghcr.io/wg-easy/wg-easy`).
Clients (phones, laptops) dial in from the internet and reach the LAN
("road warrior"). Clients are created in the web UI, which shows a QR code and
a downloadable `.conf` for each one.

It runs as an **unprivileged** OCI-image LXC container and uses the **host's
in-kernel WireGuard**. It does not use `wireguard-go` and needs no
`/dev/net/tun`.

## Key Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `hostname` | `wireguard` | Container hostname; the web UI answers at `https://<hostname><domain-suffix>/`. |
| `oci_image_tag` | `15` | wg-easy major version. v15 uses a different data format than v14 and earlier. |
| `volumes` | `data=/etc/wireguard,size=256M` | Holds the SQLite database (server keys, clients, settings) and the generated `wg0.conf`. **This volume is the VPN's identity.** If you lose it, every client needs a new config. |
| `envs` | `TZ=Europe/Berlin`, `PORT=51821`, `HOST=0.0.0.0`, `INSECURE=false` | `PORT` is wg-easy's internal HTTP port, which only the SSL proxy reaches. Keep `INSECURE=false`: wg-easy then refuses logins over plain HTTP. Optional `DISABLE_IPV6=true` turns off the IPv6 part of the tunnel. See *Unattended setup* for the `INIT_*` variables. |
| `static_ip` / `static_gw` | DHCP | **Recommended.** The router forwards UDP 51820 to this container, so its address must not change. A DHCP reservation by MAC does not work for this, because upgrade and reconfigure give the container a new MAC. |
| `ipv6_token` | empty (MAC-derived) | Fixed IPv6 interface ID for `eth0`, for example `::53`. The container's global address becomes `<prefix>::53` and stays that way across upgrades (new MAC) and prefix changes. **Needed for inbound IPv6** (see *IPv6 and DS-Lite*). |
| `kernel_modules` | `wireguard iptable_nat iptable_filter ip6table_nat ip6table_filter xt_MASQUERADE` | Locked. Loaded on the PVE host and persisted (see *Host requirements*). |
| `container_sysctls` | `net.ipv6.conf.eth0.accept_ra=2`, `net.ipv4.ip_forward=1`, `net.ipv4.conf.all.src_valid_mark=1`, IPv6 forwarding | Locked. `accept_ra=2` keeps SLAAC working: with forwarding on, the kernel would otherwise ignore router advertisements, and the container would lose its own IPv6 address and default route. Set inside the container's network namespace on every start (see *Host requirements*). |

## First start: setup wizard

On the first visit, the web UI runs a setup wizard:

1. Create the **admin user** and password.
2. Enter the **host** clients connect to. Use a DNS name, for example `vpn.example.de`. On a DS-Lite line it needs an **AAAA record** (see *IPv6 and DS-Lite* for which address).
3. Enter the **port**. Normally this is `51820`, which must match the router rule.

After that, add clients under *Clients → New*. Scan the QR code **inside the
WireGuard app** ("Create from QR code"); the phone's camera app would only
open the endpoint name as a web page.

### Unattended setup (optional)

Instead of the wizard, wg-easy can configure itself on first start. Add the
following to `envs`. The first four must be set together:

```
INIT_ENABLED=true
INIT_USERNAME=admin
INIT_PASSWORD=<initial password>
INIT_HOST=vpn.example.de
INIT_PORT=51820
INIT_DNS=192.168.1.1            # optional: DNS server pushed to clients (e.g. your LAN resolver)
INIT_ALLOWED_IPS=192.168.1.0/24 # optional: split tunnel, only LAN traffic through the VPN
```

The values only take effect on the very first start, while the database is still empty.
Remove `INIT_PASSWORD` afterwards (reconfigure), so the password does not
stay in `/etc/pve/lxc/<vmid>.conf`.

## Network: how clients reach the LAN

```
Client ──UDP 51820──► Router (IPv4 forward / IPv6 firewall rule) ──► wireguard LXC (eth0)
                                                      │ wg0 10.8.0.0/24
                                                      ▼ MASQUERADE out eth0
                                                    LAN devices
```

- **Router:** with a public IPv4, forward **UDP 51820** to the container's IPv4. On a DS-Lite line, bring it in over IPv6 instead (see *IPv6 and DS-Lite*). Nothing else is exposed; the web UI (TCP 443) stays LAN-only.
- **NAT:** wg-easy masquerades client traffic out of `eth0`. LAN devices see requests coming from the container's IP, so **no static route** for `10.8.0.0/24` is needed on the router.
- **Full tunnel or split tunnel:** by default, clients send *all* traffic through the VPN (`0.0.0.0/0, ::/0`). To route only LAN traffic, set *Allowed IPs* in the web UI's admin settings, or per client, to your LAN subnet, for example `192.168.1.0/24`. `INIT_ALLOWED_IPS` sets it at first start.
- **DNS:** to resolve LAN hostnames, set the client DNS to your LAN resolver (for example the router) in the web UI or with `INIT_DNS`.
- **Client subnet:** `10.8.0.0/24` must not overlap with the LAN, nor with the networks clients are typically in. Change it in the web UI if needed.

## IPv6 and DS-Lite

On a **DS-Lite** line (common with cable providers), the router has no public
IPv4 of its own. It shares one behind the provider's carrier-grade NAT, so an
IPv4 port forward can never be reached from outside. A Cloudflare Tunnel does
not help either, because it does not carry WireGuard's UDP. Clients can then
**only connect over IPv6**. Most mobile networks provide IPv6; some hotel or
guest Wi-Fi networks do not.

Two ways to let IPv6 clients in, depending on what the upstream box allows:

**A) Firewall rule into the delegated prefix (no NAT).** If the upstream box
(e.g. a FritzBox) can open its firewall for the prefix it delegated to the
router ("Firewall für delegierte IPv6-Präfixe dieses Geräts öffnen"), clients
talk directly to the container's global address:

1. **Stable address:** set `ipv6_token` (for example `::53`). The init wrapper runs `ip token set ::53 dev eth0` on every start, so the address is always `<prefix>::53`. Without a token, the interface ID follows the MAC, which changes on every upgrade and reconfigure.
2. **OpenWrt rule:** allow UDP 51820 from WAN to the container, matching only the interface ID so the rule survives prefix changes:
   ```
   config rule
       option name 'wan-cluster-allow-wireguard-udp-51820'
       option src 'wan'
       option dest 'cluster'      # the zone the container is in
       option family 'ipv6'
       option proto 'udp'
       option dest_ip '::53/::ffff:ffff:ffff:ffff'
       option dest_port '51820'
       option target 'ACCEPT'
   ```
3. **DNS:** an AAAA record for the client host name pointing to `<prefix>::53`, kept current by DynDNS.

**B) Port share to the router + DNAT (used in production).** Some FritzBox
models (seen on a Vodafone cable box) have no option for the delegated prefix
and only accept port shares for addresses in their *own* LAN — that is, the
router's WAN address. Then:

1. **FritzBox:** share UDP 51820 (IPv6) to the router's WAN interface ID.
2. **OpenWrt:** DNAT that port to the container's **ULA**, which never changes (the ULA prefix is fixed, the interface ID is the token):
   ```
   config redirect
       option name 'wan-cluster-dnat-wireguard-udp-51820'
       option src 'wan'
       option dest 'cluster'
       option family 'ipv6'
       option proto 'udp'
       option src_dport '51820'
       option dest_ip 'fd29:cd10:9a98::53'
       option dest_port '51820'
       option target 'DNAT'
   ```
3. **OpenWrt `wan6`: `option sourcefilter '0'`.** By default OpenWrt installs only source-specific default routes (`default from <delegated prefix>`). The container answers from its ULA, no default route matches that source, and the reply is dropped *before* conntrack rewrites it back to the WAN address. Symptom: handshake initiations arrive and the container answers (visible on the cluster bridge), but nothing leaves on `wan`.
4. **DNS:** the AAAA record points to the **router's WAN address** (DynDNS with `ip_source network` on `wan6`).

WireGuard works fine through this NAT. From inside the LAN the DNAT does not
apply (it matches `src wan` only); that is fine for a split tunnel, where the
VPN is not needed at home.

**Troubleshooting order:** a client inside the upstream box's own LAN/WLAN
reaches the router's WAN address without passing the upstream firewall —
use it to prove router + DNAT + container. If that works and mobile clients
still get no handshake, the upstream box is dropping the traffic.

Inside the tunnel, clients get an IPv4 address from `10.8.0.0/24` and an IPv6
ULA. wg-easy masquerades both out of `eth0`. IPv6 traffic from the clients
therefore works only if the container itself has IPv6, which is why
`accept_ra=2` is set.

## HTTPS (addon-ssl, required)

wg-easy has no TLS of its own and, with `INSECURE=false`, requires HTTPS.
So the **SSL addon is mandatory** and runs in **proxy mode**:

- An on-start hook installs **nginx** in the container. nginx terminates TLS on **443** with the managed certificate (`/etc/ssl/addon/`) and proxies to wg-easy on `127.0.0.1:51821`.
- An iptables rule blocks port **51821** from outside the container. The UI can only be reached through HTTPS.
- `addon-acme` can replace the internal-CA certificate with a Let's Encrypt one.

## Authentication

wg-easy has its own login (username and password, optional two-factor
authentication).

wg-easy v15 can also log in through a generic OIDC provider
(`OAUTH_PROVIDERS=oidc`, `OAUTH_OIDC_SERVER`, `OAUTH_OIDC_CLIENT_ID`,
`OAUTH_OIDC_CLIENT_SECRET`, callback `/api/auth/oidc/callback`). proxvex does
**not** offer `addon-oidc` for it yet, for two reasons:

- wg-easy has no role mapping: with `OAUTH_AUTO_REGISTER` every user who logs in becomes an **admin**. For a VPN gateway that is too coarse.
- The provider must support PKCE and `client_secret_post`, which the Zitadel client registration does not currently guarantee.

You can set the `OAUTH_*` variables by hand in `envs` if you need it.

## Host requirements (handled automatically)

An unprivileged container can neither load kernel modules nor set sysctls
before its first process starts. proxvex handles both:

- **Kernel modules:** the `image` phase (`096-host-load-kernel-modules`) runs `modprobe` on the PVE host for `wireguard` plus the iptables-legacy NAT/filter modules wg-easy uses. It also adds them to **`/etc/modules-load.d/proxvex.conf`**, so they come back after a host reboot.
- **IP forwarding and IPv6 token:** Proxmox drops raw `lxc.sysctl.*` keys. The init wrapper `/usr/local/sbin/proxvex-init` (`109-host-install-init-wrapper`) is therefore placed in front of the image's entrypoint. On every start it writes `container_sysctls` into the container's network namespace, sets `ipv6_token`, and then `exec`s wg-easy.
- **Capabilities:** an unprivileged container already holds `net_admin`/`net_raw` inside its user namespace. That is enough for `ip link add wg0 type wireguard` and iptables. No extra LXC config is needed.

## Where to change configuration

- **LXC container** (network, static IP, environment, entrypoint with the init wrapper): `/etc/pve/lxc/<vmid>.conf` on the PVE host. Change it with *Reconfigure* rather than editing the file by hand.
- **VPN settings and clients:** in the **web UI**. wg-easy keeps them in an SQLite database under `/etc/wireguard/` (on the `data` volume) and regenerates `/etc/wireguard/wg0.conf` from it on every change. **Do not edit `wg0.conf` directly**, because it is overwritten. Use the web UI's admin settings instead, for example for custom firewall rules.

## Storage, backup and upgrade

- `disk_size` is 1 GB: about 80 MB compressed image, Node.js runtime and nginx.
- The `data` volume is small, but it holds the server's private key and all client keys. `volume_backup` is enabled.
- **Upgrade** pulls the new image, creates a fresh container and reattaches `data`. The server key, the clients and their configs stay valid, and the modules are loaded again in the `image` phase.
