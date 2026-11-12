#!/usr/bin/env python3
"""Build a clean Debian ARM64 staging root, never a running-device snapshot."""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import uuid

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
MARKER = 'tr100-clean-rootfs-v1\n'
DEFAULT_UUID = 'a8d4abf7-6ae4-4f9b-a39a-ef1b79c63230'


def fail(message):
    raise ValueError(message)


def run(argv, **kwargs):
    subprocess.run(list(map(str, argv)), check=True, **kwargs)


def rooted(root, relative):
    path = root / relative
    if not path.parent.resolve().is_relative_to(root):
        fail(f'path escapes staging root: {relative}')
    return path


def put(root, relative, text, mode=0o644):
    path = rooted(root, relative)
    if path.is_symlink():
        fail(f'refusing symlink destination: {relative}')
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    path.chmod(mode)


def guard(path, new=False):
    given = Path(path).absolute()
    root = given.resolve()
    if root != given or len(root.parts) < 4 or root in (Path('/'), Path.home()):
        fail('root must be an explicit, non-symlink staging subdirectory, never host root/home')
    if new:
        if root.exists():
            fail('new staging root must not already exist')
    else:
        marker = rooted(root, 'etc/tr100/build-marker')
        if marker.is_symlink() or not marker.is_file() or marker.read_text() != MARKER:
            fail('not a root created by this builder (build-marker missing)')
        # Never traverse live mounts while cleaning or publishing a root.
        for line in Path('/proc/self/mountinfo').read_text().splitlines():
            mounted = Path(line.split()[4].replace('\\040', ' '))
            if mounted == root or mounted.is_relative_to(root):
                fail(f'unmount staging filesystems first: {mounted}')
    return root


def verify(path, digest):
    if not re.fullmatch('[0-9a-fA-F]{64}', digest or ''):
        fail('every supplied archive requires its explicit SHA256')
    actual = hashlib.file_digest(open(path, 'rb'), 'sha256').hexdigest()
    if actual != digest.lower():
        fail(f'SHA256 mismatch: {path}')
    return actual


def extract(archive, root, skip_dev=False):
    """Reject traversal, device nodes, and writes through escaping symlinks."""
    with tarfile.open(archive, 'r:*') as tar:
        members = [member for member in tar.getmembers()
                   if not (skip_dev and PurePosixPath(member.name).parts[:1] == ('dev',))]
        for member in members:
            name = PurePosixPath(member.name)
            if name.is_absolute() or '..' in name.parts or member.isdev() or member.isfifo():
                fail(f'unsafe archive member: {member.name}')
            if member.islnk():
                target = PurePosixPath(member.linkname)
                if target.is_absolute() or '..' in target.parts:
                    fail(f'unsafe archive hardlink: {member.name}')
        root.mkdir(parents=True, exist_ok=True)
        for member in members:
            if member.name.rstrip('/') in ('', '.'):
                continue
            destination = rooted(root, member.name)
            if destination.is_symlink() and not member.issym():
                fail(f'archive overwrites symlink: {member.name}')
            if member.islnk() and not (root / member.linkname).resolve().is_relative_to(root):
                fail(f'archive hardlink escapes root: {member.name}')
            options = {'filter': 'fully_trusted'} if hasattr(tarfile, 'data_filter') else {}
            tar.extract(member, root, **options)


