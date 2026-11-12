"""Host-side safety and identity regressions; no root, chroot or network required."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[1] / 'rootfs' / 'build.py'


class RootfsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.work = Path(self.tmp.name)
        self.root = self.work / 'root'

    def run_cli(self, *args, ok=True):
        self.assertTrue(SCRIPT.exists(), 'rootfs builder must exist')
        result = subprocess.run(['python3', str(SCRIPT), *map(str, args)], text=True,
                                capture_output=True)
        if ok:
            self.assertEqual(result.returncode, 0, result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0, result.stdout)
        return result

    def base(self, members=None):
        path = self.work / 'base.tar'
        with tarfile.open(path, 'w') as tar:
            for name, content in (members or {
                'etc/os-release': 'ID=debian\nVERSION_CODENAME=bookworm\n',
                'etc/shadow': 'root:!:19000:0:99999:7:::\n',
                'etc/passwd': 'root:x:0:0:root:/root:/bin/bash\n',
                'usr/bin/true': '',
            }).items():
                entry = tarfile.TarInfo(name)
                content = content.encode()
                entry.size = len(content)
                tar.addfile(entry, io.BytesIO(content))
        return path, hashlib.sha256(path.read_bytes()).hexdigest()

    def prepare(self):
        base, digest = self.base()
        self.run_cli('prepare', '--root', self.root, '--rootfs-tar', base,
                     '--rootfs-sha256', digest)

    def test_refuses_host_root_and_unmarked_directory(self):
        self.run_cli('sanitize', '--root', '/', ok=False)
        self.root.mkdir()
        (self.root / 'sentinel').write_text('keep')
        self.run_cli('sanitize', '--root', self.root, ok=False)
        self.assertEqual((self.root / 'sentinel').read_text(), 'keep')

    def test_checksum_failure_does_not_create_target(self):
        base, _ = self.base()
        self.run_cli('prepare', '--root', self.root, '--rootfs-tar', base,
                     '--rootfs-sha256', '0' * 64, ok=False)
        self.assertFalse(self.root.exists())

    def test_archive_traversal_cannot_write_outside_root(self):
        base, digest = self.base({'../escape': 'bad'})
        self.run_cli('prepare', '--root', self.root, '--rootfs-tar', base,
                     '--rootfs-sha256', digest, ok=False)
        self.assertFalse((self.work / 'escape').exists())

    def test_sanitize_removes_credentials_identity_and_leases(self):
        self.prepare()
        for name in ['etc/ssh/ssh_host_ed25519_key', 'root/.ssh/authorized_keys',
                     'var/lib/systemd/random-seed', 'var/lib/dbus/machine-id',
                     'var/lib/dhcp/lease', 'root/.bash_history',
                     'etc/tr100/factory-mac', 'etc/tr100/personalized']:
            dest = self.root / name
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text('sensitive')
        (self.root / 'etc/machine-id').write_text('device-id')
        (self.root / 'etc/shadow').write_text('root:$6$private$hash:19000:0:99999:7:::\n')
        self.run_cli('sanitize', '--root', self.root)
        self.assertEqual((self.root / 'etc/machine-id').read_text(), '')
        self.assertEqual((self.root / 'etc/shadow').read_text().split(':')[1], '!')
        self.assertFalse((self.root / 'root/.ssh').exists())
        self.assertFalse((self.root / 'etc/ssh/ssh_host_ed25519_key').exists())
        self.assertFalse((self.root / 'etc/tr100/factory-mac').exists())
        self.assertFalse((self.root / 'var/lib/systemd/random-seed').exists())
        self.assertFalse((self.root / 'var/lib/dhcp/lease').exists())
        self.run_cli('audit', '--root', self.root)

    def test_audit_rejects_identity_symlink_escape(self):
        self.prepare()
        secret = self.work / 'secret'
        secret.write_text('outside')
        (self.root / 'etc/machine-id').unlink()
        (self.root / 'etc/machine-id').symlink_to(secret)
        self.run_cli('sanitize', '--root', self.root, ok=False)
        self.assertEqual(secret.read_text(), 'outside')

    def test_personalization_requires_usable_mac_and_authentication(self):
        self.prepare()
        self.run_cli('personalize', '--root', self.root, '--mac', '00:00:00:00:00:00', ok=False)
        self.run_cli('personalize', '--root', self.root, '--mac', '02:12:34:56:78:90', ok=False)
        key = self.work / 'key.pub'
        # Real key structure validation happens through ssh-keygen.
        subprocess.run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(self.work / 'key')], check=True)
        self.run_cli('personalize', '--root', self.root, '--mac', '02:12:34:56:78:90', '--authorized-key', key)
        self.assertEqual((self.root / 'etc/tr100/factory-mac').read_text(), '02:12:34:56:78:90\n')
        self.assertEqual((self.root / 'root/.ssh/authorized_keys').stat().st_mode & 0o777, 0o600)
        self.run_cli('audit', '--root', self.root, ok=False)
        self.run_cli('audit', '--root', self.root, '--personalized')
        self.run_cli('sanitize', '--root', self.root)
        self.run_cli('audit', '--root', self.root)

    def test_archive_rejects_unsanitized_root(self):
        self.prepare()
        (self.root / 'etc/machine-id').write_text('private')
        self.run_cli('archive', '--root', self.root, '--output', self.work / 'out.tar.gz', ok=False)
        self.assertFalse((self.work / 'out.tar.gz').exists())


    def test_base_device_nodes_are_discarded(self):
        base, _ = self.base()
        with tarfile.open(base, 'a') as tar:
            node = tarfile.TarInfo('dev/console')
            node.type = tarfile.CHRTYPE
            node.devmajor, node.devminor = 5, 1
            tar.addfile(node)
        digest = hashlib.sha256(base.read_bytes()).hexdigest()
        self.run_cli('prepare', '--root', self.root, '--rootfs-tar', base,
                     '--rootfs-sha256', digest)
        self.assertFalse((self.root / 'dev/console').exists())

    def test_archive_cannot_write_through_escaping_symlink(self):
        base, _ = self.base()
        with tarfile.open(base, 'a') as tar:
            link = tarfile.TarInfo('outside')
            link.type = tarfile.SYMTYPE
            link.linkname = str(self.work)
            tar.addfile(link)
            file = tarfile.TarInfo('outside/escaped')
            file.size = 3
            tar.addfile(file, io.BytesIO(b'bad'))
        digest = hashlib.sha256(base.read_bytes()).hexdigest()
        self.run_cli('prepare', '--root', self.root, '--rootfs-tar', base,
                     '--rootfs-sha256', digest, ok=False)
        self.assertFalse((self.work / 'escaped').exists())

    def test_unprovisioned_root_cannot_be_published(self):
        self.prepare()
        self.run_cli('archive', '--root', self.root,
                     '--output', self.work / 'out.tar.gz', ok=False)
        self.assertFalse((self.work / 'out.tar.gz').exists())

    def test_password_is_hashed_and_removed_by_sanitization(self):
        self.prepare()
        password = self.work / 'password'
        password.write_text('a-local-test-only-password\n')
        password.chmod(0o600)
        self.run_cli('personalize', '--root', self.root, '--mac', '02:12:34:56:78:90',
                     '--password-file', password)
        shadow = (self.root / 'etc/shadow').read_text()
        self.assertTrue(shadow.startswith('root:$6$'))
        self.assertNotIn('a-local-test-only-password', shadow)
        self.run_cli('sanitize', '--root', self.root)
        self.assertEqual((self.root / 'etc/shadow').read_text().split(':')[1], '!')

    def test_successful_public_archive_keeps_identity_blank_and_modes(self):
        self.prepare()
        # Unit fixture models the successful provision boundary; no apt/chroot needed.
        (self.root / 'etc/tr100/provisioned').write_text('clean-rootfs-provisioned-v1\n')
        out = self.work / 'rootfs.tar.gz'
        self.run_cli('archive', '--root', self.root, '--output', out)
        with tarfile.open(out, 'r:gz') as tar:
            self.assertEqual(tar.extractfile('./etc/machine-id').read(), b'')
            self.assertEqual(tar.getmember('./etc/shadow').mode, 0o640)
            self.assertNotIn('./etc/tr100/factory-mac', tar.getnames())

    def test_prepared_hdmi_console_accepts_current_kvm_kernel(self):
        self.prepare()
        console = self.root / 'usr/local/sbin/tr100-hdmi-console'
        result = subprocess.run(['bash', '-c', 'source "$1"; tr100_validate_identity Linux 0 '
                                 '5.10.165_gk6323-tr100-arm64-kvm '
                                 'tr100-arm64-bookworm-20261111 "259:0 ext4"', '_', str(console)],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        # systemd evaluates these OR conditions before it executes the loader.
        service = self.root / 'etc/systemd/system/tr100-display-modules.service'
        conditions = [line.split('=', 1)[1] for line in service.read_text().splitlines()
                      if line.startswith('ConditionKernelVersion=')]
        self.assertIn('|5.10.165_gk6323-tr100-arm64-kvm', conditions)

    def test_provision_docker_is_explicit_opt_in(self):
        self.prepare()
        spec = importlib.util.spec_from_file_location('rootfs_builder', SCRIPT)
        builder = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(builder)
        import argparse
        for enabled in (False, True):
            service = self.root / 'etc/systemd/system/docker.service'
            if enabled:
                # A prior minimal provision deliberately removed the optional unit.
                service.unlink()
            with self.subTest(with_docker=enabled), mock.patch.object(builder, 'require_root'), \
                    mock.patch.object(builder.platform, 'machine', return_value='aarch64'), \
                    mock.patch.object(builder, 'run') as run:
                builder.provision(argparse.Namespace(root=self.root, offline=True, qemu=None,
                                                      with_docker=enabled))
                self.assertEqual(run.call_args.args[0][-2:], ['1', '1' if enabled else '0'])
                if enabled:
                    self.assertTrue(service.is_file(), 'reprovisioning must restore the optional Docker unit')

    def test_verified_firmware_input_is_installed_without_device_identity(self):
        base, digest = self.base()
        firmware = self.work / 'firmware.tar'
        with tarfile.open(firmware, 'w') as tar:
            entry = tarfile.TarInfo('usr/lib/firmware/example.bin')
            entry.size = 4
            tar.addfile(entry, io.BytesIO(b'abcd'))
        self.run_cli('prepare', '--root', self.root, '--rootfs-tar', base,
                     '--rootfs-sha256', digest, '--firmware-tar', firmware,
                     '--firmware-sha256', hashlib.sha256(firmware.read_bytes()).hexdigest())
        self.assertEqual((self.root / 'usr/lib/firmware/example.bin').read_bytes(), b'abcd')
        self.run_cli('audit', '--root', self.root)

    def test_docker_worker_can_keep_unix_root_ownership_in_named_volume(self):
        commands = self.work / 'bin'
        commands.mkdir()
        docker = commands / 'docker'
        docker.write_text('#!/bin/sh\n[ "$1" != image ] || exit 0\nprintf "%s\\n" "$@"\n')
        docker.chmod(0o755)
        env = dict(os.environ, PATH=str(commands) + ':' + os.environ['PATH'],
                   TR100_ROOTFS_VOLUME='tr100-test-build')
        result = subprocess.run(['bash', str(SCRIPT.parent / 'docker-run.sh'), str(self.work),
                                 'audit', '--root', '/build/stage/root'], env=env,
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('type=volume,src=tr100-test-build,dst=/build', result.stdout.splitlines())

    def test_restore_published_archive_for_local_personalization(self):
        self.prepare()
        (self.root / 'etc/tr100/provisioned').write_text('clean-rootfs-provisioned-v1\n')
        archive = self.work / 'release.tar.gz'
        self.run_cli('archive', '--root', self.root, '--output', archive)
        private_root = self.work / 'private-root'
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        self.run_cli('restore', '--root', private_root, '--archive', archive, '--sha256', digest)
        self.run_cli('audit', '--root', private_root)
        self.assertEqual((private_root / 'etc/shadow').stat().st_mode & 0o777, 0o640)
        self.assertEqual((private_root / 'etc/tr100/provisioned').read_text(), 'clean-rootfs-provisioned-v1\n')
        self.run_cli('restore', '--root', self.work / 'bad-root', '--archive', archive,
                     '--sha256', '0' * 64, ok=False)
        self.assertFalse((self.work / 'bad-root').exists())


if __name__ == '__main__':
    unittest.main()
