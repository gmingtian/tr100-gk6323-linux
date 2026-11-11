'use strict';
// PC ordinary-file delivery bundler. No serial/network/process/device operations.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),zlib=require('node:zlib'),{isDeepStrictEqual}=require('node:util');
const imageTool=require('./pure-linux-image.cjs'),environmentTool=require('./build-environment.cjs');
const ROOT=7774142464,DISK=7818182656,PREFIX=44040192;
const BOOT_SHA='c4e63e9a104d126685885b33db2c231f7ece5b5babc85f03531cc263722de7c9';
const ENV_SHA='06ea929120af9e164f5ad6f6845ecff0a720cf25515ce051e6b717a5ff498885';
const FLASH_SHA='2e3b4f99b2f3ac5c99bd627be5c171dfb55e90f0766aa39bac6e357189c9ee82';
const PROBE_SHA='216e44221aff6cf13f4cfeba8a2b97194a4a162220354a338b3fb8536b2db13f';
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function expectedSHA(s){if(typeof s!=='string'||!/^[a-f0-9]{64}$/.test(s))throw Error('Explicit lowercase 64hex SHA256 required');return s;}
function regular(file,bytes){const s=fs.lstatSync(file);if(!s.isFile()||(bytes!==undefined&&s.size!==bytes))throw Error('Ordinary non-symlink file/size mismatch: '+file);return s;}
function hashFile(file){regular(file);const fd=fs.openSync(file,'r'),b=Buffer.alloc(1048576),h=crypto.createHash('sha256');try{let n;while((n=fs.readSync(fd,b))>0)h.update(b.subarray(0,n));}finally{fs.closeSync(fd);}return h.digest('hex');}
function slice(file,start,length){const fd=fs.openSync(file,'r'),b=Buffer.alloc(length);try{let n=0;while(n<length){const r=fs.readSync(fd,b,n,length-n,start+n);if(!r)throw Error('Short ordinary file read');n+=r;}}finally{fs.closeSync(fd);}return b;}
function safeName(name){return typeof name==='string'&&/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name)&&name.split('/').every(p=>p&&p!=='.'&&p!=='..')&&!['SHA256SUMS','package-manifest.json'].includes(name);}
function validateDeliveryPlan(assembly,runtime,evidence){
 const evidenceNames=evidence.map(e=>typeof e==='string'?e:e.name);
 if(assembly.schemaVersion!==1||!isDeepStrictEqual(assembly.layout,imageTool.layout()))throw Error('Assembly does not use fixed pure-Linux layout');
 if(assembly.image?.prefixBytes!==PREFIX||assembly.image?.rootBytes!==ROOT||assembly.image?.rawBytes!==DISK||assembly.kernel?.bytes!==9863168||assembly.kernel?.sha256!==BOOT_SHA||assembly.inputs?.root?.bytes!==ROOT)throw Error('Assembly fixed image geometry/kernel differs');
 for(const value of [assembly.image.rawSHA256,assembly.image.gzipSHA256,assembly.inputs.root.sha256])expectedSHA(value);
 if(!runtime)return {status:'absent',note:'No pure-Linux default-boot receipt supplied; packager did not access hardware.'};
 if(runtime.mode!=='pure-linux-emmc-boot'||runtime.result!=='passed'||runtime.kernelSHA256!==BOOT_SHA||runtime.rootSHA256!==assembly.inputs.root.sha256||runtime.environmentSHA256!==ENV_SHA)throw Error('Runtime receipt mode/result/image hashes do not match this final pure-Linux bundle');
 if(typeof runtime.observedAt!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(runtime.observedAt)||Number.isNaN(Date.parse(runtime.observedAt))||typeof runtime.physicalPowerCycleTested!=='boolean')throw Error('Explicit UTC observation and physical power-cycle boolean required');
 for(const key of ['serialLog','runtimeLog'])if(!safeName(runtime[key])||!evidenceNames.includes(runtime[key]))throw Error('Runtime receipt must reference a copied evidence log');
 if(runtime.physicalPowerCycleTested){
  if(!safeName(runtime.powerCycleLog)||!evidenceNames.includes(runtime.powerCycleLog)||[runtime.serialLog,runtime.runtimeLog].includes(runtime.powerCycleLog))throw Error('Power-cycle success requires a distinct copied power-cycle log');
  const logHashes=[runtime.serialLog,runtime.runtimeLog,runtime.powerCycleLog].map(n=>expectedSHA(evidence.find(e=>typeof e==='object'&&e.name===n)?.sha256));
  if(logHashes[2]===logHashes[0]||logHashes[2]===logHashes[1])throw Error('Power-cycle evidence cannot be a hash-identical alias of the ordinary boot/runtime logs');
 }
 return {status:'provided-by-parent',packagerIndependentlyObservedHardware:false,receipt:runtime};
}
function publishDirectory(entries,out,metadata){
 out=path.resolve(out);if(fs.existsSync(out))throw Error('Output directory already exists');const seen=new Set();
 for(const e of entries){
  if(!safeName(e.name)||seen.has(e.name))throw Error('Unsafe or duplicate output name');seen.add(e.name);regular(e.file,e.bytes);
  if(hashFile(e.file)!==expectedSHA(e.sha256))throw Error('Input digest mismatch: '+e.name);
  if(e.name.startsWith('evidence/')){
   if(e.bytes>33554432)throw Error('Evidence exceeds 32MiB per explicitly selected file');
   if(/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/.test(fs.readFileSync(e.file,'utf8')))throw Error('Private key evidence refused');
  }
 }
 fs.mkdirSync(out);const records=[];
 for(const e of entries){const target=path.join(out,...e.name.split('/'));fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(e.file,target,fs.constants.COPYFILE_EXCL);
  if(hashFile(target)!==e.sha256)throw Error('Copied file digest mismatch: '+e.name);records.push({name:e.name,bytes:e.bytes,sha256:e.sha256});}
 const manifest={...metadata,schemaVersion:1,createdAt:new Date().toISOString(),hardwareAccessPerformedByPackager:false,files:records};
 const manifestPath=path.join(out,'package-manifest.json');fs.writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
 const all=[...records,{name:'package-manifest.json',bytes:fs.statSync(manifestPath).size,sha256:hashFile(manifestPath)}];
 fs.writeFileSync(path.join(out,'SHA256SUMS'),all.map(e=>e.sha256+'  '+e.name).join('\n')+'\n',{flag:'wx'});
 for(const e of all)if(hashFile(path.join(out,...e.name.split('/')))!==e.sha256)throw Error('Final package digest verification failed');
 return manifest;
}
async function verifyRootGzip(file,gzipSHA,rawSHA){
 const stat=regular(file);if(stat.size>1073741824||hashFile(file)!==expectedSHA(gzipSHA))throw Error('Root gzip digest/size mismatch');
 const input=fs.createReadStream(file),unzip=zlib.createGunzip(),h=crypto.createHash('sha256'),head=Buffer.alloc(2048);let bytes=0;
 input.on('error',e=>unzip.destroy(e));input.pipe(unzip);
 try{for await(const chunk of unzip){if(bytes+chunk.length>ROOT)throw Error('Root gzip exceeds exact root capacity');if(bytes<head.length)chunk.copy(head,bytes,0,Math.min(chunk.length,head.length-bytes));h.update(chunk);bytes+=chunk.length;}}
 finally{input.destroy();unzip.destroy();}
 if(bytes!==ROOT||h.digest('hex')!==expectedSHA(rawSHA))throw Error('Root gzip logical size/raw SHA mismatch');
 imageTool.validateRootSuperblock(head.subarray(1024),ROOT);return {bytes:stat.size,sha256:gzipSHA,rawBytes:bytes,rawSHA256:rawSHA};
}
function json(file){regular(file);if(fs.statSync(file).size>1048576)throw Error('Metadata JSON exceeds 1MiB');return JSON.parse(fs.readFileSync(file,'utf8'));}
function artifact(file,name,expected){const stat=regular(file);const actual=hashFile(file);if(expected&&actual!==expectedSHA(expected))throw Error('Required artifact hash mismatch: '+name);return {file:path.resolve(file),name,bytes:stat.size,sha256:actual};}
function installationArtifacts(){
 const workspace=path.resolve(__dirname,'../..'),factory=path.join(workspace,'firmware-analysis/factory-backup/factory-bootargs.bin');
 const probeDir=path.join(workspace,'firmware-analysis/board-pure-linux/research/probe-environment/probe-candidate');
 const probe=path.join(probeDir,'probe-bootargs-NOT-FINAL.bin'),receipt=path.join(probeDir,'receipt.json');
 regular(factory,4194304);regular(probe,4194304);const originalBytes=fs.readFileSync(factory),probeBytes=fs.readFileSync(probe);
 const records=[artifact(factory,'installation/factory-bootargs.bin',environmentTool.FACTORY_SHA),artifact(probe,'installation/probe-bootargs-NOT-FINAL.bin',PROBE_SHA),artifact(receipt,'installation/probe-environment-receipt.json')];
 const before=environmentTool.parseEnvironment(originalBytes).entries,after=environmentTool.parseEnvironment(probeBytes).entries;
 if(before.length!==after.length||before.some((e,i)=>e.key!==after[i].key)||!originalBytes.subarray(65536).equals(probeBytes.subarray(65536)))throw Error('Probe environment keys/order/tail differ');
 const changed=after.filter((e,i)=>e.value!==before[i].value);
 if(!isDeepStrictEqual(changed.map(e=>e.key),['bootdelay','bootcmd','bootargs'])||changed[0].value!=='3'||changed[1].value!=='printenv'||changed[2].value!==environmentTool.BOOTARGS)throw Error('Installation probe is not exact three-key printenv safety state');
 const proof=json(receipt);if(proof.imageSHA256!==PROBE_SHA||proof.originalSHA256!==environmentTool.FACTORY_SHA||proof.finalBootEnvironment!==false)throw Error('Probe receipt does not match actual installation environment');
 return records;
}
function maintenanceArtifacts(){
 const dir=path.resolve(__dirname,'../../firmware-analysis/ram-test/RAMONLY-bookworm-full-boot-v2'),file=path.join(dir,'RAMONLY-manifest.json');
 const manifestHash='3850220736465e8981a388bd3f3bcd4a58151a0654ee0aef6d1ecd7a00b67a42';
 const records=[artifact(file,'maintenance/RAMONLY-manifest.json',manifestHash)],m=json(file),whole=crypto.createHash('sha256');let total=0,crc=0;
 if(m.RAMONLY!==true||m.emmcFlashable!==false||m.fragments?.length!==9||m.fragmentBytes!==16777216||m.boot?.bytes!==143294464||m.boot?.address!==0x40000000)throw Error('Maintenance resource must be the pinned RAMONLY nine-fragment image');
 for(let i=0;i<9;i++){
  const f=m.fragments[i],name='RAMONLY-part-'+String(i).padStart(3,'0')+'.bin';
  if(f.file!==name||f.offset!==total||f.address!==0x40000000+total||f.bytes!==Math.min(16777216,m.boot.bytes-total))throw Error('RAMONLY fragment boundary/address mismatch');
  const source=path.join(dir,name);regular(source,f.bytes);records.push(artifact(source,'maintenance/'+name,f.sha256));const b=fs.readFileSync(source);
  if(zlib.crc32(b).toString(16).padStart(8,'0')!==f.crc32)throw Error('RAMONLY fragment CRC mismatch');whole.update(b);crc=zlib.crc32(b,crc);total+=b.length;
 }
 if(total!==m.boot.bytes||whole.digest('hex')!==m.boot.sha256||crc.toString(16).padStart(8,'0')!==m.boot.crc32)throw Error('RAMONLY concatenated image hash/CRC mismatch');return records;
}
function maintenanceScriptArtifacts(){
 const workspace=path.resolve(__dirname,'../..'),source=path.join(workspace,'firmware-analysis/tools');
 const pins=[
  ['tftp-server.cjs','ce92844636d1cc3c56b9f9dcabefc842a9b23b6add510dcc85e95aad682290a9'],
  ['load-full-ramonly.ps1','faed9d535dd01095843f5de3f99f256fe3a21d5aa072694d8f1868fdfafa89bc'],
  ['boot-pure-maintenance.ps1','546c355f86511f64d0c813610ddb837eeeb1377479cb2b6f1698f709fadca801'],
  ['capture-pure-map-probe.ps1','b24d4a0e3aed6149e592171e7f18d1afed0f411b7bf757344c264f2bb139883b'],
  ['capture-pure-emmc-boot.ps1','977e489b2050d2ad6c6f4c70749ee3c87246474139bd34294c6998f239baf0d8']
 ];
 const records=pins.map(([file,pin])=>artifact(path.join(source,file),'maintenance/scripts/'+file,pin));
 // Its WORKSPACE is parent(__dirname), so tools/ keeps fixed-file access inside the delivered package.
 records.push(artifact(path.join(workspace,'tools/tcp-file.cjs'),'tools/tcp-file.cjs','8d6b5a44f7ed5fc25d3dae2b761e08b5a00971a4001864f46e8cdb0a8e87c66a'));return records;
}
async function packageFirmware(config,out){
 const dir=path.resolve(config.assemblyDirectory),assemblyFile=path.join(dir,'manifest.json'),assembly=json(assemblyFile);
 const evidence=config.evidence??[];if(!Array.isArray(evidence))throw Error('Evidence must be an explicit list');
 const names=evidence.map(e=>e.name);if(names.some(n=>!safeName(n)||n.includes('/'))||new Set(names).size!==names.length)throw Error('Evidence names must be unique simple filenames');
 for(const e of evidence)expectedSHA(e.sha256);
 let runtime=null;if(config.runtimeEvidence){runtime=json(config.runtimeEvidence.file);if(hashFile(config.runtimeEvidence.file)!==expectedSHA(config.runtimeEvidence.sha256))throw Error('Runtime JSON SHA mismatch');}
 const deployment=validateDeliveryPlan(assembly,runtime,evidence);
 const original=config.originalPrefix;regular(original.file,274726912);if(hashFile(original.file)!==expectedSHA(original.sha256))throw Error('Original 262MiB prefix backup digest mismatch');
 const baseline=slice(original.file,0,PREFIX),wholePath=path.join(dir,'TR100-pure-linux.img.gz');
 const verified=await imageTool.verifyGzipSegments(wholePath,assembly.image,true);
 const prefixPolicy=imageTool.validatePrefix({prefix:verified.capturedPrefix,originalPrefix:baseline,kernelBytes:9863168,kernelSHA256:BOOT_SHA});
 imageTool.validateRootSuperblock(verified.rootHead.subarray(1024),ROOT);
 if(verified.rootSHA256!==assembly.inputs.root.sha256)throw Error('Whole image root digest differs from assembly canonical root');
 const boot=artifact(config.boot.file,'boot.img',BOOT_SHA);if(boot.bytes!==9863168||!fs.readFileSync(boot.file).equals(verified.capturedPrefix.subarray(8388608,8388608+9863168)))throw Error('Standalone boot differs from actual whole-image prefix');
 const env=artifact(config.environment.file,'bootargs.bin',ENV_SHA);if(env.bytes!==4194304||!fs.readFileSync(env.file).equals(verified.capturedPrefix.subarray(4194304,8388608)))throw Error('Standalone environment differs from actual prefix');
 environmentTool.verifyEnvironment(baseline.subarray(4194304,8388608),fs.readFileSync(env.file),environmentTool.FACTORY_SHA);
 if(config.rootGzip.rawSHA256!==verified.rootSHA256)throw Error('Explicit root gzip raw SHA differs from whole image root');
 const root=await verifyRootGzip(config.rootGzip.file,config.rootGzip.sha256,verified.rootSHA256);
 const entries=[artifact(wholePath,'TR100-pure-linux.img.gz',verified.gzipSHA256),boot,env,artifact(config.rootGzip.file,'rootfs.ext4.gz',root.sha256),artifact(assemblyFile,'assembly-manifest.json')];
 entries.push(...installationArtifacts(),...maintenanceArtifacts(),...maintenanceScriptArtifacts());
 for(const e of evidence)entries.push(artifact(e.file,'evidence/'+e.name,e.sha256));
 if(config.runtimeEvidence)entries.push(artifact(config.runtimeEvidence.file,'runtime-evidence.json',config.runtimeEvidence.sha256));
 for(const [source,name,pin]of [
  ['flash-pure-from-ram.sh','scripts/flash-pure-from-ram.sh',FLASH_SHA],['check-environment-from-ram.sh','scripts/check-environment-from-ram.sh'],
  ['build-environment.cjs','tools/build-environment.cjs'],['pure-linux-image.cjs','tools/pure-linux-image.cjs']])entries.push(artifact(path.join(__dirname,source),name,pin));
 for(const name of ['DELIVERY.md','NETWORK-ACCESS.md','MIGRATION-DATA-PHASE.md','ENVIRONMENT-COMMIT.md','MAINTENANCE-RESOURCES.md'])entries.push(artifact(path.join(__dirname,'..',name),name));
 entries.push(artifact(path.join(__dirname,'..','layout.json'),'layout.json'));
 return publishDirectory(entries,out,{product:'Sumavision TR100',soc:'GK6323V100C',deviceBound:true,experimental:true,officialBoardSupportClaimed:false,
  format:'complete-eMMC-user-area-raw-gzip; not a HiTool Android upgrade package',kernel:'unchanged factory 3.18.24_gk6323v100c payload with pure-Linux initrd',
  scope:'Vendor boot firmware/device identity/hardware parameters retained in first42MiB; Linux owns all remaining user-area bytes. No eMMC boot0/boot1/RPMB.',
  old800MiBCheckpointIncluded:false,layout:assembly.layout,image:{gzipSHA256:verified.gzipSHA256,rawSHA256:verified.rawSHA256,rawBytes:DISK,rootSHA256:verified.rootSHA256},
  verification:{wholeGzipCRCAndSegmentSHA256:true,standaloneRootGzipCRCAndRawSHA256:true,standaloneBootAndEnvironmentMatchWholePrefix:true,protectedPrefix:prefixPolicy.status},
  deploymentEvidence:deployment,evidenceRedaction:'Only explicit parent-selected files; parent must omit plaintext passwords/private keys. Private-key PEM/OpenSSH headers are refused.'});
}
async function main(args){
 if(!args.length||args[0]==='--help'){console.log('PC ordinary-file bundle only; no hardware and no ZIP.\n--inputs INPUTS.json --out NEW_DIRECTORY\nSee DELIVERY.md for the strict config schema and evidence contract.');return;}
 if(args.length!==4||args[0]!=='--inputs'||args[2]!=='--out')throw Error('Expected --inputs FILE --out NEW_DIRECTORY');
 const result=await packageFirmware(json(args[1]),args[3]);console.log(JSON.stringify({status:'ordinary-file-package-created',out:path.resolve(args[3]),files:result.files.length,deviceBound:result.deviceBound,deploymentEvidence:result.deploymentEvidence.status},null,2));
}
module.exports={validateDeliveryPlan,publishDirectory,packageFirmware,installationArtifacts,maintenanceArtifacts,maintenanceScriptArtifacts};
if(require.main===module)main(process.argv.slice(2)).catch(e=>{console.error(e.message);process.exitCode=1;});
