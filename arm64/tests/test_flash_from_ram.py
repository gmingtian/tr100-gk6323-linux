"""Exercise input rejection without any block-device access."""
import gzip
import hashlib
from pathlib import Path
import subprocess
import shutil
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'tools/flash-from-ram.sh'
SHELLS = [['bash']]
if shutil.which('busybox'):
    SHELLS.append([shutil.which('busybox'), 'sh'])

class FlashInputs(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.kernel = self.root / 'installed-p3.bin'
        self.kernel.write_bytes(bytes(12 * 1024 * 1024))
        self.rootfs = self.root / 'private-rootfs.ext4.gz'
        self.rootfs.write_bytes(gzip.compress(b'not a partition', mtime=0))
        self.manifest = self.root / 'flash-manifest.txt'
        self.fields = {
            'kernel_sha256': hashlib.sha256(self.kernel.read_bytes()).hexdigest(),
            'rootfs_gz_sha256': hashlib.sha256(self.rootfs.read_bytes()).hexdigest(),
            'rootfs_ext4_sha256': hashlib.sha256(b'not a partition').hexdigest(),
            'rootfs_ext4_bytes': '7774142464',
        }

    def check(self, expected):
        self.manifest.write_text(''.join(f'{k}={v}\n' for k, v in self.fields.items()))
        for shell in SHELLS:
            with self.subTest(shell=shell):
                result = subprocess.run(shell + [str(SCRIPT), '--check-inputs', str(self.kernel),
                                         str(self.rootfs), str(self.manifest)], capture_output=True, text=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(expected, result.stderr)

    def test_rejects_wrong_kernel_hash(self):
        self.fields['kernel_sha256'] = '0' * 64
        self.check('kernel SHA256 mismatch')

    def test_rejects_short_kernel(self):
        self.kernel.write_bytes(b'short')
        self.check('kernel must be exactly 12582912 bytes')

    def test_rejects_compressed_hash_mismatch(self):
        self.fields['rootfs_gz_sha256'] = '0' * 64
        self.check('compressed rootfs SHA256 mismatch')

    def test_rejects_expanded_size_even_when_compressed_hash_matches(self):
        self.check('expanded rootfs must be exactly 7774142464 bytes')

    def test_rejects_truncated_gzip_before_writing(self):
        self.rootfs.write_bytes(self.rootfs.read_bytes()[:-5])
        self.fields['rootfs_gz_sha256'] = hashlib.sha256(self.rootfs.read_bytes()).hexdigest()
        self.check('gzip integrity check failed')

    def test_manifest_is_data_never_shell(self):
        marker = self.root / 'must-not-exist'
        self.fields['unknown'] = f'$(touch {marker})'
        self.check('unknown or duplicate manifest field')
        self.assertFalse(marker.exists())

    def test_rejects_wrong_geometry_manifest(self):
        self.fields['rootfs_ext4_bytes'] = '1024'
        self.check('rootfs_ext4_bytes must be 7774142464')

    def test_refuses_flash_without_explicit_acknowledgment(self):
        result = subprocess.run(['bash', str(SCRIPT), str(self.kernel), str(self.rootfs),
                                 str(self.manifest), str(self.root / 'backup')], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('ERASE-P3-P8-PERSONALIZED', result.stderr)
        self.assertFalse((self.root / 'backup').exists())

if __name__ == '__main__':
    unittest.main()
