#!/bin/sh
# Rotate LXC console log files in /var/log/lxc/.
#
# Runs on the PVE host (execute_on: ve).
# Uses copytruncate semantics: copy the log, then truncate the original,
# because LXC holds the file descriptor open.
#
# - Rotates *.log files > 0 bytes to {name}-{YYYY-MM-DD}.log
# - Deletes rotated copies older than 7 days
# - Skips already-rotated files (matching *-????-??-??.log)
#
# Output: JSON to stdout

set -eu

LOG_DIR="/var/log/lxc"
RETENTION_DAYS=7

log() { echo "$@" >&2; }

ROTATED=0
DELETED=0
ERRORS=""

if [ ! -d "$LOG_DIR" ]; then
  log "Log directory $LOG_DIR does not exist"
  printf '[{"id":"log_rotation_result","value":"rotated:0,deleted:0"}]\n'
  exit 0
fi

TODAY=$(date +%Y-%m-%d)

# Rotate active log files (copytruncate)
for file in "$LOG_DIR"/*.log; do
  [ -f "$file" ] || continue

  basename=$(basename "$file")

  # Skip already-rotated files (e.g. hostname-503-2026-03-25.log)
  case "$basename" in
    *-[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9].log) continue ;;
  esac

  # Skip empty files
  if [ ! -s "$file" ]; then
    continue
  fi

  # Build rotated filename: foo.log -> foo-2026-03-25.log
  rotated_name="${basename%.log}-${TODAY}.log"
  rotated_path="${LOG_DIR}/${rotated_name}"

  # Handle collision (multiple rotations on same day)
  if [ -f "$rotated_path" ]; then
    SEQ=1
    while [ -f "${LOG_DIR}/${basename%.log}-${TODAY}-${SEQ}.log" ]; do
      SEQ=$((SEQ + 1))
    done
    rotated_path="${LOG_DIR}/${basename%.log}-${TODAY}-${SEQ}.log"
  fi

  if cp "$file" "$rotated_path" 2>/dev/null; then
    cat /dev/null > "$file" 2>/dev/null
    ROTATED=$((ROTATED + 1))
    log "Rotated: $basename -> $(basename "$rotated_path")"
  else
    ERRORS="${ERRORS}copy failed: ${basename}; "
    log "Error: Failed to copy $basename"
  fi
done

# Delete rotated files older than retention period
DELETED=$(find "$LOG_DIR" -maxdepth 1 -name "*-[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9].log" -mtime "+${RETENTION_DAYS}" -type f -print -delete 2>/dev/null | wc -l)
DELETED=$(echo "$DELETED" | tr -d ' ')

if [ "$DELETED" -gt 0 ]; then
  log "Deleted $DELETED rotated log(s) older than ${RETENTION_DAYS} days"
fi

log "Log rotation complete: rotated=$ROTATED, deleted=$DELETED"
printf '[{"id":"log_rotation_result","value":"rotated:%s,deleted:%s"}]\n' "$ROTATED" "$DELETED"
