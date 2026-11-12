#!/usr/bin/env python3
"""Download public TR100 release assets with exact size and SHA256 verification."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import urllib.request

REPOSITORY = 'gmingtian/tr100-gk6323-linux'
MAX_ASSET_BYTES = 16 * 1024**3

def validate_tag(tag):
    if not isinstance(tag,str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,100}',tag) or '..' in tag:
        raise ValueError('Invalid release tag')
    return tag

def validate_manifest(manifest):
    if not isinstance(manifest,dict) or manifest.get('schema_version') != 1:
        raise ValueError('Unsupported release manifest')
    tag=validate_tag(manifest.get('tag'))
    assets=manifest.get('assets')
    if not isinstance(assets,list) or not assets:
        raise ValueError('Manifest has no assets')
    seen=set()
    for asset in assets:
        if not isinstance(asset,dict):raise ValueError('Invalid asset')
        name=asset.get('name')
        if not isinstance(name,str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*',name) or '..' in name or name in seen:
            raise ValueError('Unsafe or duplicate asset name')
        seen.add(name)
        size=asset.get('bytes')
        if type(size) is not int or not 0<size<=MAX_ASSET_BYTES:
            raise ValueError('Invalid asset size')
        if not isinstance(asset.get('sha256'),str) or not re.fullmatch(r'[0-9a-f]{64}',asset['sha256']):
            raise ValueError('Invalid SHA256')
        expected=f'https://github.com/{REPOSITORY}/releases/download/{tag}/{name}'
        if asset.get('url') != expected:raise ValueError('Asset URL does not match the official repository/tag')
    return manifest

def copy_verified(stream,destination,expected_bytes,expected_sha256):
    destination=Path(destination)
    partial=destination.with_name(destination.name+'.part')
    digest=hashlib.sha256();count=0;created=False
    try:
        with partial.open('xb') as output:
            created=True
            while True:
                chunk=stream.read(1024*1024)
                if not chunk:break
                count+=len(chunk)
                if count>expected_bytes:raise ValueError('Downloaded asset exceeds its declared size')
                output.write(chunk);digest.update(chunk)
            if count!=expected_bytes or digest.hexdigest()!=expected_sha256:
                raise ValueError('Asset size or SHA256 mismatch')
            output.flush();os.fsync(output.fileno())
        os.replace(partial,destination)
    except BaseException:
        if created:partial.unlink(missing_ok=True)
        raise

def open_public(url):
    request=urllib.request.Request(url,headers={'User-Agent':'tr100-release-downloader/1','Accept':'application/vnd.github+json'})
    response=urllib.request.urlopen(request,timeout=90)
    if not response.url.startswith('https://'):
        response.close();raise ValueError('Refused non-HTTPS redirect')
    return response

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--tag',default='latest',help='Release tag, or latest (default)')
    parser.add_argument('--output',type=Path,default=Path('tr100-downloads'))
    parser.add_argument('--only',action='append',help='Download only this asset name; repeat as needed')
    args=parser.parse_args()
    tag=args.tag
    if tag=='latest':
        with open_public(f'https://api.github.com/repos/{REPOSITORY}/releases/latest') as response:
            tag=json.load(response)['tag_name']
    validate_tag(tag)
    url=f'https://github.com/{REPOSITORY}/releases/download/{tag}/release-manifest.json'
    with open_public(url) as response:
        raw=response.read(1024*1024+1)
    if len(raw)>1024*1024:raise ValueError('Manifest is too large')
    manifest=validate_manifest(json.loads(raw))
    if manifest['tag']!=tag:raise ValueError('Manifest tag mismatch')
    requested=set(args.only or [])
    if requested-set(x['name'] for x in manifest['assets']):raise ValueError('Unknown requested asset')
    args.output.mkdir(parents=True,exist_ok=True)
    for asset in manifest['assets']:
        if requested and asset['name'] not in requested:continue
        target=args.output/asset['name']
        if target.is_symlink():raise ValueError(f'Refused symlink: {target}')
        if target.exists():
            if target.is_file() and target.stat().st_size==asset['bytes'] and hashlib.file_digest(target.open('rb'),'sha256').hexdigest()==asset['sha256']:
                print(f'VERIFIED_CACHE {asset["name"]}');continue
            raise ValueError(f'Existing file differs; move it aside before retrying: {target}')
        print(f'DOWNLOADING {asset["name"]}',flush=True)
        with open_public(asset['url']) as response:
            copy_verified(response,target,asset['bytes'],asset['sha256'])
        print(f'VERIFIED {asset["name"]}')
    (args.output/'release-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    print('Downloads verified. Personalize the local images before installation; see arm64/QUICKSTART.md.')

if __name__=='__main__':
    try:main()
    except (ValueError,OSError,KeyError) as error:
        raise SystemExit(f'ERROR: {error}')
