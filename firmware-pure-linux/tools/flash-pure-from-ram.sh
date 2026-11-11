#!/usr/lib/tr100/busybox sh
# Separate pure-Linux migration data phase. No environment write or reboot.
set -eu
set -o pipefail
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
umask 077

# BEGIN OFFLINE GUARDS
tr100_valid_sha256() {
    [ "$#" -eq 1 ] && [ "${#1}" -eq 64 ] || return 1
    case "$1" in *[!0-9a-fA-F]*) return 1;; esac
}
tr100_check_boot_hash() {
    [ "$#" -eq 1 ] && [ "$1" = c4e63e9a104d126685885b33db2c231f7ece5b5babc85f03531cc263722de7c9 ]
}
tr100_check_runtime() {
    [ "$#" -eq 2 ] && [ "$1" = 3.18.24_gk6323v100c ] || return 1
    tr100_maps=0
    set -f
    for tr100_token in $2; do
        case "$tr100_token" in
            blkdevparts=*)
                [ "$tr100_token" = 'blkdevparts=mmcblk0:4M(fastboot),4M(bootargs),12M(kernel),4M(deviceinfo),2M(atf),8M(baseparam),8M(pqparam),-(rootfs)' ] || return 1
                tr100_maps=$((tr100_maps + 1)) ;;
        esac
    done
    [ "$tr100_maps" -eq 1 ]
}
tr100_check_partition() {
    [ "$#" -eq 6 ] && [ "$6" = 15269888 ] || return 1
    case "$1:$2:$3:$4:$5" in
        1:0:8192:179:1:b3:1|2:8192:8192:179:2:b3:2|3:16384:24576:179:3:b3:3|\
        4:40960:8192:179:4:b3:4|5:49152:4096:179:5:b3:5|6:53248:16384:179:6:b3:6|\
        7:69632:16384:179:7:b3:7|8:86016:15183872:259:0:103:0) return 0;;
    esac
    return 1
}
tr100_check_sysfs_relation() {
    [ "$#" -eq 3 ] && [ "${2%/*}" = "$1" ] && [ "$2" = "$3" ]
}
tr100_check_mountinfo() {
    # No block-backed mounts anywhere, including bind mounts and aliased devices.
    "$BB" awk '
      $3 !~ /^0:/ {bad=1}
      $5=="/" {
        for(i=7;i<=NF;i++) if($i=="-") type=$(i+1)
        root_ok=($3 ~ /^0:/ && (type=="rootfs" || type=="tmpfs") && $6 ~ /(^|,)rw(,|$)/)
      }
      END {exit (bad || !root_ok)}'
}
tr100_check_ram_path() {
    [ "$#" -eq 1 ] || return 1
    "$BB" awk -v target="$1" '
      $5=="/" || target==$5 || index(target,$5 "/")==1 {
        if(length($5)>=best) {
          best=length($5); type=""; for(i=7;i<=NF;i++) if($i=="-") type=$(i+1)
          ok=($3 ~ /^0:/ && (type=="tmpfs" || type=="rootfs") && $6 ~ /(^|,)rw(,|$)/)
        }
      }
      END {exit !ok}'
}
tr100_check_sizes() {
    [ "$#" -eq 3 ] || return 1
    case "$1:$2:$3" in *[!0-9:]*) return 1;; esac
    [ "$1" = 9863168 ] && [ "$1" -le 10485760 ] && [ "$2" -gt 0 ] &&
        [ "$2" -le 1073741824 ] && [ "$3" = 7774142464 ]
}
tr100_check_wc_banner() {
    [ "$#" -eq 1 ] && [ "$1" = 'wc (GNU coreutils) 9.1' ]
}
tr100_native_count() {
    # Caller must feed a PIPE: target wc's seekable-file fast path is not trusted.
    /usr/bin/wc -c
}
tr100_require_remaining_count() {
    [ "$#" -eq 1 ] && [ "$1" = 7774140416 ] ||
        die "decoded root length mismatch: expected_remaining=7774140416 actual=${1-absent} header=2048 expected_raw=7774142464"
}
tr100_check_protected_hash() {
    [ "$#" -eq 2 ] || return 1
    case "$1:$2" in
        1:fdc8847fafd9ef5ca006cb414561b99464b344deba1c16f8c223c0916f2c521e|\
        2:216e44221aff6cf13f4cfeba8a2b97194a4a162220354a338b3fb8536b2db13f|\
        4:94d6d4cc9d39a43b126d9b5075d39dac72b83c44aa6db269cf773ab4a4a870aa|\
        5:4ff6abeff404e8eeb0f0f3816470b3d65a9261c2ed75c6e4ce48fbf7fcc2f939|\
        6:9e56eb715425dd4e2f5e57f2211e4f69469104e3bbb1a473b666a463fa6a8237|\
        7:b325063170911917d7511c37b1718ed815639c5aea08c47127e8d94487cd199a) return 0;;
    esac
    return 1
}
tr100_copy_capped() {
    [ "$#" -eq 2 ] || return 1
    case "$1:$2" in *[!0-9:]*) return 1;; esac
    [ "$1" -gt 0 ] && [ "$2" -gt 0 ] || return 1
    "$BB" dd bs="$1" count="$2" iflag=fullblock 2>/dev/null || return 1
    tr100_extra=$("$BB" dd bs=1 count=1 2>/dev/null | "$BB" wc -c) || return 1
    [ "$tr100_extra" -eq 0 ]
}
tr100_check_root_header() {
    [ "$#" -eq 1 ] && [ "${#1}" = 4096 ] || return 1
    tr100_magic=$(printf '%s' "$1" | "$BB" cut -c 2161-2164) || return 1
    tr100_uuid=$(printf '%s' "$1" | "$BB" cut -c 2257-2288) || return 1
    [ "$tr100_magic" = 53ef ] && [ "$tr100_uuid" = a8d4abf76ae44f9ba39aef1b79c63230 ]
}
tr100_digest() {
    tr100_sum=$(/usr/bin/openssl dgst -sha256 "$@") || return 1
    tr100_sum=${tr100_sum##* }
    tr100_valid_sha256 "$tr100_sum" || return 1
    printf '%s\n' "$tr100_sum"
}
tr100_protected() {
    for tr100_part in 1 2 4 5 6 7; do
        tr100_hash=$(tr100_digest "/dev/mmcblk0p$tr100_part") || return 1
        tr100_check_protected_hash "$tr100_part" "$tr100_hash" || return 1
        printf 'TR100_PURE PROTECTED_OK p%s=%s\n' "$tr100_part" "$tr100_hash"
    done
}
tr100_write_partitions() {
    tr100_assert_boundary
    printf '%s\n' 'TR100_PURE WRITE_STARTED: p8 overwrites the old boot/system/data regions; remain in RAM'
    "$BB" gunzip -c "$SYSTEM_GZ" | tr100_copy_capped 1048576 7414 |
        "$BB" dd of="$P8" bs=1048576 count=7414 iflag=fullblock conv=fsync || die 'p8 bounded write failed; remain in RAM'
    readback_root=$(tr100_digest "$P8") || die 'p8 full readback failed'
    [ "$readback_root" = "$raw_expected" ] || die 'p8 full readback SHA256 mismatch; p3 has NOT been changed'
    printf '%s\n' 'TR100_PURE ROOT_READBACK_OK; clearing entire 12 MiB p3 slot'
    tr100_assert_boundary
    "$BB" dd if=/dev/zero of="$P3" bs=1048576 count=12 conv=fsync || die 'p3 full-slot zero fill failed'
    "$BB" dd if="$BOOT" of="$P3" bs=512 count=19264 iflag=fullblock conv=fsync || die 'p3 kernel write failed'
    readback_boot=$("$BB" dd if="$P3" bs=512 count=19264 iflag=fullblock 2>/dev/null | tr100_digest) || die 'p3 prefix readback failed'
    [ "$readback_boot" = "$boot_expected" ] || die 'p3 kernel prefix SHA256 mismatch'
    readback_tail=$("$BB" dd if="$P3" bs=512 skip=19264 count=5312 iflag=fullblock 2>/dev/null | tr100_digest) || die 'p3 zero-tail readback failed'
    [ "$readback_tail" = 60e4f24b3a702f56fdf9d52c7f63e63e2835407591dce1445e193a7720be9ada ] || die 'p3 remaining 2719744 bytes are not all zero'
    tr100_protected || die 'protected partition changed after data writes; remain in RAM'
    printf 'TR100_PURE DATA_WRITE_COMPLETE root_raw_sha256=%s kernel_prefix_bytes=9863168 kernel_prefix_sha256=%s slot_tail_zero_bytes=2719744\n' "$raw_expected" "$boot_expected"
    printf '%s\n' 'PERSISTENT_BOOT_CONFIGURATION_PENDING: no environment change, reboot or bootability claim. Parent must separately review and commit bootcmd/map.'
}
# END OFFLINE GUARDS

die() { printf 'TR100_PURE REFUSED: %s\nRemain in RAM. No automatic retry, recovery, environment write or reboot.\n' "$*" >&2; exit 1; }
mode=check
mode_seen=0
boot_expected=
gzip_expected=
raw_expected=
while [ "$#" -gt 0 ]; do
    case "$1" in
        --check|--write)
            [ "$mode_seen" = 0 ] || die 'duplicate or ambiguous mode'; mode_seen=1; mode=${1#--}; shift ;;
        --boot-sha256|--root-gzip-sha256|--root-raw-sha256)
            key=$1; [ "$#" -ge 2 ] || die 'missing SHA256 argument'
            tr100_valid_sha256 "$2" || die 'SHA256 must contain exactly 64 hexadecimal digits'
            case "$key" in
                --boot-sha256) [ -z "$boot_expected" ] || die 'duplicate boot SHA256'; boot_expected=$2 ;;
                --root-gzip-sha256) [ -z "$gzip_expected" ] || die 'duplicate gzip SHA256'; gzip_expected=$2 ;;
                --root-raw-sha256) [ -z "$raw_expected" ] || die 'duplicate raw SHA256'; raw_expected=$2 ;;
            esac
            shift 2 ;;
        --help)
            [ "$#" = 1 ] && [ "$mode_seen" = 0 ] && [ -z "$boot_expected$gzip_expected$raw_expected" ] || die 'ambiguous help'
            printf '%s\n' 'Usage: flash-pure-from-ram.sh [--check|--write] --boot-sha256 HEX --root-gzip-sha256 HEX --root-raw-sha256 HEX' \
                'Default --check never writes block devices; it uses one small private RAM probe file.' \
                'Fixed RAM inputs: /run/tr100/pure-flash/boot.img and system.ext4.gz. Upload must be complete and inputs frozen.' \
                'Only --write modifies p8 then the entire p3 slot. p2/env and all other partitions remain unchanged.' \
                'p2 must remain the tested printenv probe, so an unexpected reset returns to fastboot CLI. No reboot or environment commit is performed.' \
                'Tool readiness is not migration authorization or proof that independent recovery works. Parent safety review is required.'
            exit 0 ;;
        *) die 'unknown argument; target overrides and bypasses are not accepted' ;;
    esac
