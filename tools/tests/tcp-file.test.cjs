'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { startTransfer } = require('../tcp-file.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tr100-tcp-file-tests-'));
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
let sequence = 0;
function file() { return path.join(root, 'file-' + ++sequence + '.bin'); }
const base = { host: '127.0.0.1', port: 0, peer: '127.0.0.1', timeoutMs: 3000 };
test.after(() => {
  const absolute = fs.realpathSync(root), parent = fs.realpathSync(os.tmpdir());
  assert.equal(path.dirname(absolute), parent);
  assert.ok(path.basename(absolute).startsWith('tr100-tcp-file-tests-'));
  fs.rmSync(absolute, { recursive: true });
});
function client(port, data) {
  return new Promise((resolve, reject) => {
    const parts = [], socket = net.createConnection({ host: '127.0.0.1', port });
    socket.on('error', reject);
    socket.on('connect', () => socket.end(data)); // EOF on write; read half must remain usable.
    socket.on('data', chunk => parts.push(chunk));
    socket.on('end', () => resolve(Buffer.concat(parts)));
  });
}
test('send preserves the read half when a client immediately half-closes its empty stdin', async () => {
  const source = file(), payload = crypto.randomBytes(2 * 1024 * 1024 + 7);
  fs.writeFileSync(source, payload);
  const transfer = await startTransfer({ ...base, mode: 'send', file: source });
  try {
    const received = await client(transfer.address.port);
    assert.deepEqual(received, payload);
    const result = await transfer.completion;
    assert.equal(result.status, 'transport-complete', JSON.stringify(result));
    assert.equal(result.bytes, 2097159);
    assert.equal(result.sha256, digest(payload));
  } finally { transfer.cancel(); }
});
test('receive writes exact bytes and returns digest only after peer EOF and file sync', async () => {
  const target = file(), payload = crypto.randomBytes(1024 * 1024 + 31);
  const transfer = await startTransfer({ ...base, mode: 'receive', file: target, maxBytes: payload.length });
  try {
    const response = await client(transfer.address.port, payload);
    assert.equal(response.length, 0, 'raw transport must not add a protocol header');
    const result = await transfer.completion;
    assert.equal(result.status, 'transport-complete');
    assert.equal(result.bytes, 1048607);
    assert.equal(result.sha256, digest(payload));
    assert.equal(result.fileSynced, true);
    assert.deepEqual(fs.readFileSync(target), payload);
  } finally { transfer.cancel(); }
});
test('receive cannot replace an existing target', async () => {
  const target = file(); fs.writeFileSync(target, 'preserve original');
  await assert.rejects(startTransfer({ ...base, mode: 'receive', file: target }), /exist|EEXIST/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'preserve original');
});
test('receive wx also preserves a target created after listener startup', async () => {
  const target = file();
  const transfer = await startTransfer({ ...base, mode: 'receive', file: target });
  try {
    fs.writeFileSync(target, 'created by another operation');
    await client(transfer.address.port, Buffer.from('upload')).catch(() => {});
    const result = await transfer.completion;
    assert.equal(result.complete, false);
    assert.equal(fs.readFileSync(target, 'utf8'), 'created by another operation');
  } finally { transfer.cancel(); }
});
test('receive rejects an over-limit stream and never reports a complete file or digest', async () => {
  const target = file();
  const transfer = await startTransfer({ ...base, mode: 'receive', file: target, maxBytes: 1024 });
  try {
    await client(transfer.address.port, Buffer.alloc(2048)).catch(error => {
      assert.ok(['ECONNRESET', 'EPIPE'].includes(error.code), error.message);
    });
    const result = await transfer.completion;
    assert.equal(result.status, 'failed');
    assert.equal(result.complete, false);
    assert.equal(result.sha256, null);
    assert.match(result.error, /limit/);
    assert.equal(fs.existsSync(target), false, 'partial destination must be removed');
  } finally { transfer.cancel(); }
});
test('a disallowed peer receives no data and cannot create a destination', async () => {
  const target = file();
  const transfer = await startTransfer({ ...base, peer: '127.0.0.2', mode: 'receive', file: target, timeoutMs: 150 });
  try {
    await client(transfer.address.port, Buffer.from('untrusted')).catch(error => {
      assert.ok(['ECONNRESET', 'EPIPE'].includes(error.code), error.message);
    });
    const result = await transfer.completion;
    assert.equal(result.status, 'failed'); assert.equal(result.bytes, 0);
    assert.equal(result.sha256, null); assert.equal(fs.existsSync(target), false);
  } finally { transfer.cancel(); }
});
test('an interrupted connection removes a partial file rather than claiming success', async () => {
  const target = file();
  const transfer = await startTransfer({ ...base, mode: 'receive', file: target, timeoutMs: 100 });
  try {
    const socket = net.createConnection({ host: '127.0.0.1', port: transfer.address.port });
    socket.on('error', () => {});
    await new Promise(resolve => socket.once('connect', resolve));
    socket.write(Buffer.alloc(1024));
    // No EOF: simulate a stuck upload. Timeout must invalidate the partial file.
    const result = await transfer.completion;
    socket.destroy();
    assert.equal(result.status, 'failed'); assert.equal(result.complete, false);
    assert.match(result.error, /timed out/);
    assert.equal(fs.existsSync(target), false);
  } finally { transfer.cancel(); }
});
test('rejects target paths outside the workspace and designated test temporary root', async () => {
  const target = path.join(os.tmpdir(), 'tr100-outside-allowed-scope.bin');
  await assert.rejects(startTransfer({ ...base, mode: 'receive', file: target }), /path.*allowed|allowed.*path/i);
});
test('CLI emits listening and final JSON records and sends a file without a header', async () => {
  const source = file(), payload = Buffer.from('CLI raw binary\0\xff'); fs.writeFileSync(source, payload);
  const child = spawn(process.execPath, [path.resolve(__dirname, '../tcp-file.cjs'), 'send', '127.0.0.1', '0', '127.0.0.1', source],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stderr.on('data', data => { errors += data; });
  const exit = new Promise(resolve => child.once('exit', code => resolve(code)));
  const listening = new Promise((resolve, reject) => {
    child.stdout.on('data', data => {
      output += data;
      for (const line of output.split('\n')) {
        try { const record = JSON.parse(line); if (record.status === 'listening') resolve(record); } catch {}
      }
    });
    child.once('error', reject);
    child.once('exit', () => reject(Error('CLI exited before listening: ' + errors)));
  });
  try {
    const ready = await listening;
    assert.deepEqual(await client(ready.port), payload);
    assert.equal(await exit, 0, errors + output);
    const records = output.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(records.at(-1).status, 'transport-complete');
    assert.equal(records.at(-1).sha256, digest(payload));
  } finally { child.kill(); }
});
