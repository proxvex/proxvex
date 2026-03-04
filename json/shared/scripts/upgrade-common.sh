#!/bin/sh
# upgrade-common.sh - Shared library for copy-upgrade and upgrade tasks.
#
# Rules:
#   - No {{ }} template variables (this is a library, not a script)
#   - No direct execution - only function definitions
#   - All functions use explicit arguments (no globals except log/fail)
#
# Functions:
#   extract_description(conf_file)
#   decode_url(text)
#   extract_addons(text)
#   check_managed_marker(desc, desc_decoded, conf_text, conf_text_decoded)
#   get_conf_value(conf_file, key)
#   get_conf_line(conf_file, key)
#   normalize_size_to_gb(val)
#   write_notes_block(conf_file, oci_image, app_id, app_name)
#   copy_mappings_between(src_conf, tgt_conf)
#   merge_conf_from_backup(backup_conf, target_conf, skip_keys_space_separated)
#   apply_new_conf_to_backup(backup_conf, new_conf)
#   update_notes_version(conf_file, new_version, new_oci_image)
#   update_notes_vmid(conf_file, old_vmid, new_vmid)

# Extract description block from a Proxmox config (description: ... + indented continuation lines)
extract_description() {
  awk '
    BEGIN { in_desc=0 }
    /^description:/ {
      in_desc=1;
      sub(/^description:[ ]?/, "", $0);
      print $0;
      next
    }
    in_desc==1 {
      if ($0 ~ /^[[:space:]]+/) {
        sub(/^[[:space:]]+/, "", $0);
        print $0;
        next
      }
      exit
    }
  ' "$1" || true
}

# Decode %XX URL sequences (POSIX sh compatible via python3)
decode_url() {
  python3 - <<'PY' "$1"
import sys
from urllib.parse import unquote
print(unquote(sys.argv[1] if len(sys.argv) > 1 else ""))
PY
}

# Extract installed addon keys from container notes/config text.
# Outputs comma-separated list.
extract_addons() {
  python3 - <<'PY' "$1"
import sys
import re
from urllib.parse import unquote

text = sys.argv[1] if len(sys.argv) > 1 else ""
decoded = unquote(text)

addons = set()
for match in re.findall(r'addon[:%]3[Aa]([a-zA-Z0-9_-]+)', text):
    addons.add(match)
for match in re.findall(r'addon:([a-zA-Z0-9_-]+)', decoded):
    addons.add(match)

print(",".join(sorted(addons)))
PY
}

# Check that the container has the oci-lxc-deployer managed marker.
# Returns 0 if marker found, 1 if not.
# Args: desc desc_decoded conf_text conf_text_decoded
check_managed_marker() {
  _desc="$1"
  _desc_decoded="$2"
  _conf_text="$3"
  _conf_text_decoded="$4"

  if printf "%s\n" "$_desc" | grep -qiE 'oci-lxc-deployer:managed|oci-lxc-deployer%3Amanaged|^# OCI LXC Deployer|Managed by .*oci-lxc-deployer'; then
    return 0
  fi
  if printf "%s\n" "$_desc_decoded" | grep -qiE 'oci-lxc-deployer:managed|^# OCI LXC Deployer|Managed by .*oci-lxc-deployer'; then
    return 0
  fi
  if printf "%s\n" "$_conf_text" | grep -qiE 'oci-lxc-deployer:managed|oci-lxc-deployer%3Amanaged'; then
    return 0
  fi
  if printf "%s\n" "$_conf_text_decoded" | grep -qiE 'oci-lxc-deployer:managed'; then
    return 0
  fi
  return 1
}

# Get a single config value by key from a conf file.
# Args: conf_file key
get_conf_value() {
  _conf="$1"
  _key="$2"
  awk -v k="$_key" -F':' 'BEGIN { found=0 }
    $1==k { sub(/^[^:]+:[ ]?/, "", $0); print $0; found=1; exit }
    END { if (!found) exit 1 }' "$_conf" 2>/dev/null
}

# Get a full config line (key: value) from a conf file.
# Args: conf_file key
get_conf_line() {
  _conf="$1"
  _key="$2"
  awk -v k="$_key" 'index($0, k":") == 1 { print $0; exit }' "$_conf" 2>/dev/null
}

