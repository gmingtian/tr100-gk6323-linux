"""Validate user supplied binaries and reproducible initramfs input."""
import importlib.util
import pathlib
import struct
import tempfile
import unittest
from types import SimpleNamespace

SCRIPT = pathlib.Path(__file__).resolve().parents[1] / 'build' / 'build.py'

class BuildTests(unittest.TestCase):
    def module(self):
        self.assertTrue(SCRIPT.is_file(), 'portable kernel build is missing')
        spec = importlib.util.spec_from_file_location('build_kernel', SCRIPT)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_busybox_rejects_wrong_arch_and_dynamic_linker(self):
        m = self.module()
        with tempfile.TemporaryDirectory() as tmp:
            binary = pathlib.Path(tmp) / 'busybox'
            header = bytearray(64)
            header[:6] = b'\x7fELF\x02\x01'
            struct.pack_into('<HHIQQQIHHHHHH', header, 16, 2, 183, 1, 0, 64, 0, 0, 64, 56, 1, 0, 0, 0)
            binary.write_bytes(header + struct.pack('<IIQQQQQQ', 1, 5, 0, 0, 0, 120, 120, 4096))
            m.validate_static_arm64(binary)
            struct.pack_into('<H', header, 18, 40)
            binary.write_bytes(header)
            with self.assertRaisesRegex(ValueError, 'AArch64'):
                m.validate_static_arm64(binary)
            struct.pack_into('<H', header, 18, 183)
            binary.write_bytes(header + struct.pack('<IIQQQQQQ', 3, 0, 0, 0, 0, 0, 0, 0))
            with self.assertRaisesRegex(ValueError, 'static'):
                m.validate_static_arm64(binary)

    def test_config_replaces_host_initramfs_and_wont_hide_other_options(self):
        m = self.module()
        original = 'CONFIG_COMPAT=y\nCONFIG_INITRAMFS_SOURCE="/someone/else/root"\nCONFIG_INITRAMFS_ROOT_UID=1000\n'
        resolved = m.configure_initramfs(original, pathlib.Path('/work/initramfs.list'))
        self.assertIn('CONFIG_COMPAT=y\n', resolved)
        self.assertIn('CONFIG_INITRAMFS_SOURCE="/work/initramfs.list"\n', resolved)
        self.assertNotIn('/someone', resolved)
        self.assertIn('CONFIG_INITRAMFS_ROOT_UID=0\n', resolved)

    def test_failed_build_does_not_publish_partial_output(self):
        m = self.module()
        with tempfile.TemporaryDirectory() as tmp:
            work = pathlib.Path(tmp)
            args = SimpleNamespace(work_dir=work, output=work / 'release')
            with self.assertRaisesRegex(ValueError, 'source-manifest'):
                m.build(args)
            self.assertFalse(args.output.exists())
            self.assertEqual(list(work.glob('.output-*')), [])

    def test_make_paths_with_whitespace_are_rejected_early(self):
        m = self.module()
        with self.assertRaisesRegex(ValueError, 'whitespace'):
            m.make_path(pathlib.Path('/build/path with space'))

if __name__ == '__main__':
    unittest.main()
