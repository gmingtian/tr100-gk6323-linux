"""Fail-closed TR100 loader protocol. No serial-port dependency or device I/O at import.

The only persistent device operation is saveenv, after all apply checks and a
three-key readback. Inspection uses RAM as a scratch buffer for read-only eMMC
reads; it never patches executable RAM, sets variables, or writes eMMC.
"""
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import time

MIB = 1024 * 1024
MAP = '4M(fastboot),4M(bootargs),12M(kernel),4M(deviceinfo),2M(atf),8M(baseparam),8M(pqparam),-(rootfs)'
PROFILE = '4m-loader-v1'
ROOT_UUID = 'a8d4abf76ae44f9ba39aef1b79c63230'
SIGNATURE = (0xe58d40b4, 0xe1cd2cf0, 0xe3a03000, 0xe3a02802,
             0xe1cd2cf8, 0xe30033c5, 0xe58d00b0, 0xea00001b,
             0xe3590020, 0x1a00001a)
PROTECTED = (('fastboot', 0, 4), ('deviceinfo', 20, 4), ('atf', 24, 2),
             ('baseparam', 26, 8), ('pqparam', 34, 8))
FORBIDDEN_MACS = {'00:00:00:00:00:00', 'ff:ff:ff:ff:ff:ff',
                  '02:00:00:00:00:00', '02:00:00:00:00:01'}


class PolicyError(ValueError):
    """An unknown state is unsafe; stop without advancing the write phase."""


def require(condition, message):
    if not condition:
        raise PolicyError(message)


def _ascii(data):
    try:
        text = data.decode('ascii')
    except UnicodeError as error:
        raise PolicyError('loader output is not ASCII') from error
    require(all(32 <= ord(c) <= 126 or c in '\r\n\t' for c in text),
            'unexpected control bytes in loader output')
    return text.replace('\r\n', '\n').replace('\r', '\n')


class SerialConsole:
    """Bounded prompt/echo framing over a pyserial-like read/write object.

    The caller must already have interrupted boot at the factory loader prompt.
    No automatic interrupts, boot commands, or retries occur.
    Synchronization transmits only the explicit read-only printenv command.
    """
    def __init__(self, stream, timeout=20.0, max_output=131072):
        self.stream = stream
        self.timeout = timeout
        self.max_output = max_output
        self.prompt = None

    def _receive(self, discovery=False):
        deadline = time.monotonic() + self.timeout
        buffer = bytearray()
        while time.monotonic() < deadline:
            chunk = self.stream.read(4096)
            if chunk:
                buffer.extend(chunk)
                require(len(buffer) <= self.max_output, 'loader output exceeds bound')
                text = _ascii(bytes(buffer))
                if discovery:
                    match = re.search(r'(?:^|\n)([A-Za-z0-9_.:/@() -]{0,64}[#>] ?)\Z', text)
                    echoed = re.search(r'(?:^|\n)(?:[A-Za-z0-9_.:/@() -]{0,64}[#>] ?)?printenv\n', text)
                    if match and echoed:
                        self.prompt = match[1].rstrip()
                        return text[:match.start(1)]
                elif self.prompt is not None:
                    match = re.search(r'(?:^|\n)' + re.escape(self.prompt) + r' ?\Z', text)
                    if match:
                        return text[:match.start()].rstrip('\n')
            else:
                time.sleep(0.005)
        raise PolicyError('loader prompt timeout; stop and reconnect at the loader prompt')

    def connect(self):
        # Empty Enter can repeat the previous command in U-Boot. Always send
        # an explicit read-only command, even when the prompt is already visible.
        self.stream.write(b'printenv\n')
        self._receive(discovery=True)

    def command(self, command):
        require(self.prompt is not None, 'loader prompt has not been synchronized')
        require(command and '\n' not in command and '\r' not in command,
                'command must be one ASCII line')
        self.stream.write((command + '\n').encode('ascii'))
        response = self._receive()
        lines = response.splitlines()
        require(lines and lines[0].strip() == command, 'missing or unexpected loader command echo')
        return '\n'.join(lines[1:])


