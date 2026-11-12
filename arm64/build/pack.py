#!/usr/bin/env python3
"""Deterministic TR100 ARM64 packaging. Never opens or writes a device."""
import argparse
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import tempfile
import zlib

MIB = 1024 * 1024
LOAD = 0x02000000
DTB_LOAD = 0x06000000
ATF_LOAD = 0x08020000
SCRATCH = 0x40000000
TOKEN = "tr100.arm64.root=installed"
PLACEHOLDER = bytes.fromhex("020000000001")
HEADER = ">7I4B32s"


def check(condition, message):
    if not condition:
        raise ValueError(message)


def checksum(data):
    return {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(),
            "crc32": f"{zlib.crc32(data):08x}"}


def validate_image(image):
    check(len(image) >= 64 and struct.unpack_from("<I", image, 0x38)[0] == 0x644D5241,
          "input must be an uncompressed AArch64 Image, not ELF/uImage/gzip")
    offset, size = struct.unpack_from("<QQ", image, 8)
    check(offset == 0, "Image text_offset must be zero for this legacy boot layout")
    check(size > 0, "Image image_size must describe the decompressed memory extent")
    extent = max(size, len(image))
    check(LOAD + extent <= DTB_LOAD, "decompressed Image overlaps DTB at 0x06000000")
    check(LOAD + extent <= ATF_LOAD, "decompressed Image overlaps ATF at 0x08020000")
    return extent


def parse_mac(value):
    check(re.fullmatch(r"[0-9a-fA-F]{2}(:[0-9a-fA-F]{2}){5}", value) is not None,
          "MAC must contain six colon-separated hexadecimal octets")
    mac = bytes.fromhex(value.replace(":", ""))
    check(mac not in (bytes(6), PLACEHOLDER) and not mac[0] & 1,
          "MAC must be a unicast factory address, not zero/multicast/template MAC")
    return mac


def fdt_properties(blob):
    """Read compiled FDT properties, checking header, bounds, and structure."""
    check(len(blob) >= 40, "truncated DTB header")
    magic, total, off_struct, off_strings, off_reserve, version, compat, _, strings_size, struct_size = struct.unpack_from(
        ">10I", blob)
    check(magic == 0xD00DFEED and total == len(blob) and version >= 17 and compat <= 17,
          "invalid DTB header")
    check(40 <= off_reserve < total and 40 <= off_struct <= total and
          off_struct + struct_size <= total and 40 <= off_strings <= total and
          off_strings + strings_size <= total, "invalid DTB block bounds")
    strings = blob[off_strings:off_strings + strings_size]
    pos, end = off_struct, off_struct + struct_size
    nodes, props = [], {}
    while pos + 4 <= end:
        token = struct.unpack_from(">I", blob, pos)[0]; pos += 4
        if token == 1:
            stop = blob.find(b"\0", pos, end)
            check(stop >= pos, "invalid DTB node name")
            nodes.append(blob[pos:stop].decode("ascii"))
            pos = (stop + 4) & ~3
        elif token == 2:
            check(bool(nodes), "invalid DTB node nesting")
            nodes.pop()
        elif token == 3:
            check(nodes and pos + 8 <= end, "invalid DTB property")
            length, name_offset = struct.unpack_from(">II", blob, pos); pos += 8
            check(name_offset < len(strings) and pos + length <= end,
                  "invalid DTB property bounds")
            stop = strings.find(b"\0", name_offset)
            check(stop >= name_offset, "invalid DTB property name")
            name = strings[name_offset:stop].decode("ascii")
            key = ("/" + "/".join(nodes[1:]), name)
            check(key not in props, "duplicate DTB property")
            props[key] = blob[pos:pos + length]
            pos = (pos + length + 3) & ~3
        elif token == 4:
            pass
        elif token == 9:
            check(not nodes, "unclosed DTB node")
            return props
        else:
            raise ValueError("invalid DTB structure token")
    raise ValueError("missing DTB end token")


