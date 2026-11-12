import hashlib
import importlib.util
import io
import pathlib
import tempfile
import unittest

TOOL = pathlib.Path(__file__).resolve().parents[1] / 'tools' / 'download_release.py'

class DownloadTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location('download_release', TOOL)
        cls.mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.mod)

    def test_manifest_rejects_path_traversal_and_wrong_repository(self):
        for name, url in [('../shadow', 'https://github.com/gmingtian/tr100-gk6323-linux/releases/download/v1/shadow'), ('x.tar.gz', 'https://evil.example/x.tar.gz')]:
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.mod.validate_manifest({'schema_version':1,'tag':'v1','assets':[{'name':name,'bytes':3,'sha256':'a'*64,'url':url}]})

    def test_manifest_rejects_duplicate_asset_names(self):
        asset={'name':'x.tar.gz','bytes':3,'sha256':'a'*64,'url':'https://github.com/gmingtian/tr100-gk6323-linux/releases/download/v1/x.tar.gz'}
        with self.assertRaises(ValueError):
            self.mod.validate_manifest({'schema_version':1,'tag':'v1','assets':[asset,asset]})

    def test_corrupt_or_truncated_download_never_replaces_existing_file(self):
        with tempfile.TemporaryDirectory() as d:
            path=pathlib.Path(d)/'kernel.tar.gz'; path.write_bytes(b'original')
            for body in [b'bad',b'ab']:
                with self.subTest(body=body), self.assertRaises(ValueError):
                    self.mod.copy_verified(io.BytesIO(body),path,3,hashlib.sha256(b'abc').hexdigest())
                self.assertEqual(path.read_bytes(),b'original')
                self.assertFalse(path.with_name(path.name+'.part').exists())

    def test_preexisting_partial_is_not_deleted(self):
        with tempfile.TemporaryDirectory() as d:
            path=pathlib.Path(d)/'kernel.tar.gz'
            partial=path.with_name(path.name+'.part');partial.write_bytes(b'previous transfer')
            with self.assertRaises(FileExistsError):
                self.mod.copy_verified(io.BytesIO(b'abc'),path,3,'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
            self.assertEqual(partial.read_bytes(),b'previous transfer')

    def test_verified_download_writes_exact_bytes_and_cleans_partial(self):
        with tempfile.TemporaryDirectory() as d:
            path=pathlib.Path(d)/'kernel.tar.gz'
            self.mod.copy_verified(io.BytesIO(b'abc'),path,3,'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
            self.assertEqual(path.read_bytes(),b'abc')
            self.assertFalse(path.with_name(path.name+'.part').exists())

    def test_manifest_with_public_release_asset_is_accepted(self):
        m={'schema_version':1,'tag':'v1','assets':[{'name':'kernel.tar.gz','bytes':3,'sha256':'a'*64,'url':'https://github.com/gmingtian/tr100-gk6323-linux/releases/download/v1/kernel.tar.gz'}]}
        self.assertEqual(self.mod.validate_manifest(m),m)

if __name__=='__main__':unittest.main()
