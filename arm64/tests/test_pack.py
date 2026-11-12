"""Exercise the portable packager with real Image/uImage/FDT bytes.

Set DTC to a built device-tree compiler to enable the end-to-end tests.
"""
import gzip
import hashlib
import json
import os
import random
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
import zlib

PACK = Path(__file__).resolve().parents[1] / "build" / "pack.py"
DTS = PACK.parent.parent / "tr100.dts"
DTC = os.environ.get("DTC") or shutil.which("dtc")
TOKEN = b"tr100.arm64.root=installed"


def image_bytes(size=4096, memory_size=0xA70000, offset=0):
    data = bytearray(size)
    struct.pack_into("<QQQ", data, 8, offset, memory_size, 10)
    struct.pack_into("<I", data, 0x38, 0x644D5241)
    return bytes(data)


class PackagingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="tr100 pack spaces ")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.image = self.root / "kernel Image"
        self.image.write_bytes(image_bytes())
        self.out = self.root / "release outputs"

    def run_pack(self, *extra, mac=True, output=None):
        cmd = [sys.executable, str(PACK), "--image", str(self.image),
               "--dts", str(DTS), "--output", str(output or self.out),
               "--dtc", str(DTC or "dtc"), "--source-date-epoch", "1735689600"]
        cmd += ["--mac", "00:11:22:33:44:55"] if mac else []
        return subprocess.run(cmd + list(extra), text=True, capture_output=True)

    def assert_rejected(self, result, message):
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn(message, result.stderr)
        self.assertFalse(self.out.exists())

    def test_rejects_elf_and_nonzero_text_offset(self):
        self.image.write_bytes(b"\x7fELF" + bytes(100))
        self.assert_rejected(self.run_pack(), "AArch64 Image")
        self.image.write_bytes(image_bytes(offset=0x80000))
        self.assert_rejected(self.run_pack(), "text_offset")

    def test_requires_regular_input_files(self):
        directory = self.root / "not an Image"
        directory.mkdir()
        self.assert_rejected(self.run_pack("--image", str(directory)), "regular file")

    def test_rejects_decompressed_memory_overlap(self):
        self.image.write_bytes(image_bytes(memory_size=0x4000001))
        self.assert_rejected(self.run_pack(), "DTB")

    def test_rejects_incompressible_uimage_before_dtb_slot(self):
        data = bytearray(random.Random(1234).randbytes(9 * 1024 * 1024))
        data[:64] = image_bytes()[:64]
        self.image.write_bytes(data)
        self.assert_rejected(self.run_pack(), "8 MiB")

    @unittest.skipUnless(DTC, "set DTC to run real DTB integration")
    def test_rejects_invalid_dts_layout_and_overflowing_dtb(self):
        template = self.root / "template.dts"
        template.write_text(DTS.read_text().replace("0x01000000>;\n\t\t\tno-map;",
                                                   "0x00800000>;\n\t\t\tno-map;"))
        self.assert_rejected(self.run_pack("--dts", str(template)), "reserve")
        template.write_text(DTS.read_text().replace('stdout-path =',
                            'large-test-property = "' + "x"*(2*1024*1024) + '";\nstdout-path ='))
        self.assert_rejected(self.run_pack("--dts", str(template)), "10 MiB")

    def test_requires_reproducible_timestamp_and_template_identity(self):
        self.assert_rejected(self.run_pack("--source-date-epoch", "-1"), "timestamp")
        template = self.root / "private.dts"
        template.write_text(DTS.read_text().replace("02 00 00 00 00 01", "00 11 22 33 44 55"))
        self.assert_rejected(self.run_pack("--dts", str(template)), "placeholder")

    def test_rejects_missing_invalid_placeholder_and_multicast_mac(self):
        self.assert_rejected(self.run_pack(mac=False), "--mac")
        for mac in ("bad", "00:00:00:00:00:00", "ff:ff:ff:ff:ff:ff",
                    "02:00:00:00:00:01", "01:11:22:33:44:55"):
            with self.subTest(mac=mac):
                self.assert_rejected(self.run_pack("--mac", mac), "MAC")

    @unittest.skipUnless(DTC, "set DTC to run real DTB integration")
    def test_binary_headers_partition_layout_and_source_provenance(self):
        result = self.run_pack()
        self.assertEqual(result.returncode, 0, result.stderr)
        manifest = json.loads((self.out / "manifest.json").read_text())
        uimage = (self.out / "candidate.uImage").read_bytes()
        fields = struct.unpack(">7I4B32s", uimage[:64])
        self.assertEqual(fields[0], 0x27051956)
        header = bytearray(uimage[:64]); header[4:8] = bytes(4)
        self.assertEqual(fields[1], zlib.crc32(header))
        self.assertEqual(fields[2], 1735689600)
        self.assertEqual(fields[3], len(uimage) - 64)
        self.assertEqual(fields[4:6], (0x2000000, 0x2000000))
        self.assertEqual(fields[6], zlib.crc32(uimage[64:]))
        self.assertEqual(fields[7:11], (5, 22, 2, 1))
        self.assertEqual(gzip.decompress(uimage[64:]), self.image.read_bytes())
        ram = (self.out / "candidate.dtb").read_bytes()
        installed = (self.out / "installed.dtb").read_bytes()
        self.assertNotIn(TOKEN, ram)
        self.assertEqual(installed.count(TOKEN), 1)
        self.assertIn(bytes.fromhex("001122334455"), ram)
        self.assertNotIn(bytes.fromhex("020000000001"), ram)
        for name in ("candidate.dtb", "installed.dtb"):
            decoded = subprocess.run([str(DTC), "-I", "dtb", "-O", "dts",
                                      str(self.out / name)], capture_output=True)
            self.assertEqual(decoded.returncode, 0, decoded.stderr)
        bundle = (self.out / "candidate-ram-bundle.bin").read_bytes()
        offset = manifest["ram"]["dtb_offset"]
        self.assertEqual(offset % 65536, 0)
        self.assertEqual(bundle[offset:], ram)
        self.assertLessEqual(len(bundle), 16 * 1024 * 1024)
        partition = (self.out / "installed-p3.bin").read_bytes()
        self.assertEqual(len(partition), 12 * 1024 * 1024)
        self.assertEqual(partition[:len(uimage)], uimage)
        self.assertEqual(partition[8*1024*1024:8*1024*1024+len(installed)], installed)
        self.assertFalse(any(partition[len(uimage):8*1024*1024]))
        self.assertFalse(any(partition[8*1024*1024+len(installed):]))
        self.assertEqual(manifest["installed"]["read_crc32"],
                         f"{zlib.crc32(partition[:10*1024*1024]):08x}")
        self.assertEqual(manifest["inputs"]["image"]["sha256"],
                         hashlib.sha256(self.image.read_bytes()).hexdigest())
        self.assertEqual(manifest["inputs"]["dts"]["sha256"],
                         hashlib.sha256(DTS.read_bytes()).hexdigest())
        for name, info in manifest["artifacts"].items():
            data = (self.out / name).read_bytes()
            self.assertEqual(info["sha256"], hashlib.sha256(data).hexdigest())
            self.assertEqual(info["crc32"], f"{zlib.crc32(data):08x}")
        commands = manifest["installed"]["boot_commands"]
        self.assertEqual(commands[-1], "bootm 0x40000000 - 0x06000000")
        self.assertIn("mmc read 0 0x08020000 0xc000 0x1000", commands)
        self.assertLess(commands.index("mmc read 0 0x08020000 0xc000 0x1000"),
                        len(commands)-1)
        self.assertNotIn("mmc write", (self.out / "boot-commands.txt").read_text())
        second = self.root / "another output"
        self.assertEqual(self.run_pack(output=second).returncode, 0)
        for item in self.out.iterdir():
            self.assertEqual(item.read_bytes(), (second / item.name).read_bytes(), item.name)

    @unittest.skipUnless(DTC, "set DTC to run real DTB integration")
    def test_generic_release_requires_personalization(self):
        result = self.run_pack("--unconfigured", mac=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        manifest = json.loads((self.out / "manifest.json").read_text())
        self.assertTrue(manifest["requires_personalization"])
        self.assertIsNone(manifest["ram"]["boot_commands"])
        self.assertIsNone(manifest["installed"]["boot_commands"])
        self.assertIn("PERSONALIZE", (self.out / "boot-commands.txt").read_text())


if __name__ == "__main__":
    unittest.main()
