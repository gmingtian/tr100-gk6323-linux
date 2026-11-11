'use strict';
// Independent read-only inspection of a built candidate; no ARM execution or devices.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), zlib = require('node:zlib');
const {spawnSync} = require('node:child_process');
const base = path.resolve(__dirname, '..'), target = path.resolve(process.argv[2] || path.join(base, 'pure-linux-candidate-v1'));
const manifest = JSON.parse(fs.readFileSync(path.join(target, 'manifest.json')));
const boot = fs.readFileSync(path.join(target, 'boot.img')), gzip = fs.readFileSync(path.join(target, 'initrd.cpio.gz'));
const factory = fs.readFileSync(path.join(base, 'factory-backup/factory-kernel.bin'));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
function requireTrue(ok, message) { if (!ok) throw Error(message); }
const cpio = zlib.gunzipSync(gzip);
requireTrue(boot.length === manifest.bootBytes && sha(boot) === manifest.bootSHA256 && boot.length <= 10485760, 'Boot hash/size/cap mismatch');
requireTrue(gzip.length === manifest.gzipBytes && sha(gzip) === manifest.gzipSHA256 && cpio.length === manifest.cpioBytes && sha(cpio) === manifest.cpioSHA256, 'Initrd hash/size mismatch');
requireTrue(boot.toString('ascii', 0, 8) === 'ANDROID!' && boot.readUInt32LE(36) === factory.readUInt32LE(36), 'Android header/page mismatch');
const page = boot.readUInt32LE(36), kernelSize = boot.readUInt32LE(8), ramdiskStart = page + Math.ceil(kernelSize / page) * page;
const kernel = boot.subarray(page, page + kernelSize);
requireTrue(kernel.equals(factory.subarray(page, page + factory.readUInt32LE(8))) && sha(kernel) === manifest.kernelSHA256, 'Factory kernel changed');
requireTrue(boot.readUInt32LE(16) === gzip.length && boot.subarray(ramdiskStart, ramdiskStart + gzip.length).equals(gzip), 'Boot ramdisk placement mismatch');
const listing = spawnSync('tar.exe', ['-tvf', path.join(target, 'initrd.cpio.gz')], {encoding: 'utf8'});
requireTrue(listing.status === 0 && !listing.stderr, 'Independent bsdtar failed: ' + listing.stderr);
const lines = listing.stdout.trim().split(/\r?\n/);
requireTrue(lines.length === manifest.entries.filter(e => e.name !== 'TRAILER!!!').length, 'Archive entry count mismatch');
requireTrue(/-rwxr-xr-x[^\r\n]*bin\/busybox/.test(listing.stdout) && /-rwxr-xr-x[^\r\n]*\binit\b/.test(listing.stdout), 'Executable modes incorrect');
requireTrue(/crw-------[^\r\n]*\b5,\s*1[^\r\n]*dev\/console/.test(listing.stdout), 'Console node incorrect');
requireTrue(!/dev\/loop/.test(listing.stdout), 'Unexpected loop device in pure initrd');
requireTrue(!/mmcblk/.test(listing.stdout), 'Unexpected pre-created eMMC node');
requireTrue(manifest.pureLinux === true && manifest.defaultRootDevice === '/dev/mmcblk0p8' && manifest.expectedRootDevnum === '259:0' && manifest.expectedStartSectors === 86016 && manifest.expectedSizeSectors === 15183872 && manifest.expectedDiskSectors === 15269888 && manifest.rootUUID === 'a8d4abf7-6ae4-4f9b-a39a-ef1b79c63230' && manifest.imageTag === 'tr100-pure-linux-20261111' && manifest.ramImageDownloadSupported === false, 'Pure p8 identity manifest mismatch');
for (const [name, local] of [['bin/busybox', 'sources/busybox-static-bookworm-armhf'], ['init', 'board-pure-linux-initrd/init'], ['lib/tr100-pure-initrd-policy.sh', 'board-pure-linux-initrd/policy.sh']]) {
  const read = spawnSync('tar.exe', ['-xOf', path.join(target, 'initrd.cpio.gz'), name], {maxBuffer: 4 * 1024 * 1024});
  requireTrue(read.status === 0 && read.stdout.equals(fs.readFileSync(path.join(base, local))), 'Critical archive bytes differ: ' + name);
}
const report = {candidateOnly: true, hardwareTested: false, checkedAt: new Date().toISOString(), directory: target,
  bootBytes: boot.length, bootSHA256: sha(boot), bootLimitBytes: 10485760, marginBytes: 10485760 - boot.length,
  gzipBytes: gzip.length, gzipSHA256: sha(gzip), cpioBytes: cpio.length, cpioSHA256: sha(cpio),
  kernelBytes: kernel.length, kernelSHA256: sha(kernel), factoryKernelByteIdentical: true,
  independentBsdtarExitCode: listing.status, filesystemEntries: lines.length, staticBusyboxAndScriptsByteIdentical: true,
  earlyCharNodesVerified: true, noLoopOrEmmcNodesIncluded: true, pureLinux: true, rootDevice: manifest.defaultRootDevice, rootUUID: manifest.rootUUID, expectedSizeSectors: manifest.expectedSizeSectors};
fs.writeFileSync(path.join(target, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
