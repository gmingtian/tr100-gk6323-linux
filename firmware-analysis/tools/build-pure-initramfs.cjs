'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const {repackAndroidBoot} = require('./build-initramfs.cjs');
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
const LIMIT = 10485760;
function buildPureInitramfs({busyboxPath, initPath, policyPath, factoryBootPath}) {
  const busybox = fs.readFileSync(busyboxPath), factory = fs.readFileSync(factoryBootPath);
  if (busybox.length < 52 || busybox.toString('hex', 0, 4) !== '7f454c46' || busybox[4] !== 1 || busybox[5] !== 1 || busybox.readUInt16LE(18) !== 40)
    throw Error('Expected little-endian ARM32 static BusyBox');
  if (busybox.length !== 1284688 || sha256(busybox) !== '9b89dbebc390b4b9174a449df18b422892387bf35717a63cf1e0aef5b4e8dcfe') throw Error('Untrusted static BusyBox SHA256/length');
  const phoff = busybox.readUInt32LE(28), stride = busybox.readUInt16LE(42), count = busybox.readUInt16LE(44);
  if (stride < 32 || phoff + stride * count > busybox.length) throw Error('Invalid BusyBox program headers');
  for (let i = 0; i < count; i++) if ([2, 3].includes(busybox.readUInt32LE(phoff + i * stride)))
    throw Error('BusyBox must be static: PT_INTERP/PT_DYNAMIC forbidden');
  for (const applet of ['sh', 'mdev', 'mount', 'switch_root', 'dd', 'sha256sum', 'od', 'tr', 'stat'])
    if (!busybox.includes(Buffer.from('\0' + applet + '\0'))) throw Error('Missing BusyBox applet: ' + applet);
  const init = fs.readFileSync(initPath), policy = fs.readFileSync(policyPath);
  for (const [name, bytes] of [['init', init], ['policy', policy]])
    if (!bytes.toString('utf8').startsWith('#!/bin/busybox sh\n') || bytes.includes(Buffer.from('\r\n')))
      throw Error('Expected LF static-BusyBox shell script: ' + name);
  const entries = [], parts = []; let inode = 1, bytes = 0;
  const push = b => {parts.push(b); bytes += b.length;};
  const align = n => {if (bytes % n) push(Buffer.alloc(n - bytes % n));};
  function add(name, mode, data = Buffer.alloc(0), major = 0, minor = 0) {
    if (name.startsWith('/') || name.split('/').includes('..') || name.includes('\0') || entries.some(e => e.name === name)) throw Error('Unsafe/duplicate newc path');
    if (typeof data === 'string') data = Buffer.from(data);
    const fields = [inode++, mode, 0, 0, (mode & 0xf000) === 0x4000 ? 2 : 1, 0, data.length, 0, 0, major, minor, Buffer.byteLength(name) + 1, 0];
    push(Buffer.from('070701' + fields.map(n => n.toString(16).padStart(8, '0')).join('')));
    push(Buffer.from(name + '\0')); align(4); push(data); align(4);
    entries.push({name, mode: mode.toString(8), bytes: data.length, major, minor, sha256: data.length ? sha256(data) : null});
  }
  for (const dir of ['bin', 'sbin', 'lib', 'dev', 'dev/pts', 'dev/shm', 'proc', 'sys', 'run', 'newroot']) add(dir, 0o040755);
  add('bin/busybox', 0o100755, busybox); add('init', 0o100755, init); add('lib/tr100-pure-initrd-policy.sh', 0o100755, policy);
  add('bin/sh', 0o120777, 'busybox'); add('sbin/mdev', 0o120777, '../bin/busybox');
  for (const [name, major, minor, mode] of [['console', 5, 1, 0o600], ['ttyAMA0', 204, 64, 0o600], ['null', 1, 3, 0o666]])
    add('dev/' + name, 0o020000 | mode, Buffer.alloc(0), major, minor);
  add('TRAILER!!!', 0); align(512);
  const cpio = Buffer.concat(parts), gzip = zlib.gzipSync(cpio, {level: 9});
  const boot = repackAndroidBoot(factory, gzip);
  if (boot.length > LIMIT) throw Error('Candidate exceeds 10MiB boot partition (10485760 bytes)');
  const page = factory.readUInt32LE(36), kernelSize = factory.readUInt32LE(8), kernel = factory.subarray(page, page + kernelSize);
  if (!boot.subarray(page, page + kernelSize).equals(kernel)) throw Error('Repacked candidate changed factory kernel');
  const manifest = {schemaVersion: 1, pureLinux: true, candidateOnly: true, hardwareTested: false, automaticallyInstalled: false,
    purpose: 'Pure Linux eight-part layout; only the fixed p8 ext4 root may be selected',
    defaultRootDevice: '/dev/mmcblk0p8', expectedRootDevnum: '259:0', expectedStartSectors: 86016, expectedSizeSectors: 15183872,
    expectedDiskSectors: 15269888, expectedDiskBytes: 7818182656, rootfsBytes: 7774142464, rootfsMiB: 7414,
    expectedBlkdevparts: 'blkdevparts=mmcblk0:4M(fastboot),4M(bootargs),12M(kernel),4M(deviceinfo),2M(atf),8M(baseparam),8M(pqparam),-(rootfs)', rootUUID: 'a8d4abf7-6ae4-4f9b-a39a-ef1b79c63230', imageTag: 'tr100-pure-linux-20261111',
    ramImageDownloadSupported: false, legacy800MiBAndLoopRootAccepted: false,
    kernelPartition: {device: '/dev/mmcblk0p3', devnum: '179:3', startSector: 16384, sizeSectors: 24576, sizeBytes: 12582912, bootReadStartSector: 16384, bootReadSectorCount: 20480, bootReadBytes: 10485760},
    switchRootCommand: ['/bin/busybox', 'switch_root', '/newroot', '/usr/lib/tr100/busybox', 'sh', '/usr/local/sbin/tr100-rom-bootstrap'],
    newRootInterpreterSHA256: '9b89dbebc390b4b9174a449df18b422892387bf35717a63cf1e0aef5b4e8dcfe',
    crossExecFailureBoundary: 'Old ash rescue traps end at final exec. Read-only preflight verifies static interpreter bytes, ARM ELF identity, bootstrap shebang/syntax and API target directories. Internal switch_root/chroot/NEW_INIT exec fatal errors remain non-recoverable by the old initrd; hardware verification and manual recovery remain required.',
    factoryBootSHA256: sha256(factory), kernelBytes: kernel.length, kernelSHA256: sha256(kernel), kernelUnchanged: true,
    pageSize: page, kernelLoadAddress: factory.readUInt32LE(12), ramdiskLoadAddress: factory.readUInt32LE(20),
    busyboxBytes: busybox.length, busyboxSHA256: sha256(busybox), initSHA256: sha256(init), policySHA256: sha256(policy),
    cpioBytes: cpio.length, cpioSHA256: sha256(cpio), gzipBytes: gzip.length, gzipSHA256: sha256(gzip),
    bootBytes: boot.length, bootSHA256: sha256(boot), bootPartitionLimitBytes: LIMIT, entries};
  return {cpio, gzip, boot, manifest};
}
module.exports = {buildPureInitramfs};
if (require.main === module) {
  try {
    const args = process.argv.slice(2), values = {};
    for (let i = 0; i < args.length; i += 2) {
      if (!args[i].startsWith('--') || !args[i + 1] || values[args[i]]) throw Error('Use unique --name value pairs');
      values[args[i]] = args[i + 1];
    }
    for (const key of ['--busybox', '--init', '--policy', '--factory-boot', '--output-dir']) if (!values[key]) throw Error('Missing ' + key);
    const built = buildPureInitramfs({busyboxPath: values['--busybox'], initPath: values['--init'], policyPath: values['--policy'], factoryBootPath: values['--factory-boot']});
    const target = path.resolve(values['--output-dir']);
    // Fresh candidate directory only: refuse any pre-existing output instead of overwriting it.
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'initrd.cpio.gz'), built.gzip, {flag: 'wx'});
    fs.writeFileSync(path.join(target, 'boot.img'), built.boot, {flag: 'wx'});
    fs.writeFileSync(path.join(target, 'manifest.json'), JSON.stringify(built.manifest, null, 2) + '\n', {flag: 'wx'});
    console.log(JSON.stringify({...built.manifest, entries: built.manifest.entries.length}, null, 2));
  } catch (error) { console.error(error.stack); process.exitCode = 1; }
}
