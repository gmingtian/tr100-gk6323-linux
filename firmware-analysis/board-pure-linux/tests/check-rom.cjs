'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const bash = 'C:/Program Files/Git/bin/bash.exe';
const scripts = ['usr/local/sbin/tr100-rom-bootstrap', 'usr/local/sbin/tr100-network',
  'usr/local/libexec/tr100-udhcpc-hook', 'usr/local/sbin/tr100-ssh-hostkeys', 'usr/sbin/mdev'];
for (const p of scripts) {
  const name = path.join(root, 'overlay', p);
  const text = fs.readFileSync(name, 'utf8');
  assert(text.startsWith('#!/usr/lib/tr100/busybox sh\n'), p + ' has correct static interpreter');
  assert(!text.includes('\r'), p + ' must use Unix line endings');
  const r = cp.spawnSync(bash, ['-n', 'overlay/' + p], {cwd: root, encoding: 'utf8'});
  assert.equal(r.status, 0, p + ': ' + r.stderr);
}
for (const file of ['install-overlay.sh', 'prepare-identity.sh', 'check-stage.sh']) {
  const r = cp.spawnSync(bash, ['-n', file], {cwd: root, encoding: 'utf8'});
  assert.equal(r.status, 0, r.stderr);
  const refusal = cp.spawnSync(bash, [file, '/'], {cwd: root, encoding: 'utf8'});
  assert.equal(refusal.status, 2); assert.match(refusal.stderr, /Refusing host root/);
}
const refusal = cp.spawnSync(bash, ['overlay/usr/local/sbin/tr100-rom-bootstrap'], {cwd: root, encoding: 'utf8'});
assert.equal(refusal.status, 2);
assert.match(refusal.stderr, /requires PID 1/);
const hook = 'overlay/usr/local/libexec/tr100-udhcpc-hook';
function run(event, env = {}) {
  return cp.spawnSync(bash, [hook, '--dry-run', event], {cwd: root,
    env: {...process.env, interface: 'eth0', ip: '192.168.5.82', subnet: '255.255.255.0',
      router: '192.168.5.1', dns: '192.168.5.1 1.1.1.1', ...env}, encoding: 'utf8'});
}
for (const event of ['bound', 'renew']) {
  const r = run(event); assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /address replace 192\.168\.5\.82\/24 dev eth0/);
  assert.match(r.stdout, /route replace default via 192\.168\.5\.1 dev eth0/);
  assert.match(r.stdout, /nameserver 1\.1\.1\.1/);
}
assert.match(run('deconfig').stdout, /address flush dev eth0 scope global/);
for (const bad of [{interface: 'lo'}, {ip: '999.1.1.1'}, {ip: '1.2.3.4;touch /tmp/owned'},
  {subnet: '255.0.255.0'}, {router: '1.2.3.4;echo bad'}, {dns: '8.8.8.8 $(touch /tmp/owned)'}]) {
  const r = run('bound', bad); assert.notEqual(r.status, 0, JSON.stringify(bad));
  assert.equal(r.stdout, '', 'Reject bad lease before any network action');
}
assert.notEqual(run('unknown').status, 0);
assert.equal(run('bound', {router: '', dns: ''}).status, 0, 'router and DNS are optional DHCP options');
for (let bits = 0; bits <= 32; bits++) {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  const subnet = [24, 16, 8, 0].map(shift => (mask >>> shift) & 255).join('.');
  const r = run('bound', {subnet});
  assert.equal(r.status, 0, subnet + ': ' + r.stderr);
  assert(r.stdout.includes('192.168.5.82/' + bits + ' dev eth0'), subnet);
}
for (const ip of ['01.2.3.4', '1.2.3', '1.2.3.4.5', '.1.2.3', '1..2.3', '-1.2.3.4', '*']) {
  const r = run('bound', {ip}); assert.notEqual(r.status, 0, ip); assert.equal(r.stdout, '');
}
const links = JSON.parse(fs.readFileSync(path.join(root, 'symlinks.json')));
for (const unit of ['systemd-repart.service', 'fstrim.timer', 'fstrim.service', 'e2scrub_all.timer', 'e2scrub_all.service', 'e2scrub_reap.service'])
  assert(links.some(l => l.path === 'etc/systemd/system/' + unit && l.target === '/dev/null'), unit);