def parse_environment(text):
    require(len(text) <= 131072, 'environment output exceeds bound')
    entries = {}
    for line in text.splitlines():
        if not line or re.fullmatch(r'Environment size: \d+/\d+ bytes', line):
            continue
        match = re.fullmatch(r'([A-Za-z_][A-Za-z0-9_]*)=([\x20-\x7e]*)', line)
        require(match is not None, 'malformed printenv output')
        key, value = match.groups()
        require(key not in entries, 'duplicate environment key: ' + key)
        entries[key] = value
    require('bootargs' in entries and 'bootcmd' in entries, 'environment lacks bootargs/bootcmd')
    return entries


def check_factory_layout(bootargs):
    """Same protected-position policy as tools/make_hitool_package.py."""
    tokens = [s for s in bootargs.split() if s.startswith('blkdevparts=')]
    require(len(tokens) == 1 and tokens[0].startswith('blkdevparts=mmcblk0:'),
            'expected one explicit mmcblk0 factory partition map')
    parts = tokens[0].split(':', 1)[1].split(',')
    expected = [('4M', {'fastboot'}), ('4M', {'bootargs'}), ('12M', {'recovery', 'kernel'}),
                ('4M', {'deviceinfo'}), ('2M', {'atf'}), ('8M', {'baseparam'}), ('8M', {'pqparam'})]
    require(len(parts) >= 8, 'factory map is incomplete')
    for entry, (size, names) in zip(parts, expected):
        match = re.fullmatch(r'(\d+M)\(([^)]+)\)', entry)
        require(match is not None and match[1] == size and match[2] in names,
                'factory protected partition positions differ; unsupported board/layout')


def validate_manifest(manifest):
    require(manifest.get('schema') == 1 and manifest.get('profile') == PROFILE,
            'unsupported universal package profile/schema')
    require(manifest.get('layout') == MAP, 'package partition map differs')
    size = manifest.get('dtb_bytes')
    require(type(size) is int and 40 <= size <= 2 * MIB, 'invalid DTB size')
    args = manifest.get('bootargs')
    require(isinstance(args, str) and 0 < len(args) < 8192 and
            re.fullmatch(r'[\x20-\x7e]+', args) is not None and
            not any(c in args for c in "';`$|&<>\\"), 'unsafe package bootargs')
    require([s for s in args.split() if s.startswith('blkdevparts=')] ==
            ['blkdevparts=mmcblk0:' + MAP] and
            args.split().count('tr100.arm64.root=installed') == 1,
            'package bootargs require the installed eight-partition map/token')
    require(re.fullmatch('[0-9a-f]{8}', manifest.get('kernel_partition_crc32', '')) is not None,
            'package lacks full p3 CRC32')
    require(manifest.get('rootfs_uuid') == ROOT_UUID, 'unsupported rootfs UUID')


def load_manifest(package):
    """Verify local package files before opening any serial port."""
    package = Path(package)
    path = package / 'install-manifest.json'
    require(path.is_file() and not path.is_symlink(), 'install-manifest.json must be a regular file')
    require(path.stat().st_size <= 1024 * 1024, 'manifest exceeds bound')
    raw = path.read_bytes()
    try:
        manifest = json.loads(raw)
    except (ValueError, UnicodeError) as error:
        raise PolicyError('invalid package manifest') from error
    require(isinstance(manifest, dict), 'invalid manifest object')
    validate_manifest(manifest)
    files = manifest.get('files')
    require(isinstance(files, dict) and {'kernel.img', 'rootfs.img'} <= files.keys(),
            'manifest lacks kernel.img/rootfs.img file hashes')
    for name, info in files.items():
        require(isinstance(name, str) and re.fullmatch(r'[A-Za-z0-9_.-]+', name) and
                name not in ('.', '..'), 'unsafe manifest file name')
        require(isinstance(info, dict) and type(info.get('bytes')) is int and info['bytes'] >= 0 and
                re.fullmatch('[0-9a-f]{64}', info.get('sha256', '')) is not None,
                'invalid manifest file metadata')
        file = package / name
        require(file.is_file() and not file.is_symlink() and file.stat().st_size == info['bytes'],
                'package file type/size mismatch: ' + name)
        with file.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        require(digest == info['sha256'], 'package SHA256 mismatch: ' + name)
    require(files['kernel.img']['bytes'] == 12 * MIB and files['rootfs.img']['bytes'] == 7414 * MIB,
            'incorrect universal image geometry')
    return manifest, hashlib.sha256(raw).hexdigest()


