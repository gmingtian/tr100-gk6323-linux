'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),zlib=require('node:zlib');
const source=path.resolve(__dirname,'../../../firmware-analysis/factory-backup/factory-bootargs.bin');
const modulePath=path.resolve(__dirname,'../build-environment.cjs');
const original=fs.readFileSync(source);
const originalSHA='489debc75ac9c3e525f5ecb336a18521e062b8ff6c10ff6551e3d4da6eabd2ac';
function api(){assert.ok(fs.existsSync(modulePath),'offline environment implementation missing');return require(modulePath);}
function editEnv(b,change){const end=b.indexOf(Buffer.from([0,0]),4),entries=b.subarray(4,end).toString('ascii').split('\0');change(entries);b.fill(0,4,65536);Buffer.from(entries.join('\0')+'\0\0','ascii').copy(b,4);b.writeUInt32LE(zlib.crc32(b.subarray(4,65536)),0);return b;}
function temporary(t){const p=fs.mkdtempSync(path.join(os.tmpdir(),'tr100-env-tests-'));t.after(()=>{const real=fs.realpathSync(p),parent=fs.realpathSync(os.tmpdir());assert.equal(path.dirname(real),parent);assert.ok(path.basename(real).startsWith('tr100-env-tests-'));fs.rmSync(real,{recursive:true,force:true});});return p;}
test('real factory environment rebuild changes exactly two ordered entries, preserves original MAC/alternates and all remaining 4MiB bytes',()=>{
 const a=api(),result=a.buildEnvironment(original,originalSHA),out=result.image;
 assert.equal(out.length,4194304);assert.equal(out.readUInt32LE(),zlib.crc32(out.subarray(4,65536)));
 assert.deepEqual(out.subarray(65536),original.subarray(65536));
 const before=a.parseEnvironment(original).entries,after=a.parseEnvironment(out).entries;
 assert.deepEqual(before.map(e=>e.key),after.map(e=>e.key));
 assert.deepEqual(after.filter((e,i)=>e.value!==before[i].value).map(e=>e.key),['bootcmd','bootargs']);
 for(const key of ['ethaddr','bootargs_2G','bootargs_512M'])assert.equal(after.find(e=>e.key===key).value,before.find(e=>e.key===key).value);
 assert.equal(after.find(e=>e.key==='ethaddr').value,before.find(e=>e.key==='ethaddr').value);
 assert.equal(after.find(e=>e.key==='bootargs').value,'console=ttyAMA0,115200 blkdevparts=mmcblk0:4M(fastboot),4M(bootargs),12M(kernel),4M(deviceinfo),2M(atf),8M(baseparam),8M(pqparam),-(rootfs) loglevel=0');
 assert.equal(after.find(e=>e.key==='bootcmd').value,'mmc read 0 0x8020000 0xC000 0x1000;mmc read 0 0x1FFBFC0 0x4000 0x5000; bootm 0x1FFBFC0');
 assert.deepEqual(result.manifest.changedKeys,['bootcmd','bootargs']);assert.equal(result.manifest.deviceWritesPerformed,false);
 assert.equal(a.verifyEnvironment(original,out,originalSHA).onlyExpectedTwoKeysChanged,true);
});
test('bad source CRC, duplicate keys, wrong pinned source hash or size are rejected before output',()=>{
 const a=api(),badCRC=Buffer.from(original);badCRC[0]^=1;
 assert.throws(()=>a.parseEnvironment(badCRC),/CRC/);
 const dup=editEnv(Buffer.from(original),entries=>entries.push('bootcmd=duplicate'));
 assert.throws(()=>a.parseEnvironment(dup),/duplicate/i);
 for(const [b,h]of [[badCRC,originalSHA],[original,'0'.repeat(64)],[original.subarray(0,65536),originalSHA]])assert.throws(()=>a.buildEnvironment(b,h));
});
test('readback policy rejects CRC-correct unrelated edits/reordering/RAM flags and modified full-partition tail',()=>{
 const a=api(),good=a.buildEnvironment(original,originalSHA).image;
 for(const change of [entries=>{let i=entries.findIndex(x=>x.startsWith('ethaddr='));entries[i]='ethaddr=02:00:00:00:00:01';},entries=>entries.reverse(),entries=>{let i=entries.findIndex(x=>x.startsWith('bootargs='));entries[i]+=' tr100.ramtest=0';},entries=>{let i=entries.findIndex(x=>x.startsWith('bootargs='));entries[i]+=' systemd.log_level=debug';}])
   assert.throws(()=>a.verifyEnvironment(original,editEnv(Buffer.from(good),change),originalSHA));
 const tail=Buffer.from(good);tail[65536]^=1;assert.throws(()=>a.verifyEnvironment(original,tail,originalSHA),/tail/i);
});
test('new output directory is exclusive and every generated manifest/file digest matches actual bytes',t=>{
 const a=api(),p=temporary(t),out=path.join(p,'env');
 const r=a.writeEnvironment({original:source,originalSHA256:originalSHA,out});
 assert.equal(fs.readFileSync(path.join(out,'bootargs.bin')).length,4194304);
 assert.equal(r.imageSHA256,crypto.createHash('sha256').update(fs.readFileSync(path.join(out,'bootargs.bin'))).digest('hex'));
 for(const line of fs.readFileSync(path.join(out,'SHA256SUMS'),'utf8').trim().split('\n')){const [hash,name]=line.split('  ');assert.equal(hash,crypto.createHash('sha256').update(fs.readFileSync(path.join(out,name))).digest('hex'));}
 assert.throws(()=>a.writeEnvironment({original:source,originalSHA256:originalSHA,out}),/exist/i);
});
test('RAM readback checker validates pinned generated SHA and physical p2 identity before any device reads',()=>{
 const {spawnSync}=require('node:child_process'),bash='C:/Program Files/Git/bin/bash.exe',p=path.resolve(__dirname,'../check-environment-from-ram.sh');
 assert.ok(fs.existsSync(p),'readback checker missing');const s=fs.readFileSync(p,'utf8'),a=s.indexOf('# BEGIN OFFLINE GUARDS\n'),b=s.indexOf('# END OFFLINE GUARDS\n');assert.ok(a>=0&&b>a);
 const run=(fn,args)=>spawnSync(bash,['-c',s.slice(a,b)+'\n'+fn+' "$@"','fixture',...args],{encoding:'utf8'});
 const hash='06ea929120af9e164f5ad6f6845ecff0a720cf25515ce051e6b717a5ff498885';
 assert.equal(run('tr100_check_environment_digest',[hash]).status,0);assert.notEqual(run('tr100_check_environment_digest',[originalSHA]).status,0);
 const good=['8192','8192','179:2','b3:2','15269888'];assert.equal(run('tr100_check_p2',good).status,0);
 for(let i=0;i<good.length;i++){const bad=[...good];bad[i]='0';assert.notEqual(run('tr100_check_p2',bad).status,0);}
 assert.equal(spawnSync(bash,['-n',p]).status,0);
 const bad=spawnSync(bash,[p,'--check','bad'],{encoding:'utf8'});assert.notEqual(bad.status,0);assert.doesNotMatch(bad.stdout,/READBACK_VERIFIED/);
});
