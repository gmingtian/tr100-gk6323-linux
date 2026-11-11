'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const bash = 'C:/Program Files/Git/bin/bash.exe';
const helper = 'overlay/usr/local/sbin/tr100-enable-network';
const script = fs.readFileSync(path.join(root, helper), 'utf8');
assert(script.startsWith('#!/usr/lib/tr100/busybox sh\n'));
assert.equal(cp.spawnSync(bash, ['-n', helper], {cwd: root}).status, 0);
const conf = fs.readFileSync(path.join(root, 'overlay/etc/adduser.conf'), 'utf8');
assert.match(conf, /^ADD_EXTRA_GROUPS=1$/m);
assert.match(conf, /^EXTRA_GROUPS="users inet"$/m, 'keep the real source default users group');
const fixture = fs.mkdtempSync(path.join(__dirname, '.network-fixture-'));
const posix = p => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive) => '/' + drive.toLowerCase());
const passwd = path.join(fixture, 'passwd'), group = path.join(fixture, 'group');
const users = 'root:x:0:0:root:/root:/bin/bash\naliasroot:x:0:0::/:/bin/false\nalice:x:1000:1000::/home/alice:/bin/bash\n_apt:x:42:3003::/nonexistent:/usr/sbin/nologin\nsystemd-timesync:x:996:3003::/:/usr/sbin/nologin\n';
const groups = 'root:x:0:\nusers:x:100:\ninet:x:3003:_apt\nalice:x:1000:\n';
function check(user, primary = false) {
  return cp.spawnSync(bash, [helper, '--check-files', posix(passwd), posix(group), ...(primary ? ['--primary'] : []), user], {cwd: root, encoding: 'utf8'});
}
try {
  fs.writeFileSync(passwd, users); fs.writeFileSync(group, groups);
  const r = check('alice'); assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /usermod -a -G inet alice/); assert.match(r.stdout, /uid=1000/);
  const p = check('alice', true); assert.equal(p.status, 0, p.stderr); assert.match(p.stdout, /usermod -g inet alice/);
  for (const name of ['_apt', 'systemd-timesync']) assert.equal(check(name).status, 0);
  for (const name of ['root', 'aliasroot', 'missing', '-a', '../root', 'a;b', '$(id)', 'a b', 'a'.repeat(33)])
    assert.notEqual(check(name).status, 0, 'reject ' + name);
  fs.writeFileSync(group, groups.replace('inet:x:3003:', 'inet:x:3004:'));
  assert.notEqual(check('alice').status, 0, 'wrong inet GID');
  fs.writeFileSync(group, groups + 'conflict:x:3003:\n');
  assert.notEqual(check('alice').status, 0, 'conflicting GID owner');
  fs.writeFileSync(group, groups); fs.writeFileSync(passwd, users + 'alice:x:1001:1001::/:/bin/false\n');
  assert.notEqual(check('alice').status, 0, 'duplicate local username');
  fs.writeFileSync(passwd, users);
  assert.equal(fs.readFileSync(passwd, 'utf8'), users);
  assert.equal(fs.readFileSync(group, 'utf8'), groups);
} finally {
  const resolved = fs.realpathSync(fixture);
  assert(resolved.startsWith(fs.realpathSync(root) + path.sep));
  fs.rmSync(resolved, {recursive: true, force: true});
}
console.log('PASS: new-user groups preserve users+inet; helper syntax; valid local accounts; default/explicit-primary plans; root, unknown, injection, duplicate and inet-conflict rejection. Read-only checks changed no account database.');
