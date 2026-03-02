## Notice

This addon enables **HTTPS** for the application container. Two modes are available:

### Proxy Mode (nginx)
A lightweight **nginx reverse proxy** is installed inside the container. It terminates
TLS on the configured HTTPS port and forwards traffic to the application's HTTP port
on localhost. External access to the HTTP port is blocked via **iptables**.

For **OCI-image** containers, nginx and iptables are installed directly.
For **Docker-Compose** containers, an nginx-ssl-proxy service is added to the
compose file and the HTTP port is removed from external mappings.

This mode requires the `net_admin` capability for OCI-image containers
(added automatically to the LXC configuration).

### Native Mode
The application handles HTTPS itself using the certificates provided in
`/etc/ssl/addon/`. The application is responsible for redirecting HTTP to HTTPS.

### Certificates
Certificates are stored in `/etc/ssl/addon/` (`server.crt` and `server.key`).
They are **auto-generated** by the internal CA if SSL is enabled and no certificate
is uploaded. You can also upload your own PEM certificate and private key.

This addon installs a **hookscript** on the Proxmox host that ensures the
SSL proxy or certificate configuration persists across container restarts.
