#!/bin/bash
# RAM-maintenance ordinary-file builder. NEVER pass a block device to mke2fs/dd.
# Sourcing defines validators only; construction is confined to explicit main --execute.
SOURCE_GZIP_BYTES=144829793
SOURCE_GZIP_SHA=f341812dbb2848e1316a60c8f612eb75368e218728c68f97fd3576c0f6ca6946
SOURCE_RAW_BYTES=838860800
SOURCE_RAW_SHA=9b6a93e8caed7abb17a56c3d7e603934b5a37ac0e815a10e30d40671979fff90
ROOT_BYTES=7774142464
ROOT_BLOCKS=1897984
ROOT_UUID=a8d4abf7-6ae4-4f9b-a39a-ef1b79c63230
ROOT_TAG=tr100-pure-linux-20261111
FEATURES=has_journal,ext_attr,resize_inode,dir_index,filetype,extent,flex_bg,sparse_super,large_file,huge_file,uninit_bg,dir_nlink,extra_isize
BASE_DIR=/run/tr100-pure-base
WORK_DIR=/mnt/tr100-pure-root-build
GNU_DD=/usr/bin/dd
OPENSSL=/usr/bin/openssl
MKE2FS=/usr/sbin/mke2fs
E2FSCK=/usr/sbin/e2fsck
LOSETUP=/usr/sbin/losetup
STATIC_BB=/usr/lib/tr100/busybox
GETCAP=/usr/sbin/getcap
SRC_LOOP= DST_LOOP= SRC_MOUNTED=0 DST_MOUNTED=0 COUNT_PID= SUCCESS=0

