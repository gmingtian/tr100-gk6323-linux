#!/usr/bin/env python3
"""Restore the exact public kernel/SDK baseline, then apply TR100 patches.

Only committed Git objects are exported; supplied working-tree changes are ignored.
No board access or installation is performed.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
import subprocess
import tarfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]


def run(args, **kwargs):
    print('+', ' '.join(map(str, args)), flush=True)
    return subprocess.run(list(map(str, args)), check=True, **kwargs)


def require_empty(path):
    path = Path(path)
    if path.exists() and (not path.is_dir() or any(path.iterdir())):
        raise ValueError(f'destination must be empty: {path}')
    path.mkdir(parents=True, exist_ok=True)


def sha256(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def export_git(repository, commit, destination, subdir=None, paths=()):
    if not re.fullmatch(r'[0-9a-f]{40}', commit):
        raise ValueError('commit must be a full 40-character SHA-1')
    repository, destination = Path(repository).resolve(), Path(destination).resolve()
    require_empty(destination)
    actual = subprocess.check_output(
        ['git', '-C', str(repository), 'rev-parse', '--verify', commit + '^{commit}'], text=True).strip()
    if actual != commit:
        raise ValueError('source commit mismatch')
    tree = commit + (':' + subdir if subdir else '')
    def archive_tree(treeish, target):
        target.mkdir(parents=True, exist_ok=True)
        process = subprocess.Popen(['git', '-C', str(repository), 'archive', treeish], stdout=subprocess.PIPE)
        try:
            with tarfile.open(fileobj=process.stdout, mode='r|') as archive:
                archive.extractall(target, filter='data')
        finally:
            process.stdout.close()
            status = process.wait()
        if status:
            raise subprocess.CalledProcessError(status, process.args)
    if not paths:
        archive_tree(tree, destination)
        return
    # git archive prefetches every blob of a partial-clone tree, even with a
    # pathspec. Export selected subtrees individually so offline SDK checkouts
    # do not need unrelated Android libraries, toolchains or firmware blobs.
    for name in paths:
        relative = Path(name)
        if relative.is_absolute() or '..' in relative.parts:
            raise ValueError('unsafe Git export path')
        kind = subprocess.check_output(['git', '-C', str(repository), 'cat-file', '-t', tree + ('/' if ':' in tree else ':') + name], text=True).strip()
        target = destination / relative
        if kind == 'tree':
            archive_tree(tree + '/' + name if ':' in tree else tree + ':' + name, target)
        elif kind == 'blob':
            target.parent.mkdir(parents=True, exist_ok=True)
            data = subprocess.check_output(['git', '-C', str(repository), 'show', tree + ( '/' if ':' in tree else ':' ) + name])
            entry = subprocess.check_output(['git', '-C', str(repository), 'ls-tree', tree, '--', name], text=True)
            if entry.startswith('120000'):
                target.symlink_to(data.decode())
            else:
                target.write_bytes(data)
                target.chmod(0o755 if entry.startswith('100755') else 0o644)
        else:
            raise ValueError('unsupported Git object: ' + name)


def apply_patch(tree, patch):
    # git apply performs a whole-patch check before writing, and rejects fuzz/reject files.
    env = os.environ.copy()
    for key in ('GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'):
        env.pop(key, None)
    env['GIT_CEILING_DIRECTORIES'] = str(Path(tree).resolve().parent)
    run(['git', 'apply', '--whitespace=nowarn', str(Path(patch).resolve())], cwd=tree, env=env)


def source_repository(kind, entry, supplied, cache):
    if supplied:
        return Path(supplied).resolve()
    repository = cache / (kind + '.git')
    if not repository.exists():
        run(['git', 'init', '--bare', repository])
    found = subprocess.run(['git', '-C', str(repository), 'cat-file', '-e', entry['commit'] + '^{commit}'],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
    if not found:
        run(['git', '-C', repository, 'fetch', '--depth=1', entry['url'], entry['commit']])
    return repository


def prepare_into(args, sources):
    lock = json.loads((HERE / 'sources.json').read_text())
    work = args.work_dir.resolve()
    cache = work / 'downloads'
    cache.mkdir(parents=True, exist_ok=True)
    for kind in ('kernel', 'vendor', 'sdk', 'onboard'):
        entry = lock[kind]
        repository = source_repository(kind, entry, getattr(args, kind + '_repo', None), cache)
        export_git(repository, entry['commit'], sources / kind, entry.get('subdir'), entry.get('paths', ()))
    for entry in lock['usb_wifi']:
        kind = entry['name']
        supplied = args.usb_repos / kind if args.usb_repos else None
        repository = source_repository(kind, entry, supplied, cache)
        destination = sources / 'usb-wifi' / kind
        export_git(repository, entry['commit'], destination)
        if sha256(destination / entry['license_source']) != entry['license_sha256']:
            raise ValueError('USB driver license mismatch: ' + kind)
    platform = sources / 'platform'
    platform.mkdir()
    for patch in sorted((sources / 'vendor/linux/patches').glob('*.patch')):
        apply_patch(platform, patch)
    for name, digest in lock['checksums'].items():
        if sha256(sources / name) != digest:
            raise ValueError(f'upstream patch checksum mismatch: {name}')
    sequence = [
        ('onboard', ROOT / 'arm64/onboard-wifi/uwe5621-tr100.patch'),
        ('kernel', sources / 'vendor/linux/linux-5.10/00000_kernel_linux-5.10.patch'),
        ('kernel', platform / 'linux-5.10/gk6323_patch/kernel.patch'),
        ('kernel', HERE / 'kernel-securec.patch'),
        ('kernel', ROOT / 'arm64/patches/kernel-arm64.patch'),
        ('kernel', ROOT / 'arm64/patches/wifi-native-pwrseq.patch'),
        ('sdk', HERE / 'sdk-modules.patch'),
        ('sdk', ROOT / 'hdmi/patches/mmz-vm-mmap-for-native-modules.patch'),
        ('sdk', ROOT / 'hdmi/patches/idle-background-waits.patch'),
        ('sdk', ROOT / 'arm64/patches/display-arm64.patch'),
    ]
    applied = []
    for kind, patch in sequence:
        apply_patch(sources / kind, patch)
        # Record relative names only; manifests remain movable between machines.
        name = str(patch.relative_to(sources) if patch.is_relative_to(sources) else patch.relative_to(ROOT))
        applied.append({'tree': kind, 'path': name, 'sha256': sha256(patch)})
    manifest = {'schema': 1, 'upstream': lock, 'patches': applied}
    (sources / 'source-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(f'Prepared pinned kernel, SDK and all radio sources in {sources}')


def prepare(args):
    destination = args.work_dir.resolve() / 'sources'
    require_empty(destination)
    temporary = Path(tempfile.mkdtemp(prefix='.sources-', dir=destination.parent))
    try:
        prepare_into(args, temporary)
        destination.rmdir()
        temporary.rename(destination)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--work-dir', type=Path, default=ROOT / '.work/arm64')
    for kind in ('kernel', 'vendor', 'sdk', 'onboard'):
        parser.add_argument('--' + kind + '-repo', type=Path,
                            help='optional existing Git repository (exports pinned objects, ignores working tree)')
    parser.add_argument('--usb-repos', type=Path, help='optional directory containing pinned USB Git repositories')
    args = parser.parse_args()
    try:
        prepare(args)
    except (ValueError, OSError, subprocess.CalledProcessError, tarfile.TarError) as error:
        parser.exit(1, f'prepare: {error}\n')

if __name__ == '__main__':
    main()