done
[ -n "$boot_expected" ] && [ -n "$gzip_expected" ] && [ -n "$raw_expected" ] || die 'all three SHA256 arguments are required'

BB=/usr/lib/tr100/busybox
BOOT=/run/tr100/pure-flash/boot.img
SYSTEM_GZ=/run/tr100/pure-flash/system.ext4.gz
P3=/dev/mmcblk0p3
P8=/dev/mmcblk0p8
readonly BB BOOT SYSTEM_GZ P3 P8
[ -f "$BB" ] && [ ! -L "$BB" ] && [ -x "$BB" ] || die 'fixed BusyBox unavailable'
[ -f /usr/bin/openssl ] && [ ! -L /usr/bin/openssl ] && [ -x /usr/bin/openssl ] || die 'native openssl unavailable'
[ -f /usr/bin/wc ] && [ ! -L /usr/bin/wc ] && [ -x /usr/bin/wc ] || die 'fixed native GNU wc unavailable'
wc_banner=$(LC_ALL=C /usr/bin/wc --version | "$BB" head -n 1) || die 'cannot read GNU wc banner'
tr100_check_wc_banner "$wc_banner" || die 'reviewed GNU wc 9.1 required for large PIPE count'
[ "$("$BB" id -u)" = 0 ] || die 'root required'
boot_expected=$(printf '%s' "$boot_expected" | "$BB" tr A-F a-f)
gzip_expected=$(printf '%s' "$gzip_expected" | "$BB" tr A-F a-f)
raw_expected=$(printf '%s' "$raw_expected" | "$BB" tr A-F a-f)
tr100_check_boot_hash "$boot_expected" || die 'boot digest is not reviewed pure-linux v2'