def _memory_words(text):
    words = []
    address = 0x00c8ed80
    for line in text.splitlines():
        count = min(4, 10 - len(words))
        require(count > 0, 'excess loader signature rows')
        pattern = (r'([0-9A-Fa-f]{8}):\s+((?:[0-9A-Fa-f]{8}\s+){' +
                   str(count - 1) + r'}[0-9A-Fa-f]{8})(?:\s{2,}[\x20-\x7e]*)?')
        match = re.fullmatch(pattern, line)
        require(match is not None and int(match[1], 16) == address, 'malformed loader signature dump')
        row = [int(w, 16) for w in match[2].split()]
        words.extend(row)
        address += len(row) * 4
    require(tuple(words) == SIGNATURE, 'unknown loader instruction signature; no writes allowed')


def _memory_bytes(text, address, count):
    result = bytearray()
    for line in text.splitlines():
        match = re.match(r'([0-9A-Fa-f]{8}):\s+(.*)', line)
        require(match is not None and int(match[1], 16) == address + len(result),
                'unexpected RAM byte dump address')
        wanted = min(16, count - len(result))
        require(wanted > 0, 'excess RAM byte dump')
        tokens = match[2].split()
        require(len(tokens) >= wanted and all(re.fullmatch('[0-9a-fA-F]{2}', b) for b in tokens[:wanted]),
                'incomplete RAM byte dump')
        result.extend(int(b, 16) for b in tokens[:wanted])
    require(len(result) == count, 'incorrect RAM byte dump length')
    return bytes(result)


def _read(console, start_mib, size_bytes):
    start, count = start_mib * MIB // 512, size_bytes // 512
    require(size_bytes % 512 == 0, 'read must contain whole sectors')
    text = console.command(f'mmc read 0 0x40000000 {hex(start)} {hex(count)}')
    require(re.search(r'(?m)^\s*' + str(count) + r' blocks read: OK\s*$', text) is not None and
            re.search(r'(?i)\b(error|failed|failure)\b', text) is None,
            'eMMC read did not confirm the exact sector count')


def _crc(console, size):
    text = console.command(f'crc32 0x40000000 {hex(size)}')
    match = re.fullmatch(r'CRC32 for (?:0x)?([0-9a-fA-F]+)\s*\.\.\.\s*(?:0x)?([0-9a-fA-F]+)\s*==>\s*([0-9a-fA-F]{8})\s*', text)
    require(match is not None and int(match[1], 16) == 0x40000000 and
            int(match[2], 16) == 0x40000000 + size - 1, 'unexpected CRC32 result/range')
    return match[3].lower()


def preflight(console, manifest, manifest_sha256):
    validate_manifest(manifest)
    require(re.fullmatch('[0-9a-f]{64}', manifest_sha256 or '') is not None, 'invalid manifest digest')
    _memory_words(console.command('md.l 0x00c8ed80 0xa'))
    env_text = console.command('printenv')
    env = parse_environment(env_text)
    check_factory_layout(env['bootargs'])
    # Prove the entire rootfs write window fits before any flash step. This
    # read is still inside the user area; firstboot checks exact disk geometry.
    _read(console, 7455, MIB)
    crcs, mac = {}, None
    for name, start, size in PROTECTED:
        _read(console, start, size * MIB)
        crcs[name] = _crc(console, size * MIB)
        if name == 'deviceinfo':
            raw = _memory_bytes(console.command('md.b 0x40000000 0x11'), 0x40000000, 17)
            require(re.fullmatch(rb'(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}', raw) is not None,
                    'unsupported deviceinfo MAC format')
            mac = raw.decode('ascii').lower()
            require(not int(mac[:2], 16) & 1 and mac not in FORBIDDEN_MACS,
                    'deviceinfo MAC is zero, multicast, broadcast, or a template')
    require(crcs['fastboot'] == '7215eebc', 'unknown full 4 MiB loader CRC32')
    require(crcs['atf'] == '96266b1b', 'unknown full 2 MiB ATF CRC32')
    return {'schema': 1, 'profile': PROFILE, 'manifest_sha256': manifest_sha256,
            'created_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'mac': mac, 'protected_crc32': crcs, 'factory_environment': env,
            'factory_printenv': env_text,
            'backup_scope': 'environment text and per-device CRC32 evidence; no raw factory partition backup'}


