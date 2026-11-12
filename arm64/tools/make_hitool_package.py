#!/usr/bin/env python3
"""Offline HiTool export for the verified TR100 4 MiB loader profile."""
import argparse
import gzip
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import re
import shutil
import struct
import subprocess
import tempfile
import xml.etree.ElementTree as ET
import zlib

MIB = 1024 * 1024
ROOT_BYTES = 7414 * MIB
LOADER_SHA = 'fdc8847fafd9ef5ca006cb414561b99464b344deba1c16f8c223c0916f2c521e'
ATF_SHA = '4ff6abeff404e8eeb0f0f3816470b3d65a9261c2ed75c6e4ce48fbf7fcc2f939'
MAP = '4M(fastboot),4M(bootargs),12M(kernel),4M(deviceinfo),2M(atf),8M(baseparam),8M(pqparam),-(rootfs)'
PARTS = [('fastboot', 0, 4), ('bootargs', 4, 4), ('kernel', 8, 12),
         ('deviceinfo', 20, 4), ('atf', 24, 2), ('baseparam', 26, 8),
         ('pqparam', 34, 8), ('rootfs', 42, 7414)]


def check(condition, message):
    if not condition:
        raise ValueError(message)


def sha(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def regular(path, size, digest):
    check(path.is_file() and not path.is_symlink(), 'input must be a regular non-symlink file')
    check(path.stat().st_size == size, 'incorrect input size: ' + path.name)
    check(re.fullmatch('[0-9a-f]{64}', digest or '') is not None, 'explicit SHA256 required')
    check(sha(path) == digest, 'input SHA256 mismatch: ' + path.name)


def read_verified(path, size, digest):
    check(path.is_file() and not path.is_symlink(), 'input must be a regular non-symlink file')
    with path.open('rb') as stream:
        data = stream.read(size + 1)
    check(len(data) == size, 'incorrect input size: ' + path.name)
    check(re.fullmatch('[0-9a-f]{64}', digest or '') is not None and
          hashlib.sha256(data).hexdigest() == digest, 'input SHA256 mismatch: ' + path.name)
    return data


def make_xml():
    root = ET.Element('Partition_Info', ProgrammerFile='')
    for name, start, size in PARTS:
        selected = name in ('bootargs', 'kernel', 'rootfs')
        ET.SubElement(root, 'Part', Sel='1' if selected else '0', PartitionName=name,
                      FlashType='emmc', FileSystem='ext3/4' if name == 'rootfs' else 'none',
                      Start='0' if start == 0 else str(start) + 'M', Length=str(size) + 'M',
                      SelectFile=name + '.img' if selected else '')
    ET.indent(root)
    return ET.tostring(root, encoding='utf-8', xml_declaration=True)


def parse_environment(image):
    check(len(image) == 4 * MIB, 'environment must be exactly 4 MiB')
    data = image[4:65536]
    check(struct.unpack_from('<I', image)[0] == zlib.crc32(data), 'environment CRC mismatch')
    end = data.find(b'\0\0')
    # U-Boot saveenv can retain inactive bytes after the double-NUL terminator.
    # They are CRC-covered, not active variables; rebuilding normalizes this area.
    check(end > 0, 'invalid environment terminator')
    entries = {}
    for item in data[:end].split(b'\0'):
        check(re.fullmatch(rb'[A-Za-z_][A-Za-z0-9_]*=[\x20-\x7e]*', item) is not None,
              'invalid environment entry')
        key, value = item.decode('ascii').split('=', 1)
        check(key not in entries, 'duplicate environment key')
        entries[key] = value
    check('bootargs' in entries and 'bootcmd' in entries, 'environment lacks bootargs/bootcmd')
    return entries


def check_factory_layout(bootargs):
    tokens = [s for s in bootargs.split() if s.startswith('blkdevparts=')]
    check(len(tokens) == 1 and tokens[0].startswith('blkdevparts=mmcblk0:'),
          'expected one explicit mmcblk0 factory partition map')
    parts = tokens[0].split(':', 1)[1].split(',')
    expected = [('4M', {'fastboot'}), ('4M', {'bootargs'}), ('12M', {'recovery', 'kernel'}),
                ('4M', {'deviceinfo'}), ('2M', {'atf'}), ('8M', {'baseparam'}), ('8M', {'pqparam'})]
    check(len(parts) >= 8, 'factory map is incomplete')
    for entry, (size, names) in zip(parts, expected):
        match = re.fullmatch(r'(\d+M)\(([^)]+)\)', entry)
        check(match is not None and match[1] == size and match[2] in names,
              'factory protected partition positions differ; unsupported board/layout')


def check_prefix(prefix):
    check(len(prefix) == 42 * MIB, 'prefix must be exactly 42 MiB')
    check(hashlib.sha256(prefix[:4 * MIB]).hexdigest() == LOADER_SHA,
          'unverified loader; this exporter supports only the tested 4 MiB loader profile')
    check(hashlib.sha256(prefix[24 * MIB:26 * MIB]).hexdigest() == ATF_SHA,
          'unverified ATF or ATF location')
    entries = parse_environment(prefix[4 * MIB:8 * MIB])
    check_factory_layout(entries['bootargs'])
    return entries


def check_device_identity(prefix, mac):
    factory_mac = prefix[20 * MIB:20 * MIB + 17]
    check(re.fullmatch(rb'(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}', factory_mac) is not None,
          'unsupported deviceinfo identity format')
    check(factory_mac.decode().lower() == mac.lower(), 'deviceinfo MAC differs from target identity')


def rebuild_environment(original, bootargs, dtb_size):
    entries = parse_environment(original)
    check(40 <= dtb_size <= 2 * MIB, 'invalid DTB size')
    check(bootargs and '\0' not in bootargs and '\n' not in bootargs, 'invalid bootargs')
    entries['bootargs'] = bootargs
    entries['bootcmd'] = ('mw.l 0x00c8ed94 0xe30033c9 1; setenv verify yes; '
                          'mmc read 0 0x40000000 0x4000 0x5000; '
                          'crc32 0x40000000 0xa00000; '
                          f'cp.b 0x40800000 0x06000000 {hex(dtb_size)}; '
                          f'crc32 0x06000000 {hex(dtb_size)}; '
                          'mmc read 0 0x8020000 0xc000 0x1000; '
                          'crc32 0x8020000 0x200000; bootm 0x40000000 - 0x06000000')
    entries['verify'] = 'yes'
    body = ('\0'.join(k + '=' + v for k, v in entries.items()) + '\0\0').encode('ascii')
    check(len(body) <= 65532, 'environment overflow')
    result = bytearray(original)
    result[4:65536] = body.ljust(65532, b'\0')
    struct.pack_into('<I', result, 0, zlib.crc32(result[4:65536]))
    return bytes(result)


def check_kernel(data, mac):
    path = Path(__file__).resolve().parents[1] / 'build/pack.py'
    spec = importlib.util.spec_from_file_location('tr100_pack', path)
    pack = importlib.util.module_from_spec(spec); spec.loader.exec_module(pack)
    expected_mac = pack.parse_mac(mac)
    fields = list(struct.unpack('>7I4B32s', data[:64]))
    check(fields[0] == 0x27051956 and fields[3] <= 8 * MIB - 64,
          'invalid legacy kernel header/size')
    crc = fields[1]; fields[1] = 0
    check(zlib.crc32(struct.pack('>7I4B32s', *fields)) == crc, 'kernel header CRC mismatch')
    payload = data[64:64 + fields[3]]
    check(zlib.crc32(payload) == fields[6], 'kernel payload CRC mismatch')
    check(fields[4:6] == [0x02000000, 0x02000000] and fields[7:11] == [5, 22, 2, 1],
          'unexpected kernel architecture/load/type/compression')
    with gzip.GzipFile(fileobj=io.BytesIO(payload)) as stream:
        image = stream.read(64 * MIB + 1)
    check(len(image) <= 64 * MIB, 'kernel decompression exceeds memory bound')
    pack.validate_image(image)
    offset = 8 * MIB
    magic, size = struct.unpack_from('>II', data, offset)
    check(magic == 0xd00dfeed and 40 <= size <= 2 * MIB, 'invalid installed DTB')
    props = pack.fdt_properties(data[offset:offset + size])
    check(props.get(('/soc/gketh@f9c30000/gketh_phy@0', 'mac-address')) == expected_mac,
          'kernel MAC does not match the target identity')
    args = props[('/chosen', 'bootargs')].rstrip(b'\0').decode('ascii')
    maps = [token for token in args.split() if token.startswith('blkdevparts=')]
    check(args.split().count('tr100.arm64.root=installed') == 1 and
          maps == ['blkdevparts=mmcblk0:' + MAP],
          'kernel does not use the required installed eight-partition layout')
    return args, size


def root_file(debugfs, image, name):
    result = subprocess.run([debugfs, '-R', 'cat /' + name, str(image)],
                            capture_output=True, check=True)
    return result.stdout


def check_rootfs(path, mac, debugfs):
    with path.open('rb') as f:
        f.seek(1024); sb = f.read(1024)
    check(struct.unpack_from('<H', sb, 56)[0] == 0xef53 and
          struct.unpack_from('<I', sb, 24)[0] == 2 and
          struct.unpack_from('<I', sb, 4)[0] == ROOT_BYTES // 4096 and
          struct.unpack_from('<I', sb, 336)[0] == 0 and
          sb[104:120].hex() == 'a8d4abf76ae44f9ba39aef1b79c63230', 'incorrect ext4 geometry/UUID')
    check(root_file(debugfs, path, 'etc/tr100/image-tag').strip() == b'tr100-arm64-bookworm-20261111',
          'incorrect rootfs image tag')
    check(root_file(debugfs, path, 'etc/tr100/factory-mac').strip().decode() == mac.lower(),
          'rootfs MAC does not match target/kernel')
    check(root_file(debugfs, path, 'etc/tr100/personalized').strip(), 'rootfs not personalized')


def copy_verified(source, destination, expected):
    digest = hashlib.sha256()
    with source.open('rb') as src, destination.open('xb') as dst:
        while chunk := src.read(MIB):
            digest.update(chunk)
            if chunk == bytes(len(chunk)):
                dst.seek(len(chunk), 1)
            else:
                dst.write(chunk)
        dst.truncate(src.tell())
    check(digest.hexdigest() == expected, 'input changed during copy')


def package(args):
    prefix = read_verified(args.prefix, 42 * MIB, args.prefix_sha256)
    kernel = read_verified(args.kernel, 12 * MIB, args.kernel_sha256)
    regular(args.rootfs, ROOT_BYTES, args.rootfs_sha256)
    check_prefix(prefix)
    check_device_identity(prefix, args.mac)
    bootargs, size = check_kernel(kernel, args.mac)
    debugfs = shutil.which(args.debugfs)
    check(debugfs is not None, 'debugfs is required for offline rootfs identity validation')
    check(not args.output.exists() and not args.output.is_symlink(), 'output must be a new directory')
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix='.hitool-', dir=args.output.parent))
    temporary.chmod(0o700)
    try:
        (temporary / 'bootargs.img').write_bytes(rebuild_environment(prefix[4 * MIB:8 * MIB], bootargs, size))
        (temporary / 'kernel.img').write_bytes(kernel)
        copy_verified(args.rootfs, temporary / 'rootfs.img', args.rootfs_sha256)
        check_rootfs(temporary / 'rootfs.img', args.mac, debugfs)
        (temporary / 'TR100-Linux.xml').write_bytes(make_xml())
        manifest = {'schema': 1, 'private_device_package': True, 'target_mac': args.mac.lower(),
                    'loader_sha256': LOADER_SHA, 'factory_prefix_sha256': args.prefix_sha256,
                    'layout': MAP, 'disk_bytes': 7456 * MIB, 'writes': ['bootargs', 'kernel', 'rootfs'],
                    'preserves': ['fastboot', 'deviceinfo', 'atf', 'baseparam', 'pqparam'],
                    'hitool_hardware_flash_tested': False,
                    'files': {p.name: {'bytes': p.stat().st_size, 'sha256': sha(p)}
                              for p in sorted(temporary.iterdir())}}
        (temporary / 'package-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
        (temporary / 'README.txt').write_text(
            'TR100 HiTool 私人烧录包\n仅用于生成该包的目标盒子，不要分发给其他机器。\n'
            '将本目录放到 NTFS/exFAT 的英文短路径；rootfs.img 超过 4 GiB。\n'
            '在支持该设备的 HiTool 中导入 TR100-Linux.xml，只应勾选 bootargs、kernel、rootfs。\n'
            '不要使用擦除整片/全盘选项。HiTool 对大于 4 GiB 镜像的支持仍需实测。\n'
            '若工具没有自动关联文件，在对应行选择同目录的 .img，不能勾选空白的保护分区。\n'
            '会清空旧系统数据；先保存目标机原厂备份。TTL 与网线仍需连接。\n'
            '已完成离线检查；尚未用 HiTool 在实体设备烧写验证。\n', encoding='utf-8')
        (temporary / 'SHA256SUMS').write_text(''.join(
            sha(p) + '  ' + p.name + '\n' for p in sorted(temporary.iterdir()) if p.is_file()))
        temporary.rename(args.output)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('prefix', 'kernel', 'rootfs'):
        parser.add_argument('--' + name, type=Path, required=True)
        parser.add_argument('--' + name + '-sha256', required=True)
    parser.add_argument('--mac', required=True)
    parser.add_argument('--debugfs', default='debugfs')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    try:
        package(args)
        print('HiTool package created; private device identity retained. Hardware flashing not performed.')
    except (ValueError, OSError, KeyError, struct.error, UnicodeError, subprocess.CalledProcessError) as error:
        parser.exit(1, 'hitool: ' + str(error) + '\n')


if __name__ == '__main__':
    main()
