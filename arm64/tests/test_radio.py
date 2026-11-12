"""Radio bundles must reject wrong factory files and avoid merged-/usr hazards."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]

class RadioTests(unittest.TestCase):
    def module(self):
        path = ROOT / 'radio' / 'build_radio.py'
        self.assertTrue(path.is_file(), 'radio builder is missing')
        spec = importlib.util.spec_from_file_location('build_radio', path)
        mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
        return mod

    def test_wrong_factory_firmware_fails_before_staging(self):
        module = self.module()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); factory = root / 'factory'; factory.mkdir()
            (factory / 'wcnmodem.bin').write_bytes(b'incorrect')
            stage = root / 'stage'
            with self.assertRaisesRegex(ValueError, 'factory firmware'):
                module.stage_factory(factory, stage)
            self.assertFalse(stage.exists())

if __name__ == '__main__':
    unittest.main()
