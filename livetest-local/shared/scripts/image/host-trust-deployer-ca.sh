#!/bin/sh
# Livetest override: skip CA trust (test uses insecure config)
echo "Skipping CA trust (livetest mode)" >&2
echo '[{"id":"ca_trusted","value":"skipped"}]'
