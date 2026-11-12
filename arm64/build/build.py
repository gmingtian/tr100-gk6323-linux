#!/usr/bin/env python3
"""Build the prepared TR100 ARM64 kernel, initramfs and all tested modules."""
import argparse
from datetime import datetime, timezone
import gzip
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import tarfile
import tempfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
SDK_MODULES = ('gk_common', 'gk_mmz', 'gk_media', 'gk_pdm', 'gk_pq', 'gk_vou', 'gfbg', 'gk_tde', 'gk_hdmi')


def run(command, **kwargs):
    print('+', ' '.join(map(str, command)), flush=True)
    return subprocess.run(list(map(str, command)), check=True, **kwargs)


def sha256(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def make_path(path):
    path = Path(path).resolve()
    if any(c.isspace() for c in str(path)):
        raise ValueError(f'Linux Kbuild paths cannot contain whitespace: {path}')
    return path


def validate_static_arm64(path):
    data = Path(path).read_bytes()
    if len(data) < 64 or data[:6] != b'\x7fELF\x02\x01' or struct.unpack_from('<H', data, 18)[0] != 183:
        raise ValueError('BusyBox must be an ELF64 little-endian AArch64 binary')
    if struct.unpack_from('<H', data, 16)[0] not in (2, 3):
        raise ValueError('BusyBox must be an executable ELF')
    offset = struct.unpack_from('<Q', data, 32)[0]
    size, count = struct.unpack_from('<HH', data, 54)
    if not count or size < 56 or offset + size * count > len(data):
        raise ValueError('BusyBox has a malformed ELF program header table')
    for index in range(count):
        kind = struct.unpack_from('<I', data, offset + index * size)[0]
        if kind in (2, 3):
            raise ValueError('BusyBox must be static (no PT_DYNAMIC or PT_INTERP)')


def configure_initramfs(config, source):
    replacements = {'CONFIG_INITRAMFS_SOURCE': '"' + str(source) + '"',
                    'CONFIG_INITRAMFS_ROOT_UID': '0', 'CONFIG_INITRAMFS_ROOT_GID': '0'}
    lines = [line for line in config.splitlines() if line.split('=', 1)[0] not in replacements]
    lines.extend(key + '=' + value for key, value in replacements.items())
    return '\n'.join(lines) + '\n'


def build_into(args, out):
    work = make_path(args.work_dir)
    sources = work / 'sources'
    source_manifest = sources / 'source-manifest.json'
    if not source_manifest.is_file():
        raise ValueError('run prepare.py first; source-manifest.json is missing')
    busybox = args.busybox.resolve()
    validate_static_arm64(busybox)
    if args.source_date_epoch is None or args.source_date_epoch < 0:
        raise ValueError('set SOURCE_DATE_EPOCH or --source-date-epoch to a nonnegative Unix timestamp')
    if args.jobs < 1:
        raise ValueError('--jobs must be positive')
    cc = args.cc or args.cross_compile + 'gcc'
    compiler = subprocess.check_output([cc, '--version'], text=True).splitlines()[0]
    target = subprocess.check_output([cc, '-dumpmachine'], text=True).strip()
    version = subprocess.check_output([cc, '-dumpversion'], text=True).strip()
    if not target.startswith('aarch64') or version.split('.')[0] != '11':
        raise ValueError('the tested build requires GCC 11 targeting aarch64; use --cc and --cross-compile')
    for tool in ('make', 'gcc', 'bison', 'flex', 'perl', 'depmod', 'modinfo', 'openssl'):
        if not shutil.which(tool):
            raise ValueError(f'missing build dependency: {tool}')
    kernel, sdk = sources / 'kernel', sources / 'sdk'
    obj = work / 'kernel-out'
    obj.mkdir(parents=True, exist_ok=True)
    out.mkdir(parents=True, exist_ok=True)
    initramfs = work / 'initramfs'
    (initramfs / 'bin').mkdir(parents=True, exist_ok=True)
    shutil.copyfile(busybox, initramfs / 'bin/busybox')
    run([cc, '-nostdlib', '-static', '-Wl,--build-id=none', ROOT / 'arm64/tests/probe64.S',
         '-o', initramfs / 'bin/probe64'])
    shutil.copyfile(ROOT / 'arm64/init', initramfs / 'init')
    listing = work / 'initramfs.list'
    content = [f'dir /{name} 0755 0 0' for name in ('bin', 'dev', 'dev/pts', 'dev/shm', 'proc', 'sys', 'run', 'newroot')]
    content += [f'file /{name} {initramfs / name} 0755 0 0' for name in ('init', 'bin/busybox', 'bin/probe64')]
    content += ['nod /dev/console 0600 0 0 c 5 1', 'nod /dev/null 0666 0 0 c 1 3']
    listing.write_text('\n'.join(content) + '\n')
    (obj / '.config').write_text(configure_initramfs((ROOT / 'arm64/kernel.config').read_text(), listing))
    env = os.environ.copy()
    env.update({'SOURCE_DATE_EPOCH': str(args.source_date_epoch), 'KBUILD_BUILD_USER': 'builder',
                'KBUILD_BUILD_HOST': 'tr100', 'KBUILD_BUILD_VERSION': '1',
                'KBUILD_BUILD_TIMESTAMP': datetime.fromtimestamp(args.source_date_epoch, timezone.utc).strftime('%a %b %d %H:%M:%S UTC %Y')})
    base = ['make', '-C', kernel, '-j' + str(args.jobs), 'O=' + str(obj), 'ARCH=arm64',
            'CROSS_COMPILE=' + args.cross_compile, 'CC=' + cc]
    if args.host_cflags:
        base.append('HOSTCFLAGS=' + args.host_cflags)
    if args.host_ldflags:
        base.append('HOSTLDFLAGS=' + args.host_ldflags)
    def make(*items):
        run([*base, *items], env=env)
    make('olddefconfig')
    config = (obj / '.config').read_text()
    required = ('CONFIG_COMPAT=y', 'CONFIG_COMPAT_32BIT_TIME=y', 'CONFIG_TUN=y',
                'CONFIG_BASE_FULL=y', 'CONFIG_BASE_SMALL=0', 'CONFIG_OVERLAY_FS=y',
                'CONFIG_CGROUPS=y', 'CONFIG_VETH=y')
    missing = [option for option in required if option not in config.splitlines()]
    if missing:
        raise ValueError('Kconfig dropped required options: ' + ', '.join(missing))
    make('Image', 'modules', 'scripts')
    release = (obj / 'include/config/kernel.release').read_text().strip()
    # Reject unexpected release strings before using them as filesystem components.
    if not re.fullmatch(r'5\.10\.165_gk6323-tr100-arm64(?:-kvm)?', release):
        raise ValueError(f'unexpected kernel release: {release}')
    make('modules_install', 'INSTALL_MOD_PATH=' + str(out / 'modules/usr'), 'DEPMOD=true')
    # The public SDK derives some include paths from a source/kernel symlink.
    link = sdk / 'source/kernel/linux-5.10.y'
    link.parent.mkdir(parents=True, exist_ok=True)
    if link.is_symlink():
        link.unlink()
    elif link.exists():
        raise ValueError(f'expected absent SDK kernel link: {link}')
    link.symlink_to(kernel, target_is_directory=True)
    sdk_args = ['SDK_DIR=' + str(sdk), 'GK_LINUX_ENV=ok', 'GK_DRV_BUILDTYPE=m',
                'GK_OUT_DIR=' + str(sdk / 'build-out'), 'GK_RAMDISK_ROOT_DIR=' + str(sdk / 'ramdisk'),
                'CFG_GK_CPU_ARCH=arm64', 'CFG_GK_64BIT_SYSTEM=y', 'CFG_GK_USER_SPACE_LIB64=y']
    (sdk / 'build-out').mkdir(exist_ok=True)
    (sdk / 'ramdisk').mkdir(exist_ok=True)
    make('M=' + str(sdk / 'source/common/drv'), *sdk_args, 'modules')
    make('M=' + str(sdk / 'source/msp/drv'), *sdk_args,
         'KBUILD_EXTRA_SYMBOLS=' + str(sdk / 'source/common/drv/Module.symvers'),
         'objects=pdm pq vo gfbg tde hdmi', 'modules')
    sensor = work / 'sensor'
    sensor.mkdir(exist_ok=True)
    for name in ('Makefile', 'tr100_tsensor.c', 'gk6323-temp.h'):
        shutil.copyfile(ROOT / 'arm64/temperature' / name, sensor / name)
    make('M=' + str(sensor), 'modules')
    extra = out / 'modules/usr/lib/modules' / release / 'extra'
    extra.mkdir(parents=True, exist_ok=True)
    for name in SDK_MODULES:
        found = list((sdk / 'source').rglob(name + '.ko'))
        if len(found) != 1:
            raise ValueError(f'expected exactly one {name}.ko, got {len(found)}')
        shutil.copyfile(found[0], extra / found[0].name)
    shutil.copyfile(sensor / 'tr100_tsensor.ko', extra / 'tr100_tsensor.ko')
    spec = importlib.util.spec_from_file_location('tr100_radio', ROOT / 'arm64/radio/build_radio.py')
    radio = importlib.util.module_from_spec(spec); spec.loader.exec_module(radio)
    firmware_stage = out / 'firmware'
    radio.build(sources, obj, extra, firmware_stage, args.factory_firmware.resolve(),
                (args.firmware_cache or work / 'downloads/firmware').resolve(), base, env, run, args.offline)
    module_root = extra.parent
    # Host paths do not belong in a downloadable runtime module tree.
    for name in ('source', 'build'):
        link = module_root / name
        if link.is_symlink():
            link.unlink()
    (out / 'modules/lib').symlink_to('usr/lib')
    run(['depmod', '-b', out / 'modules', release], env=env)
    (out / 'modules/lib').unlink()
    for source, name in ((obj / 'arch/arm64/boot/Image', 'Image'), (obj / 'vmlinux', 'vmlinux'),
                         (obj / 'System.map', 'System.map'), (obj / 'Module.symvers', 'Module.symvers'),
                         (obj / '.config', 'kernel.config'), (obj / 'scripts/dtc/dtc', 'dtc'),
                         (source_manifest, 'source-manifest.json')):
        shutil.copyfile(source, out / name)
    (out / 'dtc').chmod(0o755)
    (out / 'kernel.release').write_text(release + '\n')
    # Stable archive ownership, member ordering, timestamps, gzip filename and mtime.
    with (out / 'modules.tar.gz').open('wb') as raw:
        with gzip.GzipFile(filename='', fileobj=raw, mode='wb', mtime=args.source_date_epoch) as zipped:
            with tarfile.open(fileobj=zipped, mode='w|', format=tarfile.PAX_FORMAT) as archive:
                for path in sorted((out / 'modules').rglob('*')):
                    info = archive.gettarinfo(str(path), str(path.relative_to(out / 'modules')))
                    info.uid = info.gid = 0
                    info.uname = info.gname = 'root'
                    info.mtime = args.source_date_epoch
                    if path.is_file():
                        with path.open('rb') as stream:
                            archive.addfile(info, stream)
                    else:
                        archive.addfile(info)
    firmware_spec = importlib.util.spec_from_file_location('tr100_firmware_archive', ROOT / 'arm64/usb-firmware/fetch_firmware.py')
    firmware_tool = importlib.util.module_from_spec(firmware_spec); firmware_spec.loader.exec_module(firmware_tool)
    firmware_tool.make_archive(firmware_stage, out / 'firmware.tar.gz', args.source_date_epoch)
    manifest = {'schema': 1, 'kernel_release': release, 'source_date_epoch': args.source_date_epoch,
                'compiler': compiler, 'compiler_target': target, 'busybox_sha256': sha256(busybox),
                'sdk_modules': list(SDK_MODULES), 'sensor_module': 'tr100_tsensor', 'radio_modules': list(radio.MODULES),
                'files': {path.name: sha256(path) for path in sorted(out.iterdir()) if path.is_file()}}
    (out / 'build-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(f'Build complete: {out}')


def build(args):
    work = make_path(args.work_dir)
    out = make_path(args.output or work / 'output')
    if out.exists() and (not out.is_dir() or any(out.iterdir())):
        raise ValueError(f'output directory must be empty: {out}')
    out.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix='.output-', dir=out.parent))
    try:
        build_into(args, temporary)
        if out.exists():
            out.rmdir()
        temporary.rename(out)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--work-dir', type=Path, default=ROOT / '.work/arm64')
    parser.add_argument('--output', type=Path)
    parser.add_argument('--busybox', type=Path, required=True, help='static ELF64 AArch64 BusyBox executable')
    parser.add_argument('--cross-compile', default=os.environ.get('CROSS_COMPILE', 'aarch64-linux-gnu-'))
    parser.add_argument('--cc', default=os.environ.get('CC'))
    parser.add_argument('--host-cflags', default=os.environ.get('HOSTCFLAGS', ''))
    parser.add_argument('--host-ldflags', default=os.environ.get('HOSTLDFLAGS', ''))
    parser.add_argument('--jobs', type=int, default=min(8, os.cpu_count() or 1))
    parser.add_argument('--source-date-epoch', type=int, default=os.environ.get('SOURCE_DATE_EPOCH'))
    parser.add_argument('--factory-firmware', type=Path, required=True, help='ROM firmware directory containing the two files locked in arm64/radio/factory-firmware.json')
    parser.add_argument('--firmware-cache', type=Path, help='optional verified firmware cache')
    parser.add_argument('--offline', action='store_true', help='require all firmware resources in local cache')
    args = parser.parse_args()
    try:
        build(args)
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        parser.exit(1, f'build: {error}\n')

if __name__ == '__main__':
    main()
