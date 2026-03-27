#!/bin/sh
set -eu

# install-oci-lxc-deployer.sh
# Minimal installation script for oci-lxc-deployer as an LXC container on Proxmox
# Downloads OCI image, creates container, mounts volumes, and writes storagecontext.json

# Static GitHub source configuration
OCI_OWNER="${OCI_OWNER:-modbus2mqtt}"
OWNER="${OWNER:-modbus2mqtt}"
#OWNER="modbus2mqtt"
REPO="oci-lxc-deployer"
BRANCH="main"
OCI_IMAGE="ghcr.io/${OCI_OWNER}/oci-lxc-deployer:latest"

# Local script path - when set, scripts are loaded from local filesystem instead of GitHub
# Expected structure: LOCAL_SCRIPT_PATH/json/shared/scripts/...
LOCAL_SCRIPT_PATH="${LOCAL_SCRIPT_PATH:-}"

# Helper functions
execute_script_from_github() {
  if [ "$#" -lt 2 ]; then
    echo "Usage: execute_script_from_github <path> <output_id|-> [key=value ...]" >&2
    return 2
  fi
  path="$1"; output_id="$2"; shift 2

  sed_args=""
  for kv in "$@"; do
    key="${kv%%=*}"
    val="${kv#*=}"
    esc_val=$(printf '%s' "$val" | sed 's/[\\&|]/\\&/g')
    sed_args="$sed_args -e s|{{[[:space:]]*$key[[:space:]]*}}|$esc_val|g"
  done

  # Determine interpreter based on file extension
  case "$path" in
    *.py) interpreter="python3" ;;
    *.sh) interpreter="sh" ;;
    *) interpreter="sh" ;;
  esac

  # Load script content from local path or GitHub
  if [ -n "$LOCAL_SCRIPT_PATH" ] && [ -f "${LOCAL_SCRIPT_PATH}/${path}" ]; then
    echo "Loading script from local: ${LOCAL_SCRIPT_PATH}/${path}" >&2
    script_content=$(cat "${LOCAL_SCRIPT_PATH}/${path}")
  else
    raw_url="https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/${path}"
    script_content=$(curl -fsSL "$raw_url" 2>/dev/null || true)
    if [ -z "$script_content" ]; then
      echo "Error: Failed to download script from ${raw_url}" >&2
      return 3
    fi
  fi
  script_content=$(printf '%s' "$script_content" | sed $sed_args)

  # Some Python scripts depend on shared helpers but are still executed via stdin.
  # Prepend the helper library explicitly when needed.
  case "$path" in
    json/shared/scripts/pre_start/conf-setup-lxc-uid-mapping.py|json/shared/scripts/pre_start/conf-setup-lxc-gid-mapping.py)
      if [ -n "$LOCAL_SCRIPT_PATH" ] && [ -f "${LOCAL_SCRIPT_PATH}/json/shared/scripts/library/setup_lxc_idmap_common.py" ]; then
        lib_content=$(cat "${LOCAL_SCRIPT_PATH}/json/shared/scripts/library/setup_lxc_idmap_common.py")
      else
        lib_url="https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/json/shared/scripts/library/setup_lxc_idmap_common.py"
        lib_content=$(curl -fsSL "$lib_url")
      fi
      script_content=$(printf '%s\n\n%s' "$lib_content" "$script_content")
      ;;
    json/shared/scripts/pre_start/host-write-lxc-notes.py|json/shared/scripts/pre_start/host-write-docker-compose-notes.py)
      if [ -n "$LOCAL_SCRIPT_PATH" ] && [ -f "${LOCAL_SCRIPT_PATH}/json/shared/scripts/library/lxc-notes-common.py" ]; then
        lib_content=$(cat "${LOCAL_SCRIPT_PATH}/json/shared/scripts/library/lxc-notes-common.py")
      else
        lib_url="https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/json/shared/scripts/library/lxc-notes-common.py"
        lib_content=$(curl -fsSL "$lib_url")
      fi
      script_content=$(printf '%s\n\n%s' "$lib_content" "$script_content")
      ;;
    json/shared/scripts/image/host-get-oci-image.py)
      if [ -n "$LOCAL_SCRIPT_PATH" ] && [ -f "${LOCAL_SCRIPT_PATH}/json/shared/scripts/library/oci_version_lib.py" ]; then
        lib_content=$(cat "${LOCAL_SCRIPT_PATH}/json/shared/scripts/library/oci_version_lib.py")
      else
        lib_url="https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/json/shared/scripts/library/oci_version_lib.py"
        lib_content=$(curl -fsSL "$lib_url")
      fi
      script_content=$(printf '%s\n\n%s' "$lib_content" "$script_content")
      ;;
  esac

  if [ "$output_id" = "-" ]; then
    printf '%s' "$script_content" | $interpreter
    return $?
  fi

  script_output=$(printf '%s' "$script_content" | $interpreter)

  get_value_by_id() {
    printf '%s\n' "$script_output" \
      | awk -v ID="$1" '
        BEGIN { FS="\"" }
        /"id"[[:space:]]*:[[:space:]]*"/ {
          for (i=1; i<=NF; i++) {
            if ($i=="id" && $(i+2)==ID) {
              for (j=i; j<=NF; j++) {
                if ($j=="value") { print $(j+2); exit }
              }
            }
          }
        }'
  }

  case "$output_id" in
    *","*)
      # Multiple output IDs, comma-separated
      output_ids=$(printf '%s' "$output_id" | tr -d ' ')
      IFS=','
      set -- $output_ids
      IFS=' '
      results=""
      missing=""
      for id in "$@"; do
        value=$(get_value_by_id "$id")
        if [ -z "$value" ]; then
          missing="${missing}${missing:+,}${id}"
          value=""
        fi
        results="${results}${results:+,}${value}"
      done
      if [ -n "$missing" ]; then
        echo "Warning: Output id(s) '$missing' not found" >&2
        printf '%s\n' "$script_output" >&2
      fi
      printf '%s\n' "$results"
      return 0
      ;;
    *)
      output_value=$(get_value_by_id "$output_id")
      if [ -n "$output_value" ]; then
        printf '%s\n' "$output_value"
        return 0
      else
        echo "ERROR: Output id '$output_id' not found" >&2
        printf '%s\n' "$script_output" >&2
        return 3
      fi
      ;;
  esac
}

