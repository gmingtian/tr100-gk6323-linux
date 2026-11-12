import hashlib
import base64
import io
from unittest import mock
import importlib.util
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('fetch_firmware', ROOT / 'fetch_firmware.py')
module = importlib.util.module_from_spec(spec)


class FirmwareTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec.loader.exec_module(module)

    def test_rejects_corrupt_cached_download(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            resource = {'sha256': hashlib.sha256(b'correct').hexdigest(), 'bytes': 7,
                        'url': 'https://example.invalid/not-used'}
            (root / resource['sha256']).write_bytes(b'corrupt')
            with self.assertRaisesRegex(ValueError, 'checksum'):
                module.obtain(resource, root, offline=True)

    def test_googlesource_transport_is_decoded_before_hashing_and_caching(self):
        payload = b'official firmware bytes'
        resource = {'url': 'https://kernel.googlesource.com/file?format=TEXT',
                    'bytes': len(payload), 'sha256': hashlib.sha256(payload).hexdigest()}
        with tempfile.TemporaryDirectory() as temporary:
            cache = Path(temporary)
            response = io.BytesIO(base64.b64encode(payload) + b'\n')
            with mock.patch.object(module.urllib.request, 'urlopen', return_value=response):
                self.assertEqual(module.obtain(resource, cache), payload)
            self.assertEqual((cache/resource['sha256']).read_bytes(), payload)

    def test_rejects_paths_outside_staging_root(self):
        for value in ('../escape', '/etc/escape', 'lib/../../escape'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                module.relative_path(value)

    def test_tar_is_deterministic_and_contains_only_stage_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            stage = root / 'stage'; (stage / 'lib/firmware').mkdir(parents=True)
            (stage / 'lib/firmware/test.bin').write_bytes(b'actual firmware bytes')
            first, second = root / 'first.tar.gz', root / 'second.tar.gz'
            module.make_archive(stage, first, 1729123200)
            module.make_archive(stage, second, 1729123200)
            self.assertEqual(first.read_bytes(), second.read_bytes())
            with tarfile.open(first) as archive:
                self.assertEqual(archive.getnames(), ['lib/firmware/test.bin'])
                member = archive.getmembers()[0]
                self.assertEqual(member.uid, 0)
                self.assertEqual(member.mtime, 1729123200)
                self.assertEqual(archive.extractfile(member).read(), b'actual firmware bytes')

    def test_rejects_unlisted_stage_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            stage = Path(temporary)
            (stage/'unexpected').write_bytes(b'extra payload')
            with self.assertRaisesRegex(ValueError, 'unlisted'):
                module.check_selected_files(stage, set())

    def test_real_kernel_trust_rejects_unsigned_database(self):
        lock = json.loads((ROOT/'firmware-lock.json').read_text())
        with tempfile.TemporaryDirectory() as temporary:
            stage = Path(temporary)
            directory = stage/'usr/lib/firmware'; directory.mkdir(parents=True)
            (directory/'regulatory.db').write_bytes(b'unsigned database')
            (directory/'regulatory.db.p7s').write_bytes(b'invalid signature')
            with self.assertRaisesRegex(ValueError, 'signature verification failed'):
                module.verify_regdb(ROOT, stage, lock)



if __name__ == '__main__':
    unittest.main()