assert(!links.some(l => /tr100-ram/.test(l.path + l.target)));
assert(links.some(l => l.path === 'etc/systemd/system-generators/systemd-gpt-auto-generator' && l.target === '/dev/null'), 'GPTauto is disabled without persistent bootargs changes');
assert(links.some(l => l.path === 'etc/localtime' && l.target === '/usr/share/zoneinfo/Asia/Shanghai'));
assert.equal(fs.readFileSync(path.join(root, 'overlay/etc/timezone'), 'utf8'), 'Asia/Shanghai\n');
const bootstrap = fs.readFileSync(path.join(root, 'overlay/usr/local/sbin/tr100-rom-bootstrap'), 'utf8');
assert(!bootstrap.includes('missing required boot argument'), 'legacy handoff must work with original cold-boot args');
const overlayText = scripts.map(p => fs.readFileSync(path.join(root, 'overlay', p), 'utf8')).join('\n');
assert(!/mkfs|mke2fs|resize2fs|\bmmc write\b/.test(overlayText), 'bootstrap has no format/resize commands');
const ssh = fs.readFileSync(path.join(root, 'overlay/etc/ssh/sshd_config.d/00-tr100.conf'), 'utf8');
assert.match(ssh, /^PasswordAuthentication yes$/m);
assert.match(ssh, /^PubkeyAuthentication yes$/m);
assert.match(ssh, /^PermitRootLogin yes$/m);
assert.match(ssh, /^AuthenticationMethods any$/m);
assert.match(ssh, /^KbdInteractiveAuthentication no$/m);
assert.match(ssh, /^PermitEmptyPasswords no$/m);
assert(!bootstrap.includes('public-key-only'), 'bootstrap log follows explicitly enabled password and key authentication');
const sshUnit = fs.readFileSync(path.join(root, 'overlay/etc/systemd/system/ssh.service.d/tr100.conf'), 'utf8');
assert.match(sshUnit, /^ExecStartPre=$/m, 'reset upstream sshd -t before appending first-boot host-key generation');
assert(sshUnit.indexOf('ExecStartPre=/usr/local/sbin/tr100-ssh-hostkeys') < sshUnit.indexOf('ExecStartPre=/usr/sbin/sshd -t'));
const exclusions = JSON.parse(fs.readFileSync(path.join(root, 'remove-paths.json')));
assert(exclusions.includes('etc/systemd/system/serial-getty@ttyAMA0.service.d/tr100-ram-autologin.conf'));
for (const p of exclusions) assert(!p.startsWith('/') && !p.split('/').includes('..'));
const modes = JSON.parse(fs.readFileSync(path.join(root, 'file-modes.json')));
for (const p of scripts) assert(modes.executables.includes(p), p + ' is executable');
const hostHelper = fs.readFileSync(path.join(root, 'overlay/usr/local/sbin/tr100-ssh-hostkeys'), 'utf8');
assert(!/\brm\b/.test(hostHelper), 'persistent host-key generation must not delete existing keys');
const stage = fs.mkdtempSync(path.join(__dirname, '.identity-fixture-'));
try {
  fs.mkdirSync(path.join(stage, 'etc/tr100'), {recursive: true});
  fs.mkdirSync(path.join(stage, 'var/lib/dbus'), {recursive: true});
  fs.mkdirSync(path.join(stage, 'usr/sbin'), {recursive: true});
  const fixtures = {
    'etc/os-release': 'PRETTY_NAME="Armbian 26.11.0-trunk.123 bookworm"\nID=debian\nVERSION_CODENAME=bookworm\n',
    'etc/tr100/image-tag': 'tr100-pure-linux-20261111\n',
    'etc/group': 'root:x:0:\nnogroup:x:65534:\n',
    'etc/gshadow': 'root:*::\nnogroup:*::\n',
    'etc/passwd': 'root:x:0:0:root:/root:/bin/bash\n_apt:x:42:65534::/nonexistent:/usr/sbin/nologin\nsystemd-timesync:x:996:996:systemd Time Synchronization:/:/usr/sbin/nologin\n',
    'etc/shadow': 'root:!:20000:0:99999:7:::\n_apt:*:20000:0:99999:7:::\n',
    'etc/hostname': '562972817fa2\n', 'etc/machine-id': 'cached-container-id\n'
  };
  for (const [p, text] of Object.entries(fixtures)) fs.writeFileSync(path.join(stage, p), text);
  fs.mkdirSync(path.join(stage, 'var/lib/dpkg'), {recursive: true});
  fs.writeFileSync(path.join(stage, 'var/lib/dpkg/status'), 'Package: systemd\nStatus: install ok installed\nArchitecture: armhf\nVersion: 252.39-1~deb12u2\n\n');
  fs.writeFileSync(path.join(stage, 'usr/sbin/policy-rc.d'), '#!/bin/sh\nexit 101');
  const posix = stage.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive) => '/' + drive.toLowerCase());
  assert(!fs.existsSync(path.join(stage, 'etc/armbian-release')), 'real source cache has no armbian-release');
  const checked = cp.spawnSync(bash, ['check-stage.sh', posix], {cwd: root, encoding: 'utf8'});
  assert.equal(checked.status, 0, checked.stderr);
  assert(!fs.readFileSync(path.join(root, 'install-overlay.sh'), 'utf8').includes('etc/armbian-release'));
  const r = cp.spawnSync(bash, ['prepare-identity.sh', posix], {cwd: root, encoding: 'utf8'});
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(path.join(stage, 'etc/passwd'), 'utf8'), /^_apt:x:42:3003:/m);
  assert.match(fs.readFileSync(path.join(stage, 'etc/passwd'), 'utf8'), /^systemd-timesync:x:996:3003:/m);
  const expectedPasswd = fs.readFileSync(path.join(stage, 'etc/passwd'), 'utf8');
  fs.writeFileSync(path.join(stage, 'etc/passwd'), expectedPasswd.replace('systemd-timesync:x:996:', 'systemd-timesync:x:997:'));
  const unexpectedUid = cp.spawnSync(bash, ['prepare-identity.sh', posix], {cwd: root, encoding: 'utf8'});
  assert.notEqual(unexpectedUid.status, 0, 'unexpected timesync source UID requires explicit review');
  fs.writeFileSync(path.join(stage, 'etc/passwd'), expectedPasswd);
  assert.match(fs.readFileSync(path.join(stage, 'etc/group'), 'utf8'), /^inet:x:3003:_apt$/m);
  assert.match(fs.readFileSync(path.join(stage, 'etc/gshadow'), 'utf8'), /^inet:!::_apt$/m);
  assert.equal(fs.readFileSync(path.join(stage, 'etc/machine-id'), 'utf8'), '');
  assert.equal(fs.readFileSync(path.join(stage, 'etc/hostname'), 'utf8'), 'tr100\n');
  assert.equal(fs.readFileSync(path.join(stage, 'etc/shadow'), 'utf8'), fixtures['etc/shadow']);
  assert(!fs.readFileSync(path.join(stage, 'etc/hosts'), 'utf8').includes('562972817fa2'));
  assert(!fs.existsSync(path.join(stage, 'usr/sbin/policy-rc.d')), 'remove only exact cache service-blocking policy');
  const customPolicy = '#!/bin/sh\nexit 0\n';
  fs.writeFileSync(path.join(stage, 'usr/sbin/policy-rc.d'), customPolicy);
  const again = cp.spawnSync(bash, ['prepare-identity.sh', posix], {cwd: root, encoding: 'utf8'});
  assert.equal(again.status, 0, again.stderr);
  assert.equal(fs.readFileSync(path.join(stage, 'usr/sbin/policy-rc.d'), 'utf8'), customPolicy, 'preserve custom service policy');
  const outside = fs.mkdtempSync(path.join(__dirname, '.policy-outside-fixture-'));
  try {
    fs.writeFileSync(path.join(outside, 'policy-rc.d'), '#!/bin/sh\nexit 101');
    fs.unlinkSync(path.join(stage, 'usr/sbin/policy-rc.d'));
    fs.rmdirSync(path.join(stage, 'usr/sbin'));
    fs.symlinkSync(outside, path.join(stage, 'usr/sbin'), 'junction');
    const linked = cp.spawnSync(bash, ['prepare-identity.sh', posix], {cwd: root, encoding: 'utf8'});
    assert.notEqual(linked.status, 0, 'refuse policy parent that links outside stage');
    assert.equal(fs.readFileSync(path.join(outside, 'policy-rc.d'), 'utf8'), '#!/bin/sh\nexit 101');
  } finally {
    if (fs.lstatSync(path.join(stage, 'usr/sbin')).isSymbolicLink()) fs.unlinkSync(path.join(stage, 'usr/sbin'));
    fs.mkdirSync(path.join(stage, 'usr/sbin'), {recursive: true});
    const checkedOutside = fs.realpathSync(outside);
    assert(checkedOutside.startsWith(fs.realpathSync(root) + path.sep));
    fs.rmSync(checkedOutside, {recursive: true, force: true});
  }
  const passwd = fs.readFileSync(path.join(stage, 'etc/passwd'), 'utf8');
  fs.appendFileSync(path.join(stage, 'etc/group'), 'conflict:x:3003:\n');
  const conflict = cp.spawnSync(bash, ['prepare-identity.sh', posix], {cwd: root, encoding: 'utf8'});
  assert.notEqual(conflict.status, 0);
  assert.equal(fs.readFileSync(path.join(stage, 'etc/passwd'), 'utf8'), passwd, 'GID conflict is refused before passwd mutation');
} finally {
  const resolved = fs.realpathSync(stage);
  assert(resolved.startsWith(fs.realpathSync(root) + path.sep), 'fixture cleanup remains inside board-rom');
  fs.rmSync(resolved, {recursive: true, force: true});
}
console.log('PASS: eight shell syntax checks; PID1/host-root refusal; DHCP valid/invalid leases and all 33 masks; actual-cache guard; _apt/timesync primary GID3003 with UIDs preserved; identity/policy/junction fixtures; masks and password/key SSH ordering. No hardware commands executed.');
