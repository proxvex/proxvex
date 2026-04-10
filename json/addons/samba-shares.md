# Samba File Shares Addon

Enable SMB/CIFS file sharing for application containers. Upload a custom `smb.conf` to configure shares.

## Parameters

### `addon_content` (required)

Upload your `smb.conf` file. This file defines the Samba shares and their configuration.

### `smb_user` (required)

Samba username for authentication.

### `smb_password` (required, secure)

Samba password for the configured user.

## How It Works

1. Installs the `samba` package inside the container
2. Creates volumes for Samba data (`private`) and configuration (`config`)
3. Uploads your `smb.conf` to the container
4. Registers a hookscript that restarts Samba services after each container restart

## Notice

This addon installs a **hookscript** on the Proxmox host
(`/var/lib/vz/snippets/lxc-oci-deployer-hook.sh`) that automatically
restarts Samba services after a container restart.

The hookscript can be used by other addons as well and will be
registered for the current container being installed.
