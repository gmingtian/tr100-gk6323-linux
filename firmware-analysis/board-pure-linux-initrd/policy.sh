#!/bin/busybox sh
# Pure-Linux fixed p8 policy. Handoff records are data, never sourced.
TR100_UUID=a8d4abf7-6ae4-4f9b-a39a-ef1b79c63230
TR100_UUID_HEX=a8d4abf76ae44f9ba39aef1b79c63230
TR100_IMAGE_TAG=tr100-pure-linux-20261111
TR100_BLKDEVPARTS='blkdevparts=mmcblk0:4M(fastboot),4M(bootargs),12M(kernel),4M(deviceinfo),2M(atf),8M(baseparam),8M(pqparam),-(rootfs)'

tr100_validate_cmdline() {
    tr100_seen_map=0
    set -f
    for tr100_arg in $1; do
        case "$tr100_arg" in
            blkdevparts=*)
                [ "$tr100_seen_map" -eq 0 ] && [ "$tr100_arg" = "$TR100_BLKDEVPARTS" ] || return 1
                tr100_seen_map=1
                ;;
            tr100.ramtest=*|tr100.root_sha256=*) return 1;;
        esac
    done
    [ "$tr100_seen_map" -eq 1 ]
}

tr100_check_p8() {
    [ "$#" -eq 5 ] && [ "$1" = 86016 ] && [ "$2" = 15183872 ] &&
        [ "$3" = 259:0 ] && [ "$4" = 103:0 ] && [ "$5" = 15269888 ]
}

tr100_check_ext_signature() {
    [ "$#" -eq 2 ] && [ "$1" = 53ef ] && [ "$2" = "$TR100_UUID_HEX" ]
}

tr100_check_markers() {
    [ "$#" -eq 2 ] && [ "$1" = "$TR100_UUID" ] && [ "$2" = "$TR100_IMAGE_TAG" ]
}

tr100_read_singleline() {
    [ "$#" -eq 1 ] && [ -f "$1" ] && [ ! -L "$1" ] || return 1
    IFS= read -r TR100_LINE <"$1" || return 1
    case "$TR100_LINE" in *"$(printf '\r')"*) return 1;; esac
    [ "$("$BB" wc -l <"$1")" -eq 1 ] || return 1
    [ "$("$BB" wc -c <"$1")" -eq "$((${#TR100_LINE} + 1))" ]
}

tr100_write_handoff() {
    [ "$#" -eq 3 ] || return 1
    case "$2:$3" in /dev/mmcblk0p8:259:0) ;; *) return 1;; esac
    [ -d "$1" ] && [ ! -L "$1" ] || return 1
    printf '%s\n' "$2" >"$1/root-device" &&
        printf '%s\n' "$3" >"$1/root-devnum" &&
        printf '%s\n' "$TR100_UUID" >"$1/root-uuid"
}

tr100_check_interpreter() {
    [ "$#" -eq 1 ] && [ -f "$1" ] && [ ! -L "$1" ] || return 1
    [ "$("$BB" stat -c %s "$1")" = 1284688 ] || return 1
    tr100_elf=$("$BB" dd if="$1" bs=1 count=6 2>/dev/null | "$BB" od -An -v -tx1 | "$BB" tr -d ' \n') || return 1
    tr100_machine=$("$BB" dd if="$1" bs=1 skip=18 count=2 2>/dev/null | "$BB" od -An -v -tx1 | "$BB" tr -d ' \n') || return 1
    [ "$tr100_elf" = 7f454c460101 ] && [ "$tr100_machine" = 2800 ] || return 1
    tr100_newbb_sum=$("$BB" sha256sum "$1") || return 1
    [ "${tr100_newbb_sum%% *}" = 9b89dbebc390b4b9174a449df18b422892387bf35717a63cf1e0aef5b4e8dcfe ] || return 1
}

tr100_check_bootstrap() {
    [ "$#" -eq 1 ] && [ -f "$1" ] && [ ! -L "$1" ] || return 1
    IFS= read -r tr100_shebang <"$1" || return 1
    [ "$tr100_shebang" = '#!/usr/lib/tr100/busybox sh' ] || return 1
    # Only parse; no code from the new root is executed before switch_root.
    "$BB" sh -n "$1"
}

tr100_preflight_newroot() {
    [ "$#" -eq 1 ] && [ -d "$1" ] && [ ! -L "$1" ] || return 1
    tr100_root=$1
    # Refuse path components that could resolve outside the mounted new root before chroot.
    for tr100_dir in usr usr/lib usr/lib/tr100 usr/local usr/local/sbin proc sys dev run; do
        [ -d "$tr100_root/$tr100_dir" ] && [ ! -L "$tr100_root/$tr100_dir" ] || return 1
    done
    tr100_newbb=$tr100_root/usr/lib/tr100/busybox
    tr100_bootstrap=$tr100_root/usr/local/sbin/tr100-rom-bootstrap
    tr100_check_interpreter "$tr100_newbb" && tr100_check_bootstrap "$tr100_bootstrap" || return 1
    [ -x "$tr100_newbb" ] && [ -x "$tr100_bootstrap" ]
}
