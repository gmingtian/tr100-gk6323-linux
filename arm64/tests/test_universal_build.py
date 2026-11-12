"""Offline universal profile and preserved-partition contract tests."""
import importlib.util
from pathlib import Path
import tempfile
import os
import shutil
import struct
import types
import unittest
import xml.etree.ElementTree as ET

HERE = Path(__file__).resolve().parents[1]


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class UniversalBuildTests(unittest.TestCase):
    def setUp(self):
        self.builder = load(HERE / 'universal/build.py', 'universal_build')
        self.rootfs = load(HERE / 'rootfs/build.py', 'clean_root')
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / 'stage/root'
        self.root.mkdir(parents=True)
        (self.root / 'etc').mkdir()
        (self.root / 'etc/shadow').write_text('root:!:19000:0:99999:7:::\n')
        self.rootfs.configure(self.root, self.rootfs.DEFAULT_UUID)
        self.rootfs.sanitize_root(self.root)
        self.rootfs.put(self.root, 'etc/tr100/provisioned', 'clean-rootfs-provisioned-v1\n')

    @unittest.skipUnless(os.environ.get('DTC') or shutil.which('dtc'), 'dtc required')
    def test_generic_kernel_is_accepted_only_by_explicit_universal_path(self):
        pack = load(HERE / 'build/pack.py', 'generic_pack_test')
        image = Path(self.tmp.name) / 'Image'
        data = bytearray(64)
        struct.pack_into('<QQ', data, 8, 0, 0x10000)
        struct.pack_into('<I', data, 0x38, 0x644d5241)
        image.write_bytes(data)
        out = Path(self.tmp.name) / 'kernel'
        pack.package(types.SimpleNamespace(image=image, dts=HERE/'tr100.dts',
                     dtc=os.environ.get('DTC') or shutil.which('dtc'), output=out,
                     mac=None, unconfigured=True, source_date_epoch=1729123200))
        kernel = (out/'installed-p3.bin').read_bytes()
        args, size = self.builder.media.check_kernel(kernel, '02:00:00:00:00:01', generic=True)
        self.assertIn('tr100.arm64.root=installed', args)
        self.assertGreater(size, 40)
        with self.assertRaises(ValueError):
            self.builder.media.check_kernel(kernel, '02:00:00:00:00:01')
        with self.assertRaises(ValueError):
            self.builder.media.check_kernel(kernel, '00:26:76:12:ab:cd', generic=True)

    def test_only_kernel_and_rootfs_are_selected(self):
        xml = ET.fromstring(self.builder.make_xml())
        self.assertEqual([p.attrib['PartitionName'] for p in xml if p.attrib['Sel'] == '1'],
                         ['kernel', 'rootfs'])
        for part in xml:
            if part.attrib['PartitionName'] not in ('kernel', 'rootfs'):
                self.assertEqual(part.attrib['SelectFile'], '')

    def test_profile_gates_all_public_logins_and_network_without_identity(self):
        self.builder.install_profile(self.root)
        self.rootfs.audit_root(self.root)
        self.assertFalse((self.root / 'etc/tr100/personalized').exists())
        self.assertFalse((self.root / 'etc/tr100/factory-mac').exists())
        self.assertEqual((self.root / 'etc/shadow').read_text().split(':')[1], '!')
        for unit in self.builder.GATED:
            text = (self.root / ('etc/systemd/system/' + unit + '.d/10-firstboot.conf')).read_text()
            self.assertIn('Requires=tr100-firstboot.service', text)
            self.assertIn('After=tr100-firstboot.service', text)
        enabled = self.root / 'etc/systemd/system/multi-user.target.wants/tr100-firstboot.service'
        self.assertEqual(enabled.readlink(), Path('../tr100-firstboot.service'))
        self.assertEqual((self.root / 'usr/local/sbin/tr100-firstboot').stat().st_mode & 0o777, 0o755)
        self.builder.install_profile(self.root)  # repeat install is safe

    def test_private_root_rejected_before_profile_mutation(self):
        self.rootfs.put(self.root, 'etc/tr100/factory-mac', '00:26:76:12:ab:cd\n')
        with self.assertRaises(ValueError):
            self.builder.install_profile(self.root)
        self.assertFalse((self.root / 'etc/tr100/firstboot-auto-profile').exists())

    def test_unprovisioned_or_unknown_root_rejected(self):
        (self.root / 'etc/tr100/provisioned').unlink()
        with self.assertRaises(ValueError):
            self.builder.install_profile(self.root)
        self.rootfs.put(self.root, 'etc/tr100/provisioned', 'clean-rootfs-provisioned-v1\n')
        self.rootfs.put(self.root, 'etc/tr100/image-tag', 'another-board\n')
        with self.assertRaises(ValueError):
            self.builder.install_profile(self.root)

    def test_profile_write_does_not_follow_symlink(self):
        outside = Path(self.tmp.name) / 'outside'
        outside.write_text('keep')
        target = self.root / 'usr/local/sbin/tr100-firstboot'
        target.symlink_to(outside)
        with self.assertRaises(ValueError):
            self.builder.install_profile(self.root)
        self.assertEqual(outside.read_text(), 'keep')


if __name__ == '__main__':
    unittest.main()
