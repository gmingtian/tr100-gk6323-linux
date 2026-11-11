'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const os=require('node:os');
const script = path.resolve(__dirname, '../flash-pure-from-ram.sh');
const bash = 'C:/Program Files/Git/bin/bash.exe';
const kernelSHA = 'c4e63e9a104d126685885b33db2c231f7ece5b5babc85f03531cc263722de7c9';
function guard(body, args=[], input) {
  const s = fs.readFileSync(script, 'utf8');
  const a = s.indexOf('# BEGIN OFFLINE GUARDS\n'), b = s.indexOf('# END OFFLINE GUARDS\n');
  assert.ok(a >= 0 && b > a);
  return spawnSync(bash, ['-c', 'set -eu; set -o pipefail; BB=/usr/bin/env;\n' + s.slice(a,b) + '\n' + body, 'fixture', ...args], {input, encoding:'utf8'});
}
test('RAM gate refuses every block-backed mount, aliases, overlay root and read-only root', () => {
  const root = '1 0 0:1 / / rw - rootfs rootfs rw\n';
  const run = '2 1 0:2 / /run rw - tmpfs tmpfs rw\n';
  assert.equal(guard('tr100_check_mountinfo', [], root+run).status, 0);
  for (const bad of [root.replace('0:1','7:0'), root.replace('rootfs rootfs','overlay overlay'), root.replace('/ rw','/ ro'),
    root+run+'3 1 259:0 / /mnt/alias rw - ext4 /dev/alias rw\n', root+run+'3 1 179:4 / /hidden rw - ext4 /dev/other rw\n'])
    assert.notEqual(guard('tr100_check_mountinfo', [], bad).status, 0);
  assert.equal(guard('tr100_check_ram_path /run/tr100/pure-flash/boot.img', [], root+run).status, 0);
  assert.notEqual(guard('tr100_check_ram_path /run/tr100/pure-flash/boot.img', [], root+run+'3 2 0:3 / /run/tr100 rw - overlay overlay rw\n').status, 0);
});
test('new map/kernel and all target geometry/dev identities are exact, not caller overrides', () => {
  const map='blkdevparts=mmcblk0:4M(fastboot),4M(bootargs),12M(kernel),4M(deviceinfo),2M(atf),8M(baseparam),8M(pqparam),-(rootfs)';
  assert.equal(guard('tr100_check_runtime "$@"', ['3.18.24_gk6323v100c', 'console=ttyAMA0 '+map]).status, 0);
  for(const args of [['other',map], ['3.18.24_gk6323v100c',map+' '+map], ['3.18.24_gk6323v100c',map.replace('12M(kernel)','12M(recovery)')]])
    assert.notEqual(guard('tr100_check_runtime "$@"', args).status, 0);
  for(const good of [['3','16384','24576','179:3','b3:3','15269888'], ['8','86016','15183872','259:0','103:0','15269888']]) {
    assert.equal(guard('tr100_check_partition "$@"', good).status, 0);
    for(let i=1;i<good.length;i++){const bad=[...good];bad[i]='0';assert.notEqual(guard('tr100_check_partition "$@"',bad).status,0);}
  }
});
test('mandatory digest and exact sizes reject old kernel and truncated or oversize root', () => {
  assert.equal(guard('tr100_check_boot_hash "$1"',[kernelSHA]).status,0);
  assert.notEqual(guard('tr100_check_boot_hash "$1"',['b778cbbe4b52650c5af94639f37b8190db8de59af4538a5ea8fecebb17bb7b0a']).status,0);
  assert.equal(guard('tr100_check_sizes "$@"',['9863168','150000000','7774142464']).status,0);
  for(const args of [['10485761','1','7774142464'],['9863168','1073741825','7774142464'],['9863168','1','7774142463']])
    assert.notEqual(guard('tr100_check_sizes "$@"',args).status,0);
  for(const hash of ['x'.repeat(64),'a'.repeat(63),'$(bad)']) assert.notEqual(guard('tr100_valid_sha256 "$1"',[hash]).status,0);
});
test('canonical sysfs alias must identify the same partition under the same whole MMC',()=>{
  const disk='/sys/devices/platform/mmc/block/mmcblk0', part=disk+'/mmcblk0p8';
  assert.equal(guard('tr100_check_sysfs_relation "$@"',[disk,part,part]).status,0);
  for(const args of [[disk,part,disk+'/mmcblk0p3'],[disk,disk+'/nested/mmcblk0p8',disk+'/nested/mmcblk0p8'],[disk,'/sys/devices/other/mmcblk1/mmcblk1p8','/sys/devices/other/mmcblk1/mmcblk1p8']])
    assert.notEqual(guard('tr100_check_sysfs_relation "$@"',args).status,0);
});
test('bounded raw copier emits at most the cap and fails on an extra byte', () => {
  const exact=guard('tr100_copy_capped 4 2',[],'12345678');assert.equal(exact.status,0);assert.equal(exact.stdout,'12345678');
  const extra=guard('tr100_copy_capped 4 2',[],'123456789');assert.notEqual(extra.status,0);assert.equal(extra.stdout,'12345678');
});
test('root header gate refuses a wrong ext4 UUID or short header; native digest parses real OpenSSL output', () => {
  const header=Buffer.alloc(2048);header.writeUInt16LE(0xef53,1080);
  Buffer.from('a8d4abf76ae44f9ba39aef1b79c63230','hex').copy(header,1128);
  assert.equal(guard('tr100_check_root_header "$1"',[header.toString('hex')]).status,0);
  const bad=Buffer.from(header);bad[1128]^=1;
  for(const hex of [bad.toString('hex'),header.toString('hex').slice(0,-2)]) assert.notEqual(guard('tr100_check_root_header "$1"',[hex]).status,0);
  const digest=guard('tr100_digest',[],'abc');assert.equal(digest.status,0,digest.stderr);
  assert.equal(digest.stdout.trim(),'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
test('protection hash gate includes unchanged bootargs and base/pq hardware bytes', () => {
  const hashes=['fdc8847fafd9ef5ca006cb414561b99464b344deba1c16f8c223c0916f2c521e','216e44221aff6cf13f4cfeba8a2b97194a4a162220354a338b3fb8536b2db13f','94d6d4cc9d39a43b126d9b5075d39dac72b83c44aa6db269cf773ab4a4a870aa','4ff6abeff404e8eeb0f0f3816470b3d65a9261c2ed75c6e4ce48fbf7fcc2f939','9e56eb715425dd4e2f5e57f2211e4f69469104e3bbb1a473b666a463fa6a8237','b325063170911917d7511c37b1718ed815639c5aea08c47127e8d94487cd199a'];
  for(let i=0;i<hashes.length;i++){
    const n=[1,2,4,5,6,7][i];assert.equal(guard('tr100_check_protected_hash "$@"',[String(n),hashes[i]]).status,0);
    assert.notEqual(guard('tr100_check_protected_hash "$@"',[String(n),'0'.repeat(64)]).status,0);
  }
  assert.notEqual(guard('tr100_check_protected_hash "$@"',['2','489debc75ac9c3e525f5ecb336a18521e062b8ff6c10ff6551e3d4da6eabd2ac']).status,0,'old p2 must not be accepted during data migration');
});
function writeFixture(failure='none') {
  // Only hardware/process IO is doubled; the actual production sequencing and failures run.
  return guard(`
    die(){ printf 'REFUSED:%s\\n' "$*" >&2; exit 1; }
    BB=fixture_io; BOOT=fixture-boot; SYSTEM_GZ=fixture-gzip; P3=fixture-p3; P8=fixture-p8
    boot_expected=${kernelSHA}; raw_expected=${'a'.repeat(64)}; boot_bytes=9863168; fail_at=$1
    tr100_assert_boundary(){ printf 'ACTION:boundary\\n' >&2; }
    tr100_protected(){ printf 'ACTION:protected\\n' >&2; [ "$fail_at" != protected ]; }
    tr100_digest(){
      if [ "$#" = 1 ]; then
        printf 'ACTION:root-readback\\n' >&2
        [ "$fail_at" != readback ] && printf '%s\\n' "$raw_expected" || printf '%064d\\n' 0
      else
        payload=$(/usr/bin/cat)
        case "$payload" in
          tail) printf 'ACTION:read-tail\\n' >&2; [ "$fail_at" != tail ] && printf '%s\\n' 60e4f24b3a702f56fdf9d52c7f63e63e2835407591dce1445e193a7720be9ada || printf '%064d\\n' 0 ;;
          *) [ "$fail_at" != kernel ] && printf '%s\\n' "$boot_expected" || printf '%064d\\n' 0 ;;
        esac
      fi
    }
    fixture_io(){
      c=$1; shift
      case "$c" in
        gunzip) [ "$fail_at" != gunzip ] || return 1; printf root ;;
        dd)
          case " $* " in
            *' of=fixture-p8 '*) printf 'ACTION:write-root\\n' >&2; /usr/bin/cat >/dev/null; [ "$fail_at" != root-dd ] ;;
            *' if=/dev/zero '*) printf 'ACTION:zero-slot\\n' >&2; [ "$fail_at" != zero ] ;;
            *' of=fixture-p3 '*) printf 'ACTION:write-kernel\\n' >&2 ;;
            *' skip=19264 '*) printf tail ;;
            *' if=fixture-p3 '*) printf 'ACTION:read-kernel\\n' >&2; printf kernel ;;
            *) /usr/bin/cat ;;
          esac ;;
        wc) /usr/bin/wc "$@" ;;
        *) return 98 ;;
      esac
    }
    tr100_write_partitions
  `,[failure]);
}
test('system failure or readback mismatch cannot clear the kernel slot', () => {
  for(const f of ['gunzip','root-dd','readback']) {const r=writeFixture(f);assert.notEqual(r.status,0,r.stderr);assert.doesNotMatch(r.stderr,/ACTION:zero-slot|ACTION:write-kernel/);assert.doesNotMatch(r.stdout,/DATA_WRITE_COMPLETE/);}
});
test('successful sequence verifies entire root before zeroing full slot and verifies tail then protected partitions', () => {
  const r=writeFixture();assert.equal(r.status,0,r.stderr);
  assert.match(r.stderr,/write-root[\s\S]*root-readback[\s\S]*zero-slot[\s\S]*write-kernel[\s\S]*read-tail[\s\S]*protected/);
  assert.match(r.stdout,/DATA_WRITE_COMPLETE/);assert.match(r.stdout,/PERSISTENT_BOOT_CONFIGURATION_PENDING/);
});
test('zero, kernel, tail or protected readback failure never reports completion',()=>{
  for(const f of ['zero','kernel','tail','protected']) {const r=writeFixture(f);assert.notEqual(r.status,0,r.stderr);assert.doesNotMatch(r.stdout,/DATA_WRITE_COMPLETE/);}
});
test('CLI rejects missing hashes/ambiguous modes before platform access; syntax valid',()=>{
  for(const args of [[],['--write'],['--write','--check'],['--boot-sha256','bad']]){
    const r=spawnSync(bash,[script,...args],{encoding:'utf8'});assert.notEqual(r.status,0);assert.doesNotMatch(r.stdout,/WRITE_STARTED|CHECK_PASSED/);
  }
  const r=spawnSync(bash,['-n',script],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);
});
test('large root count uses native GNU wc and refuses modulo-32 count with measured diagnostic before writes',t=>{
  assert.equal(guard('tr100_check_wc_banner "$1"',['wc (GNU coreutils) 9.1']).status,0);
  for(const banner of ['BusyBox v1.22.1','wc (GNU coreutils) 8.32','not wc'])assert.notEqual(guard('tr100_check_wc_banner "$1"',[banner]).status,0);
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'tr100-count-tests-'));
  t.after(()=>{const actual=fs.realpathSync(root);assert.equal(path.dirname(actual),fs.realpathSync(os.tmpdir()));assert.ok(path.basename(actual).startsWith('tr100-count-tests-'));fs.rmSync(actual,{recursive:true,force:true});});
  const file=path.join(root,'large.sparse');fs.writeFileSync(file,'');
  const sparse=spawnSync('fsutil.exe',['sparse','setflag',file],{encoding:'utf8'});assert.equal(sparse.status,0,sparse.stdout+sparse.stderr);
  fs.truncateSync(file,7774140416);assert.equal(fs.statSync(file).size,7774140416);
  // Force a real pipe; the ARM wc seekable-file fast path has separately returned a 32-bit remainder.
  const actual=guard('"$BB" cat "$1" | tr100_native_count',[file.replaceAll('\\','/')]);assert.equal(actual.status,0,actual.stderr);assert.equal(actual.stdout.trim(),'7774140416');
  const success=guard('die(){ printf "%s\\n" "$*" >&2; exit 1; }; tr100_require_remaining_count "$1"; printf WOULD_ENTER_WRITE', ['7774140416']);assert.equal(success.status,0);assert.match(success.stdout,/WOULD_ENTER_WRITE/);
  for(const wrong of ['3479173120','7774140415']){
    const failure=guard('die(){ printf "%s\\n" "$*" >&2; exit 1; }; tr100_require_remaining_count "$1"; printf WOULD_ENTER_WRITE',[wrong]);
    assert.notEqual(failure.status,0);assert.match(failure.stderr,new RegExp('actual='+wrong));assert.doesNotMatch(failure.stdout,/WOULD_ENTER_WRITE/);
  }
});