def boot_values(manifest):
    validate_manifest(manifest)
    size = hex(manifest['dtb_bytes'])
    return {'bootargs': manifest['bootargs'],
            'bootcmd': ('mw.l 0x00c8ed94 0xe30033c9 1; setenv verify yes; '
                        'mmc read 0 0x40000000 0x4000 0x5000; '
                        'crc32 0x40000000 0xa00000; '
                        f'cp.b 0x40800000 0x06000000 {size}; '
                        f'crc32 0x06000000 {size}; '
                        'mmc read 0 0x8020000 0xc000 0x1000; '
                        'crc32 0x8020000 0x200000; bootm 0x40000000 - 0x06000000'),
            'verify': 'yes'}


def apply(console, manifest, manifest_sha256, session):
    """Explicit commit phase: preserve every environment key except three."""
    validate_manifest(manifest)
    require(isinstance(session, dict) and session.get('schema') == 1 and
            session.get('profile') == PROFILE and session.get('manifest_sha256') == manifest_sha256,
            'session does not belong to this package/profile')
    current = preflight(console, manifest, manifest_sha256)
    require(current['mac'] == session.get('mac') and
            current['protected_crc32'] == session.get('protected_crc32'),
            'device identity/protected partition CRC32 changed since inspection')
    require(current['factory_environment'] == session.get('factory_environment'),
            'factory environment changed since inspection; inspect again to a new report')
    _read(console, 8, 12 * MIB)
    require(_crc(console, 12 * MIB) == manifest['kernel_partition_crc32'],
            'installed full p3 CRC32 differs from package; no environment writes')
    _read(console, 42, 4 * 512)
    uuid = _memory_bytes(console.command('md.b 0x40000468 0x10'), 0x40000468, 16)
    require(uuid.hex() == manifest['rootfs_uuid'], 'installed p8 superblock UUID differs')
    original = parse_environment(console.command('printenv'))
    require(original == current['factory_environment'], 'environment changed during validation')
    updates = boot_values(manifest)
    expected = dict(original, **updates)
    for key, value in updates.items():
        # Values are generated constants or validated ASCII bootargs, never factory text.
        console.command(f"setenv {key} '{value}'")
    require(parse_environment(console.command('printenv')) == expected,
            'environment readback mismatch; saveenv was NOT issued; reconnect/power-cycle before retry')
    text = console.command('saveenv')
    require(re.search(r'(?i)\b(error|failed|failure)\b', text) is None and
            re.search(r'(?i)\b(done|OK)\b', text) is not None,
            'saveenv did not report success; inspect manually before booting')
    require(parse_environment(console.command('printenv')) == expected,
            'post-save environment readback mismatch; inspect manually before booting')
    return {'mac': current['mac'], 'updated_keys': list(updates), 'saved': True,
            'rebooted': False, 'before_environment': original, 'after_environment': expected}


def encode_terminal_line(value):
    """Encode one explicit terminal submission; controls use separate UI actions."""
    require(isinstance(value, str) and len(value) <= 4096 and
            all(32 <= ord(character) <= 126 for character in value),
            '终端只接受一行可打印 ASCII 字符；不允许换行或控制字符')
    return value.encode('ascii') + b'\r'


def write_session(path, report):
    """New PC-local private report only. Never overwrite a prior device report."""
    data = (json.dumps(report, ensure_ascii=True, indent=2) + '\n').encode('ascii')
    descriptor = os.open(os.fspath(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'wb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())


def read_session(path):
    path = Path(path)
    require(path.is_file() and not path.is_symlink() and path.stat().st_size <= 1024 * 1024,
            'session report must be a bounded regular file')
    try:
        report = json.loads(path.read_text(encoding='ascii'))
    except (ValueError, UnicodeError) as error:
        raise PolicyError('invalid session report') from error
    require(isinstance(report, dict), 'invalid session report object')
    return report
