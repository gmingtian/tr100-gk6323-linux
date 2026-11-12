#!/bin/busybox sh
# Only p3 + p8 on the documented TR100 layout. Never source a manifest.
set -eu
set -o pipefail
fail() { echo "ERROR: $*" >&2; exit 1; }
usage() {
    echo 'Usage: flash-from-ram.sh KERNEL ROOTFS_GZ FLASH_MANIFEST NEW_BACKUP_DIR BACKUP_URL ERASE-P3-P8-PERSONALIZED' >&2
    echo 'Read-only host validation: bash flash-from-ram.sh --check-inputs KERNEL ROOTFS_GZ FLASH_MANIFEST' >&2
    exit 1
}
mode=flash
if [ "${1:-}" = --check-inputs ]; then
    mode=check
    shift
    [ "$#" = 3 ] || usage
else
    [ "$#" = 6 ] || usage
    [ "$6" = ERASE-P3-P8-PERSONALIZED ] || usage
fi
kernel=$1
rootfs=$2
manifest=$3
if [ "$mode" = flash ]; then
    # The embedded initramfs has /bin/busybox, with no applet symlinks.
    [ -x /bin/busybox ] || fail 'requires the supplied RAM BusyBox'
    [ "$(/bin/busybox id -u)" = 0 ] || fail 'requires root in the RAM initramfs'
    case " $(/bin/busybox cat /proc/cmdline) " in *' tr100.arm64.root=installed '*) fail 'installed-root boot token present; reboot the candidate RAM image' ;; esac
    /bin/busybox awk '$2 == "/" && ($3 == "rootfs" || $3 == "ramfs" || $3 == "tmpfs") {ok=1} END {exit !ok}' /proc/mounts || fail 'root must be a RAM filesystem'
    /bin/busybox awk '$2 == "/run" && $3 == "tmpfs" {ok=1} END {exit !ok}' /proc/mounts || fail '/run must be tmpfs'
    applet_dir=$(/bin/busybox mktemp -d /run/tr100-flash-bin.XXXXXX)
    for applet in awk blockdev cat cut dd dirname basename gzip id ln ls mkdir od readlink sha256sum stat sync tr wc wget; do
        /bin/busybox ln -s /bin/busybox "$applet_dir/$applet"
    done
    PATH=$applet_dir
    export PATH
fi
for input in "$kernel" "$rootfs" "$manifest"; do
    [ -f "$input" ] && [ ! -L "$input" ] || fail "input must be a regular non-symlink file: $input"
done
kernel_sha256= rootfs_gz_sha256= rootfs_ext4_sha256= rootfs_ext4_bytes=
while IFS='=' read -r key value || [ -n "$key" ]; do
    case "$key" in
        kernel_sha256) [ -z "$kernel_sha256" ] || fail 'unknown or duplicate manifest field'; kernel_sha256=$value ;;
        rootfs_gz_sha256) [ -z "$rootfs_gz_sha256" ] || fail 'unknown or duplicate manifest field'; rootfs_gz_sha256=$value ;;
        rootfs_ext4_sha256) [ -z "$rootfs_ext4_sha256" ] || fail 'unknown or duplicate manifest field'; rootfs_ext4_sha256=$value ;;
        rootfs_ext4_bytes) [ -z "$rootfs_ext4_bytes" ] || fail 'unknown or duplicate manifest field'; rootfs_ext4_bytes=$value ;;
        *) fail 'unknown or duplicate manifest field' ;;
    esac
done < "$manifest"
for digest in "$kernel_sha256" "$rootfs_gz_sha256" "$rootfs_ext4_sha256"; do
    [ "${#digest}" = 64 ] || fail 'manifest SHA256 must contain 64 lowercase hex digits'
    case "$digest" in *[!0-9a-f]*) fail 'manifest SHA256 must contain 64 lowercase hex digits' ;; esac