def compile_dtb(dtc, source, work, name, mac, installed):
    src = work / (name + ".dts")
    dst = work / (name + ".dtb")
    src.write_text(source, encoding="utf-8")
    result = subprocess.run([dtc, "-I", "dts", "-O", "dtb", "-o", str(dst), str(src)],
                            capture_output=True, text=True)
    check(result.returncode == 0, "dtc failed: " + result.stderr)
    blob = dst.read_bytes()
    props = fdt_properties(blob)
    bootargs = props.get(("/chosen", "bootargs"), b"").rstrip(b"\0").decode("ascii").split()
    check(bootargs.count(TOKEN) == int(installed), "DTB installed-root token count is incorrect")
    check("mmz=ddr,0,0,44M" in bootargs, "DTB must preserve mmz=ddr,0,0,44M")
    check(props.get(("/soc/gketh@f9c30000/gketh_phy@0", "mac-address")) == mac,
          "DTB factory MAC is incorrect")
    for node, addr, size in (("ram-boot-scratch@40000000", SCRATCH, 16*MIB),
                             ("atf-staging@8020000", ATF_LOAD, 2*MIB)):
        check(props.get(("/reserved-memory/" + node, "reg")) == struct.pack(">II", addr, size),
              "DTB must reserve " + node)
    return blob


