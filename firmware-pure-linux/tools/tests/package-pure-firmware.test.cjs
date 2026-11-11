'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const modulePath=path.resolve(__dirname,'../package-pure-firmware.cjs');
function api(){assert.ok(fs.existsSync(modulePath),'pure delivery packager missing');return require(modulePath);}
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function plan(){const layout=require('../pure-linux-image.cjs').layout();return {schemaVersion:1,layout,image:{prefixBytes:44040192,rootBytes:7774142464,rawBytes:7818182656,rawSHA256:'a'.repeat(64),gzipSHA256:'b'.repeat(64)},kernel:{bytes:9863168,sha256:'c4e63e9a104d126685885b33db2c231f7ece5b5babc85f03531cc263722de7c9'},inputs:{root:{bytes:7774142464,sha256:'c'.repeat(64)}}};}
test('delivery plan accepts fixed new geometry only and never invents runtime evidence',()=>{
 const a=api(),p=plan(),r=a.validateDeliveryPlan(p,null,[]);assert.equal(r.status,'absent');
 for(const change of [x=>x.layout.root.uuid='7d9317bc-354a-4f12-a45d-38c56546d3e3',x=>x.image.rootBytes=838860800,x=>x.kernel.sha256='b778cbbe4b52650c5af94639f37b8190db8de59af4538a5ea8fecebb17bb7b0a']){
  const bad=structuredClone(p);change(bad);assert.throws(()=>a.validateDeliveryPlan(bad,null,[]));
 }
});
test('runtime receipt must match final image digests and reference copied logs; power-cycle success needs its own log',()=>{
 const a=api(),p=plan(),r={mode:'pure-linux-emmc-boot',result:'passed',kernelSHA256:p.kernel.sha256,rootSHA256:p.inputs.root.sha256,environmentSHA256:'06ea929120af9e164f5ad6f6845ecff0a720cf25515ce051e6b717a5ff498885',observedAt:'2026-11-11T00:00:00Z',physicalPowerCycleTested:false,serialLog:'first-boot.txt',runtimeLog:'runtime.txt'};
 assert.equal(a.validateDeliveryPlan(p,r,['first-boot.txt','runtime.txt']).status,'provided-by-parent');
 for(const bad of [{...r,rootSHA256:'0'.repeat(64)},{...r,mode:'ram-boot'},{...r,physicalPowerCycleTested:true},{...r,serialLog:'../outside.txt'},
   {...r,physicalPowerCycleTested:true,powerCycleLog:'first-boot.txt'}])assert.throws(()=>a.validateDeliveryPlan(p,bad,['first-boot.txt','runtime.txt']));
 assert.throws(()=>a.validateDeliveryPlan(p,r,[]));
 const powered={...r,physicalPowerCycleTested:true,powerCycleLog:'power-cycle.txt'},records=[{name:'first-boot.txt',sha256:'1'.repeat(64)},{name:'runtime.txt',sha256:'2'.repeat(64)},{name:'power-cycle.txt',sha256:'3'.repeat(64)}];
 assert.equal(a.validateDeliveryPlan(p,powered,records).status,'provided-by-parent');
 records[2].sha256=records[0].sha256;assert.throws(()=>a.validateDeliveryPlan(p,powered,records),/alias|identical/);
});
function fixture(t){const p=fs.mkdtempSync(path.join(os.tmpdir(),'tr100-delivery-tests-'));t.after(()=>{const r=fs.realpathSync(p);assert.equal(path.dirname(r),fs.realpathSync(os.tmpdir()));assert.ok(path.basename(r).startsWith('tr100-delivery-tests-'));fs.rmSync(r,{recursive:true,force:true});});return p;}
test('ordinary-file publisher copies exact bytes, records every digest, and refuses an existing destination',t=>{
 const a=api(),p=fixture(t),source=path.join(p,'source');fs.writeFileSync(source,'fixture image bytes');const out=path.join(p,'package');
 const result=a.publishDirectory([{file:source,name:'images/fixture.img.gz',bytes:19,sha256:hash(Buffer.from('fixture image bytes'))}],out,{experimental:true,deviceBound:true});
 assert.equal(result.hardwareAccessPerformedByPackager,false);assert.equal(result.deviceBound,true);
 for(const line of fs.readFileSync(path.join(out,'SHA256SUMS'),'utf8').trim().split('\n')){const [h,n]=line.split('  ');assert.equal(h,hash(fs.readFileSync(path.join(out,n))));}
 assert.throws(()=>a.publishDirectory([],out,{}),/exist/i);
});
test('publisher refuses wrong input bytes, traversal, duplicate outputs and private-key evidence before creating output',t=>{
 const a=api(),p=fixture(t),source=path.join(p,'source');fs.writeFileSync(source,'fixture');
 const good={file:source,name:'evidence/log.txt',bytes:7,sha256:hash(Buffer.from('fixture'))};
 for(const list of [[{...good,sha256:'0'.repeat(64)}],[{...good,name:'../outside'}],[good,good]]){const out=path.join(p,crypto.randomUUID());assert.throws(()=>a.publishDirectory(list,out,{}));assert.equal(fs.existsSync(out),false);}
 fs.writeFileSync(source,'-----BEGIN OPENSSH PRIVATE KEY-----\nsecret');
 const b=fs.readFileSync(source);assert.throws(()=>a.publishDirectory([{...good,bytes:b.length,sha256:hash(b)}],path.join(p,'secret-output'),{}),/private key/i);
});
test('installation materials include the exact three-key probe and original factory env without confusing final bootargs',()=>{
 const entries=api().installationArtifacts(),byName=new Map(entries.map(e=>[e.name,e]));
 assert.equal(byName.get('installation/probe-bootargs-NOT-FINAL.bin').sha256,'216e44221aff6cf13f4cfeba8a2b97194a4a162220354a338b3fb8536b2db13f');
 assert.equal(byName.get('installation/factory-bootargs.bin').sha256,'489debc75ac9c3e525f5ecb336a18521e062b8ff6c10ff6551e3d4da6eabd2ac');
 assert.ok(byName.has('installation/probe-environment-receipt.json'));assert.equal(byName.has('bootargs.bin'),false);
});
test('maintenance materials retain RAMONLY classification and all nine actual fragment hashes/CRC/addresses',()=>{
 const entries=api().maintenanceArtifacts();assert.equal(entries.length,10);
 assert.ok(entries.every(e=>e.name.startsWith('maintenance/RAMONLY-')));
 assert.equal(entries.filter(e=>e.name.endsWith('.bin')).length,9);
});
test('maintenance control materials contain the actual TFTP loader/boot/passive-capture dependencies and package-scoped TCP sender',()=>{
 const entries=api().maintenanceScriptArtifacts(),names=entries.map(e=>e.name);
 for(const name of ['maintenance/scripts/tftp-server.cjs','maintenance/scripts/load-full-ramonly.ps1','maintenance/scripts/boot-pure-maintenance.ps1','maintenance/scripts/capture-pure-map-probe.ps1','maintenance/scripts/capture-pure-emmc-boot.ps1','tools/tcp-file.cjs'])assert.ok(names.includes(name),name);
 for(const e of entries)assert.equal(e.sha256,hash(fs.readFileSync(e.file)));
});
