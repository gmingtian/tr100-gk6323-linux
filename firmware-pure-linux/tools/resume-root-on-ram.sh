#!/bin/bash
# Resume only the known post-fsck RAM-file checkpoint. No mkfs, input expansion or device writes.
set -Eeuo pipefail
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH LC_ALL=C
EXPECTED_BUILDER_SHA=373efa719c821d216eb0d0bbb2b3c6b4439781805b3218ec78e31f1e583407ca
BUILDER=/run/build-root-on-ram.sh
RESUME_MODE=plan
mode_seen=0
while [[ $# -gt 0 ]]; do
    case "$1" in
        --plan|--execute) [[ $mode_seen == 0 ]] || exit 2; mode_seen=1; RESUME_MODE=${1#--}; shift;;
        --builder) [[ $# -ge 2 && $2 =~ ^/run/[A-Za-z0-9_./-]+$ && /$2/ != */../* && /$2/ != */./* ]] || exit 2; BUILDER=$2; shift 2;;
        *) echo 'Usage: resume-root-on-ram.sh [--plan|--execute] [--builder /run/build-root-on-ram.sh]' >&2; exit 2;;
    esac
done
if [[ $RESUME_MODE == plan ]]; then
    printf '%s\n' '{"status":"resume-plan-only-unverified","mkfs":false,"rawRebuilt":false,"deviceWrites":false,"sourceLoop":"/dev/loop0","sourceRaw":"/run/tr100-pure-base/source.raw","targetRaw":"/mnt/tr100-pure-root-build/rootfs.raw","buildUTC":"2026-11-10 19:07:35","next":"fixed superblock check, RO content check, source release, SHA/gzip/receipt"}'
    exit 0
fi
[[ $(uname -s) == Linux && $(id -u) == 0 ]] || { echo 'REFUSED: Linux root RAM-maintenance required' >&2; exit 1; }
case "$(stat -f -c %T /)" in ramfs|tmpfs) ;; *) echo 'REFUSED: root is not RAM' >&2; exit 1;; esac
[[ -f $BUILDER && ! -L $BUILDER && $(readlink -f "$BUILDER") == "$BUILDER" && $(stat -f -c %T "$BUILDER") == tmpfs ]] || exit 1
builder_sha=$(/usr/bin/openssl dgst -sha256 "$BUILDER"); builder_sha=${builder_sha##* }
[[ $builder_sha == "$EXPECTED_BUILDER_SHA" ]] || { echo 'REFUSED: corrected builder SHA mismatch' >&2; exit 1; }
. "$BUILDER"
BASE_RAW=$BASE_DIR/source.raw BASE_MNT=$BASE_DIR/ro
ROOT_RAW=$WORK_DIR/rootfs.raw ROOT_MNT=$WORK_DIR/root-mount ROOT_GZ=$WORK_DIR/rootfs.ext4.gz
SRC_LOOP=/dev/loop0 SRC_MOUNTED=1 DST_LOOP= DST_MOUNTED=0
assert_ram_regular "$BASE_RAW"
assert_ram_regular "$ROOT_RAW"
assert_ram_regular "$WORK_DIR/clock.txt"
[[ $(stat -c %s "$BASE_RAW") == "$SOURCE_RAW_BYTES" && $(stat -c %s "$ROOT_RAW") == "$ROOT_BYTES" ]] || exit 1
[[ $(stat -c %s "$WORK_DIR/clock.txt") == 20 ]] || exit 1
IFS= read -r checkpoint_utc <"$WORK_DIR/clock.txt"
[[ $checkpoint_utc == '2026-11-10 19:07:35' ]] || { echo 'REFUSED: checkpoint UTC mismatch' >&2; exit 1; }
parse_args --execute --source-gz /run/tr100-pure-input/system.ext4.gz --overlay /run/tr100-pure-overlay-three --build-utc "$checkpoint_utc"
for tool in "$PIGZ" "$SETFACL" "$GETFACL"; do assert_ram_regular "$tool"; [[ -x $tool ]]; done
for file in "$ROOT_GZ" "$ROOT_GZ.partial" "$WORK_DIR/receipt.json" "$WORK_DIR/decoded.bytes" "$WORK_DIR/decoded.sha256" "$WORK_DIR/SHA256SUMS"; do
    [[ ! -e $file && ! -L $file ]] || { echo 'REFUSED: later-stage output already exists' >&2; exit 1; }
done
[[ $(stat -f -c %T "$WORK_DIR") == tmpfs && $(awk 'END{print NR}' /proc/swaps) -eq 1 ]] || exit 1
owned_loop "$SRC_LOOP" "$BASE_RAW"
owned_mount "$BASE_MNT" "$SRC_LOOP" "$BASE_RAW"
[[ $(cat /sys/class/block/loop0/ro) == 1 ]] || exit 1
awk -v source="$BASE_MNT" '$3!~/^0:/ {type="";for(i=7;i<=NF;i++)if($i=="-"){type=$(i+1);break};if($3!="7:0" || $5!=source || type!="ext4" || $6!~/(^|,)ro(,|$)/)bad=1} END{exit bad}' /proc/self/mountinfo
[[ -z $("$LOSETUP" -j "$ROOT_RAW") ]] && ! mountpoint -q "$ROOT_MNT" || { echo 'REFUSED: target raw is still attached or mounted' >&2; exit 1; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
log "Resuming preserved RAM files, UTC=$BUILD_UTC; no formatting or population is run."
[[ $(hash_file "$BASE_RAW") == "$SOURCE_RAW_SHA" ]] || { fail 'preserved source raw SHA mismatch'; exit 1; }
identity_checks "$BASE_MNT"
capture_kept_files
superblock_checks
"$E2FSCK" -f -n "$ROOT_RAW"
DST_LOOP=$(attach_file "$ROOT_RAW" ro)
mount -t ext4 -o ro,noload "$DST_LOOP" "$ROOT_MNT"; DST_MOUNTED=1
root_content_checks
umount -- "$ROOT_MNT"; DST_MOUNTED=0
# Prior cleanup may have set LO_FLAGS_AUTOCLEAR; accept an already-detached owned loop after umount.
if [[ -e /sys/class/block/${DST_LOOP##*/}/loop/backing_file ]]; then detach_one "$DST_LOOP" "$ROOT_RAW"; fi
DST_LOOP=
umount -- "$BASE_MNT"; SRC_MOUNTED=0
if [[ -e /sys/class/block/loop0/loop/backing_file ]]; then detach_one "$SRC_LOOP" "$BASE_RAW"; fi
SRC_LOOP=
assert_ram_regular "$BASE_RAW"
rm -- "$BASE_RAW"
log 'RO target checks passed; own source loop/file released. Continuing original SHA/gzip tail.'
finish_verified_root
