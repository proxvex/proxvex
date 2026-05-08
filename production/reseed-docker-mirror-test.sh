#!/bin/bash
# Reseed the test Docker registry mirror (docker-mirror-test on ubuntupve)
# with the cache contents of the production mirror (docker-registry-mirror on
# pve1) via ZFS replication.
#
# Why:
#   The test mirror lives on a dedicated LXC and pull-throughs Docker Hub.
#   When --force-docker-mirror-test redeploys it, `pct destroy --purge`
#   removes the data volume — so the next e2e/step2a-setup-mirrors.sh
#   pre-pull (~30 tags from versions.sh) would refetch every layer, hitting
#   Docker Hub's anonymous 100 pulls/6h limit within a few iterations.
#
#   Reseeding from the prod mirror's ZFS subvol gives the test mirror an
#   identical cache instantly — pre-pull becomes pure mirror hits, zero
#   load on Docker Hub.
#
# Prerequisites:
#   - Both hosts have ZFS-backed `local-zfs` storage (rpool/data).
#   - Prod mirror (docker-registry-mirror) is running on pve1.
#   - Test mirror (docker-mirror-test) has been deployed at least once via
#     production/setup-production.sh --step 18 (so its data subvol exists).
#
# Idempotent: can be re-run after every --force-docker-mirror-test cycle.
#
# Usage:
#   ./production/reseed-docker-mirror-test.sh
#   PROD_HOST=pve1.cluster TEST_HOST=ubuntupve $0

set -e

PROD_HOST="${PROD_HOST:-pve1.cluster}"
TEST_HOST="${TEST_HOST:-ubuntupve}"
PROD_HOSTNAME="${PROD_HOSTNAME:-docker-registry-mirror}"
TEST_HOSTNAME="${TEST_HOSTNAME:-docker-mirror-test}"

ssh_at() {
  ssh -o StrictHostKeyChecking=no "root@$1" "$2"
}

echo "=== Reseed: ${PROD_HOSTNAME}@${PROD_HOST}  →  ${TEST_HOSTNAME}@${TEST_HOST} ==="

# 1. Resolve VMIDs on each host.
prod_vmid=$(ssh_at "$PROD_HOST" \
  "pct list | awk -v h='$PROD_HOSTNAME' '\$NF==h{print \$1; exit}'")
[ -n "$prod_vmid" ] || {
  echo "ERROR: no container '$PROD_HOSTNAME' on $PROD_HOST" >&2
  exit 1
}
test_vmid=$(ssh_at "$TEST_HOST" \
  "pct list | awk -v h='$TEST_HOSTNAME' '\$NF==h{print \$1; exit}'")
[ -n "$test_vmid" ] || {
  echo "ERROR: no container '$TEST_HOSTNAME' on $TEST_HOST" >&2
  echo "  Deploy it first: ./production/setup-production.sh --step 18" >&2
  exit 1
}
echo "  Prod VMID: $prod_vmid (on $PROD_HOST)"
echo "  Test VMID: $test_vmid (on $TEST_HOST)"

# 2. Resolve the data-volume volid on each host. The mirror's data lives at
#    /var/lib/registry — find the mp line with mp=/var/lib/registry and
#    extract the storage:volume token (first comma-separated field).
extract_volid() {
  local host="$1" vmid="$2"
  ssh_at "$host" "pct config $vmid" \
    | awk '/^mp[0-9]+:.*mp=\/var\/lib\/registry([, ]|$)/ {
        sub(/^mp[0-9]+:[[:space:]]+/, "");
        split($0, a, ",");
        print a[1];
        exit
      }'
}

prod_volid=$(extract_volid "$PROD_HOST" "$prod_vmid")
test_volid=$(extract_volid "$TEST_HOST" "$test_vmid")
[ -n "$prod_volid" ] || { echo "ERROR: no /var/lib/registry mp on prod VMID $prod_vmid" >&2; exit 1; }
[ -n "$test_volid" ] || { echo "ERROR: no /var/lib/registry mp on test VMID $test_vmid" >&2; exit 1; }
echo "  Prod volid: $prod_volid"
echo "  Test volid: $test_volid"