def package(args):
    mac = PLACEHOLDER if args.unconfigured else parse_mac(args.mac)
    for path in (args.image, args.dts):
        check(path.is_file(), "input must be a regular file: " + str(path))
    image = args.image.read_bytes()
    extent = validate_image(image)
    source_bytes = args.dts.read_bytes()
    source = source_bytes.decode("utf-8")
    check(TOKEN not in source, "DTS template must not already contain the installed-root token")
    mac_templates = re.findall(r"\bmac-address\s*=\s*\[([^]]*)\]\s*;", source)
    check(len(mac_templates) == 1,
          "DTS must contain exactly one mac-address byte-array template")
    check(bytes.fromhex(mac_templates[0]) == PLACEHOLDER,
          "DTS must contain the unconfigured MAC placeholder, not a private device identity")
    source = re.sub(r"\bmac-address\s*=\s*\[[^]]*\]\s*;",
                    "mac-address = [" + mac.hex(" ") + "];", source)
    bootargs = re.findall(r'\bbootargs\s*=\s*"([^"\n]*)"\s*;', source)
    check(len(bootargs) == 1, "DTS must contain exactly one bootargs string")
    installed_source = source.replace('"' + bootargs[0] + '"',
                                      '"' + bootargs[0] + " " + TOKEN + '"', 1)
    # GzipFile fixes the OS byte to 255 on every host; no source filename is stored.
    compressed = io.BytesIO()
    with gzip.GzipFile(fileobj=compressed, mode="wb", filename="", compresslevel=9,
                       mtime=args.source_date_epoch) as stream:
        stream.write(image)
    payload = compressed.getvalue()
    fields = [0x27051956, 0, args.source_date_epoch, len(payload), LOAD, LOAD,
              zlib.crc32(payload), 5, 22, 2, 1, b"TR100 ARM64 RAM candidate".ljust(32, b"\0")]
    fields[1] = zlib.crc32(struct.pack(HEADER, *fields))
    uimage = struct.pack(HEADER, *fields) + payload
    check(len(uimage) <= 8*MIB, "compressed uImage exceeds 8 MiB before installed DTB")
    dtc = shutil.which(str(args.dtc))
    check(dtc is not None, "dtc not found; specify --dtc /path/to/dtc")
    with tempfile.TemporaryDirectory(prefix="tr100-pack-") as temp:
        work = Path(temp)
        ram_dtb = compile_dtb(dtc, source, work, "candidate", mac, False)
        installed_dtb = compile_dtb(dtc, installed_source, work, "installed", mac, True)
    check(len(installed_dtb) <= 2*MIB, "installed DTB exceeds 10 MiB boot read window")
    check(DTB_LOAD + max(len(ram_dtb), len(installed_dtb)) <= ATF_LOAD,
          "DTB destination overlaps ATF")
    offset = (len(uimage) + 65535) & ~65535
    bundle = uimage + bytes(offset - len(uimage)) + ram_dtb
    check(len(bundle) <= 16*MIB, "RAM bundle exceeds reserved 16 MiB scratch window")
    partition = (uimage + bytes(8*MIB - len(uimage)) + installed_dtb)
    partition += bytes(12*MIB - len(partition))
    atf_commands = ["mmc read 0 0x08020000 0xc000 0x1000",
                    "crc32 0x08020000 0x200000", "bootm 0x40000000 - 0x06000000"]
    ram_commands = ["tftpboot 0x40000000 candidate-ram-bundle.bin",
                    f"crc32 0x40000000 {hex(len(bundle))}",
                    f"cp.b {hex(SCRATCH + offset)} 0x06000000 {hex(len(ram_dtb))}",
                    f"crc32 0x06000000 {hex(len(ram_dtb))}"] + atf_commands
    installed_commands = ["mmc read 0 0x40000000 0x4000 0x5000",
                          "crc32 0x40000000 0xa00000",
                          f"cp.b 0x40800000 0x06000000 {hex(len(installed_dtb))}",
                          f"crc32 0x06000000 {hex(len(installed_dtb))}"] + atf_commands
    if args.unconfigured:
        ram_commands = installed_commands = None
        commands_text = "PERSONALIZE FIRST: re-run pack.py with --mac FACTORY_MAC.\n"
    else:
        commands_text = ("Compare each CRC against manifest.json before proceeding.\n"
                         "ATF CRC must match your verified original ATF backup; stop on mismatch.\n\n"
                         "RAM ONLY (configure TFTP server before running):\n" +
                         "\n".join(ram_commands) + "\n\nINSTALLED p3 (after separately verified installation):\n" +
                         "\n".join(installed_commands) + "\n")
    artifacts = {"Image": image, "source.dts": source_bytes,
                 "candidate.dts": source.encode(), "installed.dts": installed_source.encode(),
                 "candidate.uImage": uimage, "candidate.dtb": ram_dtb,
                 "candidate-ram-bundle.bin": bundle, "installed.dtb": installed_dtb,
                 "installed-p3.bin": partition, "boot-commands.txt": commands_text.encode()}
    manifest = {
        "format_version": 1, "source_date_epoch": args.source_date_epoch,
        "requires_personalization": args.unconfigured,
        "mac": "UNCONFIGURED" if args.unconfigured else mac.hex(":"),
        "inputs": {"image": checksum(image), "dts": checksum(source_bytes),
                   "packager": checksum(Path(__file__).read_bytes()), "dtc": checksum(Path(dtc).read_bytes())},
        "image": {"load_address": LOAD, "entry_address": LOAD, "text_offset": 0,
                  "decompressed_memory_bytes": extent},
        "ram": {"purpose": "RAM_ONLY", "emmc_flashable": False,
                "scratch_address": SCRATCH, "scratch_bytes": 16*MIB,
                "dtb_offset": offset, "dtb_source_address": SCRATCH + offset,
                "dtb_destination_address": DTB_LOAD, "boot_commands": ram_commands},
        "installed": {"purpose": "INSTALLED_PARTITION_P3", "partition_bytes": 12*MIB,
                      "partition_start_sector": 0x4000, "dtb_offset": 8*MIB,
                      "read_bytes": 10*MIB, "read_crc32": checksum(partition[:10*MIB])["crc32"],
                      "boot_commands": installed_commands},
        "atf": {"source": "target original eMMC ATF partition; not included",
                "start_sector": 0xC000, "sectors": 0x1000, "load_address": ATF_LOAD,
                "bytes": 2*MIB, "expected_crc32": None,
                "requirement": "reload fresh immediately before every boot; compare against verified original backup"},
        "artifacts": {name: checksum(data) for name, data in artifacts.items()}}
    # All validation completes before creating output files. Refuse stale mixed outputs.
    args.output.mkdir(parents=True, exist_ok=True)
    check(not any(args.output.iterdir()), "output directory must be empty")
    for name, data in artifacts.items():
        (args.output / name).write_bytes(data)
    (args.output / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", type=Path, required=True, help="raw uncompressed AArch64 Image")
    parser.add_argument("--dts", type=Path, required=True, help="TR100 template DTS")
    parser.add_argument("--dtc", default="dtc", help="device-tree compiler executable (default: PATH)")
    parser.add_argument("--output", type=Path, required=True, help="new or empty local output directory")
    identity = parser.add_mutually_exclusive_group(required=True)
    identity.add_argument("--mac", help="target device factory MAC; never infer from the build host")
    identity.add_argument("--unconfigured", action="store_true", help="generic download requiring factory MAC personalization")
    parser.add_argument("--source-date-epoch", type=int, default=os.environ.get("SOURCE_DATE_EPOCH"),
                        help="required reproducible timestamp, or set SOURCE_DATE_EPOCH")
    args = parser.parse_args()
    if args.source_date_epoch is None or not 0 <= args.source_date_epoch <= 0xFFFFFFFF:
        parser.error("--source-date-epoch or SOURCE_DATE_EPOCH must be an unsigned 32-bit timestamp")
    try:
        manifest = package(args)
    except (ValueError, OSError, UnicodeError, struct.error) as error:
        parser.exit(1, f"pack.py: {error}\n")
    print(json.dumps({"requires_personalization": manifest["requires_personalization"],
                      "artifacts": sorted(manifest["artifacts"])}, indent=2))


if __name__ == "__main__":
    main()