tr100_assert_runtime() {
    tr100_check_mountinfo </proc/self/mountinfo || die 'root must be writable rootfs/tmpfs and no block device may be mounted'
    "$BB" awk 'NR>1 {bad=1} END {exit bad}' /proc/swaps || die 'active swap is forbidden'
    tr100_check_runtime "$("$BB" uname -r)" "$("$BB" cat /proc/cmdline)" || die 'factory kernel or exact new eight-part map mismatch'
    [ -f /etc/tr100-ram-validation ] && [ ! -L /etc/tr100-ram-validation ] || die 'full RAM maintenance marker absent'
    for input in "$BOOT" "$SYSTEM_GZ"; do
        tr100_check_ram_path "$input" </proc/self/mountinfo || die 'input path is not on writable rootfs/tmpfs'
    done
}
tr100_assert_targets() {
    [ -b /dev/mmcblk0 ] && [ ! -L /dev/mmcblk0 ] || die 'whole MMC node mismatch'
    [ "$("$BB" stat -c '%t:%T' /dev/mmcblk0)" = b3:0 ] &&
        [ "$("$BB" cat /sys/class/block/mmcblk0/dev)" = 179:0 ] &&
        [ "$("$BB" cat /sys/class/block/mmcblk0/queue/logical_block_size)" = 512 ] &&
        [ "$("$BB" cat /sys/class/block/mmcblk0/ro)" = 0 ] || die 'whole MMC identity/block size/read-only mismatch'
    disk_sys=$("$BB" readlink -f /sys/class/block/mmcblk0) || die 'cannot resolve whole MMC sysfs'
    [ "$("$BB" readlink -f /sys/dev/block/179:0)" = "$disk_sys" ] || die 'whole MMC sysfs alias mismatch'
    disksectors=$("$BB" cat /sys/class/block/mmcblk0/size) || die 'cannot read MMC size'
    for part in 1 2 3 4 5 6 7 8; do
        node=/dev/mmcblk0p$part
        sys=/sys/class/block/mmcblk0p$part
        [ -b "$node" ] && [ ! -L "$node" ] || die 'partition is not a real fixed block node'
        part_sys=$("$BB" readlink -f "$sys") || die 'cannot resolve partition sysfs'
        partdev=$("$BB" cat "$sys/dev") || die 'cannot read partition dev'
        tr100_check_sysfs_relation "$disk_sys" "$part_sys" "$("$BB" readlink -f "/sys/dev/block/$partdev")" || die 'partition sysfs alias or MMC parent mismatch'
        [ "$("$BB" cat "$sys/ro")" = 0 ] || die 'partition is read-only'
        tr100_check_partition "$part" "$("$BB" cat "$sys/start")" "$("$BB" cat "$sys/size")" \
            "$partdev" "$("$BB" stat -c '%t:%T' "$node")" "$disksectors" || die 'partition geometry/device/disk mismatch'
    done
}
tr100_assert_runtime
tr100_assert_targets
for directory in /run /run/tr100 /run/tr100/pure-flash; do
    [ -d "$directory" ] && [ ! -L "$directory" ] || die 'input directory missing or symlink'