done
[ "$rootfs_ext4_bytes" = 7774142464 ] || fail 'rootfs_ext4_bytes must be 7774142464'
hash_file() { sha256sum "$1" | cut -d ' ' -f 1; }
[ "$(wc -c < "$kernel" | tr -d ' ')" = 12582912 ] || fail 'kernel must be exactly 12582912 bytes'
[ "$(hash_file "$kernel")" = "$kernel_sha256" ] || fail 'kernel SHA256 mismatch'
[ "$(hash_file "$rootfs")" = "$rootfs_gz_sha256" ] || fail 'compressed rootfs SHA256 mismatch'
gzip -t "$rootfs" || fail 'gzip integrity check failed'
echo 'Checking the complete expanded rootfs; no partition writes yet.'
[ "$(gzip -dc "$rootfs" | wc -c | tr -d ' ')" = "$rootfs_ext4_bytes" ] || fail 'expanded rootfs must be exactly 7774142464 bytes'
[ "$(gzip -dc "$rootfs" | sha256sum | cut -d ' ' -f 1)" = "$rootfs_ext4_sha256" ] || fail 'expanded rootfs SHA256 mismatch'
# Consume the remaining stream so pipefail cannot mistake an early reader exit
# for a corrupt gzip. ext4 UUID is at superblock byte offset 1024 + 104.
uuid=$(gzip -dc "$rootfs" | {
    dd bs=1 skip=1128 count=16 2>/dev/null | od -An -tx1 | tr -d ' \n'
    cat > /dev/null
})
[ "$uuid" = a8d4abf76ae44f9ba39aef1b79c63230 ] || fail 'rootfs UUID does not match initramfs contract'
[ "$mode" = flash ] || { echo INPUTS_VERIFIED_NO_DEVICE_ACCESS; exit 0; }

[ "$(id -u)" = 0 ] || fail 'requires root in the RAM initramfs'
case " $(cat /proc/cmdline) " in *' tr100.arm64.root=installed '*) fail 'installed-root boot token present; reboot the candidate RAM image' ;; esac
awk '$2 == "/" && ($3 == "rootfs" || $3 == "ramfs" || $3 == "tmpfs") {ok=1} END {exit !ok}' /proc/mounts || fail 'root must be a RAM filesystem'
awk '$2 == "/run" && $3 == "tmpfs" {ok=1} END {exit !ok}' /proc/mounts || fail '/run must be tmpfs'
# No block mounts at all, including aliases and mounts outside this namespace.
for mounts in /proc/[0-9]*/mountinfo; do
    [ -r "$mounts" ] || continue
    awk '$3 !~ /^0:/ {bad=1} END {exit bad}' "$mounts" || fail 'a block filesystem is mounted'