def configure(root, root_uuid):
    uuid.UUID(root_uuid)
    put(root, 'etc/tr100/build-marker', MARKER)
    put(root, 'etc/tr100/image-tag', 'tr100-arm64-bookworm-20261111\n')
    put(root, 'etc/tr100/rootfs-uuid', root_uuid + '\n')
    put(root, 'etc/tr100/needs-personalization', 'Set factory MAC and local credentials before installation.\n')
    for relative in ('usr/local/sbin/tr100-network', 'usr/local/libexec/tr100-udhcpc-hook',
                     'etc/systemd/system/tr100-network.service'):
        source = HERE / 'overlay' / relative
        if not source.exists():
            source = REPO / 'firmware-analysis/board-pure-linux/overlay' / relative
        put(root, relative, source.read_text(), 0o755 if relative.startswith('usr/') else 0o644)
    for source in (HERE / 'overlay').rglob('*'):
        if source.is_file():
            relative = str(source.relative_to(HERE / 'overlay'))
            put(root, relative, source.read_text(), source.stat().st_mode & 0o777)
    # HDMI has one canonical implementation. Never publish stale overlay copies.
    for name in ('tr100-display-modules', 'tr100-hdmi-console'):
        put(root, 'usr/local/sbin/' + name, (REPO / 'hdmi/bin' / name).read_text(), 0o755)
        put(root, 'etc/systemd/system/' + name + '.service',
            (REPO / 'hdmi/systemd' / (name + '.service')).read_text())
    put(root, 'usr/local/libexec/tr100-provision-root', (HERE / 'provision-root.sh').read_text(), 0o755)
    put(root, 'etc/hostname', 'tr100\n')
    put(root, 'etc/hosts', '127.0.0.1 localhost\n127.0.1.1 tr100\n::1 localhost ip6-localhost ip6-loopback\n')
    put(root, 'etc/fstab', '# Root mounted by TR100 initramfs, exact partition/UUID guard.\n')
    # OCI roots commonly provide an ordinary resolv.conf; never retain host resolver identity.
    resolver = rooted(root, 'etc/resolv.conf')
    if resolver.is_symlink():
        resolver.unlink()
    put(root, 'etc/resolv.conf', 'nameserver 119.29.29.29\nnameserver 223.5.5.5\n')
    put(root, 'etc/tr100/build-packages', (HERE / 'packages.txt').read_text())
    put(root, 'etc/tr100/build-snapshot', 'https://snapshot.debian.org/archive/debian/20261110T000000Z/\n')
    put(root, 'usr/sbin/policy-rc.d', '#!/bin/sh\nexit 101\n', 0o755)


def prepare(args):
    root = guard(args.root, new=True)
    inputs = {}
    for name in ('rootfs', 'packages', 'armhf', 'docker', 'modules', 'firmware'):
        archive = getattr(args, name + '_tar', None)
        if archive:
            inputs[name] = {'sha256': verify(archive, getattr(args, name + '_sha256')), 'file': Path(archive).name}
    extract(args.rootfs_tar, root, skip_dev=True)
    os_release = rooted(root, 'etc/os-release')
    # /etc/os-release can legitimately be a relative symlink inside a Debian root.
    if not os_release.resolve().is_relative_to(root) or 'bookworm' not in os_release.read_text():
        fail('base must be a clean Debian bookworm ARM64 root (not a device snapshot)')
    for name, subdir in [('packages', 'var/cache/tr100-build/arm64'), ('armhf', 'var/cache/tr100-build/armhf')]:
        archive = getattr(args, name + '_tar')
        if archive:
            extract(archive, root / subdir)
    if args.docker_tar:
        docker_stage = root / 'var/cache/tr100-build/docker'
        extract(args.docker_tar, docker_stage)
        binaries = docker_stage / 'docker'
        if not (binaries / 'dockerd').is_file():
            fail('Docker archive must contain docker/dockerd')
        shutil.copytree(binaries, root / 'opt/tr100-docker', dirs_exist_ok=True)
    if args.modules_tar:
        extract(args.modules_tar, root)
    if args.firmware_tar:
        extract(args.firmware_tar, root)
    configure(root, args.uuid)
    put(root, 'etc/tr100/build-inputs.json', json.dumps(inputs, indent=2) + '\n')
    sanitize_root(root)
    print(root)


def bootstrap(args):
    require_root()
    root = guard(args.root, new=True)
    if not re.fullmatch(r'https://snapshot\.debian\.org/archive/debian/[0-9]{8}T[0-9]{6}Z/', args.snapshot):
        fail('bootstrap requires explicit HTTPS Debian snapshot URL')
    run(['debootstrap', '--arch=arm64', '--foreign', '--variant=minbase', '--include=ca-certificates,debian-archive-keyring',
         'bookworm', root, args.snapshot])
    configure(root, args.uuid)
    put(root, 'etc/tr100/build-snapshot', args.snapshot + '\n')
    print('Bootstrap first stage complete; run provision next (native ARM64 or configured QEMU/binfmt).')