# Defaults
vm_id=""
vm_id_start=""
disk_size="1"
memory="512"
bridge="vmbr0"
hostname="oci-lxc-deployer"
config_volume_path=""
secure_volume_path=""
storage="local"

# Known UID/GID from Dockerfile (lxc user)
LXC_UID=1001
LXC_GID=1001

# Static IP configuration (optional)
static_ip=""
static_gw=""
nameserver=""

# External URL for deployer (optional, for NAT/port-forwarding scenarios)
deployer_url=""

# HTTPS option (reconfigure with SSL addon after install)
enable_https=""
domain_suffix=".local"

# Parse CLI flags
while [ "$#" -gt 0 ]; do
  case "$1" in
    --vm-id) vm_id="$2"; shift 2 ;;
    --vm-id-start) vm_id_start="$2"; shift 2 ;;
    --disk-size) disk_size="$2"; shift 2 ;;
    --memory) memory="$2"; shift 2 ;;
    --bridge) bridge="$2"; shift 2 ;;
    --hostname) hostname="$2"; shift 2 ;;
    --config-volume) config_volume_path="$2"; shift 2 ;;
    --secure-volume) secure_volume_path="$2"; shift 2 ;;
    --storage) storage="$2"; shift 2 ;;
    --static-ip) static_ip="$2"; shift 2 ;;
    --gateway) static_gw="$2"; shift 2 ;;
    --nameserver) nameserver="$2"; shift 2 ;;
    --deployer-url) deployer_url="$2"; shift 2 ;;
    --https) enable_https="true"; shift ;;
    --domain-suffix) domain_suffix="$2"; shift 2 ;;
    --help|-h)
      cat >&2 <<USAGE
Usage: $0 [options]

Installs oci-lxc-deployer as an LXC container from OCI image on a Proxmox host.

Options:
  --vm-id <id>          Optional VMID. If empty, the next free VMID is chosen.
  --vm-id-start <id>    Start index for auto-assigned VM IDs (next free ID from this value).
  --disk-size <GB>      LXC rootfs size in GB. Default: 1
  --memory <MB>         Container memory in MB. Default: 512
  --bridge <name>       Network bridge (e.g. vmbr0). Default: vmbr0
  --hostname <name>     Container hostname. Default: oci-lxc-deployer
  --config-volume <path> Host path for /config volume (default: /mnt/volumes/\$hostname/config)
  --secure-volume <path> Host path for /secure volume (default: /mnt/volumes/\$hostname/secure)
  --storage <name>      Proxmox storage for OCI image. Default: local
  --static-ip <IP/CIDR> Static IP address (e.g., 10.0.0.100/24). Default: DHCP
  --gateway <IP>        Gateway IP address (required if --static-ip is used)
  --nameserver <IP>     DNS nameserver (e.g., 10.0.0.1). Optional, defaults to host resolv.conf
  --deployer-url <URL>  External URL for deployer (e.g., http://pve1:3080 for NAT setups)
  --https               Enable HTTPS (reconfigures with SSL addon after install)
  --domain-suffix <sfx> Domain suffix for SSL certificates (default: .local)

Notes:
  - OCI image: ${OCI_IMAGE}
  - Container UID/GID: ${LXC_UID}/${LXC_GID}
  - If --static-ip is not provided, the container uses DHCP
  - The script creates a storagecontext.json file for repeatable installations
USAGE
      exit 0 ;;
    *)
      echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

