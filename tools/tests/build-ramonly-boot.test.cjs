'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { buildRamOnlyBoot, planLayout, validateRanges, crc32 } = require('../build-ramonly-boot.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tr100-ramonly-tests-'));
const factory = path.resolve(__dirname, '../../firmware-analysis/factory-backup/factory-kernel.bin');
const sha = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
let sequence = 0;
test.after(() => {
  const resolved = fs.realpathSync(root);
  assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('tr100-ramonly-tests-'));
  fs.rmSync(resolved, { recursive: true });
});
function cpio(payload) {
  const entry = (name, data) => {
    const fields = [1, 0o100644, 0, 0, 1, 0, data.length, 0, 0, 0, 0, name.length + 1, 0];
    const header = Buffer.from('070701' + fields.map(n => n.toString(16).padStart(8, '0')).join(''));
    const start = Buffer.concat([header, Buffer.from(name + '\0')]);
    return Buffer.concat([start, Buffer.alloc((4 - start.length % 4) % 4), data, Buffer.alloc((4 - data.length % 4) % 4)]);
  };
  return Buffer.concat([entry('fixture', payload), entry('TRAILER!!!', Buffer.alloc(0))]);
}
function fixture(payload = Buffer.from('fixture only, not a bootable rootfs')) {
  const dir = path.join(root, String(++sequence)); fs.mkdirSync(dir);
  const initramfsPath = path.join(dir, 'fullCPIO.gz'); fs.writeFileSync(initramfsPath, zlib.gzipSync(cpio(payload)));
  return { factoryKernelPath: factory, initramfsPath, outDir: path.join(dir, 'RAMONLY-output') };
}
test('keeps factory kernel bytes and fixed safe RAM addresses while marking all outputs RAMONLY', async () => {
  const input = fixture(), manifest = await buildRamOnlyBoot(input);
  const original = fs.readFileSync(factory), output = fs.readFileSync(path.join(input.outDir, 'RAMONLY-boot.img'));
  const page = original.readUInt32LE(36), bytes = original.readUInt32LE(8);
  assert.deepEqual(output.subarray(page, page + bytes), original.subarray(page, page + bytes));
  assert.equal(output.readUInt32LE(20), 268435456);
  assert.equal(output.readUInt32LE(12), original.readUInt32LE(12));
  assert.equal(manifest.RAMONLY, true); assert.equal(manifest.emmcFlashable, false);
  assert.equal(manifest.layout.sourceAddress, 1073741824);
  assert.equal(manifest.layout.uimageLoadAddress, 33554432);
  assert.ok(manifest.layout.initrdEndExclusive < 520093696);
  assert.equal(manifest.factoryKernelSHA256, '5f56ea379f7f4ec35d14b85f0bd9f0350697ab3b09c9ddc9e2769f2c457917d9');
  assert.equal(manifest.boot.sha256, sha(output));
  assert.equal(manifest.boot.crc32, crc32(output));
});
test('16 MiB fragments reconstruct the image and carry independent digest/address metadata', async () => {
  const input = fixture(crypto.randomBytes(10 * 1024 * 1024));
  const manifest = await buildRamOnlyBoot(input);
  assert.equal(manifest.fragments.length, 2);
  const fragments = manifest.fragments.map((fragment, index) => {
    assert.match(fragment.file, /^RAMONLY-part-\d{3}\.bin$/);
    assert.equal(fragment.address, 1073741824 + index * 16777216);
    const bytes = fs.readFileSync(path.join(input.outDir, fragment.file));
    assert.equal(bytes.length, fragment.bytes);
    assert.equal(sha(bytes), fragment.sha256);
    assert.equal(crc32(bytes), fragment.crc32);
    return bytes;
  });
  assert.equal(fragments[0].length, 16777216);
  assert.deepEqual(Buffer.concat(fragments), fs.readFileSync(path.join(input.outDir, 'RAMONLY-boot.img')));
});
test('CRC32 agrees with the independent standard test vector', () => {
  assert.equal(crc32(Buffer.from('123456789')), 'cbf43926');
});
test('rejects initrd ending exactly at the strict 496 MiB boundary', () => {
  assert.throws(() => planLayout({ bootBytes: 260000000, ramdiskBytes: 251658240,
    uimageLoadAddress: 33554432, uimagePayloadBytes: 8918487, androidKernelAddress: 50364416, androidKernelBytes: 8918551 }), /initrd.*boundary/i);
});
test('rejects kernel target changes, overlapping ranges and source past DDR', () => {
  const valid = { bootBytes: 160000000, ramdiskBytes: 150000000, uimageLoadAddress: 33554432,
    uimagePayloadBytes: 8918487, androidKernelAddress: 50364416, androidKernelBytes: 8918551 };
  assert.throws(() => planLayout({ ...valid, uimageLoadAddress: 134217728 }), /uImage/);
  assert.throws(() => planLayout({ ...valid, bootBytes: 1073741825 }), /DDR/);
  assert.throws(() => validateRanges([{ name: 'first', start: 16777216, end: 40000000 },
    { name: 'second', start: 33554432, end: 50000000 }]), /overlap/);
});
test('ATF guard covers the real 128 MiB plus 128 KiB load address and its final byte', () => {
  const layout = planLayout({ bootBytes: 160000000, ramdiskBytes: 150000000, uimageLoadAddress: 33554432,
    uimagePayloadBytes: 8918487, androidKernelAddress: 50364416, androidKernelBytes: 8918551 });
  const atf = layout.ranges.find(range => range.name === 'atf');
  assert.equal(atf.start, 134348800);
  assert.equal(atf.end, 136445952);
  assert.throws(() => validateRanges([atf, { name: 'collision-at-atf-tail', start: 136445951, end: 136445953 }]), /overlap/);
  assert.doesNotThrow(() => validateRanges([atf, { name: 'exactly-after-atf', start: 136445952, end: 136445953 }]));
});
test('rejects damaged gzip before creating an output directory', async () => {
  const input = fixture(); fs.appendFileSync(input.initramfsPath, Buffer.from('invalid gzip suffix'));
  await assert.rejects(buildRamOnlyBoot(input), /gzip|header|compression|data/i);
  assert.equal(fs.existsSync(input.outDir), false);
});