def restore(args):
    """Restore a verified generic release without changing its build provenance."""
    root = guard(args.root, new=True)
    verify(args.archive, args.sha256)
    extract(args.archive, root, skip_dev=True)
    guard(root)
    audit_root(root)
    stamp = rooted(root, 'etc/tr100/provisioned')
    if not stamp.is_file() or stamp.read_text().strip() != 'clean-rootfs-provisioned-v1':
        fail('restore requires a successfully provisioned generic release')
    print(root)


def require_root():
    if os.geteuid() != 0:
        fail('this operation requires Linux root privileges (sudo)')


def provision(args):
    require_root()
    root = guard(args.root)
    if args.with_docker:
        put(root, 'etc/systemd/system/docker.service',
            (HERE / 'overlay/etc/systemd/system/docker.service').read_text())
    if platform.machine() not in ('aarch64', 'arm64'):
        if not args.qemu:
            fail('x86 host needs --qemu /usr/bin/qemu-aarch64-static AND enabled qemu-aarch64 binfmt')
        if not Path('/proc/sys/fs/binfmt_misc/qemu-aarch64').exists():
            fail('qemu-aarch64 binfmt is not registered; install qemu-user-static + binfmt-support')
        shutil.copy2(args.qemu, root / 'usr/bin/qemu-aarch64-static')
    # Borrow worker DNS only during provisioning, never store it in public output.
    resolver = Path('/etc/resolv.conf').read_text()
    put(root, 'etc/resolv.conf', resolver)
    remove(root, 'etc/tr100/provisioned')
    try:
        # Private mount/PID namespaces guarantee cleanup even when provisioning fails.
        run(['unshare', '--mount', '--pid', '--fork', 'bash', str(HERE / 'chroot-run.sh'), root,
             '1' if args.offline else '0', '1' if args.with_docker else '0'])
    finally:
        put(root, 'etc/resolv.conf', '# Managed by TR100 DHCP\n')
    sanitize_root(root)
    audit_root(root)


def remove(root, relative):
    path = rooted(root, relative)
    if path.is_symlink() or path.is_file():
        path.unlink()
    elif path.exists():
        shutil.rmtree(path)


def sanitize_root(root):
    # Fail before any writes if identity files could escape via a malicious link.
    for name in ('etc/machine-id', 'etc/shadow'):
        path = rooted(root, name)
        if path.is_symlink():
            fail(f'identity file may not be a symlink: {name}')
    for name in ('.dockerenv', 'root/.ssh', 'root/.bash_history', 'root/.ash_history', 'root/.cache',
                 'etc/tr100/factory-mac', 'etc/tr100/personalized', 'var/lib/dbus/machine-id',
                 'var/lib/systemd/random-seed', 'var/lib/dhcp', 'var/lib/NetworkManager',
                 'var/lib/systemd/network', 'var/lib/docker', 'var/lib/containerd'):
        remove(root, name)
    for path in rooted(root, 'etc/ssh').glob('ssh_host_*'):
        remove(root, str(path.relative_to(root)))
    for name in ('var/log', 'tmp', 'run'):
        path = rooted(root, name)
        if path.is_symlink():
            fail(f'expected directory, not symlink: {name}')
        if path.exists():
            for child in path.iterdir():
                remove(root, str(child.relative_to(root)))
    shadow = rooted(root, 'etc/shadow')
    if shadow.exists():
        lines = []
        for line in shadow.read_text().splitlines():
            fields = line.split(':')
            # Lock all local account passwords. Personalization explicitly enables root.
            if len(fields) >= 2:
                fields[1] = '!'
            lines.append(':'.join(fields))
        put(root, 'etc/shadow', '\n'.join(lines) + '\n', 0o640)
    put(root, 'etc/machine-id', '')
    put(root, 'etc/tr100/needs-personalization', 'Set factory MAC and local credentials before installation.\n')
    put(root, 'etc/resolv.conf', '# Managed by TR100 DHCP\n')
    put(root, 'etc/ssh/sshd_config.d/00-tr100.conf', 'PermitRootLogin prohibit-password\nPasswordAuthentication no\nPubkeyAuthentication yes\nKbdInteractiveAuthentication no\nPermitEmptyPasswords no\n')