done
for input in "$BOOT" "$SYSTEM_GZ"; do
    [ -f "$input" ] && [ ! -L "$input" ] && [ "$("$BB" stat -c %h "$input")" = 1 ] || die 'input must be a regular non-symlink file with one link'
done
boot_bytes=$("$BB" stat -c %s "$BOOT")
gzip_bytes=$("$BB" stat -c %s "$SYSTEM_GZ")
tr100_check_sizes "$boot_bytes" "$gzip_bytes" 7774142464 || die 'input size mismatch'
boot_identity=$("$BB" stat -c '%d:%i:%s:%Y' "$BOOT")
gzip_identity=$("$BB" stat -c '%d:%i:%s:%Y' "$SYSTEM_GZ")
[ "$(tr100_digest "$BOOT")" = "$boot_expected" ] || die 'boot input digest mismatch'
[ "$(tr100_digest "$SYSTEM_GZ")" = "$gzip_expected" ] || die 'gzip input digest mismatch'

# One owned RAM file holds only the first 2048 decoded bytes as hex; no 7.7GB temporary raw.
probe=$("$BB" mktemp /run/tr100/pure-flash/.probe-XXXXXX) || die 'cannot create private RAM probe'
probe_identity=$("$BB" stat -c '%d:%i' "$probe")
cleanup_probe() {
    if [ -n "$probe" ] && [ -f "$probe" ] && [ ! -L "$probe" ] &&
        [ "$("$BB" stat -c '%d:%i' "$probe")" = "$probe_identity" ]; then "$BB" rm -f -- "$probe"; fi
}
trap cleanup_probe EXIT
trap 'die interrupted' HUP INT TERM
printf 'TR100_PURE preflight bounded decode and native SHA256, mode=%s; no block writes\n' "$mode"
# Drain the rest after the header. Use the target-verified GNU PIPE path, never a seekable-file count.
remaining=$("$BB" gunzip -c "$SYSTEM_GZ" | tr100_copy_capped 1048576 7414 | {
    "$BB" dd bs=1024 count=2 iflag=fullblock 2>/dev/null | "$BB" od -An -v -tx1 | "$BB" tr -d ' \n' >"$probe" || exit 1
    "$BB" cat
} | tr100_native_count) || die "gzip CRC/EOF or raw size cap failed; actual_remaining=${remaining-unknown}"
tr100_require_remaining_count "$remaining"
tr100_check_root_header "$("$BB" cat "$probe")" || die 'canonical root header/magic/UUID mismatch'
raw_hash=$("$BB" gunzip -c "$SYSTEM_GZ" | tr100_copy_capped 1048576 7414 | tr100_digest) || die 'bounded root digest failed'
[ "$raw_hash" = "$raw_expected" ] || die 'canonical root raw digest mismatch'
cleanup_probe
probe=
tr100_protected || die 'protected prefix or tested printenv probe environment digest mismatch'

tr100_assert_boundary() {
    tr100_assert_runtime
    tr100_assert_targets
    for input in "$BOOT" "$SYSTEM_GZ"; do [ -f "$input" ] && [ ! -L "$input" ] || die 'input type changed'; done
    [ "$("$BB" stat -c '%d:%i:%s:%Y' "$BOOT")" = "$boot_identity" ] &&
        [ "$("$BB" stat -c '%d:%i:%s:%Y' "$SYSTEM_GZ")" = "$gzip_identity" ] || die 'inputs changed; freeze uploads before use'
}
tr100_assert_boundary
printf 'TR100_PURE CHECK_PASSED mode=%s boot=%s gzip=%s raw=%s protected=p1,p2,p4,p5,p6,p7\n' "$mode" "$boot_expected" "$gzip_expected" "$raw_expected"
[ "$mode" = write ] || exit 0
tr100_write_partitions
