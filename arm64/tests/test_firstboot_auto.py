"""Host-only tests for the universal board's real first-boot shell helpers."""
from pathlib import Path
import configparser
import shutil
import subprocess
import tempfile
import unittest

BASE = Path(__file__).resolve().parents[1] / 'universal' / 'firstboot'
SCRIPT = BASE / 'tr100-firstboot'


class FirstbootTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.work = Path(self.tmp.name)

    def shell(self, expression, *args):
        self.assertTrue(SCRIPT.is_file(), 'universal first-boot shell is required')
        # Source only real function definitions, without invoking hardware access.
        definitions = SCRIPT.read_text().split('\ntr100_firstboot_main "$@"', 1)[0]
        return subprocess.run([shutil.which('busybox'), 'sh', '-c',
                               definitions + '\nBB="$1"; shift\n' + expression,
                               '_', shutil.which('busybox'), *map(str, args)],
                              text=True, capture_output=True)

    def test_deviceinfo_parser_accepts_factory_ascii_and_outputs_network_format(self):
        deviceinfo = self.work / 'deviceinfo'
        for identity in (b'00:26:76:12:AB:CD', b'00:26:76:12:ab:cd'):
            deviceinfo.write_bytes(identity + b'\x00\xff' * 32)
            result = self.shell('tr100_read_factory_mac "$1"', deviceinfo)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, '00:26:76:12:ab:cd\n')

    def test_deviceinfo_parser_rejects_corrupt_multicast_and_template_identity(self):
        deviceinfo = self.work / 'deviceinfo'
        for data in (b'', b'00:26:76:12:AB:C',
                     b'01:26:76:12:AB:CD', b'FF:FF:FF:FF:FF:FF',
                     b'00:00:00:00:00:00', b'02:00:00:00:00:00',
                     b'02:00:00:00:00:01',
                     b'00:26:76:12:AB:\x00D', b'00:26:76:12:AB:\nD',
                     b'00-26-76-12-AB-CD', b'00:26:76:12:AB:CG'):
            with self.subTest(data=data):
                deviceinfo.write_bytes(data)
                result = self.shell('tr100_read_factory_mac "$1"', deviceinfo)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, '')

    def test_geometry_rejects_every_wrong_disk_or_root_value(self):
        good = ['15269888', '86016', '15183872', '259:0']
        self.assertEqual(self.shell('tr100_validate_geometry "$@"', *good).returncode, 0)
        for index in range(4):
            args = good.copy()
            args[index] = '0'
            self.assertNotEqual(self.shell('tr100_validate_geometry "$@"', *args).returncode, 0)
        self.assertNotEqual(self.shell('tr100_validate_geometry "$@"', *good, 'extra').returncode, 0)

    def test_all_protected_partition_boundaries_are_checked(self):
        for args in [('1', '0', '8192'), ('2', '8192', '8192'),
                     ('3', '16384', '24576'), ('4', '40960', '8192'),
                     ('5', '49152', '4096'), ('6', '53248', '16384'),
                     ('7', '69632', '16384'), ('8', '86016', '15183872')]:
            with self.subTest(partition=args[0]):
                self.assertEqual(self.shell('tr100_validate_partition_geometry "$@"', *args).returncode, 0)
                self.assertNotEqual(self.shell('tr100_validate_partition_geometry "$@"', args[0], '1', args[2]).returncode, 0)
                self.assertNotEqual(self.shell('tr100_validate_partition_geometry "$@"', args[0], args[1], '1').returncode, 0)
        self.assertNotEqual(self.shell('tr100_validate_partition_geometry 9 0 8192').returncode, 0)

    def test_configuration_is_private_and_marks_complete_only_at_commit(self):
        config = self.work / 'etc/tr100'
        ssh = self.work / 'etc/ssh/sshd_config.d'
        config.mkdir(parents=True)
        (config / 'needs-personalization').write_text('pending\n')
        result = self.shell('tr100_install_personality "$@"', config, ssh, '00:26:76:12:ab:cd')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((config / 'factory-mac').read_text(), '00:26:76:12:ab:cd\n')
        self.assertEqual((config / 'personalized').read_text(), 'local credentials configured\n')
        self.assertFalse((config / 'needs-personalization').exists())
        for name in ('factory-mac', 'personalized'):
            self.assertEqual((config / name).stat().st_mode & 0o777, 0o600)
        ssh_config = (ssh / '00-tr100.conf').read_text()
        self.assertIn('PermitRootLogin yes\n', ssh_config)
        self.assertIn('PasswordAuthentication yes\n', ssh_config)
        self.assertIn('PermitEmptyPasswords no\n', ssh_config)

    def test_configuration_refuses_symlink_destinations(self):
        outside = self.work / 'outside'
        outside.mkdir()
        config = self.work / 'tr100'
        config.symlink_to(outside, target_is_directory=True)
        result = self.shell('tr100_install_personality "$@"', config,
                            self.work / 'sshd', '00:26:76:12:ab:cd')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(list(outside.iterdir()), [])

    def test_service_gates_logins_and_uses_only_serial_for_password_io(self):
        unit = configparser.ConfigParser(interpolation=None)
        unit.read(BASE / 'tr100-firstboot.service')
        self.assertEqual(unit['Unit']['ConditionPathExists'], '!/etc/tr100/personalized')
        before = set(unit['Unit']['Before'].split())
        self.assertTrue({'tr100-network.service', 'ssh.service',
                         'serial-getty@ttyAMA0.service',
                         'tr100-hdmi-console.service'} <= before)
        self.assertTrue({'local-fs.target', 'systemd-udev-settle.service'} <=
                        set(unit['Unit']['After'].split()))
        service = unit['Service']
        self.assertEqual(service['Type'], 'oneshot')
        self.assertEqual(service['RemainAfterExit'], 'yes')
        self.assertEqual(service['TimeoutStartSec'], 'infinity')
        for channel in ('StandardInput', 'StandardOutput', 'StandardError'):
            self.assertEqual(service[channel], 'tty')
        self.assertEqual(service['TTYPath'], '/dev/ttyAMA0')
        self.assertNotIn('Restart', service)


if __name__ == '__main__':
    unittest.main()