def audit_root(root, personalized=False):
    if rooted(root, 'etc/machine-id').is_symlink() or rooted(root, 'etc/machine-id').read_text():
        fail('machine-id must be an empty regular file before first boot')
    for name in ('var/lib/dbus/machine-id', 'var/lib/systemd/random-seed', 'root/.bash_history'):
        if rooted(root, name).exists() or rooted(root, name).is_symlink():
            fail(f'identity remains: {name}')
    if list(rooted(root, 'etc/ssh').glob('ssh_host_*')):
        fail('SSH host keys must be generated only on the destination device')
    if not personalized:
        for name in ('root/.ssh', 'etc/tr100/factory-mac', 'etc/tr100/personalized'):
            if rooted(root, name).exists():
                fail(f'personal information remains: {name}')
        for line in rooted(root, 'etc/shadow').read_text().splitlines():
            if len(line.split(':')) >= 2 and line.split(':')[1] not in ('!', '*', '!!'):
                fail('published image contains an unlocked/password account')
    elif not rooted(root, 'etc/tr100/personalized').is_file():
        fail('local personalization is required')


def valid_mac(value):
    if not re.fullmatch(r'(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}', value):
        fail('MAC must contain six hex octets')
    octets = bytes.fromhex(value.replace(':', ''))
    if octets[0] & 1 or octets == bytes(6):
        fail('MAC must be a nonzero unicast address from your own device')
    return value.lower()


def personalize(args):
    root = guard(args.root)
    mac = valid_mac(args.mac)
    if not args.authorized_key and not args.password_file:
        fail('supply --authorized-key and/or --password-file; no default password is provided')
    key_text = None
    if args.authorized_key:
        key_text = Path(args.authorized_key).read_text().strip()
        if '\n' in key_text or not key_text.startswith(('ssh-ed25519 ', 'ssh-rsa ', 'ecdsa-sha2-')):
            fail('provide one plain SSH public key, not a private key or authorized_keys options')
        run(['ssh-keygen', '-l', '-f', args.authorized_key], stdout=subprocess.DEVNULL)
    password_hash = None
    if args.password_file:
        password_path = Path(args.password_file)
        if password_path.stat().st_mode & 0o077:
            fail('password file must be readable only by its owner (chmod 600)')
        password = password_path.read_text().rstrip('\n')
        if not password or '\n' in password or '\0' in password:
            fail('password file must contain one nonempty password')
        result = subprocess.run(['openssl', 'passwd', '-6', '-stdin'], input=password + '\n',
                                text=True, capture_output=True, check=True)
        password_hash = result.stdout.strip()
    if password_hash:
        shadow = rooted(root, 'etc/shadow')
        lines = shadow.read_text().splitlines()
        if not any(line.startswith('root:') for line in lines):
            fail('base shadow has no root account')
        lines = [':'.join([line.split(':')[0], password_hash, *line.split(':')[2:]])
                 if line.startswith('root:') else line for line in lines]
        put(root, 'etc/shadow', '\n'.join(lines) + '\n', 0o640)
    if key_text:
        directory = rooted(root, 'root/.ssh')
        if directory.is_symlink():
            fail('root .ssh must not be a symlink')
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        directory.chmod(0o700)
        put(root, 'root/.ssh/authorized_keys', key_text + '\n', 0o600)
        # A locked shadow password can prohibit key access on some OpenSSH builds.
        # '*' cannot authenticate by password, while PermitRootLogin below allows keys.
        if not password_hash:
            shadow = rooted(root, 'etc/shadow')
            put(root, 'etc/shadow', re.sub(r'^root:[^:]*:', 'root:*:', shadow.read_text(), flags=re.M), 0o640)
    put(root, 'etc/tr100/factory-mac', mac + '\n', 0o600)
    put(root, 'etc/tr100/personalized', 'local credentials configured\n', 0o600)
    remove(root, 'etc/tr100/needs-personalization')
    put(root, 'etc/ssh/sshd_config.d/00-tr100.conf',
        'PermitRootLogin ' + ('yes' if password_hash else 'prohibit-password') + '\nPasswordAuthentication ' +
        ('yes' if password_hash else 'no') + '\nPubkeyAuthentication yes\nKbdInteractiveAuthentication no\nPermitEmptyPasswords no\n')
    print('Personalized local root. Keep it private; use the same MAC when packing the boot image.')