fail() { printf 'REFUSED: %s\n' "$*" >&2; return 1; }
log() { printf '[pure-root %s] %s\n' "$(date -u '+%Y-%m-%d %H:%M:%S')" "$*"; }
safe_run_path() {
    [[ $# -eq 1 && $1 =~ ^/run/[A-Za-z0-9_./-]+$ && $1 != */ && $1 != *//* ]] || return 1
    [[ /$1/ != */../* && /$1/ != */./* ]]
}
validate_gnu_dd_version() {
    [[ $# -eq 1 ]] || return 1
    local first=${1%%$'\n'*}
    [[ $first =~ ^dd\ \(coreutils\)\ [0-9]+\.[0-9]+([.][0-9]+)?$ ]]
}
parse_args() {
    MODE= SOURCE_GZ= OVERLAY= BUILD_UTC=
    PIGZ=/run/pure-tools/pigz/usr/bin/pigz
    SETFACL=/run/pure-tools/acl/bin/setfacl
    GETFACL=/run/pure-tools/acl/bin/getfacl
    local seen=' ' key value
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --plan|--execute)
                [[ -z $MODE ]] || { fail 'choose exactly one of --plan/--execute'; return 1; }
                MODE=${1#--}; shift ;;
            --source-gz|--overlay|--build-utc|--pigz|--setfacl|--getfacl)
                key=$1
                [[ $# -ge 2 && $2 != --* && $seen != *" $key "* ]] || { fail 'missing/duplicate argument'; return 1; }
                value=$2; seen+="$key "
                case "$key" in
                    --source-gz) SOURCE_GZ=$value;; --overlay) OVERLAY=$value;; --build-utc) BUILD_UTC=$value;;
                    --pigz) PIGZ=$value;; --setfacl) SETFACL=$value;; --getfacl) GETFACL=$value;;
                esac
                shift 2 ;;
            *) fail "unknown argument $1"; return 1;;
        esac
    done
    [[ -n $MODE && -n $SOURCE_GZ && -n $OVERLAY && -n $BUILD_UTC ]] || { fail '--plan/--execute, --source-gz, --overlay and --build-utc are required'; return 1; }
    for value in "$SOURCE_GZ" "$OVERLAY" "$PIGZ" "$SETFACL" "$GETFACL"; do
        safe_run_path "$value" || { fail 'input/overlay/tool paths must be simple absolute /run paths without traversal'; return 1; }
    done
    [[ $BUILD_UTC =~ ^20[0-9][0-9]-[0-9][0-9]-[0-9][0-9]\ [0-9][0-9]:[0-9][0-9]:[0-9][0-9]$ ]] || { fail 'invalid UTC timestamp syntax'; return 1; }
    [[ $(date -u -d "$BUILD_UTC" '+%Y-%m-%d %H:%M:%S' 2>/dev/null) == "$BUILD_UTC" ]] || { fail 'invalid UTC calendar timestamp'; return 1; }
}
plan() {
    cat <<EOF
{"status":"plan-only-unverified","deviceWrites":false,"sourceGzipBytes":$SOURCE_GZIP_BYTES,"sourceGzipSHA256":"$SOURCE_GZIP_SHA","sourceRawBytes":$SOURCE_RAW_BYTES,"sourceRawSHA256":"$SOURCE_RAW_SHA","rootBytes":$ROOT_BYTES,"blocks":$ROOT_BLOCKS,"blockSize":4096,"inodeRatio":32768,"inodeSize":256,"reservedPercent":0,"journalMiB":32,"sourceMustBeReadOnly":true,"onlyExplicitOverlayFiles":3,"rootUUID":"$ROOT_UUID","imageTag":"$ROOT_TAG","buildUTC":"$BUILD_UTC","baseDirectory":"$BASE_DIR","outputDirectory":"$WORK_DIR","runtimeAndInputChecksPerformed":false}
EOF
}
ram_mountpoint() {
    [[ $# -eq 2 && $1 == /* ]] || return 1
    awk -v file="$1" '
      {mp=$5; if(mp=="/" || file==mp || index(file,mp "/")==1) {
        if(length(mp)>=best) {best=length(mp); dev=$3; target=mp; type="";
          for(i=7;i<=NF;i++) if($i=="-") {type=$(i+1); break}
        }
      }}
      END {if(best && dev ~ /^0:/ && type=="tmpfs") print target; else exit 1}
    ' "$2"
}
memory_gate() {
    local minimum=${1:-} info=${2:-/proc/meminfo} quiet=${3:-} available
    [[ $minimum =~ ^[0-9]+$ && $minimum -gt 0 ]] || return 1
    available=$(awk '$1=="MemAvailable:" && $3=="kB" {print $2}' "$info") || return 1
    [[ $available =~ ^[0-9]+$ && $available -ge $minimum ]] || { fail "MemAvailable below ${minimum} KiB (found ${available:-missing})"; return 1; }
    [[ $quiet == quiet ]] || log "MemAvailable=${available}KiB; required=${minimum}KiB"
}
loop_backing_matches() {
    [[ $# -eq 2 && -f $1 && $2 == /run/* || $# -eq 2 && -f $1 && $2 == /mnt/tr100-pure-root-build/* ]] || return 1
    [[ $2 != /dev/* && $(cat -- "$1") == "$2" ]]
}
no_symlink_components() {
    local item=$1 component walk= parts
    IFS=/ read -r -a parts <<<"${item#/}"
    for component in "${parts[@]}"; do
        [[ -n $component && $component != . && $component != .. ]] || return 1
        walk+=/$component
        [[ ! -L $walk ]] || return 1
    done
}
assert_ram_regular() {
    [[ -f $1 && ! -L $1 && ! -b $1 && ! -c $1 ]] || { fail "not an ordinary file: $1"; return 1; }
    no_symlink_components "$1" || { fail 'symlink component refused'; return 1; }
    [[ $(stat -f -c %T -- "$1") == tmpfs ]] || { fail "file is not on tmpfs: $1"; return 1; }
    ram_mountpoint "$1" /proc/self/mountinfo >/dev/null || { fail 'non-RAM or nested block mount'; return 1; }
}
hash_file() {
    local result
    result=$("$OPENSSL" dgst -sha256 "$1") || return 1
    result=${result##* }
    [[ $result =~ ^[a-f0-9]{64}$ ]] || return 1
    printf '%s\n' "$result"
}
verify_gzip_reread() {
    [[ $# -eq 4 && -f $1 && ! -L $1 && $2 =~ ^[a-f0-9]{64}$ && $3 =~ ^[0-9]+$ && $3 -gt 0 ]] || return 1
    local compressed=$1 expected_sha=$2 expected_bytes=$3 prefix=$4 decoded_sha decoded_bytes
    [[ ! -e $prefix.bytes && ! -L $prefix.bytes && ! -e $prefix.sha256 && ! -L $prefix.sha256 ]] || return 1
    (set -o noclobber; : >"$prefix.bytes"; : >"$prefix.sha256") || return 1
    set -o pipefail
    # Separate bounded-memory passes avoid inherited-FD/process-substitution races.
    decoded_bytes=$("$PIGZ" -dc "$compressed" | wc -c) || { fail 'gzip/count worker failed'; return 1; }
    decoded_bytes=${decoded_bytes//[[:space:]]/}
    [[ $decoded_bytes == "$expected_bytes" ]] || { fail 'gzip logical length mismatch'; return 1; }
    decoded_sha=$("$PIGZ" -dc "$compressed" | "$OPENSSL" dgst -sha256) || { fail 'gzip/hash worker failed'; return 1; }
    printf '%s\n' "$decoded_bytes" >"$prefix.bytes"
    printf '%s\n' "$decoded_sha" >"$prefix.sha256"
    decoded_sha=${decoded_sha##* }
    [[ $decoded_sha == "$expected_sha" ]] || { fail 'gzip reread raw SHA mismatch'; return 1; }
}
allocation_gate() {
    local file=$1 maximum=$2 allocated
    assert_ram_regular "$file" || return 1
    allocated=$(du -B1 -- "$file" | awk '{print $1}')
    [[ $allocated =~ ^[0-9]+$ && $allocated -le $maximum ]] || { fail "RAM allocation limit exceeded: $file"; return 1; }
    log "allocated=$allocated bytes; logical=$(stat -c %s -- "$file") bytes: $file"
    free -m
}
runtime_guard() {
    [[ $(uname -s) == Linux && $(id -u) == 0 ]] || { fail 'requires Linux root RAM-maintenance environment'; return 1; }
    case "$(stat -f -c %T /)" in ramfs|tmpfs) ;; *) fail 'current / is not a RAM-maintenance filesystem'; return 1;; esac
    awk '$5=="/" {dev=$3; type=""; for(i=7;i<=NF;i++)if($i=="-"){type=$(i+1);break}} END{exit !(dev~/^0:/ && type~/^(rootfs|ramfs|tmpfs)$/)}' /proc/self/mountinfo || { fail 'block-backed root refused'; return 1; }
    # No block filesystem mount or swap may be consuming/modifying a real device here.
    awk '$3!~/^0:/ {bad=1} END{exit bad}' /proc/self/mountinfo || { fail 'existing block-backed mount refused'; return 1; }
    [[ $(awk 'END{print NR}' /proc/swaps) -eq 1 ]] || { fail 'swap must be disabled'; return 1; }
    [[ $(stat -f -c %T /run) == tmpfs ]] && ram_mountpoint /run /proc/self/mountinfo >/dev/null || { fail '/run must be tmpfs'; return 1; }
    no_symlink_components /run && no_symlink_components /mnt || return 1
    [[ -d /mnt && ! -e $BASE_DIR && ! -L $BASE_DIR && ! -e $WORK_DIR && ! -L $WORK_DIR ]] || { fail 'fixed work directories must be new'; return 1; }
    validate_gnu_dd_version "$("$GNU_DD" --version)" || { fail 'GNU dd, not BusyBox dd, is required'; return 1; }
    [[ $("$LOSETUP" --version) == *'util-linux'* ]] || { fail 'util-linux losetup is required'; return 1; }
    [[ $("$MKE2FS" -V 2>&1) == *'mke2fs 1.47.'* ]] || { fail 'reviewed e2fsprogs 1.47 is required'; return 1; }
    for item in "$SOURCE_GZ" "$PIGZ" "$SETFACL" "$GETFACL"; do assert_ram_regular "$item" || return 1; done
    [[ -x $PIGZ && -x $SETFACL && -x $GETFACL && -x $GETCAP && -x $OPENSSL && -x $E2FSCK ]] || { fail 'required native tool is not executable'; return 1; }
    [[ $("$PIGZ" --version 2>&1) == 'pigz 2.6' ]] || { fail 'expected verified pigz 2.6'; return 1; }
    [[ $(hash_file "$STATIC_BB") == 9b89dbebc390b4b9174a449df18b422892387bf35717a63cf1e0aef5b4e8dcfe ]] || { fail 'maintenance BusyBox identity mismatch'; return 1; }
    [[ $(stat -c %s "$SOURCE_GZ") == "$SOURCE_GZIP_BYTES" && $(hash_file "$SOURCE_GZ") == "$SOURCE_GZIP_SHA" ]] || { fail 'canonical input gzip identity mismatch'; return 1; }
    [[ -d $OVERLAY && ! -L $OVERLAY ]] && no_symlink_components "$OVERLAY" || return 1
    [[ $(find "$OVERLAY" -type f | wc -l) -eq 3 && -z $(find "$OVERLAY" -type l -print -quit) ]] || { fail 'overlay must contain exactly three regular files and no symlinks'; return 1; }
    for item in usr/local/sbin/tr100-rom-bootstrap etc/tr100/rootfs-uuid etc/tr100/image-tag; do assert_ram_regular "$OVERLAY/$item" || return 1; done
    cmp -s <(printf '%s\n' "$ROOT_UUID") "$OVERLAY/etc/tr100/rootfs-uuid" || return 1
    cmp -s <(printf '%s\n' "$ROOT_TAG") "$OVERLAY/etc/tr100/image-tag" || return 1
    [[ $(head -n 1 "$OVERLAY/usr/local/sbin/tr100-rom-bootstrap") == '#!/usr/lib/tr100/busybox sh' ]] || return 1
    "$STATIC_BB" sh -n "$OVERLAY/usr/local/sbin/tr100-rom-bootstrap" || return 1
    memory_gate 921600 /proc/meminfo
}
owned_loop() {
    [[ $1 =~ ^/dev/loop[0-9]+$ ]] && loop_backing_matches "/sys/class/block/${1##*/}/loop/backing_file" "$2"
}
normalize_devnum() {
    [[ $# -eq 1 ]] || return 1
    awk 'NF {if(NF!=1 || $1!~/^[0-9]+:[0-9]+$/) bad=1; count++; value=$1} END {if(bad || count!=1) exit 1; print value}' <<<"$1"
}
owned_mount() {
    local point=$1 loop=$2 file=$3 actual expected
    owned_loop "$loop" "$file" || return 1
    actual=$(findmnt -n -o MAJ:MIN --mountpoint "$point") || return 1
    actual=$(normalize_devnum "$actual") || return 1
    expected=$(cat "/sys/class/block/${loop##*/}/dev") || return 1
    [[ $actual == "$expected" ]]
}
detach_one() {
    local loop=$1 file=$2
    owned_loop "$loop" "$file" || { fail 'loop ownership changed; not detaching'; return 1; }
    "$LOSETUP" -d "$loop"
}
cleanup() {
    local status=$?
    trap - EXIT INT TERM HUP
    set +e
    exec 3>&-
    if [[ -n $COUNT_PID ]]; then kill "$COUNT_PID" 2>/dev/null; wait "$COUNT_PID" 2>/dev/null; fi
    if [[ $DST_MOUNTED -eq 1 ]] && owned_mount "$ROOT_MNT" "$DST_LOOP" "$ROOT_RAW"; then umount -- "$ROOT_MNT"; fi
    if [[ $SRC_MOUNTED -eq 1 ]] && owned_mount "$BASE_MNT" "$SRC_LOOP" "$BASE_RAW"; then umount -- "$BASE_MNT"; fi
    [[ -z $DST_LOOP ]] || detach_one "$DST_LOOP" "$ROOT_RAW"
    [[ -z $SRC_LOOP ]] || detach_one "$SRC_LOOP" "$BASE_RAW"
    if [[ $SUCCESS -eq 1 && $status -eq 0 ]]; then
        log "Verified RAM files retained at $WORK_DIR. No eMMC write performed."
    else
        printf 'BUILD FAILED (status %s). Owned loops were checked for cleanup; partial RAM files/logs retained for inspection. No automatic retry/reboot.\n' "$status" >&2
    fi
    # Keep the output tmpfs mounted: unmounting it would destroy the parent's outputs.
    exit "$status"
}
attach_file() {
    local file=$1 readonly_mode=$2 loop
    assert_ram_regular "$file" || return 1
    if [[ $readonly_mode == ro ]]; then loop=$("$LOSETUP" --find --show --read-only "$file") || return 1
    else loop=$("$LOSETUP" --find --show "$file") || return 1; fi
    owned_loop "$loop" "$file" || { fail 'new loop backing verification failed'; return 1; }
    [[ $readonly_mode != ro || $(cat "/sys/class/block/${loop##*/}/ro") == 1 ]] || return 1
    printf '%s\n' "$loop"
}
capability_value() {
    local value
    value=$("$GETCAP" "$1") || return 1
    [[ $value == "$1 "* ]] || return 1
    printf '%s\n' "${value#* }"
}
no_hostkeys() {
    [[ -z $(find "$1/etc/ssh" -maxdepth 1 -name 'ssh_host_*_key*' -print -quit) ]]
}
identity_checks() {
    local root=$1
    [[ -f $root/etc/machine-id && ! -L $root/etc/machine-id && $(stat -c %s "$root/etc/machine-id") == 0 ]] || return 1
    no_hostkeys "$root" || return 1
    [[ -s $root/root/.ssh/authorized_keys && ! -L $root/root/.ssh/authorized_keys && $(stat -c '%u:%g:%a' "$root/root/.ssh/authorized_keys") == 0:0:600 ]] || return 1
    awk -F: '$1=="root" {ok=($2!="" && $2!="*" && $2!="!" && $2!~/^!/)} END{exit !ok}' "$root/etc/shadow" || return 1
    awk -F: '$1=="_apt" {a=($4==3003)} $1=="systemd-timesync" {t=($4==3003)} END{exit !(a&&t)}' "$root/etc/passwd" || return 1
    awk -F: '$1=="inet" {ok=($3==3003)} END{exit !ok}' "$root/etc/group" || return 1
    grep -Eq '^ADD_EXTRA_GROUPS=1[[:space:]]*$' "$root/etc/adduser.conf" || return 1
    grep -Eq '^EXTRA_GROUPS="([^" ]+ )*inet( [^" ]+)*"[[:space:]]*$' "$root/etc/adduser.conf" || return 1
    for setting in 'PasswordAuthentication yes' 'PubkeyAuthentication yes' 'PermitRootLogin yes' 'PermitEmptyPasswords no'; do
        grep -Fxq "$setting" "$root/etc/ssh/sshd_config.d/00-tr100.conf" || return 1
    done
    [[ $(capability_value "$root/usr/bin/ping") == cap_net_raw=ep ]] || return 1
}
journal_acl() {
    "$GETFACL" -c -p -n "$1/var/log/journal" | awk 'NF && $0!~/^#/' | sort
}
expected_acl() {
    printf '%s\n' user::rwx group::r-x group:4:r-x mask::r-x other::r-x default:user::rwx default:group::r-x default:group:4:r-x default:mask::r-x default:other::r-x | sort
}
declare -A KEEP_HASHES KEEP_METADATA
KEEP_FILES=(etc/passwd etc/shadow etc/group etc/gshadow etc/adduser.conf etc/fstab etc/ssh/sshd_config etc/ssh/sshd_config.d/00-tr100.conf root/.ssh/authorized_keys usr/local/sbin/tr100-network usr/local/sbin/tr100-enable-network usr/local/libexec/tr100-udhcpc-hook etc/systemd/system/tr100-network.service usr/lib/tr100/busybox usr/lib/systemd/systemd usr/bin/udevadm usr/sbin/sshd usr/sbin/blkid)
capture_kept_files() {
    local file
    for file in "${KEEP_FILES[@]}"; do
        [[ -f $BASE_MNT/$file && ! -L $BASE_MNT/$file ]] || return 1
        KEEP_HASHES[$file]=$(hash_file "$BASE_MNT/$file") || return 1
        KEEP_METADATA[$file]=$(stat -c '%u:%g:%a' "$BASE_MNT/$file") || return 1
    done
}
check_kept_files() {
    local file
    for file in "${KEEP_FILES[@]}"; do
        [[ -f $ROOT_MNT/$file && ! -L $ROOT_MNT/$file && $(hash_file "$ROOT_MNT/$file") == "${KEEP_HASHES[$file]}" && $(stat -c '%u:%g:%a' "$ROOT_MNT/$file") == "${KEEP_METADATA[$file]}" ]] || { fail "canonical policy/content/owner/mode changed: $file"; return 1; }
    done
}
root_content_checks() {
    identity_checks "$ROOT_MNT" && check_kept_files || return 1
    cmp -s <(expected_acl) <(journal_acl "$ROOT_MNT") || { fail 'journal access/default ACL mismatch'; return 1; }
    [[ $(stat -c %s "$ROOT_MNT/etc/fake-hwclock.data") == 20 ]] || return 1
    cmp -s <(printf '%s\n' "$BUILD_UTC") "$ROOT_MNT/etc/fake-hwclock.data" || return 1
    local file
    for file in usr/local/sbin/tr100-rom-bootstrap etc/tr100/rootfs-uuid etc/tr100/image-tag; do
        [[ $(hash_file "$ROOT_MNT/$file") == $(hash_file "$OVERLAY/$file") ]] || return 1
    done
}
superblock_field() {
    [[ $# -eq 2 ]] || return 1
    awk -v key="$2" 'index($0,key ":")==1 {value=substr($0,length(key)+2); sub(/^[[:space:]]+/,"",value); sub(/[[:space:]]+$/,"",value); count++} END {if(count!=1) exit 1; print value}' <<<"$1"
}
superblock_checks() {
    local dump features wanted
    dump=$(/usr/sbin/dumpe2fs -h "$ROOT_RAW" 2>/dev/null) || return 1
    [[ $(superblock_field "$dump" 'Filesystem UUID') == "$ROOT_UUID" ]] || return 1
    [[ $(superblock_field "$dump" 'Filesystem volume name') == TR100ROOT ]] || return 1
    [[ $(superblock_field "$dump" 'Block count') == "$ROOT_BLOCKS" ]] || return 1
    [[ $(superblock_field "$dump" 'Block size') == 4096 ]] || return 1
    [[ $(superblock_field "$dump" 'Inode size') == 256 ]] || return 1
    [[ $(superblock_field "$dump" 'Reserved block count') == 0 ]] || return 1
    features=$(superblock_field "$dump" 'Filesystem features' | xargs -n1 | sort | xargs)
    wanted=$(tr ',' '\n' <<<"$FEATURES" | sort | xargs)
    [[ $features == "$wanted" ]] || { fail 'filesystem features differ from explicit legacy whitelist'; return 1; }
    printf '%s\n' "$dump" >"$WORK_DIR/superblock.txt"
}
finish_verified_root() {
    memory_gate 393216 /proc/meminfo
    allocation_gate "$ROOT_RAW" 629145600
    log 'OpenSSL hashing the 7.7 GB logical raw file.'
    ROOT_SHA=$(hash_file "$ROOT_RAW")
    log 'pigz -p 4 -1; no second large raw file is created.'
    (set -o noclobber; "$PIGZ" -p 4 -1 -c "$ROOT_RAW" >"$ROOT_GZ.partial")
    # Count and hash complete gzip rereads without another raw file or detached workers.
    verify_gzip_reread "$ROOT_GZ.partial" "$ROOT_SHA" "$ROOT_BYTES" "$WORK_DIR/decoded"
    GZIP_SHA=$(hash_file "$ROOT_GZ.partial")
    GZIP_BYTES=$(stat -c %s "$ROOT_GZ.partial")
    allocation_gate "$ROOT_GZ.partial" 209715200
    ln -- "$ROOT_GZ.partial" "$ROOT_GZ"; rm -- "$ROOT_GZ.partial"
    cat >"$WORK_DIR/receipt.json" <<EOF
{"status":"ram-file-build-verified-not-device-boot-tested","deviceWrites":false,"sourceGzipSHA256":"$SOURCE_GZIP_SHA","sourceRawSHA256":"$SOURCE_RAW_SHA","rootUUID":"$ROOT_UUID","imageTag":"$ROOT_TAG","rootBytes":$ROOT_BYTES,"rootSHA256":"$ROOT_SHA","gzipBytes":$GZIP_BYTES,"gzipSHA256":"$GZIP_SHA","buildUTC":"$BUILD_UTC","fsckReadOnlyPassed":true,"readOnlyContentRecheckPassed":true,"journalAccessAndDefaultACLVerified":true,"pingCapabilityVerified":"cap_net_raw=ep","canonicalAccountSSHInetFilesUnchanged":true,"machineIdEmpty":true,"hostKeysAbsent":true,"gzipRereadCountAndSHA256Verified":true,"hardwareBootTested":false}
EOF
    printf '%s  rootfs.raw\n%s  rootfs.ext4.gz\n' "$ROOT_SHA" "$GZIP_SHA" >"$WORK_DIR/SHA256SUMS"
    SUCCESS=1
    log "READY ordinary RAM files: $ROOT_RAW and $ROOT_GZ; receipt=$WORK_DIR/receipt.json"
}
run_build() {
    runtime_guard
    BASE_RAW=$BASE_DIR/source.raw BASE_MNT=$BASE_DIR/ro
    ROOT_RAW=$WORK_DIR/rootfs.raw ROOT_MNT=$WORK_DIR/root-mount
    ROOT_GZ=$WORK_DIR/rootfs.ext4.gz
    export LC_ALL=C
    umask 077
    mkdir -- "$BASE_DIR" "$WORK_DIR"
    mount -t tmpfs -o size=1100m,mode=0700,nosuid,nodev tmpfs "$WORK_DIR"
    [[ $(stat -f -c %T "$WORK_DIR") == tmpfs ]] || return 1
    mkdir -- "$BASE_MNT" "$ROOT_MNT"
    trap cleanup EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM HUP
    log 'Inputs and RAM maintenance root verified; GNU sparse canonical decompression.'
    (set -o noclobber; : >"$BASE_RAW")
    assert_ram_regular "$BASE_RAW"
    "$PIGZ" -dc "$SOURCE_GZ" | {
        "$GNU_DD" of="$BASE_RAW" bs=1048576 count=800 iflag=fullblock conv=sparse status=none
        extra=$("$GNU_DD" bs=1 count=1 status=none | wc -c)
        [[ $extra -eq 0 ]] || { fail 'canonical decompression exceeded 800 MiB'; return 1; }
    }
    [[ $(stat -c %s "$BASE_RAW") == "$SOURCE_RAW_BYTES" && $(hash_file "$BASE_RAW") == "$SOURCE_RAW_SHA" ]] || { fail 'raw canonical identity mismatch'; return 1; }
    allocation_gate "$BASE_RAW" 471859200
    memory_gate 563200 /proc/meminfo
    SRC_LOOP=$(attach_file "$BASE_RAW" ro)
    mount -t ext4 -o ro,noload "$SRC_LOOP" "$BASE_MNT"; SRC_MOUNTED=1
    identity_checks "$BASE_MNT"
    capture_kept_files
    log 'Creating only a RAM ordinary sparse file; mke2fs -d reads the RO canonical source.'
    (set -o noclobber; : >"$ROOT_RAW")
    /usr/bin/truncate -s "$ROOT_BYTES" "$ROOT_RAW"
    assert_ram_regular "$ROOT_RAW"
    [[ $(stat -c %s "$ROOT_RAW") == "$ROOT_BYTES" ]] || return 1
    "$MKE2FS" -q -F -t ext4 -b 4096 -i 32768 -I 256 -m 0 -U "$ROOT_UUID" -L TR100ROOT -J size=32 \
        -O "none,$FEATURES" -E nodiscard,lazy_itable_init=0,lazy_journal_init=0 -d "$BASE_MNT" "$ROOT_RAW" "$ROOT_BLOCKS"
    DST_LOOP=$(attach_file "$ROOT_RAW" rw)
    mount -t ext4 -o rw "$DST_LOOP" "$ROOT_MNT"; DST_MOUNTED=1
    install -o 0 -g 0 -m 0755 "$OVERLAY/usr/local/sbin/tr100-rom-bootstrap" "$ROOT_MNT/usr/local/sbin/tr100-rom-bootstrap"
    install -o 0 -g 0 -m 0644 "$OVERLAY/etc/tr100/rootfs-uuid" "$ROOT_MNT/etc/tr100/rootfs-uuid"
    install -o 0 -g 0 -m 0644 "$OVERLAY/etc/tr100/image-tag" "$ROOT_MNT/etc/tr100/image-tag"
    [[ ! -L $ROOT_MNT/etc/fake-hwclock.data ]] || return 1
    printf '%s\n' "$BUILD_UTC" >"$WORK_DIR/clock.txt"
    install -o 0 -g 0 -m 0644 "$WORK_DIR/clock.txt" "$ROOT_MNT/etc/fake-hwclock.data"
    "$SETFACL" --set='u::rwx,g::r-x,g:4:r-x,m::r-x,o::r-x' "$ROOT_MNT/var/log/journal"
    "$SETFACL" -d --set='u::rwx,g::r-x,g:4:r-x,m::r-x,o::r-x' "$ROOT_MNT/var/log/journal"
    root_content_checks
    umount -- "$ROOT_MNT"; DST_MOUNTED=0
    detach_one "$DST_LOOP" "$ROOT_RAW"; DST_LOOP=
    allocation_gate "$ROOT_RAW" 629145600
    memory_gate 204800 /proc/meminfo
    "$E2FSCK" -f -n "$ROOT_RAW"
    superblock_checks
    DST_LOOP=$(attach_file "$ROOT_RAW" ro)
    mount -t ext4 -o ro,noload "$DST_LOOP" "$ROOT_MNT"; DST_MOUNTED=1
    root_content_checks
    umount -- "$ROOT_MNT"; DST_MOUNTED=0
    detach_one "$DST_LOOP" "$ROOT_RAW"; DST_LOOP=
    # Release the owned canonical temporary file before hashing/compressing the large root.
    umount -- "$BASE_MNT"; SRC_MOUNTED=0
    detach_one "$SRC_LOOP" "$BASE_RAW"; SRC_LOOP=
    assert_ram_regular "$BASE_RAW"
    rm -- "$BASE_RAW"
    log 'Source loop detached and own temporary 800 MiB file released; target is unmounted.'
    finish_verified_root

}
main() {
    parse_args "$@" || return 2
    if [[ $MODE == plan ]]; then plan; return; fi
    set -Eeuo pipefail
    PATH=/usr/sbin:/usr/bin:/sbin:/bin
    export PATH LC_ALL=C
    run_build
}
if [[ ${BASH_SOURCE[0]} == "$0" ]]; then main "$@"; fi
