#!/bin/sh
# List Certificate Status
#
# Scans all managed LXC volumes (subvol-<VMID>-<hostname>-<key>) for certificate
# files and reports their status.
# Runs on PVE host via SSH.
#
# Volume layout (post managed-volumes migration):
#   <storage>:subvol-<VMID>-<hostname>-<key>  → resolved via `pvesm path`
# The container rootdisks (subvol-<VMID>-disk-*) are skipped.
#
# Template variables:
#   VOLUME_STORAGE - Proxmox storage ID to scan (default: local-zfs)

STORAGE="${VOLUME_STORAGE:-local-zfs}"

RESULT="["
FIRST=true

append_cert() {
  _hn="$1"
  _crt="$2"
  _rel="$3"

  [ -f "$_crt" ] || return 0
  openssl x509 -in "$_crt" -noout 2>/dev/null || return 0

  SUBJECT=$(openssl x509 -in "$_crt" -noout -subject 2>/dev/null | sed 's/^subject= *//')
  ISSUER=$(openssl x509 -in "$_crt" -noout -issuer 2>/dev/null | sed 's/^issuer= *//')
  END_DATE_STR=$(openssl x509 -in "$_crt" -noout -enddate 2>/dev/null | sed 's/^notAfter=//')
  END_EPOCH=$(date -d "$END_DATE_STR" +%s 2>/dev/null || date -j -f "%b %d %T %Y %Z" "$END_DATE_STR" +%s 2>/dev/null || echo 0)
  NOW_EPOCH=$(date +%s)
  DAYS_REMAINING=$(( (END_EPOCH - NOW_EPOCH) / 86400 ))

  BASENAME=$(basename "$_crt")
  # fullchain.pem is treated as the server cert (contains leaf + chain) since
  # the deployer's own renewal flow writes exactly this file.
  case "$BASENAME" in
    chain.pem|ca.crt)               CERTTYPE="ca_pub" ;;
    fullchain.pem|fullchain.crt)    CERTTYPE="server" ;;
    cert.pem)                       CERTTYPE="server" ;;
    privkey.pem)                    CERTTYPE="key" ;;
    *)                              CERTTYPE="unknown" ;;
  esac

  if [ "$DAYS_REMAINING" -le 0 ]; then
    STATUS="expired"
  elif [ "$DAYS_REMAINING" -le 30 ]; then
    STATUS="warning"
  else
    STATUS="ok"
  fi

  if [ "$FIRST" = true ]; then
    FIRST=false
  else
    RESULT="${RESULT},"
  fi

  RESULT="${RESULT}{\"hostname\":\"${_hn}\",\"file\":\"${_rel}\",\"certtype\":\"${CERTTYPE}\",\"subject\":\"${SUBJECT}\",\"issuer\":\"${ISSUER}\",\"expiry_date\":\"${END_DATE_STR}\",\"days_remaining\":${DAYS_REMAINING},\"status\":\"${STATUS}\"}"
}

if command -v pvesm >/dev/null 2>&1; then
  VOLIDS=$(pvesm list "$STORAGE" --content rootdir 2>/dev/null | awk 'NR>1 {print $1}')

  for volid in $VOLIDS; do
    volname="${volid##*:}"

    # Skip root disks and stale/backup volumes. The deployer leaves *.backup
    # and *.bak suffixes behind after destructive operations; they hold the
    # same certs the active volume has and would produce duplicate rows.
    case "$volname" in
      subvol-*-disk-*) continue ;;
      *.backup|*.bak|*.old) continue ;;
    esac

    # Extract hostname: subvol-<VMID>-<hostname>-<key> → <hostname>
    # The key suffix is everything after the last "-" (e.g. "certs", "app").
    stem="${volname#subvol-}"
    case "$stem" in
      *-*-*) ;;         # need at least VMID-host-key
      *) continue ;;
    esac
    stem="${stem#*-}"          # <hostname>-<key>
    hostname="${stem%-*}"
    [ -n "$hostname" ] || continue

    vpath=$(pvesm path "$volid" 2>/dev/null || true)
    [ -n "$vpath" ] && [ -d "$vpath" ] || continue

    # Collect cert files, but emit only ONE "server" cert per volume: prefer
    # fullchain.pem (leaf + chain — what's actually served), fall back to
    # cert.pem (leaf only). CA files and keys are emitted separately.
    CERT_FILES=$(find "$vpath" \( -name "*.pem" -o -name "*.crt" \) -type f 2>/dev/null)
    FULLCHAIN_FOUND=""
    for cf in $CERT_FILES; do
      case "$(basename "$cf")" in
        fullchain.pem|fullchain.crt) FULLCHAIN_FOUND="$cf"; break ;;
      esac
    done
    for cf in $CERT_FILES; do
      # Skip cert.pem if a fullchain exists (same subject, would dupe)
      if [ -n "$FULLCHAIN_FOUND" ] && [ "$(basename "$cf")" = "cert.pem" ]; then
        continue
      fi
      rel="${volname}/${cf#$vpath/}"
      append_cert "$hostname" "$cf" "$rel"
    done
  done
fi

RESULT="${RESULT}]"

# Encode value as JSON string to satisfy outputs.schema.json (value must be a primitive)
ESCAPED=$(printf '%s' "$RESULT" | sed 's/\\/\\\\/g; s/"/\\"/g')
echo "[{\"id\":\"certificates\",\"value\":\"${ESCAPED}\"}]"