done
[ "$(wc -l < /proc/swaps | tr -d ' ')" = 1 ] || fail 'swap must be disabled'
awk '$2 ~ /^\/run\// {bad=1} END {exit bad}' /proc/mounts || fail 'nested mounts under /run are forbidden'
for input in "$kernel" "$rootfs" "$manifest" "$0"; do
    case "$(readlink -f "$input")" in /run/*) ;; *) fail 'script and all inputs must be under /run in RAM' ;; esac
done
backup=$4
backup_url=$5
case "$backup_url" in http://*) ;; *) fail 'backup receiver URL must be http://HOST_IPV4:PORT' ;; esac
case "${backup_url#http://}" in ''|*[!0-9.:]*) fail 'backup receiver URL must be http://HOST_IPV4:PORT' ;; esac
case "$(readlink -f "$(dirname "$backup")")/$(basename "$backup")" in /run/*) ;; *) fail 'backup must be under /run in RAM' ;; esac
[ ! -e "$backup" ] && [ ! -L "$backup" ] || fail 'backup directory must not already exist'
check_node() {
    node=$1
    [ -b "/dev/$node" ] && [ ! -L "/dev/$node" ] || fail "not a real block node: $node"
    dev=$(cat "/sys/class/block/$node/dev")
    major=${dev%:*}; minor=${dev#*:}
    [ "$(stat -c '%t:%T' "/dev/$node")" = "$(printf '%x:%x' "$major" "$minor")" ] || fail 'block node/sysfs mismatch'
    [ "$(readlink -f "/sys/dev/block/$dev")" = "$(readlink -f "/sys/class/block/$node")" ] || fail 'sysfs alias mismatch'
    [ -z "$(ls -A "/sys/class/block/$node/holders")" ] || fail 'block device has holders'
}
for node in mmcblk0 mmcblk0p2 mmcblk0p3 mmcblk0p8; do check_node "$node"; done
[ "$(cat /sys/class/block/mmcblk0/size)" = 15269888 ] || fail 'wrong eMMC disk size'
[ "$(cat /sys/class/block/mmcblk0/queue/logical_block_size)" = 512 ] || fail 'expected 512-byte sectors'
for spec in '2 8192 8192' '3 16384 24576' '8 86016 15183872'; do
    set -- $spec
    [ "$(cat "/sys/class/block/mmcblk0p$1/start")" = "$2" ] &&
    [ "$(cat "/sys/class/block/mmcblk0p$1/size")" = "$3" ] || fail 'partition geometry mismatch'
    [ "$(dirname "$(readlink -f "/sys/class/block/mmcblk0p$1")")" = "$(readlink -f /sys/class/block/mmcblk0)" ] || fail 'wrong partition parent'
done
for node in mmcblk0 mmcblk0p3 mmcblk0p8; do
    [ "$(blockdev --getro "/dev/$node")" = 1 ] || fail 'expected initial read-only storage from RAM init'
done
mkdir "$backup"
for part in 2 3; do
    dd if="/dev/mmcblk0p$part" of="$backup/original-p$part.bin" bs=1048576
    [ "$(wc -c < "$backup/original-p$part.bin" | tr -d ' ')" = "$(( $(cat "/sys/class/block/mmcblk0p$part/size") * 512 ))" ] || fail 'short backup'
    [ "$(hash_file "$backup/original-p$part.bin")" = "$(hash_file "/dev/mmcblk0p$part")" ] || fail 'backup verification failed'
done
(cd "$backup" && sha256sum original-p2.bin original-p3.bin > SHA256SUMS)
for part in 2 3; do
    wget -O "$backup/upload-p$part-receipt.txt" --post-file="$backup/original-p$part.bin" "$backup_url/original-p$part.bin" || fail 'host backup upload failed'
    [ "$(cat "$backup/upload-p$part-receipt.txt")" = "$(hash_file "$backup/original-p$part.bin")" ] || fail 'host backup receipt SHA256 mismatch'
done
cat "$backup/SHA256SUMS"
echo "Backups verified in $backup and uploaded. Compare the host SHA256 before continuing."
echo 'Type BACKUPS-COPIED on the serial console to write personalized p8 then p3:'
read -r answer < /dev/ttyAMA0
[ "$answer" = BACKUPS-COPIED ] || fail 'backup acknowledgment missing'
# Restore the RAM initramfs storage policy on success, errors, and interruption.
restore_ro() {
    ro_failed=0
    sync || ro_failed=1
    blockdev --setro /dev/mmcblk0p3 || ro_failed=1
    blockdev --setro /dev/mmcblk0p8 || ro_failed=1
    blockdev --setro /dev/mmcblk0 || ro_failed=1
    [ "$ro_failed" = 0 ] || { echo 'ERROR: failed to restore all storage read-only flags' >&2; return 1; }
}
trap 'tr100_status=$?; trap - EXIT; restore_ro || tr100_status=1; exit "$tr100_status"' EXIT
trap 'exit 1' HUP INT TERM
blockdev --setrw /dev/mmcblk0
blockdev --setrw /dev/mmcblk0p8
gzip -dc "$rootfs" | dd of=/dev/mmcblk0p8 bs=1048576
sync
[ "$(hash_file /dev/mmcblk0p8)" = "$rootfs_ext4_sha256" ] || fail 'p8 readback mismatch; do not boot installed root'
blockdev --setro /dev/mmcblk0p8
blockdev --setrw /dev/mmcblk0p3
dd if="$kernel" of=/dev/mmcblk0p3 bs=1048576
sync
[ "$(hash_file /dev/mmcblk0p3)" = "$kernel_sha256" ] || fail 'p3 full readback mismatch; do not boot installed kernel'
restore_ro || fail 'readback passed but storage read-only restoration failed'
trap - EXIT
echo 'P3_P8_FULL_READBACK_VERIFIED; no loader, ATF, environment, or partition-table write performed.'
