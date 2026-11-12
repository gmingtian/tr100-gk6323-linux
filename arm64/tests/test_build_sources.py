"""Safety and source provenance regressions for the portable build."""
import importlib.util
import pathlib
import subprocess
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).resolve().parents[1] / 'build' / 'prepare.py'

class SourceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = pathlib.Path(self.tmp.name)

    def module(self):
        self.assertTrue(SCRIPT.is_file(), 'portable source preparation is missing')
        spec = importlib.util.spec_from_file_location('prepare', SCRIPT)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_export_uses_pinned_git_objects_not_dirty_checkout(self):
        m = self.module()
        repo = self.root / 'repo'
        repo.mkdir()
        def git(*args):
            return subprocess.check_output(['git', '-C', str(repo), *args], text=True).strip()
        git('init', '-q')
        git('config', 'user.email', 'test@example.invalid')
        git('config', 'user.name', 'Test')
        (repo / 'sdk').mkdir()
        (repo / 'sdk' / 'file').write_text('pinned\n')
        git('add', '.')
        git('commit', '-qm', 'fixture')
        commit = git('rev-parse', 'HEAD')
        (repo / 'sdk' / 'file').write_text('unreviewed local changes\n')
        out = self.root / 'export'
        m.export_git(repo, commit, out, 'sdk')
        self.assertEqual((out / 'file').read_text(), 'pinned\n')
        with self.assertRaises((ValueError, subprocess.CalledProcessError)):
            m.export_git(repo, '0'*40, self.root / 'bad')

    def test_filtered_export_works_with_sparse_offline_repository(self):
        m = self.module()
        repo = self.root / 'sparse'
        repo.mkdir()
        def git(*args):
            return subprocess.check_output(['git', '-C', str(repo), *args], text=True).strip()
        git('init', '-q')
        git('config', 'user.email', 'test@example.invalid')
        git('config', 'user.name', 'Test')
        (repo / 'needed').write_text('build input\n')
        (repo / 'unrelated').write_text('large firmware\n')
        git('add', '.')
        git('commit', '-qm', 'sparse fixture')
        commit = git('rev-parse', 'HEAD')
        blob = git('rev-parse', 'HEAD:unrelated')
        (repo / '.git/objects' / blob[:2] / blob[2:]).unlink()
        git('config', 'remote.origin.promisor', 'true')
        git('config', 'remote.origin.url', str(self.root / 'unavailable'))
        out = self.root / 'selected'
        m.export_git(repo, commit, out, paths=['needed'])
        self.assertEqual((out / 'needed').read_text(), 'build input\n')
        self.assertFalse((out / 'unrelated').exists())

    def test_patch_failure_never_silently_continues(self):
        m = self.module()
        tree = self.root / 'tree'
        tree.mkdir()
        (tree / 'file').write_text('unexpected baseline\n')
        patch = self.root / 'fix.patch'
        patch.write_text('--- a/file\n+++ b/file\n@@ -1 +1 @@\n-original\n+fixed\n')
        with self.assertRaises(subprocess.CalledProcessError):
            m.apply_patch(tree, patch)
        self.assertEqual((tree / 'file').read_text(), 'unexpected baseline\n')

    def test_patch_inside_parent_repository_applies_to_exported_tree(self):
        m = self.module()
        subprocess.run(['git', 'init', '-q', str(self.root)], check=True)
        subprocess.run(['git', '-C', str(self.root), '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'outer'], check=True)
        tree = self.root / 'work' / 'sources'
        tree.mkdir(parents=True)
        (tree / 'file').write_text('original\n')
        patch = self.root / 'fix.patch'
        patch.write_text('--- a/file\n+++ b/file\n@@ -1 +1 @@\n-original\n+fixed\n')
        m.apply_patch(tree, patch)
        self.assertEqual((tree / 'file').read_text(), 'fixed\n')

    def test_existing_destination_is_never_overwritten(self):
        m = self.module()
        destination = self.root / 'existing'
        destination.mkdir()
        (destination / 'important').write_text('keep')
        with self.assertRaises(ValueError):
            m.require_empty(destination)
        self.assertEqual((destination / 'important').read_text(), 'keep')

if __name__ == '__main__':
    unittest.main()
