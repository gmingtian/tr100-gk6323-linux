#!/usr/bin/env python3
"""Offline universal-media builder; never opens hardware or changes a bootloader."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
import zlib

HERE = Path(__file__).resolve().parent
ARM64 = HERE.parent
GATED = ('tr100-network.service', 'ssh.service', 'serial-getty@ttyAMA0.service',
         'tr100-hdmi-console.service', 'tr100-onboard-wifi.service')
PROFILE = '4m-loader-v1'


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


rootfs = load(ARM64 / 'rootfs/build.py', 'universal_rootfs')
media = load(ARM64 / 'tools/make_hitool_package.py', 'universal_media')
policy = load(HERE / 'serial_policy.py', 'universal_policy')
check = media.check


def install_profile(path):
    root = rootfs.guard(path)
    rootfs.audit_root(root)
    for name, expected in {
        'etc/tr100/provisioned': 'clean-rootfs-provisioned-v1',
        'etc/tr100/image-tag': 'tr100-arm64-bookworm-20261111',
        'etc/tr100/rootfs-uuid': rootfs.DEFAULT_UUID,
    }.items():
        marker = rootfs.rooted(root, name)
        check(marker.is_file() and not marker.is_symlink() and marker.read_text().strip() == expected,
              'unsupported or unprovisioned generic root: ' + name)
    for relative, source, mode in (
        ('usr/local/sbin/tr100-firstboot', 'firstboot/tr100-firstboot', 0o755),
        ('etc/systemd/system/tr100-firstboot.service', 'firstboot/tr100-firstboot.service', 0o644)):
        rootfs.put(root, relative, (HERE / source).read_text(), mode)
    rootfs.put(root, 'etc/tr100/firstboot-auto-profile', PROFILE + '\n')
    for unit in GATED:
        rootfs.put(root, 'etc/systemd/system/' + unit + '.d/10-firstboot.conf',
                   '[Unit]\nRequires=tr100-firstboot.service\nAfter=tr100-firstboot.service\n')
    enabled = rootfs.rooted(root, 'etc/systemd/system/multi-user.target.wants/tr100-firstboot.service')
    enabled.parent.mkdir(parents=True, exist_ok=True)
    if enabled.is_symlink():
        check(enabled.readlink() == Path('../tr100-firstboot.service'), 'unexpected firstboot unit link')
    else:
        check(not enabled.exists(), 'unexpected firstboot unit destination')
        enabled.symlink_to('../tr100-firstboot.service')
    rootfs.audit_root(root)


def make_xml():
    root = ET.Element('Partition_Info', ProgrammerFile='')
    for name, start, size in media.PARTS:
        selected = name in ('kernel', 'rootfs')
        ET.SubElement(root, 'Part', Sel='1' if selected else '0', PartitionName=name,
                      FlashType='emmc', FileSystem='ext3/4' if name == 'rootfs' else 'none',
                      Start='0' if start == 0 else str(start) + 'M', Length=str(size) + 'M',
                      SelectFile=name + '.img' if selected else '')
    ET.indent(root)
    return ET.tostring(root, encoding='utf-8', xml_declaration=True)


def debug(debugfs, image, command):
    result = subprocess.run([debugfs, '-R', command, str(image)], capture_output=True, check=True)
    return result.stdout


def check_root_image(path, debugfs):
    with path.open('rb') as stream:
        stream.seek(1024)
        sb = stream.read(1024)
    check(len(sb) == 1024 and struct.unpack_from('<H', sb, 56)[0] == 0xef53 and
          struct.unpack_from('<I', sb, 24)[0] == 2 and
          struct.unpack_from('<I', sb, 4)[0] == media.ROOT_BYTES // 4096 and
          struct.unpack_from('<I', sb, 336)[0] == 0 and
          sb[104:120].hex() == policy.ROOT_UUID, 'incorrect ext4 geometry/UUID')
    def cat(name):
        return media.root_file(debugfs, path, name)
    for name, value in {
        'etc/tr100/build-marker': rootfs.MARKER.encode(),
        'etc/tr100/provisioned': b'clean-rootfs-provisioned-v1\n',
        'etc/tr100/image-tag': b'tr100-arm64-bookworm-20261111\n',
        'etc/tr100/firstboot-auto-profile': (PROFILE + '\n').encode(),
        'usr/local/sbin/tr100-firstboot': (HERE / 'firstboot/tr100-firstboot').read_bytes(),
        'etc/systemd/system/tr100-firstboot.service': (HERE / 'firstboot/tr100-firstboot.service').read_bytes(),
        'etc/machine-id': b'',
    }.items():
        check(cat(name) == value, 'generic root mismatch: ' + name)
    shadow = cat('etc/shadow').decode('ascii').splitlines()
    check(shadow and sum(line.startswith('root:') for line in shadow) == 1 and
          all(len(line.split(':')) == 9 and line.split(':')[1] in ('!', '*', '!!') for line in shadow),
          'generic root must have all passwords locked')
    for name in ('etc/tr100/factory-mac', 'etc/tr100/personalized', 'root/.ssh',
                 'var/lib/dbus/machine-id', 'var/lib/systemd/random-seed'):
        check(not debug(debugfs, path, 'stat /' + name), 'private identity remains: ' + name)
    check(b'ssh_host_' not in debug(debugfs, path, 'ls -p /etc/ssh'), 'SSH host keys remain')
    for unit in GATED:
        check(cat('etc/systemd/system/' + unit + '.d/10-firstboot.conf') ==
              b'[Unit]\nRequires=tr100-firstboot.service\nAfter=tr100-firstboot.service\n',
              'missing firstboot dependency: ' + unit)
    enabled = debug(debugfs, path, 'stat /etc/systemd/system/multi-user.target.wants/tr100-firstboot.service')
    check(b'../tr100-firstboot.service' in enabled, 'firstboot unit is not enabled')


def make_media(args):
    kernel = media.read_verified(args.kernel, 12 * media.MIB, args.kernel_sha256)
    bootargs, dtb_size = media.check_kernel(kernel, '02:00:00:00:00:01', generic=True)
    media.regular(args.rootfs, media.ROOT_BYTES, args.rootfs_sha256)
    debugfs = shutil.which(args.debugfs)
    check(debugfs is not None, 'debugfs is required')
    check(not args.output.exists() and not args.output.is_symlink(), 'output must be a new directory')
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix='.universal-', dir=args.output.parent))
    try:
        (temporary / 'kernel.img').write_bytes(kernel)
        media.copy_verified(args.rootfs, temporary / 'rootfs.img', args.rootfs_sha256)
        check_root_image(temporary / 'rootfs.img', debugfs)
        (temporary / 'TR100-Universal.xml').write_bytes(make_xml())
        for name in ('assistant.py', 'serial_policy.py', 'README.md', 'BUILD.md', 'start-windows.cmd', 'start-linux.sh', 'requirements.txt'):
            shutil.copyfile(HERE / name, temporary / name)
        (temporary / 'start-linux.sh').chmod(0o755)
        manifest = {'schema': 1, 'profile': PROFILE, 'layout': media.MAP,
                    'universal_preview': True, 'hitool_hardware_flash_tested': False,
                    'new_board_firstboot_tested': False, 'large_file_hitool_import_tested': False,
                    'dtb_bytes': dtb_size, 'bootargs': bootargs,
                    'kernel_partition_crc32': f'{zlib.crc32(kernel):08x}',
                    'rootfs_uuid': policy.ROOT_UUID, 'writes': ['kernel', 'rootfs'],
                    'preserves': ['fastboot', 'deviceinfo', 'atf', 'baseparam', 'pqparam'],
                    'bootargs_update': 'assistant changes only bootargs, bootcmd, verify; saveenv last',
                    'files': {p.name: {'bytes': p.stat().st_size, 'sha256': media.sha(p)}
                              for p in sorted(temporary.iterdir())}}
        policy.validate_manifest(manifest)
        (temporary / 'install-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
        (temporary / 'SHA256SUMS').write_text(''.join(
            media.sha(p) + '  ' + p.name + '\n' for p in sorted(temporary.iterdir())))
        temporary.rename(args.output)
    except BaseException:
        shutil.rmtree(temporary)
        raise
    print(args.output)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    install = sub.add_parser('install-profile')
    install.add_argument('--root', required=True, type=Path)
    package = sub.add_parser('make-media')
    for name in ('kernel', 'rootfs'):
        package.add_argument('--' + name, required=True, type=Path)
        package.add_argument('--' + name + '-sha256', required=True)
    package.add_argument('--output', required=True, type=Path)
    package.add_argument('--debugfs', default='debugfs')
    args = parser.parse_args()
    try:
        if args.command == 'install-profile':
            install_profile(args.root)
            print('Universal profile installed; identity remains blank and all accounts locked.')
        else:
            make_media(args)
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print('universal:', error, file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
