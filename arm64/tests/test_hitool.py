import importlib.util
from pathlib import Path
import struct
import os
import shutil
import tempfile
import unittest
import xml.etree.ElementTree as ET
import zlib

SCRIPT = Path(__file__).resolve().parents[1] / 'tools/make_hitool_package.py'


def load():
    assert SCRIPT.is_file(), 'HiTool package exporter is not implemented'
    spec = importlib.util.spec_from_file_location('hitool', SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def environment(entries, tail=b'factory-tail'):
    image = bytearray(4 * 1024 * 1024)
    body = ('\0'.join(k + '=' + v for k, v in entries) + '\0\0').encode()
    image[4:4 + len(body)] = body
    struct.pack_into('<I', image, 0, zlib.crc32(image[4:65536]))
    image[65536:65536 + len(tail)] = tail
    return bytes(image)


class HiToolTests(unittest.TestCase):
    def test_xml_covers_exact_device_and_only_selects_three_images(self):
        module = load()
        parts = ET.fromstring(module.make_xml()).findall('Part')
        self.assertEqual(len(parts), 8)
        self.assertEqual([p.get('PartitionName') for p in parts if p.get('Sel') == '1'],
                         ['bootargs', 'kernel', 'rootfs'])
        self.assertEqual([p.get('SelectFile') for p in parts if p.get('Sel') == '1'],
                         ['bootargs.img', 'kernel.img', 'rootfs.img'])
        self.assertEqual([(p.get('Start'), p.get('Length')) for p in parts],
                         [('0', '4M'), ('4M', '4M'), ('8M', '12M'), ('20M', '4M'),
                          ('24M', '2M'), ('26M', '8M'), ('34M', '8M'), ('42M', '7414M')])
        self.assertTrue(all(p.get('FlashType') == 'emmc' for p in parts))
        self.assertEqual(parts[-1].get('FileSystem'), 'ext3/4')

    def test_environment_preserves_identity_order_and_full_tail(self):
        module = load()
        before = [('bootdelay', '3'), ('bootcmd', 'old'), ('bootargs', 'old'),
                  ('ethaddr', '02:aa:bb:cc:dd:ee'), ('verify', 'n')]
        original = environment(before)
        result = module.rebuild_environment(original, 'new args', 0x3491)
        after = module.parse_environment(result)
        self.assertEqual(list(after), [k for k, v in before])
        self.assertEqual(after['ethaddr'], '02:aa:bb:cc:dd:ee')
        self.assertEqual(after['bootdelay'], '3')
        self.assertEqual(after['verify'], 'yes')
        self.assertEqual(after['bootargs'], 'new args')
        self.assertIn('mw.l 0x00c8ed94 0xe30033c9 1', after['bootcmd'])
        self.assertIn('cp.b 0x40800000 0x06000000 0x3491', after['bootcmd'])
        self.assertTrue(after['bootcmd'].endswith('bootm 0x40000000 - 0x06000000'))
        self.assertEqual(result[65536:], original[65536:])
        self.assertNotIn('if ', after['bootcmd'])
        self.assertNotIn('&&', after['bootcmd'])

    def test_environment_rejects_bad_crc_and_duplicates_but_accepts_inactive_padding(self):
        module = load()
        original = environment([('bootcmd', 'a'), ('bootargs', 'b')])
        bad = bytearray(original); bad[7] ^= 1
        with self.assertRaises(ValueError):
            module.parse_environment(bytes(bad))
        with self.assertRaises(ValueError):
            module.parse_environment(environment([('bootcmd', 'a'), ('bootcmd', 'b'), ('bootargs', 'c')]))
        bad = bytearray(original); bad[60000] = 1
        struct.pack_into('<I', bad, 0, zlib.crc32(bad[4:65536]))
        self.assertEqual(module.parse_environment(bytes(bad)), {'bootcmd': 'a', 'bootargs': 'b'})

    def test_identity_is_bound_to_deviceinfo_not_stale_environment_ethaddr(self):
        module = load()
        prefix = bytearray(42 * 1024 * 1024)
        prefix[20 * 1024 * 1024:20 * 1024 * 1024 + 17] = b'02:AA:BB:CC:DD:EE'
        module.check_device_identity(prefix, '02:aa:bb:cc:dd:ee')
        with self.assertRaises(ValueError):
            module.check_device_identity(prefix, '02:aa:bb:cc:dd:ef')

    def test_verified_snapshot_binds_bytes_to_hash(self):
        import hashlib
        module = load()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'prefix'
            path.write_bytes(b'known')
            frozen = module.read_verified(path, 5, hashlib.sha256(b'known').hexdigest())
            path.write_bytes(b'other')
            self.assertEqual(frozen, b'known')
            with self.assertRaises(ValueError):
                module.read_verified(path, 5, hashlib.sha256(b'known').hexdigest())

    @unittest.skipUnless(os.environ.get('DTC') or shutil.which('dtc'), 'dtc required')
    def test_kernel_rejects_second_partition_map_even_when_expected_map_exists(self):
        import types
        module = load()
        path = SCRIPT.parents[1] / 'build/pack.py'
        spec = importlib.util.spec_from_file_location('pack_test', path)
        pack = importlib.util.module_from_spec(spec); spec.loader.exec_module(pack)
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            raw = bytearray(64)
            struct.pack_into('<QQ', raw, 8, 0, 0x10000)
            struct.pack_into('<I', raw, 0x38, 0x644d5241)
            (folder / 'Image').write_bytes(raw)
            source = (SCRIPT.parents[1] / 'tr100.dts').read_text()
            source = source.replace('console=ttyAMA0,115200 ',
                                    'blkdevparts=mmcblk0:-(wrong-root) console=ttyAMA0,115200 ', 1)
            (folder / 'source.dts').write_text(source)
            pack.package(types.SimpleNamespace(image=folder/'Image', dts=folder/'source.dts',
                         dtc=os.environ.get('DTC') or shutil.which('dtc'), output=folder/'out',
                         mac='02:aa:bb:cc:dd:ee', unconfigured=False, source_date_epoch=1729123200))
            with self.assertRaisesRegex(ValueError, 'eight-partition'):
                module.check_kernel((folder/'out/installed-p3.bin').read_bytes(), '02:aa:bb:cc:dd:ee')

    def test_factory_layout_must_match_protected_positions(self):
        module = load()
        valid = 'console=ttyAMA0 blkdevparts=mmcblk0:4M(fastboot),4M(bootargs),12M(recovery),4M(deviceinfo),2M(atf),8M(baseparam),8M(pqparam),-(system)'
        module.check_factory_layout(valid)
        for invalid in ('console=ttyAMA0', valid.replace('4M(fastboot)', '1M(fastboot)'),
                        valid.replace('2M(atf)', '4M(atf)'), valid + ' blkdevparts=mmcblk0:-(root)'):
            with self.assertRaises(ValueError):
                module.check_factory_layout(invalid)

    def test_unknown_loader_or_atf_is_rejected(self):
        module = load()
        with self.assertRaisesRegex(ValueError, 'loader'):
            module.check_prefix(bytes(42 * 1024 * 1024))

    def test_sparse_copy_keeps_exact_bytes_and_rejects_wrong_hash(self):
        module = load()
        import hashlib
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'source'; output = Path(directory) / 'output'
            data = bytes(1024 * 1024) + b'payload' + bytes(1024 * 1024)
            source.write_bytes(data)
            module.copy_verified(source, output, hashlib.sha256(data).hexdigest())
            self.assertEqual(output.read_bytes(), data)
            with self.assertRaises(ValueError):
                module.copy_verified(source, Path(directory) / 'bad', '0' * 64)


if __name__ == '__main__':
    unittest.main()