# Detect ZFS pool and mountpoint for volumes
detect_volume_base_path() {
  # Check for ZFS pools first (common in Proxmox)
  if command -v zpool >/dev/null 2>&1 && command -v zfs >/dev/null 2>&1; then
    # Try common pool names: rpool, tank, data
    for pool in rpool tank data; do
      if zpool list "$pool" >/dev/null 2>&1; then
        mountpoint=$(zfs get -H -o value mountpoint "$pool" 2>/dev/null || echo "")
        if [ -n "$mountpoint" ] && [ "$mountpoint" != "none" ] && [ "$mountpoint" != "-" ] && [ -d "$mountpoint" ]; then
          # Check for volumes subdirectory (common pattern)
          if [ -d "${mountpoint}/volumes" ]; then
            echo "${mountpoint}/volumes"
            return 0
          else
            # Use pool mountpoint directly
            echo "$mountpoint"
            return 0
          fi
        fi
      fi
    done
  fi
  
  # Fallback to /mnt/volumes
  echo "/mnt/volumes"
}

get_storage_type() {
  _storage="$1"
  pvesm status -storage "$_storage" 2>/dev/null | awk 'NR==2 {print $2}' || true
}

get_zfs_pool_for_storage() {
  _storage="$1"
  if [ -r /etc/pve/storage.cfg ]; then
    awk -v storage="$_storage" '
      $1 ~ /^zfspool:/ { inblock=0 }
      $1 == "zfspool:" && $2 == storage { inblock=1 }
      inblock && $1 == "pool" { print $2; exit }
    ' /etc/pve/storage.cfg 2>/dev/null || true
  fi
}

resolve_shared_volume_path() {
  _storage="$1"
  _storage_type="$2"
  _volid="$3"
  _volname="$4"

  _path="$(pvesm path "$_volid" 2>/dev/null || true)"
  if [ -n "$_path" ]; then
    echo "$_path"
    return 0
  fi

  if [ "$_storage_type" = "zfspool" ]; then
    _pool=$(get_zfs_pool_for_storage "$_storage")
    if [ -n "$_pool" ]; then
      _mp=$(zfs get -H -o value mountpoint "${_pool}/${_volname}" 2>/dev/null || true)
      if [ -z "$_mp" ] || [ "$_mp" = "-" ] || [ "$_mp" = "none" ]; then
        _mp=$(zfs list -H -o mountpoint "${_pool}/${_volname}" 2>/dev/null || true)
      fi
      if [ -n "$_mp" ] && [ "$_mp" != "-" ] && [ "$_mp" != "none" ]; then
        echo "$_mp"
        return 0
      fi
    fi
  fi
  return 1
}

# Set default volume paths if not provided
volume_base=$(detect_volume_base_path)
if [ -z "$config_volume_path" ]; then
  config_volume_path="${volume_base}/${hostname}/config"
fi
if [ -z "$secure_volume_path" ]; then
  secure_volume_path="${volume_base}/${hostname}/secure"
fi

# Get Proxmox hostname for VE context (use FQDN)
proxmox_hostname=$(hostname -f 2>/dev/null || hostname 2>/dev/null || echo "localhost")

echo "Installing oci-lxc-deployer..." >&2
echo "  OCI Image: ${OCI_IMAGE}" >&2
echo "  Hostname: ${hostname}" >&2
echo "  Proxmox Host: ${proxmox_hostname}" >&2
echo "  Volume base: ${volume_base}" >&2
echo "  Config volume: ${config_volume_path}" >&2
echo "  Secure volume: ${secure_volume_path}" >&2
if [ "$OWNER" = "modbus2mqtt" ]; then
  echo "  \033[33mOWNER=${OWNER}\033[0m, REPO=${REPO}, BRANCH=${BRANCH}, OCI_IMAGE=${OCI_IMAGE}" >&2
else
  echo "  OWNER=${OWNER}, REPO=${REPO}, BRANCH=${BRANCH}, OCI_IMAGE=${OCI_IMAGE}" >&2
fi

# Check and install SSH server if needed (on Proxmox VE host)
# This matches the installation command from the SSH config page
echo "Step 0: Installing and hardening SSH server..." >&2
# Check if SSH port is listening
if ! nc -z localhost 22 2>/dev/null && ! timeout 2 nc -z localhost 22 2>/dev/null; then
  echo "  SSH server not listening, installing and configuring..." >&2
  
  # Install openssh-server if apt-get exists (Proxmox is Debian-based)
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update >/dev/null 2>&1 && DEBIAN_FRONTEND=noninteractive apt-get install -y openssh-server >/dev/null 2>&1 || {
      echo "Warning: Failed to install openssh-server" >&2
    }
  fi
  
  # Prepare directories
  mkdir -p /root/.ssh /var/run/sshd /etc/ssh/sshd_config.d
  
  # Write oci-lxc-deployer drop-in configuration (matches ssh.mts getInstallSshServerCommand)
  cat > /etc/ssh/sshd_config.d/oci-lxc-deployer.conf <<'SSHCONF'
