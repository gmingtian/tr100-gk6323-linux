const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib');
const p=require('./build-probe-environment.cjs');
const original=fs.readFileSync(path.resolve(__dirname,'../../../factory-backup/factory-bootargs.bin'));
test('real original creates only three-key probe, CRC and exact tail independently checked',()=>{
 const {image,receipt}=p.buildProbe(original,p.FACTORY_SHA);
 assert.equal(image.length,4194304);
 assert.equal(image.readUInt32LE(0),zlib.crc32(image.subarray(4,65536)));
 assert.ok(image.subarray(65536).equals(original.subarray(65536)));
 assert.deepEqual(receipt.changedKeys,['bootdelay','bootcmd','bootargs']);
 const entries=Object.fromEntries(p.parse(image).entries.map(e=>[e.key,e.value]));
 assert.equal(entries.bootcmd,'printenv');assert.equal(entries.bootdelay,'3');
 assert.match(entries.bootargs,/12M\(kernel\).*,-\(rootfs\) loglevel=0$/);
 assert.equal(receipt.finalBootEnvironment,false);
 assert.equal(entries.DDRT_TEST,'TRUE');
});
test('wrong original hash rejected',()=>assert.throws(()=>p.buildProbe(original,'0'.repeat(64)),/SHA/));
test('byte changed in original rejects even with valid CRC',()=>{
 const bad=Buffer.from(original);bad[100]^=1;bad.writeUInt32LE(zlib.crc32(bad.subarray(4,65536)));
 assert.throws(()=>p.buildProbe(bad,p.FACTORY_SHA),/SHA/);
});
test('probe readback identical candidate accepted',()=>{const {image}=p.buildProbe(original,p.FACTORY_SHA);assert.equal(p.verifyProbe(original,image,p.FACTORY_SHA).status,'probe-byte-policy-passed');});
test('partition tail corruption rejected',()=>{const {image}=p.buildProbe(original,p.FACTORY_SHA);image[65536]^=1;assert.throws(()=>p.verifyProbe(original,image,p.FACTORY_SHA),/tail|unexpected/i);});
test('additional env key mutation rejected despite valid CRC',()=>{
 const {image}=p.buildProbe(original,p.FACTORY_SHA);const at=image.indexOf(Buffer.from('DDRT_TEST=TRUE'));assert.ok(at>0);image[at+10]=0x46;
 image.writeUInt32LE(zlib.crc32(image.subarray(4,65536)));
 assert.throws(()=>p.verifyProbe(original,image,p.FACTORY_SHA),/three|unexpected|other/i);
});
test('final environment is explicitly rejected by probe verifier',()=>{const final=p.source().buildEnvironment(original,p.FACTORY_SHA).image;assert.throws(()=>p.verifyProbe(original,final,p.FACTORY_SHA),/three|probe|exact/i);});
