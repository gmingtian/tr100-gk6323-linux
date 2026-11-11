'use strict';
// Offline RAM-only image construction. No device access or persistent-write commands.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { repackAndroidBoot } = require('../firmware-analysis/tools/build-initramfs.cjs');
const FACTORY_SHA = '5f56ea379f7f4ec35d14b85f0bd9f0350697ab3b09c9ddc9e2769f2c457917d9';
const FRAGMENT_BYTES = 16 * 1024 * 1024;
const DDR_START = 0x01000000, DDR_END = 0x80000000;
const INITRD_ADDRESS = 0x10000000, INITRD_END_LIMIT = 0x1f000000, SOURCE_ADDRESS = 0x40000000;
const sha256 = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(buffer) {
  let value = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) value = crcTable[(value ^ buffer[i]) & 0xff] ^ (value >>> 8);
  return ((value ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
}
function validateRanges(ranges) {
  for (const range of ranges) {
    if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < DDR_START ||
        range.end > DDR_END || range.end <= range.start) throw Error(range.name + ' range is outside usable DDR');
  }
  for (let i = 0; i < ranges.length; i++) {
    for (let j = i + 1; j < ranges.length; j++) {
      if (ranges[i].start < ranges[j].end && ranges[j].start < ranges[i].end)
        throw Error('RAM overlap: ' + ranges[i].name + ' and ' + ranges[j].name);
    }
  }
}
function planLayout({ bootBytes, ramdiskBytes, uimageLoadAddress, uimagePayloadBytes, androidKernelAddress, androidKernelBytes }) {
  if (uimageLoadAddress !== 0x02000000) throw Error('Expected actual uImage target at 32 MiB');
  const kernelWorkspace = { name: 'kernel-workspace', start: 0x02000000, end: 0x06000000 };
  if (![bootBytes, ramdiskBytes, uimagePayloadBytes, androidKernelBytes, androidKernelAddress].every(Number.isSafeInteger) ||
      bootBytes <= 0 || ramdiskBytes <= 0 || uimagePayloadBytes <= 0 || androidKernelBytes <= 0)
    throw Error('Invalid RAM image lengths/addresses');
  if (uimageLoadAddress + uimagePayloadBytes > kernelWorkspace.end || androidKernelAddress < kernelWorkspace.start ||
      androidKernelAddress + androidKernelBytes > kernelWorkspace.end) throw Error('Kernel staging/actual uImage target exceeds protected workspace');
  const initrdEndExclusive = INITRD_ADDRESS + ramdiskBytes;
  if (initrdEndExclusive >= INITRD_END_LIMIT) throw Error('Compressed initrd reaches the strict 496 MiB boundary');
  const ranges = [kernelWorkspace, { name: 'atf', start: 0x08020000, end: 0x08220000 },
    { name: 'compressed-initrd', start: INITRD_ADDRESS, end: initrdEndExclusive },
    { name: 'source-image', start: SOURCE_ADDRESS, end: SOURCE_ADDRESS + bootBytes }];
  validateRanges(ranges);
  return { ddrStart: DDR_START, ddrEndExclusive: DDR_END, sourceAddress: SOURCE_ADDRESS,
    initrdAddress: INITRD_ADDRESS, initrdEndExclusive, initrdEndLimitExclusive: INITRD_END_LIMIT,
    uimageLoadAddress, uimagePayloadBytes, androidKernelAddress, androidKernelBytes, ranges,
    kernelWorkspaceNote: '32..96 MiB is a conservative staging/self-decompression reservation, not a measured expanded kernel size.' };
}