PermitRootLogin prohibit-password
PubkeyAuthentication yes
PasswordAuthentication no
ChallengeResponseAuthentication no
UsePAM no
AuthorizedKeysFile .ssh/authorized_keys .ssh/authenticated_keys
AllowUsers root
AcceptEnv LANG LC_*
SSHCONF
  
  # Enable and restart SSH service
  systemctl enable ssh >/dev/null 2>&1 || systemctl enable sshd >/dev/null 2>&1 || true
  systemctl restart ssh >/dev/null 2>&1 || systemctl restart sshd >/dev/null 2>&1 || \
  service ssh restart >/dev/null 2>&1 || service sshd restart >/dev/null 2>&1 || {
    echo "Warning: Failed to restart SSH server" >&2
  }
  
  echo "  SSH server installed and hardened" >&2
else
  echo "  SSH server already listening" >&2
  # Still ensure drop-in config exists (may have been removed)
  if [ ! -f /etc/ssh/sshd_config.d/oci-lxc-deployer.conf ]; then
    echo "  Adding oci-lxc-deployer SSH configuration..." >&2
    mkdir -p /etc/ssh/sshd_config.d
    cat > /etc/ssh/sshd_config.d/oci-lxc-deployer.conf <<'SSHCONF'
PermitRootLogin prohibit-password
PubkeyAuthentication yes
PasswordAuthentication no
ChallengeResponseAuthentication no
UsePAM no
AuthorizedKeysFile .ssh/authorized_keys .ssh/authenticated_keys
AllowUsers root
SSHCONF
    systemctl restart ssh >/dev/null 2>&1 || systemctl restart sshd >/dev/null 2>&1 || true
  fi
fi

# 1) Download OCI image
echo "Step 1: Downloading OCI image..." >&2
template_path=$(execute_script_from_github \
  "json/shared/scripts/image/host-get-oci-image.py" \
  "template_path" \
  "oci_image=${OCI_IMAGE}" \
  "storage=${storage}" \
  "registry_username=" \
  "registry_password=" \
  "platform=linux/amd64")

if [ -z "$template_path" ]; then
  echo "Error: Failed to download OCI image" >&2
  exit 1
fi

oci_outputs=$(execute_script_from_github \
  "json/shared/scripts/image/host-get-oci-image.py" \
  "ostype,arch,application_id,application_name,oci_image,oci_image_tag" \
  "oci_image=${OCI_IMAGE}" \
  "storage=${storage}" \
  "registry_username=" \
  "registry_password=" \
  "platform=linux/amd64")

IFS=',' read -r ostype arch application_id application_name resolved_oci_image oci_image_tag <<EOF
$oci_outputs
EOF

if [ -z "$application_id" ]; then
  application_id="oci-lxc-deployer"
fi
if [ -z "$arch" ]; then
  arch="amd64"
fi
if [ -z "$resolved_oci_image" ]; then
  resolved_oci_image="${OCI_IMAGE}"
fi
if [ -z "$oci_image_tag" ]; then
  oci_image_tag=""
fi

echo "  OCI image ready: ${template_path}" >&2


# 2) Create LXC container from OCI image
echo "Step 2: Creating LXC container..." >&2
vm_id=$(execute_script_from_github \
  "json/shared/scripts/pre_start/conf-create-lxc-container.sh" \
  "vm_id" \
  "rootfs_storage=" \
  "template_path=${template_path}" \
  "vm_id=${vm_id}" \
  "vm_id_start=${vm_id_start}" \
  "disk_size=${disk_size}" \
  "memory=${memory}" \
  "bridge=${bridge}" \
  "hostname=${hostname}" \
  "application_id=${application_id}" \
  "application_name=${application_name}" \
  "oci_image=${resolved_oci_image}" \
  "oci_image_tag=${oci_image_tag}" \
  "ostype=${ostype}" \
  "arch=${arch}" \
  "startup_order=" \
  "startup_up=" \
  "startup_down=")

if [ -z "$vm_id" ]; then
  echo "Error: Failed to create LXC container" >&2
  exit 1
fi

echo "  Container created: ${vm_id}" >&2

# 2b) Configure static IP if provided
if [ -n "$static_ip" ]; then
  echo "Step 2b: Configuring static IP..." >&2
  execute_script_from_github \
    "json/shared/scripts/pre_start/conf-lxc-static-ip.sh" \
    "-" \
    "vm_id=${vm_id}" \
    "hostname=${hostname}" \
    "static_ip=${static_ip}" \
    "static_gw=${static_gw}" \
    "static_ip6=" \
    "static_gw6=" \
    "bridge=${bridge}" \
    "nameserver4=${nameserver}" \
    "nameserver6=" >/dev/null
  echo "  Static IP configured: ${static_ip} (gateway: ${static_gw})" >&2
fi

