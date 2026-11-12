"""Offline serial fixtures: no device or OS paths are opened."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import sys
import queue
import threading
import unittest
from unittest.mock import patch

MODULE = Path(__file__).resolve().parents[1] / 'universal' / 'serial_policy.py'
spec = importlib.util.spec_from_file_location('serial_policy', MODULE)
p = importlib.util.module_from_spec(spec)
if MODULE.exists():
    spec.loader.exec_module(p)

MAP = '4M(fastboot),4M(bootargs),12M(kernel),4M(deviceinfo),2M(atf),8M(baseparam),8M(pqparam),-(rootfs)'
ARGS = 'console=ttyAMA0,115200 root=/dev/mmcblk0p8 rw tr100.arm64.root=installed blkdevparts=mmcblk0:' + MAP
MANIFEST = dict(schema=1, profile='4m-loader-v1', layout=MAP, dtb_bytes=13457,
                bootargs=ARGS, kernel_partition_crc32='12345678',
                rootfs_uuid='a8d4abf76ae44f9ba39aef1b79c63230', files={})
SIGNATURE = ('00c8ed80: e58d40b4 e1cd2cf0 e3a03000 e3a02802\r\n'
             '00c8ed90: e1cd2cf8 e30033c5 e58d00b0 ea00001b\r\n'
             '00c8eda0: e3590020 1a00001a\r\n')

class CapturedSerial:
    """Small loader model at the byte boundary; responses include command echoes."""
    def __init__(self):
        self.pending = b''
        self.commands = []
        self.env = dict(bootargs='console=ttyAMA0 blkdevparts=mmcblk0:' + MAP.replace('12M(kernel)', '12M(recovery)'),
                        bootcmd='factory_boot', ethaddr='02:11:22:33:44:55', secret='factory-secret', verify='no')
        self.signature = SIGNATURE
        self.crcs = {0: '7215eebc', 40960: '11223344', 49152: '96266b1b',
                     53248: '55667788', 69632: 'aabbccdd', 16384: '12345678'}
        self.mac = b'02:11:22:33:44:55'
        self.loaded = None
        self.duplicate_env = False
        self.no_prompt = False
        self.fail_readback = False
        self.short_read = False
        self.uuid = 'a8d4abf76ae44f9ba39aef1b79c63230'
    def write(self, data):
        cmd = data.decode('ascii').strip()
        if not cmd:
            self.pending += b'\r\nfastboot# '
            return len(data)
        self.commands.append(cmd)
        out = ''
        if cmd == 'md.l 0x00c8ed80 0xa':
            out = self.signature
        elif cmd == 'printenv':
            out = '\r\n'.join(k + '=' + v for k,v in self.env.items()) + '\r\nEnvironment size: 123/65532 bytes\r\n'
            if self.duplicate_env:
                out += 'bootcmd=duplicate\r\n'
        elif cmd.startswith('mmc read 0 '):
            _, _, _, addr, start, count = cmd.split()
            self.loaded = int(start, 16)
            count = int(count,16) - int(self.short_read)
            if getattr(self, 'too_small', False) and self.loaded >= 15267840:
                count = 0
            out = f'MMC read: dev # 0, block # {self.loaded}, count {count} ...\r\n{count} blocks read: OK\r\n'
        elif cmd.startswith('crc32 '):
            _, addr, size = cmd.split()
            end = int(addr,16) + int(size,16) - 1
            out = f'CRC32 for {int(addr,16):08x} ... {end:08x} ==> {self.crcs[self.loaded]}\r\n'
        elif cmd == 'md.b 0x40000000 0x11':
            out = '40000000: ' + ' '.join(f'{b:02x}' for b in self.mac[:16]) + '    02:11:22:33:44:5\r\n'
            out += f'40000010: {self.mac[16]:02x}    5\r\n'
        elif cmd == 'md.b 0x40000468 0x10':
            out = '40000468: ' + ' '.join(f'{b:02x}' for b in bytes.fromhex(self.uuid)) + '    ....j.O.....y.20\r\n'
        elif cmd.startswith('setenv '):
            key, value = cmd[len('setenv '):].split(' ',1)
            if not self.fail_readback:
                self.env[key] = value[1:-1]
        elif cmd == 'saveenv':
            out = 'Saving Environment to MMC...\r\nWriting to MMC... done\r\n'
        else:
            raise AssertionError('unexpected or unsafe command: ' + cmd)
        self.pending += (cmd + '\r\n' + out + ('' if self.no_prompt else 'fastboot# ')).encode('ascii')
        return len(data)
    def read(self, size):
        data, self.pending = self.pending[:min(size,73)], self.pending[min(size,73):]
        return data

class ProtocolTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(hasattr(p, 'preflight'), 'universal serial policy has not been implemented')
        self.serial = CapturedSerial()
        self.console = p.SerialConsole(self.serial, timeout=0.01)
        self.console.connect()
    def inspect(self):
        return p.preflight(self.console, MANIFEST, 'f'*64)
    def test_connection_never_uses_empty_enter_to_repeat_last_loader_command(self):
        self.assertEqual(self.serial.commands[0], 'printenv')
        self.assertTrue(all(command.strip() for command in self.serial.commands))

    def test_inspect_captures_identity_and_environment_without_device_writes(self):
        report = self.inspect()
        self.assertEqual(report['mac'], '02:11:22:33:44:55')
        self.assertEqual(report['factory_environment']['secret'], 'factory-secret')
        self.assertEqual(report['protected_crc32']['deviceinfo'], '11223344')
        self.assertTrue(all(c.startswith(('md.', 'mmc read ', 'crc32 ', 'printenv')) for c in self.serial.commands))
    def test_unknown_signature_and_unsupported_layout_fail_before_any_mutation(self):
        for bad in ('signature','layout','smallenv'):
            serial = CapturedSerial()
            if bad == 'signature': serial.signature = SIGNATURE.replace('e30033c5','e30033c9')
            elif bad == 'layout': serial.env['bootargs'] = serial.env['bootargs'].replace('4M(fastboot)', '1M(fastboot)')
            else: serial.env['bootargs'] = serial.env['bootargs'].replace('4M(bootargs)', '512K(bootargs)')
            console = p.SerialConsole(serial, timeout=.01); console.connect()
            with self.assertRaises(p.PolicyError): p.preflight(console, MANIFEST, 'f'*64)
            self.assertFalse(any(c.startswith(('setenv','mw.','saveenv')) for c in serial.commands))
    def test_too_small_emmc_stops_before_any_environment_write(self):
        self.serial.too_small = True
        with self.assertRaises(p.PolicyError):
            self.inspect()
        self.assertFalse(any(c.startswith(('setenv','saveenv')) for c in self.serial.commands))

    def test_changed_protected_crc_prevents_every_environment_write(self):
        report = self.inspect(); self.serial.crcs[53248] = '00000000'
        with self.assertRaises(p.PolicyError): p.apply(self.console, MANIFEST, 'f'*64, report)
        self.assertFalse(any(c.startswith(('setenv','saveenv')) for c in self.serial.commands))
    def test_success_modifies_only_three_keys_and_saves_last(self):
        report = self.inspect(); before = dict(self.serial.env)
        p.apply(self.console, MANIFEST, 'f'*64, report)
        changed = {k for k in self.serial.env if self.serial.env[k] != before[k]}
        self.assertEqual(changed, {'bootargs','bootcmd','verify'})
        self.assertEqual(self.serial.env['secret'], 'factory-secret')
        self.assertIn('mw.l 0x00c8ed94 0xe30033c9 1;', self.serial.env['bootcmd'])
        self.assertEqual(self.serial.commands[-2:], ['saveenv','printenv'])
        self.assertFalse(any(c.startswith(('mw.', 'bootm','reset','mmc write')) for c in self.serial.commands))
    def test_wrong_kernel_mac_uuid_or_manifest_never_sets_environment(self):
        for bad in ('kernel','mac','uuid','manifest'):
            serial = CapturedSerial(); console=p.SerialConsole(serial,timeout=.01); console.connect()
            report=p.preflight(console,MANIFEST,'f'*64)
            manifest=dict(MANIFEST)
            if bad=='kernel': serial.crcs[16384]='87654321'
            if bad=='mac': serial.mac=b'02:11:22:33:44:56'
            if bad=='uuid': serial.uuid='0'*32
            if bad=='manifest': report['manifest_sha256']='0'*64
            with self.assertRaises(p.PolicyError): p.apply(console,manifest,'f'*64,report)
            self.assertFalse(any(c.startswith(('setenv','saveenv')) for c in serial.commands))
    def test_duplicate_environment_timeout_and_short_read_stop(self):
        self.serial.duplicate_env=True
        with self.assertRaises(p.PolicyError): self.inspect()
        self.serial.duplicate_env=False; self.serial.short_read=True
        with self.assertRaises(p.PolicyError): self.inspect()
        self.serial.short_read=False; self.serial.no_prompt=True
        with self.assertRaises(p.PolicyError): self.inspect()
    def test_loader_and_atf_crc_must_identify_verified_profile(self):
        for start in (0, 49152):
            self.serial.crcs[start] = '00000000'
            with self.assertRaises(p.PolicyError): self.inspect()
            self.assertFalse(any(c.startswith(('setenv','saveenv')) for c in self.serial.commands))
            self.serial.crcs[start] = '7215eebc' if start == 0 else '96266b1b'
    def test_signature_dump_accepts_uboot_ascii_column(self):
        self.serial.signature = SIGNATURE.replace('e3a02802\r\n', 'e3a02802    .@...,...0...(..\r\n').replace('ea00001b\r\n', 'ea00001b    .,...3..........\r\n').replace('1a00001a\r\n', '1a00001a    .......\r\n')
        self.assertEqual(self.inspect()['mac'], '02:11:22:33:44:55')
    def test_readback_failure_never_saves(self):
        report=self.inspect(); self.serial.fail_readback=True
        with self.assertRaises(p.PolicyError): p.apply(self.console,MANIFEST,'f'*64,report)
        self.assertNotIn('saveenv',self.serial.commands)
    def test_multicast_zero_and_template_mac_refused(self):
        for mac in (b'01:11:22:33:44:55',b'00:00:00:00:00:00',b'02:00:00:00:00:01'):
            self.serial.mac=mac
            with self.assertRaises(p.PolicyError): self.inspect()

class TerminalInputTests(unittest.TestCase):
    def test_terminal_line_has_one_cr_and_rejects_hidden_controls(self):
        self.assertTrue(hasattr(p, 'encode_terminal_line'), 'terminal input encoder has not been implemented')
        self.assertEqual(p.encode_terminal_line('new-password!'), b'new-password!\r')
        self.assertEqual(p.encode_terminal_line(''), b'\r')
        for unsafe in ('one\ntwo', 'one\rtwo', '\x03', '\x00', '\x1b[A', '\t', '\x7f'):
            with self.assertRaises(p.PolicyError): p.encode_terminal_line(unsafe)
    def test_terminal_worker_only_transmits_explicit_input_and_closes(self):
        assistant_path = MODULE.with_name('assistant.py')
        spec = importlib.util.spec_from_file_location('tr100_terminal_worker_fixture', assistant_path)
        assistant = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {'serial_policy': p}): spec.loader.exec_module(assistant)
        self.assertTrue(hasattr(assistant, 'TerminalSession'), 'terminal worker has not been implemented')
        class Port:
            def __init__(self):
                self.writes=queue.Queue(); self.closed=False; self.initial=True
            def read(self, size):
                if self.initial:
                    self.initial=False
                    return b'New password: '
                threading.Event().wait(.001)
                return b''
            def write(self, data): self.writes.put(data); return len(data)
            def close(self): self.closed=True
        port=Port()
        with patch.object(assistant, 'open_connection', return_value=port):
            terminal=assistant.TerminalSession('FAKE-PORT')
            terminal.start()
            try:
                self.assertEqual(terminal.events.get(timeout=1), ('connected', None))
                self.assertEqual(terminal.events.get(timeout=1), ('data', b'New password: '))
                self.assertTrue(port.writes.empty())
                terminal.send('private-password')
                self.assertEqual(port.writes.get(timeout=1), b'private-password\r')
                terminal.interrupt()
                self.assertEqual(port.writes.get(timeout=1), b'\x03')
            finally:
                terminal.close()
                terminal.thread.join(timeout=1)
        self.assertFalse(terminal.thread.is_alive())
        self.assertTrue(port.closed)
    def test_opening_terminal_port_never_sends_a_command_or_interrupt(self):
        assistant_path = MODULE.with_name('assistant.py')
        spec = importlib.util.spec_from_file_location('tr100_terminal_fixture', assistant_path)
        assistant = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {'serial_policy': p}): spec.loader.exec_module(assistant)
        self.assertTrue(hasattr(assistant, 'open_connection'), 'passive serial opener has not been implemented')
        class Port:
            def __init__(self, **settings):
                self.settings=settings; self.writes=[]; self.opened=False
            def open(self): self.opened=True
            def write(self, data): self.writes.append(data)
            def close(self): self.opened=False
        class SerialModule:
            Serial=Port
        with patch.object(assistant, 'serial_modules', return_value=(SerialModule, None)):
            connection = assistant.open_connection('FAKE-PORT')
        self.assertTrue(connection.opened)
        self.assertFalse(connection.dtr)
        self.assertFalse(connection.rts)
        self.assertEqual(connection.writes, [])
        connection.close()

class LocalReportTests(unittest.TestCase):
    def test_invalid_package_is_rejected_before_any_serial_module_or_port_is_opened(self):
        self.assertTrue(hasattr(p,'load_manifest'), 'manifest verifier has not been implemented')
        assistant_path = MODULE.with_name('assistant.py')
        spec = importlib.util.spec_from_file_location('tr100_assistant_fixture', assistant_path)
        assistant = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {'serial_policy': p}):
            spec.loader.exec_module(assistant)
        with tempfile.TemporaryDirectory() as directory:
            package = Path(directory)
            (package/'kernel.img').write_bytes(b'abc')
            (package/'rootfs.img').write_bytes(b'def')
            manifest = dict(MANIFEST, files={
                'kernel.img': {'bytes': 3, 'sha256': '0'*64},
                'rootfs.img': {'bytes': 3, 'sha256': hashlib.sha256(b'def').hexdigest()}})
            (package/'install-manifest.json').write_text(json.dumps(manifest))
            with patch.object(assistant, 'serial_modules', side_effect=AssertionError('serial must stay unopened')):
                with self.assertRaisesRegex(p.PolicyError, 'SHA256 mismatch'):
                    assistant.execute('inspect', package, package/'private.json', 'FAKE-PORT')
            self.assertFalse((package/'private.json').exists())

    def test_private_report_is_exclusive_and_0600(self):
        self.assertTrue(hasattr(p,'write_session'), 'session writer has not been implemented')
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'device.json'
            p.write_session(path, {'secret':'retained'})
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            with self.assertRaises(FileExistsError): p.write_session(path, {})
            self.assertEqual(json.loads(path.read_text()), {'secret':'retained'})

if __name__ == '__main__': unittest.main()