// Verify the gzip stream and parse newc entry boundaries while retaining only stream chunks.
async function inspectCpioGzip(file) {
  const compressedHash = crypto.createHash('sha256'), expandedHash = crypto.createHash('sha256');
  const source = fs.createReadStream(file), gunzip = zlib.createGunzip();
  source.on('data', chunk => compressedHash.update(chunk));
  source.on('error', error => gunzip.destroy(error));
  source.pipe(gunzip);
  let pending = Buffer.alloc(0), phase = 'header', size = 0, nameBytes = 0, remaining = 0;
  let trailer = false, expandedBytes = 0, entryCount = 0;
  try {
    for await (const chunk of gunzip) {
      expandedHash.update(chunk); expandedBytes += chunk.length;
      pending = Buffer.concat([pending, chunk]);
      while (true) {
        if (phase === 'padding') {
          if (pending.some(byte => byte !== 0)) throw Error('Nonzero data after CPIO trailer');
          pending = Buffer.alloc(0); break;
        }
        if (phase === 'data' || phase === 'filepad') {
          const consumed = Math.min(remaining, pending.length);
          pending = pending.subarray(consumed); remaining -= consumed;
          if (remaining) break;
          if (phase === 'data') { phase = 'filepad'; remaining = (4 - size % 4) % 4; continue; }
          phase = trailer ? 'padding' : 'header'; continue;
        }
        if (phase === 'header') {
          if (pending.length < 110) break;
          if (pending.toString('ascii', 0, 6) !== '070701' || !/^[0-9a-fA-F]{104}$/.test(pending.toString('ascii', 6, 110)))
            throw Error('Expected complete CPIO newc header');
          size = parseInt(pending.toString('ascii', 54, 62), 16);
          nameBytes = parseInt(pending.toString('ascii', 94, 102), 16);
          if (nameBytes < 1 || nameBytes > 4096) throw Error('Invalid CPIO name length');
          pending = pending.subarray(110); phase = 'name';
        }
        if (phase === 'name') {
          const nameAndPadding = nameBytes + (4 - (110 + nameBytes) % 4) % 4;
          if (pending.length < nameAndPadding) break;
          if (pending[nameBytes - 1] !== 0) throw Error('CPIO filename lacks NUL terminator');
          trailer = pending.toString('ascii', 0, nameBytes - 1) === 'TRAILER!!!';
          if (trailer && size !== 0) throw Error('Invalid CPIO trailer size');
          if (!trailer) entryCount++;
          pending = pending.subarray(nameAndPadding); phase = 'data'; remaining = size;
        }
      }
    }
    if (!trailer || phase !== 'padding' || pending.length) throw Error('CPIO archive is truncated or lacks a trailer');
  } finally { source.destroy(); gunzip.destroy(); }
  return { compressedSHA256: compressedHash.digest('hex'), expandedSHA256: expandedHash.digest('hex'),
    expandedBytes, entryCount, format: 'cpio-newc', gzipIntegrity: 'validated', runtimeStatus: 'not-tested-by-builder' };
}

