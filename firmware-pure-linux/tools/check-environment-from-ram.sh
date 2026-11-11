#!/usr/lib/tr100/busybox sh
# Read-only helper after a SEPARATE parent-controlled p2 commit. Never writes a device.
set -eu
set -o pipefail
# BEGIN OFFLINE GUARDS
tr100_check_environment_digest() {
    [ "$#" -eq 1 ] && [ "$1" = 06ea929120af9e164f5ad6f6845ecff0a720cf25515ce051e6b717a5ff498885 ]
}
tr100_check_p2() {
    [ "$#" -eq 5 ] && [ "$1" = 8192 ] && [ "$2" = 8192 ] && [ "$3" = 179:2 ] && [ "$4" = b3:2 ] && [ "$5" = 15269888 ]
}
# END OFFLINE GUARDS
die() { printf 'TR100_ENV REFUSED: %s; no write/reboot performed\n' "$*" >&2; exit 1; }
if [ "$#" = 0 ] || { [ "$#" = 1 ] && [ "$1" = --help ]; }; then
    printf '%s\n' 'Usage: check-environment-from-ram.sh --check 06ea929120af9e164f5ad6f6845ecff0a720cf25515ce051e6b717a5ff498885' \
        'Read-only physical p2 full-SHA verifier. Does not commit an environment or prove default boot.'
    exit 0
fi
[ "$#" = 2 ] && [ "$1" = --check ] || die 'explicit --check and generated SHA required'
tr100_check_environment_digest "$2" || die 'expected SHA is not the generated two-key pure environment'
BB=/usr/lib/tr100/busybox
readonly BB
[ -f "$BB" ] && [ ! -L "$BB" ] && [ -x "$BB" ] || die 'fixed BusyBox unavailable'
[ "$("$BB" id -u)" = 0 ] || die 'root required'
"$BB" awk '$3!~/^0:/ {bad=1} $5=="/" {for(i=7;i<=NF;i++)if($i=="-")type=$(i+1);ok=($3~/^0:/&&(type=="rootfs"||type=="tmpfs"))} END{exit(bad||!ok)}' /proc/self/mountinfo || die 'RAM root and no block mounts required'
[ -b /dev/mmcblk0p2 ] && [ ! -L /dev/mmcblk0p2 ] || die 'real fixed p2 block node required'
tr100_check_p2 "$("$BB" cat /sys/class/block/mmcblk0p2/start)" "$("$BB" cat /sys/class/block/mmcblk0p2/size)" \
    "$("$BB" cat /sys/class/block/mmcblk0p2/dev)" "$("$BB" stat -c '%t:%T' /dev/mmcblk0p2)" \
    "$("$BB" cat /sys/class/block/mmcblk0/size)" || die 'p2 geometry or identity mismatch'
disk=$("$BB" readlink -f /sys/class/block/mmcblk0)
part=$("$BB" readlink -f /sys/class/block/mmcblk0p2)
[ "${part%/*}" = "$disk" ] && [ "$("$BB" readlink -f /sys/dev/block/179:2)" = "$part" ] || die 'p2 sysfs parent/alias mismatch'
result=$(/usr/bin/openssl dgst -sha256 /dev/mmcblk0p2) || die 'full p2 readback failed'
tr100_check_environment_digest "${result##* }" || die 'full 4MiB p2 digest mismatch'
printf '%s\n' 'TR100_ENV READBACK_VERIFIED bytes=4194304 sha256=06ea929120af9e164f5ad6f6845ecff0a720cf25515ce051e6b717a5ff498885 default_boot_tested=false'
