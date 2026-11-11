'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const crypto = require('node:crypto'), zlib = require('node:zlib');
const { layout, validatePrefix, validateRootSuperblock, assembleStreams, verifyGzipSegments } = require('../pure-linux-image.cjs');
const workspace = path.resolve(__dirname, '../../..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tr100-pure-image-tests-'));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
let sequence = 0;
test.after(() => {
  const absolute = fs.realpathSync(root);
  assert.equal(path.dirname(absolute), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(absolute).startsWith('tr100-pure-image-tests-'));
  fs.rmSync(absolute, { recursive: true });
});
const MAP = '4M(fastboot),4M(bootargs),12M(kernel),4M(deviceinfo),2M(atf),8M(baseparam),8M(pqparam),-(rootfs)';
const BOOTCMD = 'mmc read 0 0x8020000 0xC000 0x1000;mmc read 0 0x1FFBFC0 0x4000 0x5000; bootm 0x1FFBFC0';
function environment(prefix, map = MAP, bootcmd = BOOTCMD, extra = '') {
  const offset = 4194304;
  const tool=require('../build-environment.cjs'),original=fs.readFileSync(path.join(workspace,'firmware-analysis/factory-backup/factory-bootargs.bin'));
  const entries=tool.parseEnvironment(tool.buildEnvironment(original,tool.FACTORY_SHA).image).entries;
  entries.find(e=>e.key==='bootcmd').value=bootcmd;
  entries.find(e=>e.key==='bootargs').value='console=ttyAMA0,115200 blkdevparts=mmcblk0:'+map+' loglevel=0'+extra;
  prefix.fill(0, offset, offset + 65536);
  const data = Buffer.from(entries.map(e=>e.key+'='+e.value).join('\0')+'\0\0');
  data.copy(prefix, offset + 4);
  prefix.writeUInt32LE(zlib.crc32(prefix.subarray(offset + 4, offset + 65536)), offset);
}
function prefixFixture() {
  const originalPrefix = Buffer.alloc(44040192);
  for (const [file, offset] of [['factory-fastboot.bin', 0], ['factory-bootargs.bin',4194304], ['factory-deviceinfo.bin', 20971520], ['factory-atf.bin', 25165824]])
    fs.readFileSync(path.join(workspace, 'firmware-analysis/factory-backup', file)).copy(originalPrefix, offset);
  const prefix = Buffer.from(originalPrefix), kernel = fs.readFileSync(path.join(workspace, 'firmware-analysis/rom-final/boot.img'));
  kernel.copy(prefix, 8388608); environment(prefix);
  return { prefix, originalPrefix, kernelBytes: kernel.length, kernelSHA256: sha(kernel) };
}
test('eight parts cover the exact user area and root uses every byte after 42 MiB', () => {
  const m = layout();
  assert.equal(m.diskBytes, 7818182656); assert.equal(m.diskSectors, 15269888);
  assert.equal(m.partitions.length, 8);
  assert.deepEqual(m.partitions.map(p => [p.index, p.startBytes, p.lengthBytes]), [
    [1, 0, 4194304], [2, 4194304, 4194304], [3, 8388608, 12582912], [4, 20971520, 4194304],
    [5, 25165824, 2097152], [6, 27262976, 8388608], [7, 35651584, 8388608], [8, 44040192, 7774142464]
  ]);
  assert.equal(m.root.blocks, 1897984); assert.equal(m.root.uuid, 'a8d4abf7-6ae4-4f9b-a39a-ef1b79c63230');
  assert.equal(m.bootReadBytes, 10485760); assert.equal(m.kernelSlotBytes, 12582912);
});
test('validates original protected bytes and actual CRC-protected new environment/kernel without device access', () => {
  const input = prefixFixture(), result = validatePrefix(input);
  assert.equal(result.status, 'prefix-policy-passed');
  assert.equal(result.environment.bootargs.includes('-(rootfs)'), true);
  assert.equal(result.environment.crc32Valid, true);
  assert.equal(result.kernel.payloadSHA256, 'a3668f0fd0e3f7b89eb4ea9293d03c8b32c7c01c7a13c520e3b2615ce84f84e6');
  assert.equal(result.kernel.zeroPaddingVerified, true);
  assert.equal(result.protectedPartitions.length, 5);
});
test('accepts exact two-key original environment rebuild and refuses other key/order/tail edits even with a valid CRC',()=>{
  const env=require('../build-environment.cjs'),input=prefixFixture();
  const original=fs.readFileSync(path.join(workspace,'firmware-analysis/factory-backup/factory-bootargs.bin'));
  const candidate=env.buildEnvironment(original,env.FACTORY_SHA).image;
  original.copy(input.originalPrefix,4194304);candidate.copy(input.prefix,4194304);
  assert.equal(validatePrefix(input).environment.ethaddr,'02:00:00:00:00:02');
  input.prefix[4194304+65536]^=1;assert.throws(()=>validatePrefix(input),/tail/);input.prefix[4194304+65536]^=1;
  const changed=Buffer.from(candidate),data=changed.subarray(4,65536),end=data.indexOf(Buffer.from([0,0]));
  const entries=data.subarray(0,end).toString('ascii').split('\0');
  entries[0]=entries[0].replace(/=.*/,'=changed');changed.fill(0,4,65536);Buffer.from(entries.join('\0')+'\0\0').copy(changed,4);
  changed.writeUInt32LE(zlib.crc32(changed.subarray(4,65536)),0);changed.copy(input.prefix,4194304);
  assert.throws(()=>validatePrefix(input),/two|bootcmd|bootargs/);
});
test('rejects each changed protected partition and nonzero Android-recovery residue after the kernel', () => {
  const input = prefixFixture();
  for (const offset of [0, 20971520, 25165824, 27262976, 35651584]) {
    input.prefix[offset] ^= 1;
    assert.throws(() => validatePrefix(input), /protected|original/i);
    input.prefix[offset] ^= 1;
  }
  input.prefix[8388608 + input.kernelBytes] = 1;
  assert.throws(() => validatePrefix(input), /padding|residue/i);
});
test('kernel slot honors the 10 MiB read boundary and rejects a changed factory payload even with a new wrapper digest', () => {
  const input = prefixFixture();
  const boundary = { ...input, kernelBytes: 10485760, kernelSHA256: sha(input.prefix.subarray(8388608, 8388608 + 10485760)) };
  assert.equal(validatePrefix(boundary).kernel.bytes, 10485760);
  assert.throws(() => validatePrefix({ ...boundary, kernelBytes: 10485761 }), /10 MiB/);
  input.prefix[8388608 + 16384 + 100] ^= 1;
  input.kernelSHA256 = sha(input.prefix.subarray(8388608, 8388608 + input.kernelBytes));
  assert.throws(() => validatePrefix(input), /factory kernel payload/);
});
test('rejects bad environment CRC, old partition map, old kernel read source and persisted RAM-test mode', () => {
  const input = prefixFixture();
  input.prefix[4194304] ^= 1;
  assert.throws(() => validatePrefix(input), /CRC32/);
  environment(input.prefix, MAP.replace('12M(kernel)', '12M(recovery)'));
  assert.throws(() => validatePrefix(input), /map|blkdevparts/);
  environment(input.prefix, MAP, BOOTCMD.replace('0x4000', '0x51000'));
  assert.throws(() => validatePrefix(input), /bootcmd/);
  environment(input.prefix, MAP, BOOTCMD, ' tr100.ramtest=1');
  assert.throws(() => validatePrefix(input), /RAM|ramtest/);
  environment(input.prefix, MAP, BOOTCMD, ' tr100.ramtest=0');
  assert.throws(() => validatePrefix(input), /RAM|ramtest/);
});
function rootHeader() {
  const b = Buffer.alloc(1024); b.writeUInt16LE(0xef53, 56); b.writeUInt16LE(1, 58);
  b.writeUInt32LE(1897984, 4); b.writeUInt32LE(2, 24); b.writeUInt32LE(2, 28);
  b.writeUInt32LE(1, 76); b.writeUInt16LE(256, 88);
  b.writeUInt32LE(0x3c, 92); b.writeUInt32LE(0x242, 96); b.writeUInt32LE(0x7b, 100);
  Buffer.from('a8d4abf76ae44f9ba39aef1b79c63230', 'hex').copy(b, 104); b.write('TR100ROOT', 120);
  b.writeUInt32LE(8, 224); return b;
}
test('root superblock requires new UUID/full 7414 MiB capacity and rejects modern feature bits', () => {
  const b = rootHeader(), r = validateRootSuperblock(b, 7774142464);
  assert.equal(r.blocks, 1897984); assert.equal(r.fileTagVerification, 'requires-external-native-evidence');
  assert.throws(() => validateRootSuperblock(b, 838860800), /length/);
  b.writeUInt32LE(204800, 4); assert.throws(() => validateRootSuperblock(b, 7774142464), /block/);
  b.writeUInt32LE(1897984, 4); b.writeUInt32LE(0x2242, 96);
  assert.throws(() => validateRootSuperblock(b, 7774142464), /feature/);
  b.writeUInt32LE(0x242, 96); b[104] ^= 1;
  assert.throws(() => validateRootSuperblock(b, 7774142464), /UUID/);
});
function streamFixture() {
  const dir = path.join(root, String(++sequence)); fs.mkdirSync(dir);
  const prefix = Buffer.from('small-prefix\0'), rootData = Buffer.from('root fixture\xff'.repeat(19));
  const prefixPath = path.join(dir, 'prefix'), rootPath = path.join(dir, 'root');
  fs.writeFileSync(prefixPath, prefix); fs.writeFileSync(rootPath, rootData);
  return { prefix, rootData, options: { prefixPath, rootPath, outputPath: path.join(dir, 'image.img.gz'),
    prefixBytes: prefix.length, rootBytes: rootData.length, prefixSHA256: sha(prefix), rootSHA256: sha(rootData) } };
}
test('stream engine creates gzip of exact concatenation and independently verifies both segments', async () => {
  const f = streamFixture(), report = await assembleStreams(f.options);
  const output = fs.readFileSync(f.options.outputPath);
  assert.deepEqual(zlib.gunzipSync(output), Buffer.concat([f.prefix, f.rootData]));
  assert.equal(report.rawSHA256, sha(Buffer.concat([f.prefix, f.rootData])));
  assert.equal(report.gzipSHA256, sha(output));
  const verified = await verifyGzipSegments(f.options.outputPath, { ...f.options, ...report });
  assert.equal(verified.status, 'image-stream-verified');
  assert.equal(verified.rawBytes, f.prefix.length + f.rootData.length);
});
test('stream engine never publishes wrong-source bytes and preserves an existing target or partial', async () => {
  const f = streamFixture();
  await assert.rejects(assembleStreams({ ...f.options, rootSHA256: '0'.repeat(64) }), /SHA256/);
  assert.equal(fs.existsSync(f.options.outputPath), false); assert.equal(fs.existsSync(f.options.outputPath + '.partial'), false);
  fs.writeFileSync(f.options.outputPath + '.partial', 'other job');
  await assert.rejects(assembleStreams(f.options), /EEXIST|exist/);
  assert.equal(fs.readFileSync(f.options.outputPath + '.partial', 'utf8'), 'other job');
  fs.writeFileSync(f.options.outputPath, 'prior image');
  await assert.rejects(assembleStreams(f.options), /exist/);
  assert.equal(fs.readFileSync(f.options.outputPath, 'utf8'), 'prior image');
});
test('gzip verification rejects an extra raw byte, a short root and corrupt gzip CRC', async () => {
  const f = streamFixture(), report = await assembleStreams(f.options);
  for (const raw of [Buffer.concat([f.prefix, f.rootData, Buffer.from([1])]), Buffer.concat([f.prefix, f.rootData.subarray(1)])]) {
    const gzip = zlib.gzipSync(raw); fs.writeFileSync(f.options.outputPath, gzip);
    await assert.rejects(verifyGzipSegments(f.options.outputPath, { ...f.options, ...report, gzipSHA256: sha(gzip) }), /length|exceed|short/);
  }
  const gzip = zlib.gzipSync(Buffer.concat([f.prefix, f.rootData])); gzip[gzip.length - 8] ^= 1;
  fs.writeFileSync(f.options.outputPath, gzip);
  await assert.rejects(verifyGzipSegments(f.options.outputPath, { ...f.options, ...report, gzipSHA256: sha(gzip) }), /check|CRC|data/i);
});
test('gzip verification rejects an inaccurate compressed-length receipt', async () => {
  const f = streamFixture(), report = await assembleStreams(f.options);
  await assert.rejects(verifyGzipSegments(f.options.outputPath, { ...f.options, ...report, gzipBytes: report.gzipBytes + 1 }), /gzip.*length|compressed.*length/i);
});
