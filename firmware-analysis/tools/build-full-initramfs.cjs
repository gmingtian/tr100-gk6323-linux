'use strict';
// RAMONLY tar -> newc converter. No device access, flashing, or Windows rootfs extraction.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const {Readable, Transform} = require('node:stream');
const {pipeline} = require('node:stream/promises');
const decoder = new TextDecoder('utf-8', {fatal: true});
const TYPES = {'0': 0o100000, '7': 0o100000, '1': 0o100000, '2': 0o120000,
  '3': 0o020000, '4': 0o060000, '5': 0o040000, '6': 0o010000};
const HOST_KEYS = new Set(['rsa', 'ecdsa', 'ed25519'].flatMap(k =>
  [`etc/ssh/ssh_host_${k}_key`, `etc/ssh/ssh_host_${k}_key.pub`]));
const pad = (n, a) => (a - n % a) % a;
function uint(n, label = 'newc field') {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw Error(`Invalid ${label}: ${n}`);
  return n;
}
function safeName(name) {
  if (typeof name !== 'string' || name.includes('\0') || name.startsWith('/'))
    throw Error('Unsafe absolute or NUL archive path');
  const parts = name.split('/');
  if (parts.includes('..')) throw Error('Unsafe traversal archive path');
  const result = parts.filter(s => s && s !== '.').join('/') || '.';
  if (Buffer.byteLength(result) > 65535) throw Error('Archive pathname too long');
  return result;
}
function octal(text, label) {
  if (typeof text !== 'string' || !/^[0-7]{3,4}$/.test(text)) throw Error(`Invalid ${label} mode`);
  return parseInt(text, 8);
}
function tarString(h, start, length) {
  const b = h.subarray(start, start + length), zero = b.indexOf(0);
  return decoder.decode(zero < 0 ? b : b.subarray(0, zero));
}
function tarNumber(h, start, length) {
  const b = h.subarray(start, start + length);
  if (b[0] & 128) {
    if (b[0] & 64) throw Error('Negative base-256 tar number unsupported');
    let n = BigInt(b[0] & 127);
    for (const byte of b.subarray(1)) n = (n << 8n) + BigInt(byte);
    if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('Tar number exceeds safe integer');
    return Number(n);
  }
  const s = b.toString('ascii').replace(/\0.*$/s, '').trim();
  if (s && !/^[0-7]+$/.test(s)) throw Error('Invalid octal tar number');
  return s ? parseInt(s, 8) : 0;
}
function parsePax(b) {
  const result = {};
  for (let offset = 0; offset < b.length;) {
    const space = b.indexOf(32, offset);
    if (space < 0) throw Error('Invalid PAX record');
    const digits = b.toString('ascii', offset, space);
    if (!/^[1-9][0-9]*$/.test(digits)) throw Error('Invalid PAX record length');
    const length = Number(digits), end = offset + length;
    if (end > b.length || end <= space + 2 || b[end - 1] !== 10) throw Error('Invalid PAX extent');
    const raw = b.subarray(space + 1, end - 1), eq = raw.indexOf(61);
    if (eq < 1) throw Error('Invalid PAX key');
    const key = decoder.decode(raw.subarray(0, eq)), value = raw.subarray(eq + 1);
    result[key] = /^(SCHILY|LIBARCHIVE)\.xattr\./.test(key) ? Buffer.from(value) : decoder.decode(value);
    offset = end;
  }
  return result;
}
function readAt(fd, offset, size) {
  const b = Buffer.alloc(size);
  let read = 0;
  while (read < size) {
    const n = fs.readSync(fd, b, read, size - read, offset + read);
    if (!n) throw Error(`Truncated tar extent at ${offset}`);
    read += n;
  }
  return b;
}
async function scanTar(tarPath) {
  const fd = fs.openSync(tarPath, 'r');
  try {
    const length = fs.fstatSync(fd).size;
    if (length % 512) throw Error('Truncated tar or trailing unaligned bytes');
    const entries = [], names = new Map();
    let offset = 0, zeros = 0, global = {}, next = {}, longName, longLink;
    while (offset < length) {
      const h = readAt(fd, offset, 512);
      if (h.every(x => x === 0)) { zeros++; offset += 512; continue; }
      if (zeros) throw Error('Nonzero trailing bytes after tar EOF');
      let checksum = 0;
      for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : h[i];
      if (checksum !== tarNumber(h, 148, 8)) throw Error(`Tar checksum mismatch at ${offset}`);
      const type = tarString(h, 156, 1) || '0';
      const extension = ['x', 'g', 'L', 'K'].includes(type);
      const attrs = {...global, ...next};
      let size = tarNumber(h, 124, 12);
      if (!extension && attrs.size !== undefined) size = Number(attrs.size);
      if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size + pad(size, 512) > length)
        throw Error(`Truncated or invalid tar extent at ${offset}`);
      const bodyOffset = offset + 512;
      const padding = readAt(fd, bodyOffset + size, pad(size, 512));
      if (padding.some(x => x !== 0)) throw Error(`Nonzero tar body padding at ${offset}`);
      if (extension) {
        if (size > 4 * 1024 * 1024) throw Error('Tar metadata record too large');
        const body = readAt(fd, bodyOffset, size);
        if (type === 'x') next = {...next, ...parsePax(body)};
        if (type === 'g') global = {...global, ...parsePax(body)};
        if (type === 'L') longName = decoder.decode(body).replace(/\0.*$/s, '');
        if (type === 'K') longLink = decoder.decode(body).replace(/\0.*$/s, '');
      } else {
        if (!(type in TYPES)) throw Error(`Unsupported tar type ${type}`);
        if (Object.keys(attrs).some(k => /sparse/.test(k)))
          throw Error('Unsupported sparse tar metadata; refusing silent loss');
        const prefix = tarString(h, 345, 155);
        const name = safeName(attrs.path ?? longName ?? ((prefix ? prefix + '/' : '') + tarString(h, 0, 100)));
        if (names.has(name)) throw Error(`Duplicate normalized tar path: ${name}`);
        let link = attrs.linkpath ?? longLink ?? tarString(h, 157, 100);
        if (type === '1') link = safeName(link);
        if (link.includes('\0')) throw Error('Unsafe NUL link target');
        if (type !== '0' && type !== '7' && size !== 0) throw Error('Non-regular tar entry has data');
        const uid = uint(attrs.uid === undefined ? tarNumber(h, 108, 8) : Number(attrs.uid), 'uid');
        const gid = uint(attrs.gid === undefined ? tarNumber(h, 116, 8) : Number(attrs.gid), 'gid');
        const mtime = uint(Math.floor(attrs.mtime === undefined ? tarNumber(h, 136, 12) : Number(attrs.mtime)), 'mtime');
        const entry = {name, type, mode: TYPES[type] | (tarNumber(h, 100, 8) & 0o7777), uid, gid, mtime,
          size: uint(size, 'file size'), link, major: tarNumber(h, 329, 8), minor: tarNumber(h, 337, 8),
          source: {kind: 'tar', path: path.resolve(tarPath), offset: bodyOffset, size}, paxKeys: Object.keys(attrs),
          xattrs: Object.fromEntries(Object.entries(attrs).filter(([k]) => /^(SCHILY|LIBARCHIVE)\.xattr\./.test(k)))};
        if (name === '.' && type !== '5') throw Error('Archive root must be directory');
        entries.push(entry); names.set(name, entry);
        next = {}; longName = longLink = undefined;
      }
      offset = bodyOffset + size + pad(size, 512);
    }
    if (zeros < 2) throw Error('Missing two-block tar EOF');
    if (Object.keys(next).length || longName !== undefined || longLink !== undefined) throw Error('Dangling tar metadata');
    function root(entry, visiting = new Set()) {
      if (entry.type !== '1') return entry;
      if (visiting.has(entry)) throw Error('Cyclic tar hardlink');
      visiting.add(entry);
      const target = names.get(entry.link);
      if (!target) throw Error(`Missing tar hardlink target: ${entry.link}`);
      const original = root(target, visiting);
      if (!['0', '7'].includes(original.type)) throw Error('Hardlink target is not regular file');
      if (entry.mode !== original.mode || entry.uid !== original.uid || entry.gid !== original.gid)
        throw Error('Inconsistent tar hardlink ownership or mode');
      return original;
    }
    for (const entry of entries) if (['0', '7', '1'].includes(entry.type)) entry.content = root(entry);
    return entries;
  } finally { fs.closeSync(fd); }
}
async function hashFile(filename) {
  const hash = crypto.createHash('sha256');
  for await (const b of fs.createReadStream(filename)) hash.update(b);
  return hash.digest('hex');
}
function regular(name, source, mode = 0o644, uid = 0, gid = 0) {
  const entry = {name: safeName(name), type: '0', mode: 0o100000 | mode, uid, gid, mtime: 0,
    size: source.size, link: '', major: 0, minor: 0, source};
  entry.content = entry;
  return entry;
}
function validateStaticBusybox(filename) {
  const b = fs.readFileSync(filename);
  if (b.length < 52 || b.toString('hex', 0, 4) !== '7f454c46' || b[4] !== 1 || b[5] !== 1 || b.readUInt16LE(18) !== 40)
    throw Error('BusyBox must be little-endian ARM32 ELF');
  const start = b.readUInt32LE(28), stride = b.readUInt16LE(42), count = b.readUInt16LE(44);
  if (stride < 32 || start + stride * count > b.length) throw Error('Invalid BusyBox program header table');
  for (let i = 0; i < count; i++) if ([2, 3].includes(b.readUInt32LE(start + i * stride)))
    throw Error('BusyBox must be static without PT_INTERP or PT_DYNAMIC');
  if (!b.includes(Buffer.from([109, 100, 101, 118, 0]))) throw Error('BusyBox mdev applet missing');
}
function readPublicKey(filename) {
  if (path.extname(filename).toLowerCase() !== '.pub') throw Error('Authorized key input must be a .pub public-key file');
  const data = fs.readFileSync(filename, 'utf8').trim();
  if (data.length > 16384 || /PRIVATE KEY|[\r\n]/.test(data) || !/^(ssh-(rsa|ed25519)|ecdsa-sha2-nistp(256|384|521)) [A-Za-z0-9+/]+={0,2}(?: .*)?$/.test(data))
    throw Error('Invalid OpenSSH public key; private keys are never read');
  return Buffer.from(data + '\n');
}
async function buildFullInitramfs(options) {
  const {tarPath, expectedTarSHA256, outputPath} = options;
  if (!outputPath || !/RAMONLY/.test(path.basename(outputPath)) || !outputPath.endsWith('.cpio.gz'))
    throw Error('Output must be explicitly named RAMONLY*.cpio.gz');
  if (!/^[a-f0-9]{64}$/.test(expectedTarSHA256 || '')) throw Error('Expected source tar SHA256 is mandatory');
  const sourceHash = await hashFile(tarPath);
  if (sourceHash !== expectedTarSHA256) throw Error('Source tar SHA256 mismatch');
  const sourceStat = fs.statSync(tarPath), original = await scanTar(tarPath);
  const final = new Map(original.filter(e => !HOST_KEYS.has(e.name)).map(e => [e.name, e]));
  const modes = options.fileModes || {uid: 0, gid: 0, defaultRegularMode: '0644', defaultDirectoryMode: '0755', executables: [], initialDeviceNodes: []};
  const uid = uint(modes.uid ?? 0, 'overlay uid'), gid = uint(modes.gid ?? 0, 'overlay gid');
  const fileMode = octal(modes.defaultRegularMode || '0644', 'regular'), dirMode = octal(modes.defaultDirectoryMode || '0755', 'directory');
  const executableMode = octal(modes.executableMode || '0755', 'executable');
  const executables = new Set((modes.executables || []).map(safeName));
  const replacements = [];
  function put(e, origin) {
    if (final.has(e.name)) replacements.push({name: e.name, origin});
    final.set(e.name, e);
  }
  function directory(name, mode = dirMode, replace = false) {
    name = safeName(name);
    const old = final.get(name);
    if (old && !replace) {
      if (old.type !== '5') throw Error(`Non-directory archive parent: ${name}`);
      return;
    }
    put({name, type: '5', mode: 0o040000 | mode, uid, gid, mtime: 0, size: 0, link: '', major: 0, minor: 0}, 'directory');
  }
  function parents(name) {
    const pieces = name.split('/');
    for (let i = 1; i < pieces.length; i++) directory(pieces.slice(0, i).join('/'));
  }
  function addFile(name, local, mode = fileMode) {
    name = safeName(name); parents(name);
    const st = fs.lstatSync(local);
    if (!st.isFile()) throw Error(`Addition must be a regular local file: ${name}`);
    put(regular(name, {kind: 'file', path: path.resolve(local), size: st.size}, mode, uid, gid), 'local file');
  }
  function walk(folder, relative = '') {
    for (const d of fs.readdirSync(folder, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const name = safeName(relative ? relative + '/' + d.name : d.name), local = path.join(folder, d.name);
      if (d.isSymbolicLink()) throw Error('Windows overlay symlinks are forbidden; use symlinks.json');
      if (d.isDirectory()) { directory(name); walk(local, name); }
      else if (d.isFile()) addFile(name, local, executables.has(name) ? executableMode : fileMode);
      else throw Error('Overlay contains unsupported local file type');
    }
  }
  if (options.overlayPath) walk(options.overlayPath);
  // BusyBox dispatches by argv[0]; the real filename must retain basename "busybox".
  if (options.busyboxPath) { validateStaticBusybox(options.busyboxPath); addFile('usr/lib/tr100/busybox', options.busyboxPath, 0o755); }
  if (options.authorizedKeyPath) {
    const data = readPublicKey(options.authorizedKeyPath);
    directory('root', 0o700, true); directory('root/.ssh', 0o700, true);
    put(regular('root/.ssh/authorized_keys', {kind: 'buffer', buffer: data, size: data.length}, 0o600), 'PC public key');
  }
  for (const module of options.modules || []) addFile(module.archivePath, module.sourcePath, 0o644);
  for (const link of options.symlinks || []) {
    const name = safeName(link.path); parents(name);
    if (typeof link.target !== 'string' || link.target.includes('\0')) throw Error('Unsafe symlink target');
    put({name, type: '2', mode: 0o120777, uid, gid, mtime: 0, size: 0, link: link.target, major: 0, minor: 0}, 'symlinks.json');
  }
  for (const node of modes.initialDeviceNodes || []) {
    const name = safeName(node.path); parents(name);
    if (!['char', 'block'].includes(node.type)) throw Error('Invalid device node type');
    put({name, type: node.type === 'char' ? '3' : '4', mode: (node.type === 'char' ? 0o020000 : 0o060000) | octal(node.mode, 'device'),
      uid, gid, mtime: 0, size: 0, link: '', major: uint(node.major), minor: uint(node.minor)}, 'file-modes.json');
  }
  // Resolve all final parents before writing: an archive path must never traverse a symlink.
  for (const e of [...final.values()]) parents(e.name);
  for (const name of executables) if (!final.has(name)) throw Error(`Executable declared but absent: ${name}`);
  const entries = [...final.values()].sort((a, b) => {
    const depth = s => s.name === '.' ? 0 : s.name.split('/').length;
    return depth(a) - depth(b) || Buffer.compare(Buffer.from(a.name), Buffer.from(b.name));
  });
  const groups = new Map();
  for (const e of entries) if (e.content) {
    if (!groups.has(e.content)) groups.set(e.content, []);
    groups.get(e.content).push(e);
  }
  let inode = 1;
  for (const e of entries) {
    if (e.content) {
      if (!e.content.cpioInode) e.content.cpioInode = inode++;
      e.inode = e.content.cpioInode;
    } else e.inode = inode++;
  }
  const inputFiles = [...new Set(entries.filter(e => e.content?.source.kind === 'file').map(e => e.content.source.path))];
  const additions = [];
  for (const filename of inputFiles) additions.push({file: filename, bytes: fs.statSync(filename).size, sha256: await hashFile(filename)});
  const cpioHash = crypto.createHash('sha256'), gzipHash = crypto.createHash('sha256');
  let cpioBytes = 0, gzipBytes = 0;
  async function* archive() {
    let total = 0;
    function* block(name, mode, owner, group, nlink, mtime, ino, size, major, minor) {
      const namesize = Buffer.byteLength(name) + 1;
      const fields = [ino, mode, owner, group, nlink, mtime, size, 0, 0, major, minor, namesize, 0];
      const h = Buffer.from('070701' + fields.map(n => uint(n).toString(16).padStart(8, '0')).join(''));
      const bytes = Buffer.concat([h, Buffer.from(name + '\0'), Buffer.alloc(pad(110 + namesize, 4))]);
      total += bytes.length; yield bytes;
    }
    for (const e of entries) {
      const members = e.content ? groups.get(e.content) : null;
      const emitContent = members && members.at(-1) === e;
      const data = e.type === '2' ? Buffer.from(e.link) : null;
      const size = data ? data.length : emitContent ? e.content.source.size : 0;
      yield* block(e.name, e.mode, e.uid, e.gid, members ? members.length : e.type === '5' ? 2 : 1,
        e.mtime, e.inode, size, e.major, e.minor);
      if (data) { total += data.length; yield data; }
      else if (emitContent && size) {
        const source = e.content.source;
        if (source.kind === 'buffer') { total += source.buffer.length; yield source.buffer; }
        else {
          let read = 0;
          const start = source.kind === 'tar' ? source.offset : 0;
          for await (const b of fs.createReadStream(source.path, {start, end: start + size - 1})) {
            read += b.length; total += b.length; yield b;
          }
          if (read !== size) throw Error('Source changed or truncated during CPIO streaming');
        }
      }
      const padding = pad(size, 4); total += padding; if (padding) yield Buffer.alloc(padding);
    }
    yield* block('TRAILER!!!', 0, 0, 0, 1, 0, inode++, 0, 0, 0);
    const padding = pad(total, 512); if (padding) yield Buffer.alloc(padding);
  }
  const partial = outputPath + '.partial';
  const protectedPaths = [tarPath, ...inputFiles, options.authorizedKeyPath].filter(Boolean).map(p => path.resolve(p).toLowerCase());
  for (const filename of [outputPath, partial, outputPath + '.manifest.json'])
    if (protectedPaths.includes(path.resolve(filename).toLowerCase())) throw Error('Output collides with an input file');
  fs.mkdirSync(path.dirname(outputPath), {recursive: true});
  let ownsPartial = false;
  try {
    const outputFd = fs.openSync(partial, 'wx');
    ownsPartial = true;
    await pipeline(Readable.from(archive()), new Transform({transform(b, enc, cb) { cpioHash.update(b); cpioBytes += b.length; cb(null, b); }}),
      zlib.createGzip({level: options.gzipLevel ?? 6}), new Transform({transform(b, enc, cb) { gzipHash.update(b); gzipBytes += b.length; cb(null, b); }}),
      fs.createWriteStream(partial, {fd: outputFd, autoClose: true}));
    const now = fs.statSync(tarPath);
    if (now.size !== sourceStat.size || now.mtimeMs !== sourceStat.mtimeMs || await hashFile(tarPath) !== sourceHash)
      throw Error('Source tar changed while building');
    for (const input of additions) if (await hashFile(input.file) !== input.sha256) throw Error('Addition changed while building');
    const manifest = {schemaVersion: 1, ramOnly: true, romImage: false, persistence: 'RAM ONLY; do not write to eMMC or flash partitions',
      purpose: 'TR100 board overlay verification with full Armbian armhf userspace; no hardware validation implied',
      source: {tarPath: path.resolve(tarPath), bytes: sourceStat.size, sha256: sourceHash, tarEntries: original.length},
      output: {file: path.resolve(outputPath), format: 'gzip(newc)', gzipBytes, gzipSHA256: gzipHash.digest('hex'), cpioBytes, cpioSHA256: cpioHash.digest('hex')},
      finalEntries: entries.length, hardlinkGroups: [...groups.values()].filter(g => g.length > 1).map(g => g.map(e => e.name)),
      excludedUpstreamHostKeys: original.filter(e => HOST_KEYS.has(e.name)).map(e => e.name), replacements,
      additions, authorizedKey: options.authorizedKeyPath ? {source: path.resolve(options.authorizedKeyPath), included: true, contentsOmitted: true} : null,
      xattrsNotApplied: entries.flatMap(e => Object.entries(e.xattrs || {}).map(([key, value]) => ({name: e.name,
        key: key.replace(/^(SCHILY|LIBARCHIVE)\.xattr\./, ''), encoding: 'base64', value: value.toString('base64')}))),
      metadataPolicy: 'Preserves tar uid/gid/mode, names, symlinks and regular hardlink relationships; mtime fractional seconds truncated to newc integer seconds. PAX atime/ctime and xattrs have no newc representation. Raw xattrs are retained in this manifest as unapplied metadata.',
      boardOverlay: options.overlayPath ? path.resolve(options.overlayPath) : null, hardwareTested: false};
    fs.renameSync(partial, outputPath);
    fs.writeFileSync(outputPath + '.manifest.json', JSON.stringify(manifest, null, 2) + '\n');
    return manifest;
  } catch (error) { if (ownsPartial && fs.existsSync(partial)) fs.unlinkSync(partial); throw error; }
}
module.exports = {scanTar, buildFullInitramfs};
if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2), options = {};
    for (let i = 0; i < args.length; i += 2) {
      if (!args[i].startsWith('--') || !args[i + 1]) throw Error('Arguments must be --name value pairs');
      if (options[args[i]]) throw Error('Duplicate command argument');
      options[args[i]] = args[i + 1];
    }
    for (const key of ['--tar', '--expected-tar-sha256', '--overlay', '--modes', '--symlinks', '--busybox', '--authorized-key', '--module-root', '--output'])
      if (!options[key]) throw Error(`Required argument ${key}`);
    const kernel = '3.18.24_gk6323v100c';
    const manifest = await buildFullInitramfs({tarPath: options['--tar'], expectedTarSHA256: options['--expected-tar-sha256'],
      overlayPath: options['--overlay'], fileModes: JSON.parse(fs.readFileSync(options['--modes'], 'utf8').replace(/^\uFEFF/, '')),
      symlinks: JSON.parse(fs.readFileSync(options['--symlinks'], 'utf8').replace(/^\uFEFF/, '')), busyboxPath: options['--busybox'],
      authorizedKeyPath: options['--authorized-key'], outputPath: options['--output'],
      modules: ['ehci-platform.ko', 'ohci-platform.ko'].map(name => ({sourcePath: path.join(options['--module-root'], name), archivePath: `usr/lib/modules/${kernel}/${name}`}))});
    console.log(JSON.stringify({ramOnly: manifest.ramOnly, romImage: manifest.romImage, output: manifest.output, entries: manifest.finalEntries}, null, 2));
  })().catch(error => { console.error(error.stack); process.exitCode = 1; });
}
