'use strict';
// PC ordinary-file tooling only. No process launch, network, device writes or environment persistence.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), zlib = require('node:zlib');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { isDeepStrictEqual } = require('node:util');
const MIB = 1048576, PREFIX = 42 * MIB, DISK = 7818182656, ROOT = 7774142464;
const UUID = 'a8d4abf7-6ae4-4f9b-a39a-ef1b79c63230', TAG = 'tr100-pure-linux-20261111';
const MAP = '4M(fastboot),4M(bootargs),12M(kernel),4M(deviceinfo),2M(atf),8M(baseparam),8M(pqparam),-(rootfs)';
const PAYLOAD_SHA = 'a3668f0fd0e3f7b89eb4ea9293d03c8b32c7c01c7a13c520e3b2615ce84f84e6';
const PINNED = {
  fastboot: 'fdc8847fafd9ef5ca006cb414561b99464b344deba1c16f8c223c0916f2c521e',
  deviceinfo: '94d6d4cc9d39a43b126d9b5075d39dac72b83c44aa6db269cf773ab4a4a870aa',
  atf: '4ff6abeff404e8eeb0f0f3816470b3d65a9261c2ed75c6e4ce48fbf7fcc2f939'
};
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function expectedHash(value) {
  if (!/^[a-f0-9]{64}$/i.test(value || '')) throw Error('Explicit 64-hex expected SHA256 is required');
  return value.toLowerCase();
}
function regular(file, bytes) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile()) throw Error('Only ordinary regular files are accepted (no symlinks/devices): ' + file);
  if (bytes !== undefined && stat.size !== bytes) throw Error('File length mismatch: ' + file);
  return stat;
}
function readAt(file, offset, bytes) {
  const b = Buffer.alloc(bytes), fd = fs.openSync(file, 'r');
  try { let n = 0; while (n < bytes) { const got = fs.readSync(fd, b, n, bytes - n, offset + n); if (!got) throw Error('Short file read'); n += got; } }
  finally { fs.closeSync(fd); }
  return b;
}
function hashFile(file, bytes) {
  regular(file, bytes);
  const h = crypto.createHash('sha256'), b = Buffer.alloc(MIB), fd = fs.openSync(file, 'r');
  try { let n; while ((n = fs.readSync(fd, b)) > 0) h.update(b.subarray(0, n)); }
  finally { fs.closeSync(fd); }
  return h.digest('hex');
}
function layout() {
  const sizes = [4, 4, 12, 4, 2, 8, 8], names = ['fastboot', 'bootargs', 'kernel', 'deviceinfo', 'atf', 'baseparam', 'pqparam', 'rootfs'];
  let offset = 0;
  const partitions = names.map((name, i) => {
    const lengthBytes = i === 7 ? ROOT : sizes[i] * MIB;
    const part = { index: i + 1, name, device: '/dev/mmcblk0p' + (i + 1), startBytes: offset, lengthBytes,
      startSector: offset / 512, sizeSectors: lengthBytes / 512, preserved: [0, 3, 4, 5, 6].includes(i) };
    offset += lengthBytes; return part;
  });
  if (offset !== DISK) throw Error('Internal fixed layout does not cover disk');
  return { schemaVersion: 1, profile: 'TR100-GK6323V100C-pure-linux-20261111', diskBytes: DISK, diskSectors: DISK / 512,
    sectorBytes: 512, prefixBytes: PREFIX, kernelSlotBytes: 12 * MIB, bootReadBytes: 10 * MIB,
    partitionSource: 'fixed kernel blkdevparts bootarg; no GPT/MBR rewrite', blkdevparts: 'blkdevparts=mmcblk0:' + MAP,
    partitions, root: { device: '/dev/mmcblk0p8', devnum: '259:0', uuid: UUID, expectedFileTag: TAG,
      bytes: ROOT, blockSize: 4096, blocks: ROOT / 4096 },
    bootcmd: 'mmc read 0 0x8020000 0xC000 0x1000;mmc read 0 0x1FFBFC0 0x4000 0x5000; bootm 0x1FFBFC0' };
}
function parseEnvironment(prefix, originalPrefix) {
  const environment = require('./build-environment.cjs');
  const original = originalPrefix.subarray(4 * MIB, 8 * MIB), candidate = prefix.subarray(4 * MIB, 8 * MIB);
  const policy = environment.verifyEnvironment(original, candidate, environment.FACTORY_SHA);
  const values = Object.fromEntries(environment.parseEnvironment(candidate).entries.map(e => [e.key, e.value]));
  return { ...policy, crc32Valid: true, bootargs: values.bootargs, bootcmd: values.bootcmd, ethaddr: values.ethaddr };
}
function validatePrefix({ prefix, originalPrefix, kernelBytes, kernelSHA256 }) {
  if (!Buffer.isBuffer(prefix) || prefix.length !== PREFIX || !Buffer.isBuffer(originalPrefix) || originalPrefix.length < PREFIX)
    throw Error('Expected exact 42 MiB current prefix and at least 42 MiB original prefix bytes');
  if (!Number.isSafeInteger(kernelBytes) || kernelBytes < 2048 || kernelBytes > 10 * MIB) throw Error('Kernel exceeds 10 MiB boot read window');
  const protectedPartitions = layout().partitions.filter(p => p.preserved).map(p => {
    const before = sha(originalPrefix.subarray(p.startBytes, p.startBytes + p.lengthBytes));
    const after = sha(prefix.subarray(p.startBytes, p.startBytes + p.lengthBytes));
    if (PINNED[p.name] && before !== PINNED[p.name]) throw Error('Original protected partition SHA256 differs from pinned factory: ' + p.name);
    if (after !== before) throw Error('Changed protected partition: ' + p.name);
    return { name: p.name, startBytes: p.startBytes, bytes: p.lengthBytes, sha256: after, matchesOriginal: true };
  });
  const kernel = prefix.subarray(8 * MIB, 8 * MIB + kernelBytes);
  if (sha(kernel) !== expectedHash(kernelSHA256)) throw Error('New kernel slot image SHA256 mismatch');
  if (kernel.toString('ascii', 0, 8) !== 'ANDROID!') throw Error('Expected Android boot wrapper in new kernel slot');
  const page = kernel.readUInt32LE(36), payloadBytes = kernel.readUInt32LE(8), ramdiskBytes = kernel.readUInt32LE(16);
  if (page < 2048 || page > 65536 || (page & (page - 1)) || !payloadBytes || kernel.readUInt32LE(24) || kernel.readUInt32LE(40) ||
      page + Math.ceil(payloadBytes / page) * page + Math.ceil(ramdiskBytes / page) * page > kernelBytes)
    throw Error('Invalid Android v0 kernel-slot layout');
  const payloadSHA256 = sha(kernel.subarray(page, page + payloadBytes));
  if (payloadSHA256 !== PAYLOAD_SHA) throw Error('Original factory kernel payload has changed');
  if (prefix.subarray(8 * MIB + kernelBytes, 20 * MIB).some(byte => byte !== 0)) throw Error('Nonzero padding/residue in the former Android recovery kernel slot');
  return { status: 'prefix-policy-passed', sha256: sha(prefix), bytes: PREFIX, protectedPartitions,
    environment: parseEnvironment(prefix, originalPrefix), kernel: { bytes: kernelBytes, sha256: expectedHash(kernelSHA256), payloadBytes,
      payloadSHA256, zeroPaddingVerified: true, slotBytes: 12 * MIB, bootReadBytes: 10 * MIB },
    initrdRootPolicyVerification: 'requires-external-new-map-runtime-evidence' };
}
function validateRootSuperblock(b, bytes) {
  if (!Buffer.isBuffer(b) || b.length !== 1024 || b.readUInt16LE(56) !== 0xef53) throw Error('Invalid raw ext4 superblock');
  if (bytes !== ROOT) throw Error('Pure root file length must be exactly 7774142464');
  if (b.readUInt32LE(4) !== ROOT / 4096 || b.readUInt32LE(336) !== 0 || b.readUInt32LE(24) !== 2 || b.readUInt32LE(28) !== 2)
    throw Error('Pure root block count/size/cluster geometry mismatch');
  const masks = [b.readUInt32LE(92), b.readUInt32LE(96), b.readUInt32LE(100)];
  if (masks.some((v, i) => (v & ~[0x3c, 0x242, 0x7b][i]) !== 0) || (masks[0] & 0xc) !== 0xc || (masks[1] & 0x42) !== 0x42)
    throw Error('Unsupported/missing conservative Linux 3.18 ext4 feature');
  if (b.subarray(104, 120).toString('hex') !== UUID.replaceAll('-', '')) throw Error('Pure root UUID mismatch');
  if (b.readUInt16LE(58) !== 1 || b.readUInt32LE(76) !== 1 || b.readUInt16LE(88) !== 256 || b.readUInt32LE(20) !== 0 ||
      b.readUInt32LE(224) !== 8 || b.readUInt32LE(228) !== 0 || b.readUInt32LE(232) !== 0 || ![0, 32].includes(b.readUInt16LE(254)))
    throw Error('Root ext4 must be clean revision 1, 256-byte inodes and internal legacy journal');
  return { status: 'root-superblock-policy-passed', bytes, blocks: ROOT / 4096, blockSize: 4096, uuid: UUID,
    label: b.subarray(120, 136).toString('utf8').replace(/\0.*$/s, ''), featureMasks: masks.map(v => '0x' + v.toString(16).padStart(8, '0')),
    expectedFileTag: TAG, fileTagVerification: 'requires-external-native-evidence', fsckPerformed: false, runtimeValidated: false };
}
async function assembleStreams(options) {
  const { prefixPath, rootPath, outputPath, prefixBytes, rootBytes } = options;
  if (![prefixBytes, rootBytes].every(n => Number.isSafeInteger(n) && n > 0)) throw Error('Invalid expected stream lengths');
  regular(prefixPath, prefixBytes); regular(rootPath, rootBytes);
  const expected = [expectedHash(options.prefixSHA256), expectedHash(options.rootSHA256)];
  if (fs.existsSync(outputPath)) throw Error('Output image already exists');
  const partial = outputPath + '.partial', whole = crypto.createHash('sha256'), compressed = crypto.createHash('sha256');
  let ownsPartial = false, rawBytes = 0, gzipBytes = 0;
  async function* bytes() {
    for (const [i, file, length] of [[0, prefixPath, prefixBytes], [1, rootPath, rootBytes]]) {
      let count = 0; const part = crypto.createHash('sha256');
      for await (const chunk of fs.createReadStream(file, { highWaterMark: MIB })) {
        count += chunk.length; rawBytes += chunk.length;
        if (count > length) throw Error('Input stream exceeds expected length');
        part.update(chunk); whole.update(chunk); yield chunk;
      }
      if (count !== length) throw Error('Input stream is short');
      if (part.digest('hex') !== expected[i]) throw Error('Input stream SHA256 mismatch');
    }
  }
  const out = fs.createWriteStream(partial, { flags: 'wx', flush: true });
  out.once('open', () => { ownsPartial = true; });
  try {
    await pipeline(Readable.from(bytes()), zlib.createGzip({ level: 6 }), new Transform({ transform(chunk, enc, cb) {
      compressed.update(chunk); gzipBytes += chunk.length; cb(null, chunk);
    } }), out);
    // Exclusive atomic publication on the NTFS host: never replace another job's image.
    fs.linkSync(partial, outputPath); fs.unlinkSync(partial); ownsPartial = false;
    return { rawBytes, rawSHA256: whole.digest('hex'), gzipBytes, gzipSHA256: compressed.digest('hex'),
      prefixBytes, rootBytes, prefixSHA256: expected[0], rootSHA256: expected[1] };
  } catch (error) { if (ownsPartial && fs.existsSync(partial)) fs.unlinkSync(partial); throw error; }
}
async function verifyGzipSegments(imagePath, expected, capture = false) {
  regular(imagePath);
  const prefixBytes = expected.prefixBytes, rootBytes = expected.rootBytes, total = prefixBytes + rootBytes;
  if (![prefixBytes, rootBytes, total].every(n => Number.isSafeInteger(n) && n > 0)) throw Error('Invalid verification lengths');
  const whole = crypto.createHash('sha256'), prefix = crypto.createHash('sha256'), rootHash = crypto.createHash('sha256'), compressed = crypto.createHash('sha256');
  const input = fs.createReadStream(imagePath), unzip = zlib.createGunzip();
  let rawBytes = 0, gzipBytes = 0;
  const capturedPrefix = capture ? Buffer.alloc(prefixBytes) : null, rootHead = capture ? Buffer.alloc(2048) : null;
  input.on('data', chunk => { compressed.update(chunk); gzipBytes += chunk.length; });
  input.on('error', error => unzip.destroy(error)); input.pipe(unzip);
  try {
    for await (const chunk of unzip) {
      if (rawBytes + chunk.length > total) throw Error('Decompressed image exceeds fixed raw length');
      whole.update(chunk);
      const n = Math.min(chunk.length, Math.max(0, prefixBytes - rawBytes));
      if (n) { prefix.update(chunk.subarray(0, n)); if (capturedPrefix) chunk.copy(capturedPrefix, rawBytes, 0, n); }
      if (n < chunk.length) {
        const part = chunk.subarray(n), rootOffset = rawBytes + n - prefixBytes;
        rootHash.update(part);
        if (rootHead && rootOffset < rootHead.length) part.copy(rootHead, rootOffset, 0, Math.min(part.length, rootHead.length - rootOffset));
      }
      rawBytes += chunk.length;
    }
    if (rawBytes !== total) throw Error('Decompressed raw length is short');
    if (expected.gzipBytes !== undefined && gzipBytes !== expected.gzipBytes) throw Error('Compressed gzip length differs from receipt');
  } finally { input.destroy(); unzip.destroy(); }
  const result = { status: 'image-stream-verified', rawBytes, rawSHA256: whole.digest('hex'), gzipBytes,
    gzipSHA256: compressed.digest('hex'), prefixSHA256: prefix.digest('hex'), rootSHA256: rootHash.digest('hex') };
  for (const key of ['rawSHA256', 'gzipSHA256', 'prefixSHA256', 'rootSHA256'])
    if (result[key] !== expectedHash(expected[key])) throw Error('Image ' + key + ' mismatch');
  return { ...result, capturedPrefix, rootHead };
}
function originalInput(file, expected) {
  const absolute = path.resolve(file); regular(absolute, 262 * MIB);
  const actual = hashFile(absolute);
  if (actual !== expectedHash(expected)) throw Error('Original 262 MiB backup SHA256 mismatch');
  return { file: absolute, bytes: 262 * MIB, sha256: actual, prefix: readAt(absolute, 0, PREFIX) };
}
async function assembleImage(options) {
  const baseline = originalInput(options['original-prefix'], options['original-prefix-sha256']);
  const prefixPath = path.resolve(options.prefix), rootPath = path.resolve(options.root), target = path.resolve(options.out);
  regular(prefixPath, PREFIX); regular(rootPath, ROOT);
  if (fs.existsSync(target)) throw Error('Output directory already exists');
  const prefixBytes = readAt(prefixPath, 0, PREFIX), prefixSHA256 = expectedHash(options['prefix-sha256']);
  if (sha(prefixBytes) !== prefixSHA256) throw Error('Actual 42 MiB prefix SHA256 mismatch');
  const kernelBytes = Number(options['kernel-bytes']), kernelSHA256 = expectedHash(options['kernel-sha256']);
  const prefixPolicy = validatePrefix({ prefix: prefixBytes, originalPrefix: baseline.prefix, kernelBytes, kernelSHA256 });
  const rootPolicy = validateRootSuperblock(readAt(rootPath, 1024, 1024), ROOT), rootSHA256 = expectedHash(options['root-sha256']);
  fs.mkdirSync(target);
  const image = path.join(target, 'TR100-pure-linux.img.gz');
  const streams = await assembleStreams({ prefixPath, rootPath, outputPath: image, prefixBytes: PREFIX, rootBytes: ROOT, prefixSHA256, rootSHA256 });
  const verified = await verifyGzipSegments(image, streams);
  const { prefix: ignored, ...originalBackup } = baseline;
  const manifest = { schemaVersion: 1, profile: layout().profile, createdAt: new Date().toISOString(), experimental: true,
    deviceBoundImage: true, emmcWritesPerformedByTool: false, runtimeValidated: false, layout: layout(),
    image: { file: path.basename(image), ...streams }, inputs: { originalBackup, prefix: { file: prefixPath, bytes: PREFIX, sha256: prefixSHA256 },
      root: { file: rootPath, bytes: ROOT, sha256: rootSHA256 } }, prefixPolicy, rootPolicy,
    kernel: { bytes: kernelBytes, sha256: kernelSHA256 }, verification: { gzipAndLogicalBytesVerified: verified.status === 'image-stream-verified',
      rootFileTagVerified: false, newInitrdRootPolicyVerified: false, note: 'Native filesystem/tag checks and device RAM/default boot evidence are separate requirements.' } };
  fs.writeFileSync(path.join(target, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  fs.writeFileSync(path.join(target, 'layout.json'), JSON.stringify(layout(), null, 2) + '\n', { flag: 'wx' });
  const names = [path.basename(image), 'layout.json', 'manifest.json'];
  fs.writeFileSync(path.join(target, 'SHA256SUMS'), names.map(name => hashFile(path.join(target, name)) + '  ' + name).join('\n') + '\n', { flag: 'wx' });
  return manifest;
}
async function verifyImage(options) {
  regular(options.manifest); const manifest = JSON.parse(fs.readFileSync(options.manifest, 'utf8'));
  if (manifest.schemaVersion !== 1 || !isDeepStrictEqual(manifest.layout, layout())) throw Error('Manifest fixed layout mismatch');
  if (manifest.image.prefixBytes !== PREFIX || manifest.image.rootBytes !== ROOT || manifest.image.rawBytes !== DISK)
    throw Error('Manifest image fixed lengths mismatch');
  const baseline = originalInput(options['original-prefix'], options['original-prefix-sha256']);
  const result = await verifyGzipSegments(options.image, manifest.image, true);
  const prefixPolicy = validatePrefix({ prefix: result.capturedPrefix, originalPrefix: baseline.prefix,
    kernelBytes: manifest.kernel.bytes, kernelSHA256: manifest.kernel.sha256 });
  const rootPolicy = validateRootSuperblock(result.rootHead.subarray(1024), ROOT);
  const { capturedPrefix, rootHead, ...summary } = result;
  return { ...summary, protectedPrefixVerified: prefixPolicy.status === 'prefix-policy-passed', rootSuperblockVerified: rootPolicy.status,
    nativeRootFileTagVerified: false, runtimeValidated: false, emmcWritesPerformedByTool: false };
}
async function main(argv) {
  const [command, ...args] = argv;
  if (command === '--help' || !command) {
    console.log('PC ordinary-file tools only. No device actions.\n' +
      'layout\nassemble --original-prefix ORIGINAL262.raw --original-prefix-sha256 HEX --prefix ACTUAL42.raw --prefix-sha256 HEX --root ROOT.raw --root-sha256 HEX --kernel-bytes N --kernel-sha256 HEX --out NEW_DIRECTORY\n' +
      'verify --image IMAGE.img.gz --manifest manifest.json --original-prefix ORIGINAL262.raw --original-prefix-sha256 HEX'); return;
  }
  if (command === 'layout') { if (args.length) throw Error('layout takes no options'); console.log(JSON.stringify(layout(), null, 2)); return; }
  const allowed = command === 'assemble' ? ['original-prefix', 'original-prefix-sha256', 'prefix', 'prefix-sha256', 'root', 'root-sha256', 'kernel-bytes', 'kernel-sha256', 'out'] :
    command === 'verify' ? ['image', 'manifest', 'original-prefix', 'original-prefix-sha256'] : null;
  if (!allowed) throw Error('Unknown command');
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].replace(/^--/, '');
    if (!args[i].startsWith('--') || !allowed.includes(key) || options[key] !== undefined || !args[i + 1] || args[i + 1].startsWith('--')) throw Error('Unknown/duplicate option or missing value');
    options[key] = args[i + 1];
  }
  for (const key of allowed) if (!options[key]) throw Error('Missing --' + key);
  const result = command === 'assemble' ? await assembleImage(options) : await verifyImage(options);
  console.log(JSON.stringify(command === 'assemble' ? { status: 'assembled-and-stream-verified-not-device-tested', output: path.resolve(options.out), image: result.image } : result, null, 2));
}
module.exports = { layout, validatePrefix, validateRootSuperblock, assembleStreams, verifyGzipSegments, assembleImage, verifyImage };
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