# Normalize a size value (with T/G/M/K suffix) to GB integer.
# Args: val
normalize_size_to_gb() {
  val="$1"
  case "$val" in
    *[Tt])
      num=${val%[Tt]}
      echo $((num * 1024))
      ;;
    *[Gg])
      echo "${val%[Gg]}"
      ;;
    *[Mm])
      num=${val%[Mm]}
      awk -v m="$num" 'BEGIN { gb = int((m + 1023) / 1024); if (gb < 1) gb = 1; print gb }'
      ;;
    *[Kk])
      num=${val%[Kk]}
      awk -v k="$num" 'BEGIN { gb = int((k / 1024 / 1024) + 0.999); if (gb < 1) gb = 1; print gb }'
      ;;
    *)
      echo "$val"
      ;;
  esac
}

# Write the oci-lxc-deployer notes/marker block into a container conf file.
# Replaces any existing oci-lxc-deployer comment lines in description.
# Args: conf_file oci_image_raw app_id app_name
write_notes_block() {
  _conf="$1"
  _oci_image_raw="$2"
  _app_id="$3"
  _app_name="$4"

  OCI_IMAGE_VISIBLE=$(printf "%s" "$_oci_image_raw" | sed -E 's#^(docker|oci)://##')

  TMP_DESC=$(mktemp)
  {
    printf "<!-- oci-lxc-deployer:managed -->\n"
    if [ -n "$OCI_IMAGE_VISIBLE" ]; then
      printf "<!-- oci-lxc-deployer:oci-image %s -->\n" "$OCI_IMAGE_VISIBLE"
    fi
    if [ -n "$_app_id" ]; then
      printf "<!-- oci-lxc-deployer:application-id %s -->\n" "$_app_id"
    fi
    if [ -n "$_app_name" ]; then
      printf "<!-- oci-lxc-deployer:application-name %s -->\n" "$_app_name"
    fi
    if [ -n "$_app_id" ] || [ -n "$_app_name" ]; then
      if [ -n "$_app_id" ] && [ -n "$_app_name" ]; then
        printf "Application: %s (%s)\n\n" "$_app_name" "$_app_id"
      elif [ -n "$_app_name" ]; then
        printf "Application: %s\n\n" "$_app_name"
      else
        printf "Application ID: %s\n\n" "$_app_id"
      fi
    fi
    if [ -n "$OCI_IMAGE_VISIBLE" ]; then
      printf "OCI image: %s\n\n" "$OCI_IMAGE_VISIBLE"
    fi
  } > "$TMP_DESC"

  TMP_CONF=$(mktemp)
  awk '
    /^#.*oci-lxc-deployer/ { next }
    /^#.*OCI LXC Deployer/ { next }
    /^#.*Managed by .*oci-lxc-deployer/ { next }
    /^#.*Application:/ { next }
    /^#.*Application ID:/ { next }
    /^#.*OCI image:/ { next }
    { print }
  ' "$_conf" > "$TMP_CONF"

  while IFS= read -r line; do
    printf '#%s\n' "$line"
  done < "$TMP_DESC" >> "$TMP_CONF"

  cp "$TMP_CONF" "$_conf" >&2
  rm -f "$TMP_CONF" "$TMP_DESC"
}

# Copy mount points and device/usb mappings from source conf to target conf.
# Used by copy-upgrade (only copies specific mapping keys).
# Args: src_conf tgt_conf
copy_mappings_between() {
  _src="$1"
  _tgt="$2"

  MAPPINGS=$(grep -E '^(mp[0-9]+:|lxc\.mount\.entry:|dev[0-9]+:|usb[0-9]+:|lxc\.cgroup2\.devices\.)' "$_src" 2>/dev/null || true)

  TMP_CONF=$(mktemp)
  awk '
    /^mp[0-9]+:/ { next }
    /^lxc\.mount\.entry:/ { next }
    /^dev[0-9]+:/ { next }
    /^usb[0-9]+:/ { next }
    /^lxc\.cgroup2\.devices\./ { next }
    { print }
  ' "$_tgt" > "$TMP_CONF"

  if [ -n "$MAPPINGS" ]; then
    printf "%s\n" "$MAPPINGS" >> "$TMP_CONF"
  fi

  cp "$TMP_CONF" "$_tgt" >&2
  rm -f "$TMP_CONF"
}

