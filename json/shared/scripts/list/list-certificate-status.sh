#!/bin/sh
# List Certificate Status
#
# Scans all volume directories for certificate files and reports their status.
# Runs on PVE host via SSH.
#
# Auto-discovers volumes directories from:
#   1. shared_volpath (if provided)
#   2. /mnt scan (non-ZFS storage)
#   3. ZFS mountpoints
#
# Template variables:
#   shared_volpath - Base path for shared volumes (optional)

SHARED_VOLPATH="{{ shared_volpath }}"

# Discover all volumes directories
VOLUMES_DIRS=""

# 1. Use shared_volpath if provided
if [ -n "$SHARED_VOLPATH" ] && [ "$SHARED_VOLPATH" != "NOT_DEFINED" ] && [ -d "${SHARED_VOLPATH}/volumes" ]; then
  VOLUMES_DIRS="${SHARED_VOLPATH}/volumes"
fi

# 2. Scan /mnt for non-ZFS volumes
for DIR in $(find /mnt -maxdepth 3 -name "volumes" -type d 2>/dev/null); do
  case " $VOLUMES_DIRS " in *" $DIR "*) ;; *) VOLUMES_DIRS="$VOLUMES_DIRS $DIR" ;; esac
done

# 3. Scan ZFS mountpoints for volumes directories
if command -v zfs >/dev/null 2>&1; then
  for MP in $(zfs list -H -o mountpoint 2>/dev/null); do
    [ -d "${MP}/volumes" ] || continue
    DIR="${MP}/volumes"
    case " $VOLUMES_DIRS " in *" $DIR "*) ;; *) VOLUMES_DIRS="$VOLUMES_DIRS $DIR" ;; esac
  done
fi

# Build JSON array of certificate statuses
RESULT="["
FIRST=true

for VOLUMES_DIR in $VOLUMES_DIRS; do
  [ -d "$VOLUMES_DIR" ] || continue

  for HOST_DIR in "$VOLUMES_DIR"/*/; do
    [ -d "$HOST_DIR" ] || continue
    HOSTNAME=$(basename "$HOST_DIR")

    # Find all certificate files (.pem and .crt) in this host's volume directories
    for CRT_FILE in $(find "$HOST_DIR" \( -name "*.pem" -o -name "*.crt" \) -type f 2>/dev/null); do
      if ! openssl x509 -in "$CRT_FILE" -noout 2>/dev/null; then
        continue
      fi

      SUBJECT=$(openssl x509 -in "$CRT_FILE" -noout -subject 2>/dev/null | sed 's/^subject= *//')
      END_DATE_STR=$(openssl x509 -in "$CRT_FILE" -noout -enddate 2>/dev/null | sed 's/^notAfter=//')
      END_EPOCH=$(date -d "$END_DATE_STR" +%s 2>/dev/null || date -j -f "%b %d %T %Y %Z" "$END_DATE_STR" +%s 2>/dev/null || echo 0)
      NOW_EPOCH=$(date +%s)
      DAYS_REMAINING=$(( (END_EPOCH - NOW_EPOCH) / 86400 ))

      # Determine certtype from filename (Let's Encrypt + legacy naming)
      BASENAME=$(basename "$CRT_FILE")
      case "$BASENAME" in
        chain.pem|ca.crt)           CERTTYPE="ca_pub" ;;
        fullchain.pem|fullchain.crt) CERTTYPE="fullchain" ;;
        cert.pem)                   CERTTYPE="server" ;;
        privkey.pem)                CERTTYPE="key" ;;
        *)                          CERTTYPE="unknown" ;;
      esac

      # Determine status
      if [ "$DAYS_REMAINING" -le 0 ]; then
        STATUS="expired"
      elif [ "$DAYS_REMAINING" -le 30 ]; then
        STATUS="warning"
      else
        STATUS="ok"
      fi

      REL_FILE=$(echo "$CRT_FILE" | sed "s|^${VOLUMES_DIR}/||")

      if [ "$FIRST" = true ]; then
        FIRST=false
      else
        RESULT="${RESULT},"
      fi

      RESULT="${RESULT}{\"hostname\":\"${HOSTNAME}\",\"file\":\"${REL_FILE}\",\"certtype\":\"${CERTTYPE}\",\"subject\":\"${SUBJECT}\",\"expiry_date\":\"${END_DATE_STR}\",\"days_remaining\":${DAYS_REMAINING},\"status\":\"${STATUS}\"}"
    done
  done
done 

RESULT="${RESULT}]"

echo "[{\"id\":\"certificates\",\"value\":${RESULT}}]"