def output_path(args, root):
    dest = Path(args.output).absolute()
    if dest.exists() or dest.is_symlink() or dest.resolve().is_relative_to(root):
        fail('output must be a new file outside staging root')
    dest.parent.mkdir(parents=True, exist_ok=True)
    audit_root(root, args.personalized)
    stamp = rooted(root, 'etc/tr100/provisioned')
    if not stamp.is_file() or stamp.read_text().strip() != 'clean-rootfs-provisioned-v1':
        fail('run provision successfully before creating a distributable artifact')
    return dest


def archive(args):
    root = guard(args.root)
    dest = output_path(args, root)
    with dest.open('xb') as raw:
        with gzip.GzipFile(filename='', mode='wb', fileobj=raw, mtime=args.epoch) as compressed:
            proc = subprocess.Popen(['tar', '--sort=name', '--numeric-owner', '--format=pax',
                                     '--pax-option=delete=atime,delete=ctime', '--mtime=@' + str(args.epoch),
                                     '-C', str(root), '-cf', '-', '.'], stdout=subprocess.PIPE)
            shutil.copyfileobj(proc.stdout, compressed)
            if proc.wait() != 0:
                fail('tar failed')
    print(hashlib.file_digest(open(dest, 'rb'), 'sha256').hexdigest(), dest)


def image(args):
    require_root()
    root = guard(args.root)
    dest = output_path(args, root)
    if args.size_mib < 256:
        fail('image must be at least 256 MiB; ensure it fits destination partition')
    root_uuid = rooted(root, 'etc/tr100/rootfs-uuid').read_text().strip()
    uuid.UUID(root_uuid)
    with dest.open('xb') as output:
        output.truncate(args.size_mib * 1024 * 1024)
    # Disable features unsupported by this Linux 5.10/vendor recovery combination.
    run(['mke2fs', '-q', '-t', 'ext4', '-F', '-b', '4096', '-L', 'tr100-root', '-U', root_uuid,
         '-O', '^metadata_csum_seed,^orphan_file', '-E', 'lazy_itable_init=0,lazy_journal_init=0', '-d', root, dest])
    run(['e2fsck', '-fn', dest])
    print(hashlib.file_digest(open(dest, 'rb'), 'sha256').hexdigest(), dest)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    for name in ('prepare', 'bootstrap', 'restore', 'provision', 'sanitize', 'personalize', 'audit', 'archive', 'image'):
        p = sub.add_parser(name)
        p.add_argument('--root', required=True)
        if name == 'prepare':
            for kind in ('rootfs', 'packages', 'armhf', 'docker', 'modules', 'firmware'):
                p.add_argument('--' + kind + '-tar', required=kind == 'rootfs')
                p.add_argument('--' + kind + '-sha256', required=kind == 'rootfs')
        if name in ('prepare', 'bootstrap'):
            p.add_argument('--uuid', default=DEFAULT_UUID)
        if name == 'bootstrap':
            p.add_argument('--snapshot', default='https://snapshot.debian.org/archive/debian/20261110T000000Z/')
        if name == 'provision':
            p.add_argument('--qemu')
            p.add_argument('--offline', action='store_true')
            p.add_argument('--with-docker', action='store_true', help='install optional static Docker runtime')
        if name == 'restore':
            p.add_argument('--archive', required=True)
            p.add_argument('--sha256', required=True)
        if name == 'personalize':
            p.add_argument('--mac', required=True)
            p.add_argument('--password-file')
            p.add_argument('--authorized-key')
        if name in ('audit', 'archive', 'image'):
            p.add_argument('--personalized', action='store_true', help='local private output only')
        if name in ('archive', 'image'):
            p.add_argument('--output', required=True)
        if name == 'archive':
            p.add_argument('--epoch', type=int, default=1794355200)
        if name == 'image':
            p.add_argument('--size-mib', type=int, default=7414)
    args = parser.parse_args()
    try:
        if args.command == 'sanitize':
            root = guard(args.root)
            sanitize_root(root)
            audit_root(root)
        elif args.command == 'audit':
            audit_root(guard(args.root), args.personalized)
        else:
            globals()[args.command](args)
    except (ValueError, OSError, subprocess.CalledProcessError, tarfile.TarError) as error:
        print('rootfs:', error, file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
