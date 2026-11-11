'use strict';
// One authorized connection, fixed local file, raw bytes, no remote filename/protocol commands.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');
const { Transform, pipeline } = require('node:stream');
const WORKSPACE = path.resolve(__dirname, '..');
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024;

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
function permittedPath(file, mode) {
  if (typeof file !== 'string' || !file) throw Error('A fixed local file path is required');
  const absolute = path.resolve(file);
  const real = mode === 'send' ? fs.realpathSync(absolute) : path.join(fs.realpathSync(path.dirname(absolute)), path.basename(absolute));
  const workspace = fs.realpathSync(WORKSPACE), temp = fs.realpathSync(os.tmpdir());
  const tempRelative = path.relative(temp, real);
  const testDirectory = tempRelative.split(path.sep)[0];
  const allowedTest = inside(temp, real) && /^tr100-tcp-file-tests-[a-zA-Z0-9_-]+$/.test(testDirectory) && tempRelative.includes(path.sep);
  if (!inside(workspace, real) && !allowedTest) throw Error('Local path is outside the allowed workspace/test directory');
  return real;
}

async function startTransfer(options) {
  const { mode, host, peer } = options;
  if (!['send', 'receive'].includes(mode)) throw Error('Mode must be send or receive');
  if (!net.isIPv4(host) || host === '0.0.0.0' || !net.isIPv4(peer)) throw Error('Specific local and peer IPv4 addresses are required');
  const port = Number(options.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error('Invalid TCP port');
  const maxBytes = options.maxBytes === undefined ? DEFAULT_MAX_BYTES : Number(options.maxBytes);
  const timeoutMs = options.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : Number(options.timeoutMs);
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw Error('MAX_BYTES must be a positive safe integer');
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > DEFAULT_TIMEOUT_MS) throw Error('Timeout must be between 1ms and ten minutes');
  const file = permittedPath(options.file, mode);
  let expectedBytes;
  if (mode === 'send') {
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw Error('Source must be a regular file');
    expectedBytes = stat.size;
    if (expectedBytes > maxBytes) throw Error('Source exceeds MAX_BYTES limit');
  } else if (fs.existsSync(file)) {
    throw Error('Destination already exists (wx prevents overwrite): ' + file);
  }
  const notify = record => { if (options.onStatus) options.onStatus(record); };
  let active = null, settled = false, created = false, fd = null, bytes = 0, timer, source;
  const hash = crypto.createHash('sha256');
  let resolveCompletion;
  const completion = new Promise(resolve => { resolveCompletion = resolve; });
  const server = net.createServer({ allowHalfOpen: true });

  function finish(initialError) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    let error = initialError;
    if (mode === 'send' && !error && bytes !== expectedBytes) error = Error('Source length changed during transmission');
    if (fd !== null) {
      try { if (!error) fs.fsyncSync(fd); }
      catch (syncError) { error = error || syncError; }
      try { fs.closeSync(fd); }
      catch (closeError) { error = error || closeError; }
      fd = null;
    }
    if (error && created) {
      // Only the exact, constrained path successfully created by THIS wx open is removable.
      try { fs.unlinkSync(file); }
      catch (unlinkError) { error = Error(error.message + '; partial file cleanup failed: ' + unlinkError.message); }
    }
    if (source && error) source.destroy();
    if (active) {
      if (error) active.destroy();
      else active.end();
    }
    server.close();
    const result = error
      ? { status: 'failed', complete: false, mode, file, bytes, sha256: null, error: error.message }
      : { status: 'transport-complete', complete: true, mode, file, bytes, sha256: hash.digest('hex'),
          fileSynced: mode === 'receive', note: 'Transport EOF only; verify expected SHA256, archive integrity and source partition size separately.' };
    notify(result);
    resolveCompletion(result);
  }
  server.on('connection', socket => {
    socket.on('error', error => { if (active === socket) finish(error); });
    if (active || socket.remoteAddress !== peer) {
      socket.destroy();
      return;
    }
    active = socket;
    // Stop accepting immediately. The one accepted connection remains open.
    server.close();
    socket.setNoDelay(true);
    notify({ status: 'connected', mode, peer: socket.remoteAddress, file });
    if (mode === 'send') {
      source = fs.createReadStream(file);
      const meter = new Transform({ transform(chunk, encoding, callback) {
        if (bytes + chunk.length > maxBytes) return callback(Error('Transmission exceeds MAX_BYTES limit'));
        bytes += chunk.length; hash.update(chunk); callback(null, chunk);
      } });
      // allowHalfOpen:true preserves writes when BusyBox nc stdin EOF has already sent FIN.
      pipeline(source, meter, socket, error => finish(error));
    } else {
      socket.on('close', () => { if (!settled) finish(Error('Connection closed before transfer EOF/completion')); });
      try { fd = fs.openSync(file, 'wx'); created = true; }
      catch (error) { finish(error); return; }
      socket.on('data', chunk => {
        if (settled) return;
        if (bytes + chunk.length > maxBytes) { finish(Error('Receive exceeds MAX_BYTES limit')); return; }
        try {
          let offset = 0;
          while (offset < chunk.length) {
            const written = fs.writeSync(fd, chunk, offset, chunk.length - offset);
            if (written <= 0) throw Error('Unable to write received file bytes');
            offset += written; bytes += written;
          }
          hash.update(chunk);
        } catch (error) { finish(error); }
      });
      socket.on('end', () => finish()); // fsync+close happen BEFORE our FIN/completion report.
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host, port, exclusive: true }, () => { server.removeListener('error', reject); resolve(); });
  });
  server.on('error', finish);
  timer = setTimeout(() => finish(Error('Transfer timed out before completion')), timeoutMs);
  const address = server.address();
  notify({ status: 'listening', mode, host: address.address, port: address.port, peer, file, maxBytes, timeoutMs });
  return { address, completion, cancel: () => finish(Error('Transfer cancelled before completion')) };
}

async function main(argv) {
  if (argv.length === 1 && argv[0] === '--help') {
    console.log('node tcp-file.cjs send|receive HOST PORT PEER FILE [MAX_BYTES]\n' +
      'Raw bytes; one authorized IPv4 connection; fixed local path; ten-minute total timeout.\n' +
      'HOST must be a specific local IPv4; PEER is the permitted IPv4 client. Default MAX_BYTES=1073741824.\n' +
      'receive uses wx, syncs at peer EOF, and deletes its own incomplete file on failure.\n' +
      'Status records are JSON lines; transport-complete is not an archive/content validation.');
    return;
  }
  if (argv.length !== 5 && argv.length !== 6) throw Error('Usage: tcp-file.cjs send|receive HOST PORT PEER FILE [MAX_BYTES]');
  const [mode, host, port, peer, file, maxBytes] = argv;
  const transfer = await startTransfer({ mode, host, port, peer, file, maxBytes, onStatus: value => console.log(JSON.stringify(value)) });
  const signal = () => transfer.cancel();
  process.once('SIGINT', signal); process.once('SIGTERM', signal);
  const result = await transfer.completion;
  process.removeListener('SIGINT', signal); process.removeListener('SIGTERM', signal);
  if (!result.complete) process.exitCode = 1;
}
module.exports = { startTransfer };
if (require.main === module) {
  main(process.argv.slice(2)).catch(error => {
    console.error(JSON.stringify({ status: 'failed', complete: false, sha256: null, error: error.message }));
    process.exitCode = 1;
  });
}
