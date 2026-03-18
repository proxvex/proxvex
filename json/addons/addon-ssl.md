# SSL/HTTPS Addon

Enable HTTPS for application containers using self-signed CA certificates.

## Use Cases

### Proxy Mode (recommended)

nginx reverse proxy terminates TLS. The application runs on HTTP internally.

```
ssl_mode = proxy
http_port = 8080
https_port = 443
```

Best for most applications — no app-specific TLS configuration needed.

### Native Mode

The application configures HTTPS itself using the provisioned certificates at `/etc/ssl/addon/`. Supported by:

- **PostgreSQL:** Modifies `postgresql.conf` with SSL settings
- **Gitea:** Sets `GITEA__server__PROTOCOL=https`
- Other apps with built-in TLS support

```
ssl_mode = native
```

### Certificates Only

Only provision certificates, no proxy or port configuration. Use for custom setups where you handle TLS yourself.

```
ssl_mode = certs
```

## Parameters

### `ssl_mode`

| Mode | Description |
|------|-------------|
| `proxy` | nginx reverse proxy handles HTTPS (default) |
| `native` | App configures HTTPS itself |
| `certs` | Only provision certificates |

### `http_port` (advanced)

The HTTP port of the application to be proxied. Only relevant for `proxy` mode.

### `https_port` (advanced)

The HTTPS port to listen on. Only relevant for `proxy` mode.

## Architecture

Certificates are generated on the PVE host during pre_start and placed into a bind-mounted volume at `/etc/ssl/addon/`.

For proxy mode, an nginx reverse proxy is configured via an on_start.d drop-in script that runs on each container start. The hookscript mechanism ensures the proxy is set up automatically after restarts.

## Certificate Files

| File | Description |
|------|-------------|
| `privkey.pem` | Server private key |
| `cert.pem` | Server certificate |
| `fullchain.pem` | Server certificate + CA certificate |
| `chain.pem` | CA/intermediate certificate (if `needs_ca_cert` is enabled) |

## Notice

This addon installs a **hookscript** on the Proxmox host
(`/var/lib/vz/snippets/lxc-oci-deployer-hook.sh`) that automatically
runs on_start.d scripts after a container restart.
