#!/bin/sh
# Volume Consistency Check.
#
# Scans all active rootdir storages on the PVE host and classifies each
# volume. Reports orphans (vmid gone, unmounted, dangling ZFS snapshots).
#
# Strict mode: exit 1 if any orphans are found, with a detailed stderr log
# of cleanup suggestions.
#
# This script does NOT mutate state. It only inspects pvesm/pct/qm/zfs.
#
# Required libraries (prepended by template engine or run-volume-check.sh):
#   - pve-common.sh
#   - vol-common.sh
#
# Output JSON (stdout) — conforms to schemas/outputs.schema.json:
#   [{"id":"volume_consistency","value":[{"name":"<check>","value":<bool>,"description":"..."}]}]
# Each array item must use {name, value} or {id, value}; `description` is the
# only allowed extra property.

GRACE_SECONDS=60

results="["
all_passed=true

add_result() {
    check="$1"
    passed="$2"
    detail="$3"
    [ "$results" != "[" ] && results="${results},"
    if [ -n "$detail" ]; then
        escaped=$(printf '%s' "$detail" | sed 's/"/\\"/g' | tr '\n' ' ')
        results="${results}{\"name\":\"${check}\",\"value\":${passed},\"description\":\"${escaped}\"}"
    else
        results="${results}{\"name\":\"${check}\",\"value\":${passed}}"
    fi
}

# Get the host-side mtime (epoch seconds) for a volume. 0 if not resolvable.
volume_mtime() {
    _vc_volid="$1"
    _vc_path=$(pvesm path "$_vc_volid" 2>/dev/null || true)
    [ -z "$_vc_path" ] && { echo 0; return; }
    [ -e "$_vc_path" ] || { echo 0; return; }
    stat -c %Y "$_vc_path" 2>/dev/null || echo 0
}

now=$(date +%s)

# --- Per-storage volume scan ---
storages=$(vol_list_active_storages)
if [ -z "$storages" ]; then
    add_result "volume_consistency" "true" "no active rootdir storages"
    echo "CHECK: volume_consistency PASSED (no active rootdir storages)" >&2
else
    for storage in $storages; do
        storage_type=$(vol_get_storage_type "$storage")
        echo "Scanning storage '${storage}' (type=${storage_type})..." >&2

        volids=$(pvesm list "$storage" --content rootdir 2>/dev/null | awk 'NR>1 {print $1}')
        if [ -z "$volids" ]; then
            add_result "volume_consistency_${storage}" "true" "no volumes"
            echo "CHECK: volume_consistency_${storage} PASSED (no volumes)" >&2
            continue
        fi

        storage_passed=true
        for volid in $volids; do
            classification=$(vol_classify "$storage" "$volid")
            case "$classification" in
                active|persistent_clean|orphan_qemu_unknown)
                    # active and persistent_clean: OK by design.
                    # orphan_qemu_unknown: defensive — log but don't fail.
                    [ "$classification" = "orphan_qemu_unknown" ] \
                        && echo "  [info] ${volid}: ${classification}" >&2
                    ;;
                orphan_vmid_gone|orphan_unmounted)
                    mtime=$(volume_mtime "$volid")
                    age=$(( now - mtime ))
                    if [ "$mtime" -gt 0 ] && [ "$age" -lt "$GRACE_SECONDS" ]; then
                        echo "  [skip] ${volid}: ${classification} but mtime ${age}s ago (within ${GRACE_SECONDS}s grace window — likely replace_ct in progress)" >&2
                        continue
                    fi
                    storage_passed=false
                    all_passed=false
                    detail="${classification}: ${volid}"
                    case "$storage_type" in
                        zfspool)
                            pool=$(vol_get_zfs_pool "$storage")
                            volname="${volid#*:}"
                            echo "  [FAIL] ${volid}: ${classification}" >&2
                            echo "    Suggested cleanup: zfs destroy -r ${pool}/${volname}" >&2
                            ;;
                        *)
                            echo "  [FAIL] ${volid}: ${classification}" >&2
                            echo "    Suggested cleanup: pvesm free ${volid}" >&2
                            ;;
                    esac
                    add_result "${classification}_${volid}" "false" "$detail"
                    ;;
                *)
                    echo "  [warn] ${volid}: classification=${classification} (unrecognized)" >&2
                    ;;
            esac
        done

        if $storage_passed; then
            add_result "volume_consistency_${storage}" "true"
            echo "CHECK: volume_consistency_${storage} PASSED" >&2
        else
            echo "CHECK: volume_consistency_${storage} FAILED" >&2
        fi
    done
fi

# --- ZFS dangling snapshot scan ---
# Find every zfspool storage and check its pool for orphan snapshots.
for storage in $storages; do
    storage_type=$(vol_get_storage_type "$storage")
    [ "$storage_type" = "zfspool" ] || continue

    pool=$(vol_get_zfs_pool "$storage")
    [ -z "$pool" ] && continue

    orphan_snaps=$(vol_list_orphan_zfs_snapshots "$pool")
    if [ -z "$orphan_snaps" ]; then
        add_result "zfs_snapshots_${storage}" "true"
        echo "CHECK: zfs_snapshots_${storage} PASSED" >&2
        continue
    fi

    all_passed=false
    echo "CHECK: zfs_snapshots_${storage} FAILED — orphan snapshots:" >&2
    echo "$orphan_snaps" | while IFS= read -r snap; do
        [ -z "$snap" ] && continue
        echo "  [FAIL] ${snap}" >&2
        echo "    Suggested cleanup: zfs destroy ${snap}" >&2
    done
    snap_list=$(echo "$orphan_snaps" | tr '\n' ',' | sed 's/,$//')
    add_result "zfs_orphan_snapshots_${storage}" "false" "$snap_list"
done

results="${results}]"

# Wrap in the standard output envelope expected by templates with outputs:["volume_consistency"].
printf '[{"id":"volume_consistency","value":%s}]\n' "$results"

if $all_passed; then
    exit 0
else
    exit 1
fi
