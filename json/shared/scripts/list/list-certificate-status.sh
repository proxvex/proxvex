#!/bin/sh
# List Certificate Status
#
# Scans shared volume directories for certificate files and reports their status.
# Runs on PVE host via SSH.
#
# Template variables:
#   shared_volpath - Base path for shared volumes (auto-resolved)

SHARED_VOLPATH="{{ shared_volpath }}"

# Default shared_volpath if not set
if [ -z "$SHARED_VOLPATH" ] || [ "$SHARED_VOLPATH" = "NOT_DEFINED" ]; then
  SHARED_VOLPATH="/mnt/shared"
fi

VOLUMES_DIR="${SHARED_VOLPATH}/volumes"

# Build JSON array of certificate statuses
RESULT="["
FIRST=true

if [ -d "$VOLUMES_DIR" ]; then
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
fi

RESULT="${RESULT}]"

echo "[{\"id\":\"certificates\",\"value\":${RESULT}}]"
