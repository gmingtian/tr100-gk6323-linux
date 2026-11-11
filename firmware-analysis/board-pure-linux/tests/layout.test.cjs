'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const text = fs.readFileSync(path.join(root, 'overlay/usr/local/sbin/tr100-rom-bootstrap'), 'utf8');
const start = text.indexOf('# BEGIN PURE LAYOUT GUARDS\n'), end = text.indexOf('# END PURE LAYOUT GUARDS\n');
assert(start >= 0 && end > start);
const defs = text.slice(start, end);
const map = 'blkdevparts=mmcblk0:4M(fastboot),4M(bootargs),12M(kernel),4M(deviceinfo),2M(atf),8M(baseparam),8M(pqparam),-(rootfs)';
const bash = 'C:/Program Files/Git/bin/bash.exe';
function run(body, args) { return cp.spawnSync(bash, ['-c', defs + '\n' + body, 'test', ...args], {encoding:'utf8'}); }
assert.equal(run('tr100_pure_validate_cmdline "$1"', ['console=ttyAMA0,115200 ' + map + ' loglevel=0']).status, 0);
for (const cmd of ['', map.replace('12M(kernel)', '12M(recovery)'), map + ' ' + map, map + ' tr100.ramtest=1', map + ' tr100.root_sha256=abc', map.replace('-(rootfs)', '800M(system)')])
  assert.notEqual(run('tr100_pure_validate_cmdline "$1"', [cmd]).status, 0, cmd);
assert.equal(run('tr100_pure_validate_geometry "$@"', ['86016', '15183872', '259:0', '15269888']).status, 0);
for (let i=0;i<4;i++) { const a=['86016','15183872','259:0','15269888']; a[i]='wrong'; assert.notEqual(run('tr100_pure_validate_geometry "$@"', a).status, 0); }
assert(!text.includes('/dev/mmcblk0p16') && !text.includes('/dev/loop0'));
assert(text.includes('expected_device=/dev/mmcblk0p8 expected_devnum=259:0'));
assert(text.includes('a8d4abf7-6ae4-4f9b-a39a-ef1b79c63230'));
assert.equal(fs.readFileSync(path.join(root,'overlay/etc/tr100/image-tag'),'utf8'),'tr100-pure-linux-20261111\n');
assert.equal(7818182656 - 42*1048576, 7774142464);
assert.equal(86016+15183872,15269888);
console.log('PASS: pure map uniqueness, stale-mode refusal, exact p8/disk geometry, new identity, full-capacity arithmetic. No device actions.');
