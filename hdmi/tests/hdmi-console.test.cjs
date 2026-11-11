'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const wrapper = path.resolve(__dirname, '../bin/tr100-hdmi-console').replaceAll('\\', '/');
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
function run(code) {
  const result = spawnSync(bash, ['--noprofile', '--norc', '-s'], {
    input: `source '${wrapper}'\n${code}\n`, encoding: 'utf8', env: { ...process.env, BASH_ENV: '' },
  });
  if (result.error) throw result.error;
  return result;
}
const good = 'geometry 1280 720 1280 2160 16\nrgba 5/11,6/5,5/0,0/0';
test('wrapper exists and has valid Bash syntax', () => {
  assert.ok(fs.existsSync(wrapper), 'HDMI wrapper is not implemented');
  assert.equal(spawnSync(bash, ['-n', wrapper]).status, 0);
});
test('plan is available without platform, file checks, or framebuffer actions', () => {
  const r = run(`tr100_check_platform(){ echo BAD; return 1; }; tr100_check_files(){ echo BAD; return 1; }; tr100_initialize(){ echo BAD; return 1; }; tr100_launch(){ echo BAD; }; tr100_main --plan`);
  assert.equal(r.status, 0); assert.match(r.stdout, /RGB565/); assert.doesNotMatch(r.stdout, /BAD/);
});
test('unknown or multiple arguments fail before actions', () => {
  for (const args of ['--unknown', '--plan extra', '--start']) {
    const r = run(`tr100_run_start(){ echo BAD; }; tr100_main ${args}`);
    assert.notEqual(r.status, 0); assert.match(r.stderr, /REFUSED/); assert.doesNotMatch(r.stdout, /BAD/);
  }
});
test('identity gate accepts only Linux root, fixed kernel/tag and p8 ext4', () => {
  const valid = ['Linux','0','3.18.24_gk6323v100c','tr100-pure-linux-20261111','259:0 ext4'];
  const invoke = a => run(`tr100_validate_identity ${a.map(x => `'${x}'`).join(' ')}`);
  assert.equal(invoke(valid).status, 0);
  assert.equal(invoke([valid[0], valid[1], '5.10.165_gk6323-tr100-docker', valid[3], valid[4]]).status, 0);
  for (const [i, bad] of [[0,'MINGW64_NT'],[1,'1000'],[2,'4.9'],[2,'5.10.165_gk6323v100c'],[2,'5.10.165_gk6323-tr100-docker-extra'],[3,'tr100-bookworm-20261111'],[4,'0:2 rootfs'],[4,'259:8 ext4'],[4,'259:0 ext4\n259:0 ext4']]) {
    const args = [...valid]; args[i] = bad; assert.notEqual(invoke(args).status, 0);
  }
});
test('readback accepts the actual RGB565 geometry including fbset indentation', () => {
  const r = run(`tr100_validate_mode $'mode "1280x720"\n    geometry 1280 720 1280 2160 16\n    rgba 5/11,6/5,5/0,0/0\nendmode'`);
  assert.equal(r.status, 0, r.stderr);
});
test('readback refuses ARGB32, wrong geometry, missing or duplicate records', () => {
  const invalid = [good.replace('2160 16','2160 32').replace('5/11,6/5,5/0,0/0','8/16,8/8,8/0,8/24'), good.replace('2160','720'), good.replace('1280 720','1920 1080'), good.replace('rgba ','rgba BAD '), good+'\n'+good, 'rgba 5/11,6/5,5/0,0/0'];
  for (const value of invalid) {
    const escaped = value.replaceAll('\\','\\\\').replaceAll("'", "'\\''");
    const r = run(`tr100_validate_mode '${escaped}'`); assert.notEqual(r.status, 0, value);
  }
});
test('check does not open, set, GET framebuffer or launch terminal', () => {
  const r = run(`tr100_check_platform(){ :; }; tr100_check_files(){ :; }; tr100_initialize(){ echo BAD; }; tr100_launch(){ echo BAD; }; tr100_main --check`);
  assert.equal(r.status, 0); assert.match(r.stdout, /CHECK_PASSED/); assert.doesNotMatch(r.stdout, /BAD/);
});
test('initialization failure never launches terminal; valid readback preserves order', () => {
  const setup = `tr100_check_platform(){ echo platform; }; tr100_check_files(){ echo files; }; tr100_hold_fb(){ echo hold; }; tr100_set_mode(){ echo set; }; tr100_launch(){ echo TERMINAL; };`;
  for (const fail of ['tr100_hold_fb(){ return 1; };','tr100_set_mode(){ return 1; };',"tr100_get_mode(){ printf 'geometry 1280 720 1280 2160 32\\nrgba 8/16,8/8,8/0,8/24\\n'; };",'tr100_get_mode(){ return 1; };']) {
    const r = run(`${setup} tr100_get_mode(){ printf '${good}\\n'; }; ${fail} tr100_run_start`);
    assert.notEqual(r.status, 0); assert.doesNotMatch(r.stdout, /TERMINAL/);
  }
  const r = run(`${setup} tr100_get_mode(){ printf '${good}\\n'; }; tr100_run_start`);
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /platform\nfiles\nhold\nset\nTERMINAL/);
});
test('fixed terminal launch requires password login and has no timeout or auto-login', () => {
  const s = fs.readFileSync(wrapper, 'utf8');
  assert.match(s, /exec \/usr\/bin\/openvt -c 1 -f -s -w -- \/usr\/bin\/fbterm/);
  assert.match(s, /\/bin\/login/); assert.match(s, /while :; do/); assert.match(s, /\/usr\/bin\/sleep 1/);
  assert.doesNotMatch(s, /--autologin|login -f|timeout|saveenv|mmc write|of=\/dev/);
});
test('service conflicts only with tty1 and bounds restart rate', () => {
  const s = fs.readFileSync(path.resolve(__dirname, '../systemd/tr100-hdmi-console.service'), 'utf8');
  assert.match(s, /^Conflicts=getty@tty1.service$/m); assert.match(s, /^After=.*systemd-user-sessions.service.*systemd-udev-settle.service/m);
  assert.match(s, /^Restart=on-failure$/m); assert.match(s, /^StartLimitBurst=3$/m); assert.match(s, /^StartLimitIntervalSec=60$/m);
  assert.match(s, /^WantedBy=multi-user.target$/m); assert.doesNotMatch(s, /serial-getty|autologin|PrivateDevices/);
});