# 3. Resolve each volid to its ZFS dataset name. `pvesm path` returns
#    /rpool/data/subvol-NNN-...-disk-0; the dataset is the same string with
#    the leading slash stripped.
prod_path=$(ssh_at "$PROD_HOST" "pvesm path '$prod_volid'")
test_path=$(ssh_at "$TEST_HOST" "pvesm path '$test_volid'")
prod_ds="${prod_path#/}"
test_ds="${test_path#/}"
case "$prod_ds" in /*|*' '*|*$'\t'*|"") echo "ERROR: bad prod dataset '$prod_ds'" >&2; exit 1 ;; esac
case "$test_ds" in /*|*' '*|*$'\t'*|"") echo "ERROR: bad test dataset '$test_ds'" >&2; exit 1 ;; esac
echo "  Prod dataset: $prod_ds"
echo "  Test dataset: $test_ds"

# Confirm both datasets actually exist as ZFS filesystems (will fail loudly
# on ext4-backed targets, which is the right behaviour — reseed is ZFS-only).
ssh_at "$PROD_HOST" "zfs list -H -o name '$prod_ds'" >/dev/null \
  || { echo "ERROR: '$prod_ds' is not a ZFS dataset on $PROD_HOST" >&2; exit 1; }
ssh_at "$TEST_HOST" "zfs list -H -o name '$test_ds'" >/dev/null \
  || { echo "ERROR: '$test_ds' is not a ZFS dataset on $TEST_HOST" >&2; exit 1; }

# 4. Snapshot the prod dataset.
SNAP="reseed-$(date +%s)"
echo "  Snapshotting ${prod_ds}@${SNAP} on $PROD_HOST..."
ssh_at "$PROD_HOST" "zfs snapshot '${prod_ds}@${SNAP}'"

# 5. Stop the test container so the receiving dataset has no open files.
echo "  Stopping test container $test_vmid on $TEST_HOST..."
ssh_at "$TEST_HOST" "pct stop $test_vmid 2>/dev/null || true"

# 6. zfs send | zfs receive -F (full replace; the freshly deployed test
#    subvol is empty but not snapshot-related to prod, so incremental is
#    not applicable on first reseed).
echo "  Replicating ${prod_ds}@${SNAP}  →  ${test_ds} on $TEST_HOST..."
ssh -o StrictHostKeyChecking=no "root@${PROD_HOST}" \
    "zfs send '${prod_ds}@${SNAP}'" \
  | ssh -o StrictHostKeyChecking=no "root@${TEST_HOST}" \
    "zfs receive -F '${test_ds}'"

# 7. Tidy up: remove the source-side snapshot (the receive created an
#    identical one on the target with the same name; we don't need both
#    sides forever).
echo "  Removing snapshot ${prod_ds}@${SNAP} on $PROD_HOST..."
ssh_at "$PROD_HOST" "zfs destroy '${prod_ds}@${SNAP}'" || true

# 8. Restart the test container.
echo "  Starting test container $test_vmid on $TEST_HOST..."
ssh_at "$TEST_HOST" "pct start $test_vmid"

# 9. Verify the mirror is reachable.
echo "  Verifying https://${TEST_HOSTNAME}/v2/ ..."
for i in $(seq 1 20); do
  if ssh_at "$TEST_HOST" "curl -sf --resolve ${TEST_HOSTNAME}:443:192.168.4.49 https://${TEST_HOSTNAME}/v2/" >/dev/null 2>&1; then
    echo ""
    echo "=== Reseed complete. Test mirror serving from cloned cache. ==="
    exit 0
  fi
  sleep 1
done

echo "WARNING: test mirror did not respond on /v2/ within 20s." >&2
echo "  Investigate: ssh root@${TEST_HOST} 'pct enter $test_vmid'" >&2
exit 1