# 3) Configure UID/GID mapping (subuid/subgid only, container config after creation)
echo "Step 3: Configuring UID/GID mapping..." >&2
# Run mapping script and capture mapped UID/GID for later steps (idempotent to call twice)
mapped_uid=$(execute_script_from_github \
  "json/shared/scripts/pre_start/conf-setup-lxc-uid-mapping.py" \
  "mapped_uid" \
  "uid=${LXC_UID}" \
  "vm_id=${vm_id}" || echo "")
mapped_gid=$(execute_script_from_github \
  "json/shared/scripts/pre_start/conf-setup-lxc-gid-mapping.py" \
  "mapped_gid" \
  "gid=${LXC_GID}" \
  "uid=${LXC_UID}" \
  "vm_id=${vm_id}" || echo "")

# Fallback to defaults if mapper returned nothing
if [ -z "$mapped_uid" ]; then mapped_uid="$LXC_UID"; fi
if [ -z "$mapped_gid" ]; then mapped_gid="$LXC_GID"; fi

echo "  UID/GID ranges configured; mapped_uid=${mapped_uid}, mapped_gid=${mapped_gid}" >&2

# 4) Create and attach storage volumes (shared volume strategy)
echo "Step 4: Preparing storage volumes..." >&2
rootfs_storage=$(pct config "$vm_id" 2>/dev/null | awk -F: '/^rootfs:/ {print $2}' | cut -d',' -f1 | cut -d':' -f1 | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')
if [ -z "$rootfs_storage" ]; then
  rootfs_storage="$storage"
fi
storage_type=$(get_storage_type "$rootfs_storage")

echo "  Volume storage: ${rootfs_storage} (type: ${storage_type})" >&2
echo "  Host: ${proxmox_hostname}" >&2
echo "  Container ID: ${vm_id}, Container hostname: ${hostname}" >&2
echo "  Using UID/GID: ${LXC_UID}/${LXC_GID} (mapped: ${mapped_uid}/${mapped_gid})" >&2

export VOLUMES="config=/config
secure=/secure,0700"

# Execute storage volumes script and capture the shared_volpath from JSON output
shared_volpath=$(execute_script_from_github \
  "json/shared/scripts/pre_start/conf-create-storage-volumes-for-lxc.sh" \
  "shared_volpath" \
  "vm_id=${vm_id}" \
  "hostname=${hostname}" \
  "volumes=\$VOLUMES" \
  "volume_storage=${rootfs_storage}" \
  "volume_size=4G" \
  "volume_backup=true" \
  "volume_shared=true" \
  "uid=${LXC_UID}" \
  "gid=${LXC_GID}" \
  "mapped_uid=${mapped_uid}" \
  "mapped_gid=${mapped_gid}" \
  "addon_volumes=")

if [ -z "$shared_volpath" ]; then
  echo "Error: Failed to create/attach storage volumes or get shared volume path" >&2
  exit 1
fi

config_volume_path="${shared_volpath}/volumes/${hostname}/config"
secure_volume_path="${shared_volpath}/volumes/${hostname}/secure"
echo "  Config volume: ${config_volume_path}" >&2
echo "  Secure volume: ${secure_volume_path}" >&2

# Write storagecontext.json before starting the container so the app can read it on startup
echo "Step 5.1: Writing storagecontext.json to /config..." >&2
storagecontext_file="${config_volume_path}/storagecontext.json"
# Prepare changed params for VMInstall context
changed_params_json="[
  {\"name\":\"vm_id\",\"value\":\"${vm_id}\"},
  {\"name\":\"hostname\",\"value\":\"${hostname}\"},
  {\"name\":\"disk_size\",\"value\":${disk_size}},
  {\"name\":\"memory\",\"value\":${memory}},
  {\"name\":\"bridge\",\"value\":\"${bridge}\"},
  {\"name\":\"config_volume_path\",\"value\":\"${config_volume_path}\"},
  {\"name\":\"secure_volume_path\",\"value\":\"${secure_volume_path}\"},
  {\"name\":\"application_id\",\"value\":\"${application_id}\"},
  {\"name\":\"oci_image\",\"value\":\"${resolved_oci_image}\"},
  {\"name\":\"oci_image_tag\",\"value\":\"${oci_image_tag}\"},
  {\"name\":\"storage\",\"value\":\"${storage}\"}
]"
mkdir -p "$(dirname "${storagecontext_file}")" 2>/dev/null || true
cat > "${storagecontext_file}" <<JSON
{
  "ve_${proxmox_hostname}": {
    "host": "${proxmox_hostname}",
    "port": 22,
    "current": true
  },
  "vminstall_${hostname}_lxc-manager": {
    "hostname": "${hostname}",
    "application": "${application_id}",
    "task": "installation",
    "changedParams": ${changed_params_json}
  }
}
JSON
# Set ownership to mapped UID/GID so container process can write to it
chown "${mapped_uid}:${mapped_gid}" "${storagecontext_file}"
echo "  storagecontext.json written at: ${storagecontext_file} (owner: ${mapped_uid}:${mapped_gid})" >&2

# 5.2) Write LXC notes/description
echo "Step 5.2: Writing LXC notes..." >&2
# For self-install, deployer_base_url points to this container
# ve_context_key must match the key in storagecontext.json (ve_${proxmox_hostname})
# Use --deployer-url if provided (for NAT/port-forwarding), otherwise use container hostname
if [ -n "$deployer_url" ]; then
  deployer_base_url="$deployer_url"
  echo "  Using external deployer URL: ${deployer_base_url}" >&2
else
  deployer_base_url="http://${hostname}:3080"
fi

# Download and Base64-encode the application icon for embedding in notes
icon_url="https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/json/applications/oci-lxc-deployer/icon.svg"
icon_base64=$(curl -fsSL "$icon_url" 2>/dev/null | base64 | tr -d '\n' || echo "")
icon_mime_type="image/svg+xml"

execute_script_from_github \
  "json/shared/scripts/pre_start/host-write-lxc-notes.py" \
  "notes_written" \
  "vm_id=${vm_id}" \
  "hostname=${hostname}" \
  "template_path=${template_path}" \
  "oci_image=${resolved_oci_image}" \
  "oci_image_tag=${oci_image_tag}" \
  "application_id=${application_id}" \
  "application_name=${application_name}" \
  "deployer_base_url=${deployer_base_url}" \
  "ve_context_key=ve_${proxmox_hostname}" \
  "icon_base64=${icon_base64}" \
  "icon_mime_type=${icon_mime_type}" \
  "username=lxc" \
  "uid=${LXC_UID}" \
  "gid=${LXC_GID}" \
  "is_deployer=true" || {
  echo "Error: Failed to write LXC notes" >&2
  exit 1
}

# 6) Ensure container is running
echo "Step 6: Ensuring container is running..." >&2
if ! pct status "${vm_id}" | grep -q "running"; then
  pct start "${vm_id}" || {
    echo "Error: Failed to start container" >&2
    exit 1
  }
  # Wait for container to be ready
  echo "  Waiting for container to be ready..." >&2
  sleep 3
  for i in 1 2 3 4 5; do
    if pct status "${vm_id}" | grep -q "running"; then
      break
    fi
    sleep 2
  done
fi

if ! pct status "${vm_id}" | grep -q "running"; then
  echo "Warning: Container may not be fully ready" >&2
else
  echo "  Container is running" >&2
fi

  # Fix volume ownership from host side (Proxmox may UID-shift bind-mount
  # content for unprivileged containers; chown from inside may fail with EPERM
  # if the on-disk UID is outside the container's mapped range)
  echo "  Fixing volume ownership (mapped_uid=${mapped_uid}, mapped_gid=${mapped_gid})..." >&2
  chown "${mapped_uid}:${mapped_gid}" "${config_volume_path}" 2>/dev/null || true
  chown "${mapped_uid}:${mapped_gid}" "${secure_volume_path}" 2>/dev/null || true
  mkdir -p "${secure_volume_path}/.ssh"
  chown "${mapped_uid}:${mapped_gid}" "${secure_volume_path}/.ssh"
  chmod 700 "${secure_volume_path}/.ssh"

# 7) Setup SSH access — all from host side via secure_volume_path
echo "Step 7: Setting up SSH access..." >&2
ssh_dir="${secure_volume_path}/.ssh"

# Check if key already exists (e.g. from a previous install with persistent /secure volume)
container_pubkey=""
if [ -f "${ssh_dir}/id_ed25519.pub" ]; then
  container_pubkey=$(cat "${ssh_dir}/id_ed25519.pub" 2>/dev/null | grep -v "^$" || echo "")
  [ -n "$container_pubkey" ] && echo "  Found existing SSH public key" >&2
elif [ -f "${ssh_dir}/id_rsa.pub" ]; then
  container_pubkey=$(cat "${ssh_dir}/id_rsa.pub" 2>/dev/null | grep -v "^$" || echo "")
  [ -n "$container_pubkey" ] && echo "  Found existing SSH public key (RSA)" >&2
fi

# Generate key if none exists (on host, write directly to secure volume)
if [ -z "$container_pubkey" ]; then
  echo "  Generating SSH keypair..." >&2
  ssh-keygen -t ed25519 -f "${ssh_dir}/id_ed25519" -N "" -C "oci-lxc-deployer@auto-generated" \
    >/dev/null 2>&1
  chown "${mapped_uid}:${mapped_gid}" "${ssh_dir}/id_ed25519" "${ssh_dir}/id_ed25519.pub" 2>/dev/null || true
  chmod 600 "${ssh_dir}/id_ed25519"
  chmod 644 "${ssh_dir}/id_ed25519.pub"
  container_pubkey=$(cat "${ssh_dir}/id_ed25519.pub" 2>/dev/null | grep -v "^$" || echo "")
  [ -n "$container_pubkey" ] && echo "  SSH keypair generated" >&2
fi

if [ -z "$container_pubkey" ]; then
  echo "Error: Failed to generate SSH keypair at ${ssh_dir}" >&2
  exit 1
fi

# Add container public key to host authorized_keys
root_auth_keys="/root/.ssh/authorized_keys"
mkdir -p /root/.ssh && chmod 700 /root/.ssh

if [ -L "${root_auth_keys}" ]; then
  actual_auth_keys=$(readlink -f "${root_auth_keys}")
else
  actual_auth_keys="${root_auth_keys}"
fi

if [ -f "${actual_auth_keys}" ] && grep -qF "${container_pubkey}" "${actual_auth_keys}" 2>/dev/null; then
  echo "  SSH key already in root authorized_keys" >&2
else
  echo "${container_pubkey}" >> "${actual_auth_keys}"
  chmod 600 "${actual_auth_keys}"
  chown root:root "${actual_auth_keys}" 2>/dev/null || true
  echo "  Added SSH key to root authorized_keys" >&2
fi

# Pre-populate known_hosts with PVE host key
host_pubkey=$(ssh-keyscan -t ed25519 "${proxmox_hostname}" 2>/dev/null || true)
if [ -z "$host_pubkey" ]; then
  # Hostname might not resolve on host itself; try localhost and rewrite
  host_pubkey=$(ssh-keyscan -t ed25519 localhost 2>/dev/null | sed "s/^localhost/${proxmox_hostname}/" || true)
fi
if [ -n "$host_pubkey" ]; then
  echo "${host_pubkey}" >> "${ssh_dir}/known_hosts"
  chown "${mapped_uid}:${mapped_gid}" "${ssh_dir}/known_hosts"
  chmod 644 "${ssh_dir}/known_hosts"
  echo "  PVE host key added to known_hosts" >&2
fi

echo "  SSH access configured" >&2

# 8) Application startup note (no API configuration; app reads storagecontext.json)
echo "Step 8: Application startup context ready (no API calls)" >&2

# 9) Enable HTTPS via reconfigure (optional)
https_done=""
if [ "$enable_https" = "true" ]; then
  echo "Step 9: Enabling HTTPS via reconfigure..." >&2

  # Resolve container IP (use static_ip if set, otherwise query from container)
  container_ip=""
  if [ -n "$static_ip" ]; then
    container_ip="${static_ip%/*}"
  else
    # Wait briefly for networking, then grab the IP
    sleep 3
    container_ip=$(pct exec "${vm_id}" -- sh -c "hostname -I 2>/dev/null" | awk '{print $1}')
  fi

  if [ -z "$container_ip" ]; then
    echo "Warning: Could not determine container IP, skipping HTTPS setup" >&2
  else

  # Wait for deployer API to be ready
  deployer_api="http://${container_ip}:3080"
  echo "  Waiting for deployer API at ${deployer_api}..." >&2
  for i in $(seq 1 30); do
    if curl -sf "${deployer_api}/api/applications" >/dev/null 2>&1; then
      break
    fi
    sleep 2
  done

  if ! curl -sf "${deployer_api}/api/applications" >/dev/null 2>&1; then
    echo "Warning: Deployer API not ready after 60s, skipping HTTPS setup" >&2
  else
    # Ensure container can resolve PVE hostname (needed for SSH from deployer to host)
    # Only add /etc/hosts entry if DNS resolution fails inside the container
    if [ -n "$proxmox_hostname" ] && ! pct exec "${vm_id}" -- getent hosts "$proxmox_hostname" >/dev/null 2>&1; then
      pve_host_ip=$(getent hosts "$proxmox_hostname" 2>/dev/null | awk '{print $1; exit}')
      if [ -z "$pve_host_ip" ]; then
        # Host can't resolve either — use IP of the default-route interface
        pve_host_ip=$(ip -4 addr show "$(ip route | awk '/default/ {print $5; exit}')" 2>/dev/null | awk '/inet / {split($2, a, "/"); print a[1]; exit}')
      fi
      if [ -n "$pve_host_ip" ]; then
        pct exec "${vm_id}" -- sh -c "echo '${pve_host_ip} ${proxmox_hostname} ${proxmox_hostname%%.*}' >> /etc/hosts"
        echo "  Added /etc/hosts entry: ${pve_host_ip} ${proxmox_hostname}" >&2
      fi
    fi

    # Resolve VE context key
    ve_key=$(curl -sf "${deployer_api}/api/ssh/config/${proxmox_hostname}" | \
      python3 -c "import sys,json; print(json.load(sys.stdin)['key'])" 2>/dev/null || echo "")

    if [ -z "$ve_key" ]; then
      echo "Warning: Could not resolve VE context for '${proxmox_hostname}', skipping HTTPS setup" >&2
    else
      echo "  VE context: ${ve_key}" >&2

      # Verify SSH connection is ready (deployer needs SSH to PVE host for reconfigure)
      echo "  Verifying SSH connection to PVE host (${proxmox_hostname}:22)..." >&2
      ssh_ok=""
      for i in $(seq 1 5); do
        ssh_check=$(curl -s --max-time 5 \
          "${deployer_api}/api/ssh/check?host=${proxmox_hostname}&port=22" 2>/dev/null || echo "")
        echo "  SSH check attempt $i: ${ssh_check}" >&2
        if printf '%s' "$ssh_check" | python3 -c "import sys,json; d=json.load(sys.stdin); sys.exit(0 if d.get('permissionOk') else 1)" 2>/dev/null; then
          ssh_ok="true"
          break
        fi
        sleep 2
      done

      if [ "$ssh_ok" != "true" ]; then
        echo "Warning: SSH connection to PVE host not ready, skipping HTTPS setup" >&2
      else
        echo "  SSH connection verified" >&2

        # Generate CA certificate (required for SSL addon)
        echo "  Generating CA certificate..." >&2
        ca_resp=$(curl -s -X POST \
          "${deployer_api}/api/${ve_key}/ve/certificates/ca/generate" 2>/dev/null || echo "")
        ca_ok=$(printf '%s' "$ca_resp" | python3 -c "import sys,json; d=json.load(sys.stdin); print('true' if d.get('success') else 'false')" 2>/dev/null || echo "false")
        if [ "$ca_ok" = "true" ]; then
          echo "  CA certificate generated" >&2
        else
          echo "  CA certificate: $(printf '%s' "$ca_resp" | python3 -c "import sys,json; print(json.load(sys.stdin).get('error','already exists or failed'))" 2>/dev/null || echo "see response")" >&2
        fi

        # Set domain suffix for SSL certificates
        echo "  Setting domain suffix to ${domain_suffix}..." >&2
        suffix_resp=$(curl -s -X POST -H "Content-Type: application/json" \
          -d "{\"domain_suffix\":\"${domain_suffix}\"}" \
          "${deployer_api}/api/${ve_key}/ve/certificates/domain-suffix" 2>/dev/null || echo "")
        suffix_ok=$(printf '%s' "$suffix_resp" | python3 -c "import sys,json; d=json.load(sys.stdin); print('true' if d.get('success') else 'false')" 2>/dev/null || echo "false")
        if [ "$suffix_ok" = "true" ]; then
          echo "  Domain suffix set to ${domain_suffix}" >&2
        else
          echo "  Domain suffix: $(printf '%s' "$suffix_resp" | python3 -c "import sys,json; print(json.load(sys.stdin).get('error','failed'))" 2>/dev/null || echo "see response")" >&2
        fi

        # Enable SSL addon on the existing container
        params_json="{\"application\":\"oci-lxc-deployer\",\"task\":\"reconfigure\",\"params\":[{\"name\":\"previouse_vm_id\",\"value\":${vm_id}},{\"name\":\"vm_id_start\",\"value\":${vm_id_start:-${vm_id}}}],\"selectedAddons\":[\"addon-ssl\"]}"

        pct exec "${vm_id}" -- sh -c "printf '%s' '${params_json}' > /tmp/ssl-params.json"

        # Run reinstall via oci-lxc-cli (already in OCI image via npm install -g)
        echo "  Running reinstall with SSL via oci-lxc-cli..." >&2
        pct exec "${vm_id}" -- oci-lxc-cli remote \
          --server http://localhost:3080 \
          --ve "${proxmox_hostname}" \
          --insecure \
          --timeout 600 \
          /tmp/ssl-params.json >&2 \
          && https_done="true" || true

        # Fallback: if CLI died (container replaced before finished), check HTTPS
        if [ "$https_done" != "true" ]; then
          echo "  CLI exited, checking HTTPS on ${container_ip}:3443..." >&2
          for i in $(seq 1 24); do
            if curl -sk --connect-timeout 3 "https://${container_ip}:3443/" >/dev/null 2>&1; then
              https_done="true"
              break
            fi
            sleep 5
          done
        fi

        if [ "$https_done" = "true" ]; then
          echo "  HTTPS enabled." >&2
        else
          echo "  Warning: HTTPS did not come up within 120s" >&2
        fi

      fi
    fi
  fi

  fi # end container_ip check
fi

echo "" >&2
echo "Installation complete!" >&2
echo "  Container ID: ${vm_id}" >&2
echo "  Hostname: ${hostname}" >&2
echo "  Config: ${config_volume_path}" >&2
echo "  Secure: ${secure_volume_path}" >&2
echo "" >&2
if [ "$enable_https" = "true" ] && [ "$https_done" = "true" ]; then
  echo "  Access the web interface at https://${hostname}:3443" >&2
else
  echo "  Access the web interface at http://${hostname}:3080" >&2
fi

exit 0