async function buildRamOnlyBoot({ factoryKernelPath, initramfsPath, outDir }) {
  for (const [name, value] of Object.entries({ factoryKernelPath, initramfsPath, outDir }))
    if (typeof value !== 'string' || !value) throw Error('Missing ' + name);
  const output = path.resolve(outDir);
  if (fs.existsSync(output)) throw Error('Output directory already exists');
  const factory = fs.readFileSync(factoryKernelPath);
  if (sha256(factory) !== FACTORY_SHA) throw Error('Original factory-kernel SHA256 mismatch');
  if (factory.toString('ascii', 0, 8) !== 'ANDROID!') throw Error('Missing original Android boot header');
  const page = factory.readUInt32LE(36), kernelBytes = factory.readUInt32LE(8);
  const kernel = factory.subarray(page, page + kernelBytes);
  if (kernel.length < 64 || kernel.readUInt32BE(0) !== 0x27051956 || kernel[29] !== 2 || kernel[30] !== 2)
    throw Error('Expected original ARM legacy uImage kernel');
  const uimagePayloadBytes = kernel.readUInt32BE(12), uimageLoadAddress = kernel.readUInt32BE(16);
  if (uimagePayloadBytes + 64 !== kernel.length || kernel.readUInt32BE(20) !== uimageLoadAddress)
    throw Error('Invalid original uImage payload/entry');
  const ramdiskBytes = fs.statSync(initramfsPath).size;
  const align = number => Math.ceil(number / page) * page;
  const bootBytes = page + align(kernelBytes) + align(ramdiskBytes);
  const layout = planLayout({ bootBytes, ramdiskBytes, uimageLoadAddress, uimagePayloadBytes,
    androidKernelAddress: factory.readUInt32LE(12), androidKernelBytes: kernelBytes });
  const cpio = await inspectCpioGzip(initramfsPath);
  const ramdisk = fs.readFileSync(initramfsPath);
  if (ramdisk.length !== ramdiskBytes || sha256(ramdisk) !== cpio.compressedSHA256) throw Error('CPIO gzip input changed during validation');
  const boot = repackAndroidBoot(factory, ramdisk);
  boot.writeUInt32LE(INITRD_ADDRESS, 20);
  if (boot.length !== bootBytes || !boot.subarray(page, page + kernelBytes).equals(kernel)) throw Error('Repacking changed original kernel bytes/layout');
  const manifest = { schemaVersion: 1, RAMONLY: true, experimental: true, emmcFlashable: false,
    purpose: 'Temporary TFTP/RAM-only boot; NEVER use this image as a persistent ROM or flash it to eMMC.',
    runtimeStatus: 'not-tested-by-builder', persistentEnvironmentModified: false,
    factoryKernelSource: path.resolve(factoryKernelPath), factoryKernelSHA256: FACTORY_SHA,
    originalAndroidKernelSHA256: sha256(kernel), originalAndroidKernelBytes: kernelBytes,
    initramfsSource: path.resolve(initramfsPath), initramfsBytes: ramdiskBytes, initramfsSHA256: sha256(ramdisk), cpio, layout,
    boot: { file: 'RAMONLY-boot.img', bytes: boot.length, sha256: sha256(boot), crc32: crc32(boot), address: SOURCE_ADDRESS },
    fragmentBytes: FRAGMENT_BYTES, fragments: [] };
  fs.mkdirSync(output);
  fs.writeFileSync(path.join(output, manifest.boot.file), boot, { flag: 'wx' });
  for (let offset = 0, index = 0; offset < boot.length; offset += FRAGMENT_BYTES, index++) {
    const fragment = boot.subarray(offset, Math.min(offset + FRAGMENT_BYTES, boot.length));
    const file = 'RAMONLY-part-' + String(index).padStart(3, '0') + '.bin';
    fs.writeFileSync(path.join(output, file), fragment, { flag: 'wx' });
    manifest.fragments.push({ file, offset, address: SOURCE_ADDRESS + offset,
      addressHex: '0x' + (SOURCE_ADDRESS + offset).toString(16), bytes: fragment.length, sha256: sha256(fragment), crc32: crc32(fragment) });
  }
  fs.writeFileSync(path.join(output, 'RAMONLY-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  fs.writeFileSync(path.join(output, 'RAMONLY-NOT-ROM.txt'),
    'RAMONLY experimental image. Never flash to eMMC. No environment changes or flash commands are generated.\n' +
    'Source address: 0x40000000. Compressed initrd destination: 0x10000000.\n' +
    'Use each fragment only at its manifest address and verify CRC32/SHA256 before a separately authorized RAM boot.\n' +
    'This tool validates packaging/layout, not runtime boot or hardware support.\n', { flag: 'wx' });
  return manifest;
}
async function main(argv) {
  if (argv.length === 1 && argv[0] === '--help') {
    console.log('node tools/build-ramonly-boot.cjs FACTORY_KERNEL.bin fullCPIO.gz NEW_OUTPUT_DIRECTORY\n' +
      'RAMONLY: 16 MiB fragments at 0x40000000; initrd at 0x10000000; never flash to eMMC.');
    return;
  }
  if (argv.length !== 3) throw Error('Usage: build-ramonly-boot.cjs FACTORY_KERNEL.bin fullCPIO.gz NEW_OUTPUT_DIRECTORY');
  const manifest = await buildRamOnlyBoot({ factoryKernelPath: argv[0], initramfsPath: argv[1], outDir: argv[2] });
  console.log(JSON.stringify({ status: 'packaged-not-boot-tested', RAMONLY: true, output: path.resolve(argv[2]),
    bytes: manifest.boot.bytes, sha256: manifest.boot.sha256, crc32: manifest.boot.crc32, fragments: manifest.fragments.length }));
}
module.exports = { buildRamOnlyBoot, planLayout, validateRanges, crc32 };
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
