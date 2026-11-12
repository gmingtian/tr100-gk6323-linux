#!/usr/bin/env python3
"""Build all five pinned radio drivers and their complete firmware overlay."""
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
MODULES = ('uwe5621_bsp_sdio', 'sprdwl_ng', '8851bu', '8821cu', '88x2bu', '88XXau')


def stage_factory(factory, stage):
    lock = json.loads((ROOT / 'radio/factory-firmware.json').read_text())
    payloads = {}
    for name, item in lock['files'].items():
        path = Path(factory) / name
        if not path.is_file():
            raise ValueError('missing factory firmware: ' + str(path))
        data = path.read_bytes()
        if len(data) != item['bytes'] or hashlib.sha256(data).hexdigest() != item['sha256']:
            raise ValueError('factory firmware checksum/size mismatch: ' + name)
        payloads[name] = data
    for name, data in payloads.items():
        target = stage / 'usr/lib/firmware/unisoc' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    doc = stage / 'usr/share/doc/tr100-radio'
    doc.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(ROOT / 'radio/factory-firmware.json', doc / 'factory-firmware.json')


def build(sources, obj, extra, stage, factory, cache, base, env, run, offline=False):
    # Validate mandatory non-public inputs before compiling or staging anything.
    stage_factory(factory, stage)
    spec = importlib.util.spec_from_file_location('tr100_firmware', ROOT / 'usb-firmware/fetch_firmware.py')
    firmware = importlib.util.module_from_spec(spec); spec.loader.exec_module(firmware)
    from types import SimpleNamespace
    with tempfile.TemporaryDirectory(prefix='official-firmware-', dir=stage.parent) as temporary:
        official = Path(temporary)
        firmware.run(SimpleNamespace(stage=official, cache=cache, offline=offline,
                                     verify_only=False, archive=False))
        shutil.copytree(official, stage, dirs_exist_ok=True)
    common = ['CFG_GK_WIFI_DEVICE_UWE5621=y', 'TR100_NATIVE_SDIO=y', 'TARGET_BUILD_VARIANT=user']
    onboard = sources / 'onboard'
    for part in ('BSP', 'WIFI'):
        run([*base, 'M=' + str(onboard / part), *common,
             'UNISOC_WIFI_CUS_CONFIG=/lib/firmware/unisoc/',
             'UNISOC_WIFI_MAC_FILE=/var/lib/tr100/wifimac.txt', 'modules'], env=env)
    artifacts = [onboard / 'BSP/uwe5621_bsp_sdio.ko', onboard / 'WIFI/sprdwl_ng.ko']
    lock = json.loads((ROOT / 'build/sources.json').read_text())
    release = (obj / 'include/config/kernel.release').read_text().strip()
    licenses = stage / 'usr/share/licenses/tr100-radio'
    licenses.mkdir(parents=True, exist_ok=True)
    doc = stage / 'usr/share/doc/tr100-radio'
    shutil.copyfile(ROOT / 'build/sources.json', doc / 'sources.json')
    for entry in lock['usb_wifi']:
        name = entry['name']; source = sources / 'usb-wifi' / name
        platform = 'CONFIG_PLATFORM_AUTODETECT=y' if name in ('8821cu-20210916', '88x2bu-20210702') else 'CONFIG_PLATFORM_I386_PC=y'
        # Use the tested vendor wrapper, with explicit target and no DKMS/install hooks.
        variables = [x for x in base if str(x).startswith(('ARCH=', 'CROSS_COMPILE=', 'CC=', '-j'))]
        run(['make', '-C', source, *variables, 'KSRC=' + str(obj), 'KVER=' + release,
             'CCACHE=', platform], env=env)
        artifacts.append(source / (entry['module'] + '.ko'))
        shutil.copyfile(source / entry['license_source'], licenses / (name + '.LICENSE'))
        if name == 'rtl8851bu':
            for filename in ('TXPWR_ByRate.txt', 'TXPWR_LMT.txt'):
                shutil.copyfile(source / 'powertable' / filename, stage / 'usr/lib/firmware' / filename)
    for artifact in artifacts:
        if not artifact.is_file() or not artifact.stat().st_size:
            raise ValueError('required radio module missing: ' + str(artifact))
        magic = subprocess.check_output(['modinfo', '-F', 'vermagic', str(artifact)], text=True).strip()
        if not magic.startswith(release + ' '):
            raise ValueError('radio module vermagic mismatch: ' + str(artifact))
        shutil.copyfile(artifact, extra / artifact.name)
    (doc / 'onboard-source-license.txt').write_text(
        'CoreELEC/uwe5631-aml has no top-level LICENSE; source headers and MODULE_LICENSE identify GPL v2. '
        'The source URL and exact commit are recorded in sources.json. Factory firmware is a separately supplied ROM input.\n')