# Merge ALL config lines from backup into target that are not already present.
# Used by upgrade (in-place): preserves all lxc.* settings, capabilities,
# iptables/nft rules, mount points, device mappings, etc.
#
# Args: backup_conf target_conf skip_keys_space_separated
#   skip_keys: space-separated list of config keys to NOT copy
#              (these were already set by pct create, e.g. "rootfs hostname memory swap cores net0 unprivileged arch ostype description")
merge_conf_from_backup() {
  _backup="$1"
  _target="$2"
  _skip_keys="$3"

  python3 - <<'PY' "$_backup" "$_target" "$_skip_keys"
import sys
import re

backup_file = sys.argv[1]
target_file = sys.argv[2]
skip_keys_raw = sys.argv[3] if len(sys.argv) > 3 else ""
skip_keys = set(skip_keys_raw.split()) if skip_keys_raw else set()

def get_key(line):
    """Extract the config key from a line, e.g. 'hostname: foo' -> 'hostname'"""
    m = re.match(r'^([a-zA-Z0-9_.]+)\s*:', line)
    if m:
        return m.group(1)
    return None

# Read target config - collect keys already present
target_lines = []
target_keys = set()
with open(target_file, 'r') as f:
    for line in f:
        target_lines.append(line.rstrip('\n'))
        key = get_key(line)
        if key:
            target_keys.add(key)

# Read backup config - find lines whose key is not already in target and not in skip list
lines_to_add = []
with open(backup_file, 'r') as f:
    for line in f:
        line = line.rstrip('\n')
        key = get_key(line)
        if key:
            if key in skip_keys or key in target_keys:
                continue
            lines_to_add.append(line)
        else:
            # Comment lines or blank lines starting with # from the conf file
            # (description is handled separately, skip it)
            pass

# Append missing lines to target
if lines_to_add:
    with open(target_file, 'a') as f:
        for line in lines_to_add:
            f.write(line + '\n')
PY
}

# Apply keys from a new conf (pct create output) into a backup conf.
# Uses backup as base (preserving comments/notes), overwrites only keys
# that appear in new conf. For multi-value keys like lxc.environment.runtime,
# matches by key + env var name so user-added values are preserved.
# Args: backup_conf new_conf
#   Result is written to new_conf path.
apply_new_conf_to_backup() {
  _backup="$1"
  _new="$2"

  python3 - <<'PY' "$_backup" "$_new"
import sys
import re

backup_file = sys.argv[1]
new_file = sys.argv[2]

def get_key(line):
    """Extract config key from line, e.g. 'hostname: foo' -> 'hostname'"""
    m = re.match(r'^([a-zA-Z0-9_.]+)\s*:', line)
    return m.group(1) if m else None

def get_line_identity(line):
    """Get the identity of a config line for matching.
    For lxc.environment.runtime: KEY=VALUE -> identity is 'lxc.environment.runtime:KEY='
    For other keys: identity is just the key name.
    """
    key = get_key(line)
    if not key:
        return None
    if key == "lxc.environment.runtime":
        m = re.match(r'^lxc\.environment\.runtime\s*:\s*([^=]+=)', line)
        if m:
            return "lxc.environment.runtime:" + m.group(1)
    return key

# Read new conf lines with their identities
new_identities = {}
with open(new_file, 'r') as f:
    for line in f:
        line = line.rstrip('\n')
        if not line or line.startswith('#'):
            continue
        identity = get_line_identity(line)
        if identity:
            if identity not in new_identities:
                new_identities[identity] = []
            new_identities[identity].append(line)

# Process backup: replace matched lines with new values, keep everything else
result = []
used_identities = set()
with open(backup_file, 'r') as f:
    for line in f:
        line = line.rstrip('\n')
        if line.startswith('#') or not line.strip():
            result.append(line)
            continue
        identity = get_line_identity(line)
        if identity and identity in new_identities:
            if identity not in used_identities:
                used_identities.add(identity)
                for new_line in new_identities[identity]:
                    result.append(new_line)
            # Skip the old backup line (replaced by new)
        else:
            result.append(line)

# Append new lines whose identity was not found in backup
for identity, lines in new_identities.items():
    if identity not in used_identities:
        for line in lines:
            result.append(line)

with open(new_file, 'w') as f:
    for line in result:
        f.write(line + '\n')
PY
}

