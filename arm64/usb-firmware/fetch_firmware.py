#!/usr/bin/env python3
"""Download and verify the locked USB firmware; never install on the host."""
import argparse
import base64
import gzip
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import tarfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parent


def relative_path(value):
    path = PurePosixPath(value)
    if path.is_absolute() or '..' in path.parts or not path.parts or '\\' in value:
        raise ValueError('unsafe relative path: ' + value)
    return path


def verify(data, metadata, label):
    if len(data) != metadata['bytes'] or hashlib.sha256(data).hexdigest() != metadata['sha256']:
        raise ValueError('checksum/size mismatch: ' + label)


def obtain(resource, cache, offline=False):
    digest = resource['sha256']
    if not re.fullmatch('[0-9a-f]{64}', digest):
        raise ValueError('invalid locked SHA256')
    target = cache / digest
    if target.is_symlink():
        raise ValueError('cache symlinks are not accepted')
    if target.exists():
        data = target.read_bytes()
    else:
        if offline:
            raise ValueError('missing cached resource: ' + resource['url'])
        if not resource['url'].startswith('https://'):
            raise ValueError('downloads require HTTPS')
        for attempt in range(3):
            try:
                request = urllib.request.Request(resource['url'], headers={'User-Agent':'tr100-firmware-reproducer/1'})
                with urllib.request.urlopen(request, timeout=60) as response:
                    data = response.read(resource['bytes'] * 2 + 1024)
                if 'format=TEXT' in resource['url']:
                    data = base64.b64decode(data.strip(), validate=True)
                break
            except OSError:
                if attempt == 2:
                    raise
                time.sleep(2)
        verify(data, resource, resource['url'])
        cache.mkdir(parents=True, exist_ok=True)
        temporary = target.with_suffix('.part')
        temporary.write_bytes(data)
        temporary.replace(target)
    verify(data, resource, str(target))
    return data


def make_archive(stage, destination, epoch):
    with destination.open('wb') as output:
        with gzip.GzipFile(fileobj=output, mode='wb', filename='', mtime=epoch, compresslevel=9) as compressed:
            with tarfile.open(fileobj=compressed, mode='w', format=tarfile.PAX_FORMAT) as archive:
                for path in sorted(stage.rglob('*')):
                    if path.is_symlink():
                        raise ValueError('staging symlinks are not accepted')
                    if not path.is_file():
                        continue
                    data = path.read_bytes()
                    member = tarfile.TarInfo(path.relative_to(stage).as_posix())
                    member.size = len(data)
                    member.mtime = epoch
                    member.mode = 0o644
                    member.uid = member.gid = 0
                    member.uname = member.gname = 'root'
                    archive.addfile(member, io.BytesIO(data))


def verify_regdb(root, stage, lock):
    trust = root / relative_path(lock['regdb']['trusted_certificate_file'])
    digest = hashlib.sha256(trust.read_bytes()).hexdigest()
    if digest != lock['regdb']['trusted_certificate_sha256']:
        raise ValueError('trusted kernel regulatory certificate checksum mismatch')
    # -nointern requires the signer to be in this exact, hash-pinned kernel
    # certificate set. Certificate expiry is ignored as in kernel PKCS#7
    # verification; detached-content signature verification remains enabled.
    command = ['openssl', 'cms', '-verify', '-binary', '-inform', 'DER',
               '-in', str(stage/'usr/lib/firmware/regulatory.db.p7s'),
               '-content', str(stage/'usr/lib/firmware/regulatory.db'),
               '-certfile', str(trust), '-CAfile', str(trust), '-nointern',
               '-purpose', 'any', '-no_check_time']
    result = subprocess.run(command, capture_output=True)
    if result.returncode:
        raise ValueError('regulatory signature verification failed: ' + result.stderr.decode(errors='replace'))
    return result.stderr.decode().strip()


def safe_target(stage, value):
    target = stage / relative_path(value)
    for path in (stage, *target.parents, target):
        if path.is_symlink():
            raise ValueError('staging path contains a symlink: ' + str(path))
    return target


def check_selected_files(stage, expected):
    actual = {path.relative_to(stage).as_posix() for path in stage.rglob('*') if path.is_file()}
    extra = actual - expected
    if extra:
        raise ValueError('unlisted staging files: ' + ', '.join(sorted(extra)))


def run(args):
    lock = json.loads((ROOT/'firmware-lock.json').read_text())
    stage, cache = args.stage.resolve(), args.cache.resolve()
    payloads = {name: obtain(resource, cache, args.offline or args.verify_only)
                for name, resource in lock['resources'].items()}
    expected = {}
    for item in lock['files']:
        target = safe_target(stage, item['path'])
        if item['path'] in expected:
            raise ValueError('duplicate output path')
        data = payloads[item['resource']]
        if 'member' in item:
            relative_path(item['member'])
            with tarfile.open(fileobj=io.BytesIO(data)) as source:
                member = source.getmember(item['member'])
                if not member.isfile():
                    raise ValueError('source archive member must be a regular file')
                data = source.extractfile(member).read()
        verify(data, item, item['path'])
        expected[item['path']] = item['sha256']
        if args.verify_only:
            verify(target.read_bytes(), item, item['path'])
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
    signature = verify_regdb(ROOT, stage, lock)
    if not args.verify_only:
        doc = stage/'usr/share/doc/tr100-usb-firmware'
        doc.mkdir(parents=True, exist_ok=True)
        for name in ('firmware-lock.json', 'README.md'):
            (doc/name).write_bytes((ROOT/name).read_bytes())
        (doc/'regdb-kernel-trust.pem').write_bytes((ROOT/lock['regdb']['trusted_certificate_file']).read_bytes())
        (doc/'regdb-signature.txt').write_text(signature+'\n')
    doc_files = {'usr/share/doc/tr100-usb-firmware/' + name for name in
                 ('firmware-lock.json', 'README.md', 'regdb-kernel-trust.pem', 'regdb-signature.txt')}
    check_selected_files(stage, set(expected) | doc_files)
    if args.archive:
        destination = args.archive_path.resolve()
        make_archive(stage, destination, lock['source_date_epoch'])
        print(destination.name, destination.stat().st_size,
              hashlib.sha256(destination.read_bytes()).hexdigest())
    print(json.dumps({'selected_payload_files':len(expected), 'regdb_signature':signature,
                      'installed_on_host':False}, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--offline', action='store_true', help='use the verified local cache only')
    parser.add_argument('--verify-only', action='store_true', help='verify cache, staged files, and regulatory signature without writes')
    parser.add_argument('--archive', action='store_true', help='also produce a deterministic rootfs overlay tar.gz')
    parser.add_argument('--stage', type=Path, default=ROOT/'rootfs')
    parser.add_argument('--cache', type=Path, default=ROOT/'cache')
    parser.add_argument('--archive-path', type=Path, default=ROOT/'tr100-usb-firmware-rootfs.tar.gz')
    args = parser.parse_args()
    if args.verify_only and args.archive:
        parser.error('--verify-only cannot be combined with --archive')
    try:
        run(args)
    except (ValueError, OSError, KeyError, tarfile.TarError) as error:
        parser.exit(1, str(error)+'\n')


if __name__ == '__main__':
    main()
