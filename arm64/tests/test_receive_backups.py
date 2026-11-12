import importlib.util
import io
from pathlib import Path
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parents[1] / 'tools/receive-backups.py'

class ReceiveBackups(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location('receive_backups', SOURCE)
        cls.mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.mod)

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.output = Path(self.tmp.name)

    def test_stores_exact_original_p2_bytes(self):
        payload = b'original' * (4 * 1024 * 1024 // 8)
        self.mod.store_backup(io.BytesIO(payload), self.output, '/original-p2.bin', len(payload))
        self.assertEqual((self.output / 'original-p2.bin').read_bytes(), payload)

    def test_refuses_wrong_size_before_creating_file(self):
        with self.assertRaises(ValueError):
            self.mod.store_backup(io.BytesIO(b'x'), self.output, '/original-p3.bin', 1)
        self.assertEqual(list(self.output.iterdir()), [])

    def test_removes_incomplete_upload(self):
        with self.assertRaises(ValueError):
            self.mod.store_backup(io.BytesIO(b'x'), self.output, '/original-p2.bin', 4194304)
        self.assertEqual(list(self.output.iterdir()), [])

    def test_never_overwrites_prior_backup(self):
        target = self.output / 'original-p2.bin'
        target.write_bytes(b'previous')
        with self.assertRaises(FileExistsError):
            self.mod.store_backup(io.BytesIO(), self.output, '/original-p2.bin', 4194304)
        self.assertEqual(target.read_bytes(), b'previous')

    def test_refuses_path_traversal(self):
        with self.assertRaises(ValueError):
            self.mod.store_backup(io.BytesIO(), self.output, '/../outside.bin', 4194304)
        self.assertEqual(list(self.output.iterdir()), [])

if __name__ == '__main__':
    unittest.main()