# Update version and OCI image markers in container notes (comment lines).
# Handles both URL-encoded (%3A) and plain (:) format.
# Args: conf_file new_version new_oci_image
update_notes_version() {
  _conf="$1"
  _version="$2"
  _oci_image="$3"

  python3 - <<'PY' "$_conf" "$_version" "$_oci_image"
import sys
import re

conf_file = sys.argv[1]
new_version = sys.argv[2] if len(sys.argv) > 2 else ""
new_oci_image_raw = sys.argv[3] if len(sys.argv) > 3 else ""

# Strip docker:// or oci:// prefix
new_oci_image = re.sub(r'^(docker|oci)://', '', new_oci_image_raw)

with open(conf_file, 'r') as f:
    lines = f.readlines()

result = []
for line in lines:
    orig = line.rstrip('\n')

    # Update version hidden marker (URL-encoded)
    if new_version and re.search(r'oci-lxc-deployer%3Aversion\s', orig):
        orig = re.sub(
            r'(oci-lxc-deployer%3Aversion\s+)\S+(\s*-->)',
            r'\g<1>' + new_version + r'\2', orig)
    # Update version hidden marker (plain)
    elif new_version and re.search(r'oci-lxc-deployer:version\s', orig):
        orig = re.sub(
            r'(oci-lxc-deployer:version\s+)\S+(\s*-->)',
            r'\g<1>' + new_version + r'\2', orig)

    # Update visible version text (URL-encoded: Version%3A)
    if new_version and re.search(r'^#Version%3A\s', orig):
        orig = re.sub(r'^(#Version%3A\s+)\S+', r'\g<1>' + new_version, orig)
    # Update visible version text (plain: #Version:)
    elif new_version and re.search(r'^#Version:\s', orig):
        orig = re.sub(r'^(#Version:\s+)\S+', r'\g<1>' + new_version, orig)

    # Update OCI image hidden marker (URL-encoded)
    if new_oci_image and re.search(r'oci-lxc-deployer%3Aoci-image\s', orig):
        orig = re.sub(
            r'(oci-lxc-deployer%3Aoci-image\s+)\S+(\s*-->)',
            r'\g<1>' + new_oci_image + r'\2', orig)
    # Update OCI image hidden marker (plain)
    elif new_oci_image and re.search(r'oci-lxc-deployer:oci-image\s', orig):
        orig = re.sub(
            r'(oci-lxc-deployer:oci-image\s+)\S+(\s*-->)',
            r'\g<1>' + new_oci_image + r'\2', orig)

    # Update visible OCI image text (URL-encoded)
    if new_oci_image and re.search(r'^#OCI image%3A\s', orig):
        orig = re.sub(r'^(#OCI image%3A\s+)\S+', r'\g<1>' + new_oci_image, orig)
    # Update visible OCI image text (plain)
    elif new_oci_image and re.search(r'^#OCI image:\s', orig):
        orig = re.sub(r'^(#OCI image:\s+)\S+', r'\g<1>' + new_oci_image, orig)

    result.append(orig)

with open(conf_file, 'w') as f:
    for line in result:
        f.write(line + '\n')
PY
}

# Update VMID references in container notes and config.
# Used by copy-upgrade where the target VMID differs from source.
# Args: conf_file old_vmid new_vmid
update_notes_vmid() {
  _conf="$1"
  _old_vmid="$2"
  _new_vmid="$3"

  python3 - <<'PY' "$_conf" "$_old_vmid" "$_new_vmid"
import sys
import re

conf_file = sys.argv[1]
old_vmid = sys.argv[2]
new_vmid = sys.argv[3]

with open(conf_file, 'r') as f:
    lines = f.readlines()

result = []
for line in lines:
    orig = line.rstrip('\n')

    # Update log-url marker: .../logs/VE_CONTEXT/OLD_VMID -> .../logs/VE_CONTEXT/NEW_VMID
    if re.search(r'oci-lxc-deployer[:%]3[Aa]log-url', orig):
        orig = re.sub(
            r'(/logs/[^/\s]+/)' + re.escape(old_vmid) + r'(?=[\s">)]|$)',
            r'\g<1>' + new_vmid, orig)

    # Update visible log links: .../logs/VE_CONTEXT/OLD_VMID -> .../logs/VE_CONTEXT/NEW_VMID
    elif re.search(r'/logs/[^/)\s]+/' + re.escape(old_vmid) + r'(?=[)\s])', orig):
        orig = re.sub(
            r'(/logs/[^/\s]+/)' + re.escape(old_vmid) + r'(?=[)\s">]|$)',
            r'\g<1>' + new_vmid, orig)

    # Update lxc.console.logfile: <hostname>-OLD_VMID.log -> <hostname>-NEW_VMID.log
    if orig.startswith('lxc.console.logfile'):
        orig = re.sub(
            r'-' + re.escape(old_vmid) + r'\.log',
            '-' + new_vmid + '.log', orig)

    # Update visible log file path in notes: hostname-OLD_VMID.log
    if re.search(r'^#.*Log file', orig):
        orig = re.sub(
            r'-' + re.escape(old_vmid) + r'\.log',
            '-' + new_vmid + '.log', orig)

    result.append(orig)

with open(conf_file, 'w') as f:
    for line in result:
        f.write(line + '\n')
PY
}
