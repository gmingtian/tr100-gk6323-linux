'use strict';
// PC ordinary files only. No device, serial, process or network API.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),zlib=require('node:zlib');
const FACTORY_SHA='489debc75ac9c3e525f5ecb336a18521e062b8ff6c10ff6551e3d4da6eabd2ac';
const SOURCE_SHA='55100d2a59920cc1e269c7a1e92660c5f1052705ca3550e786da6fcbc4ebda58';
const SOURCE=path.resolve(__dirname,'../../../../firmware-pure-linux/tools/build-environment.cjs');
const PARTITION=4194304,STORAGE=65536;
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function source(){if(sha(fs.readFileSync(SOURCE))!==SOURCE_SHA)throw Error('Frozen final env source SHA mismatch');return require(SOURCE);}
function parse(b){return source().parseEnvironment(b);}
function originalEntries(original,expected){
 if(expected!==FACTORY_SHA||!Buffer.isBuffer(original)||original.length!==PARTITION||sha(original)!==FACTORY_SHA)throw Error('Original SHA must equal exact pinned factory 4MiB');
 const api=source();if(api.FACTORY_SHA!==FACTORY_SHA)throw Error('Source factory pin mismatch');
 const entries=api.parseEnvironment(original).entries;
 if(!entries.some(e=>e.key==='bootdelay'&&e.value==='0'))throw Error('Expected original bootdelay=0');
 return entries;
}
function construct(original,entries){
 const api=source(),image=Buffer.from(original);
 const replacements={bootargs:api.BOOTARGS,bootcmd:'printenv',bootdelay:'3'};
 const updated=entries.map(e=>({key:e.key,value:Object.hasOwn(replacements,e.key)?replacements[e.key]:e.value}));
 const data=Buffer.from(updated.map(e=>e.key+'='+e.value).join('\0')+'\0\0','ascii');
 if(data.length>STORAGE-4)throw Error('Probe env exceeds 64KiB');
 image.fill(0,4,STORAGE);data.copy(image,4);image.writeUInt32LE(zlib.crc32(image.subarray(4,STORAGE)),0);return image;
}
function verifyProbe(original,candidate,expected){
 const before=originalEntries(original,expected),after=parse(candidate).entries;
 if(!candidate.subarray(STORAGE).equals(original.subarray(STORAGE)))throw Error('Probe partition tail differs');
 if(before.length!==after.length||before.some((e,i)=>e.key!==after[i].key))throw Error('Probe key set/order changed');
 const changed=after.filter((e,i)=>e.value!==before[i].value);
 if(JSON.stringify(changed.map(e=>e.key))!==JSON.stringify(['bootdelay','bootcmd','bootargs']))throw Error('Exactly three probe keys must differ');
 if(!candidate.equals(construct(original,before)))throw Error('Unexpected bytes or other value differ from exact probe');
 return {status:'probe-byte-policy-passed',purpose:'TR100_NEW_MAP_SOFTWARE_REBOOT_PROBE_NOT_FINAL',finalBootEnvironment:false,
  imageBytes:PARTITION,imageSHA256:sha(candidate),originalSHA256:FACTORY_SHA,frozenSourceSHA256:SOURCE_SHA,
  changedKeys:changed.map(e=>e.key),diff:changed.map(e=>({key:e.key,before:before.find(x=>x.key===e.key).value,after:e.value})),
  keyOrderPreserved:true,otherKeysPreserved:true,tailPreserved:true,tailBytes:PARTITION-STORAGE,
  crc32:parse(candidate).crc32,crcFormat:'LE32 + 65532 bytes NUL data',storageBytes:STORAGE,
  deviceWritesPerformed:false,environmentCommitPerformed:false,softwareRebootVerified:false,coldBootVerified:false,
  nextGate:'Parent writes/reads back separately; software reboot trace must show fresh map + printenv + interactive prompt. No old payload is erased by this PC tool.'};
}
function buildProbe(original,expected){const entries=originalEntries(original,expected),image=construct(original,entries);return {image,receipt:verifyProbe(original,image,expected)};}
function regular(file){const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==PARTITION)throw Error('Expected ordinary nonsymlink exact 4MiB input');return fs.readFileSync(file);}
function main(argv){
 const [command,...args]=argv;
 if(!command||command==='--help'){console.log('PC offline probe ONLY; no device access.\nbuild --original FILE --original-sha256 HEX --out NEW_DIRECTORY\nverify --original FILE --original-sha256 HEX --candidate FILE --candidate-sha256 HEX');return;}
 if(!['build','verify'].includes(command))throw Error('Expected build/verify');
 const o={};for(let i=0;i<args.length;i+=2){let k=args[i],v=args[i+1];if(!['--original','--original-sha256','--out','--candidate','--candidate-sha256'].includes(k)||!v||v.startsWith('--')||o[k])throw Error('Unknown/duplicate/missing explicit argument');o[k]=v;}
 if(!o['--original']||!o['--original-sha256'])throw Error('Explicit original path and SHA required');
 const original=regular(o['--original']);let receipt;
 if(command==='build'){
  if(!o['--out']||o['--candidate']||o['--candidate-sha256'])throw Error('Build requires only new output directory');
  const result=buildProbe(original,o['--original-sha256']),out=path.resolve(o['--out']);
  fs.mkdirSync(out);fs.writeFileSync(path.join(out,'probe-bootargs-NOT-FINAL.bin'),result.image,{flag:'wx'});
  receipt={...result.receipt,originalPath:path.resolve(o['--original'])};
  fs.writeFileSync(path.join(out,'receipt.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
  fs.writeFileSync(path.join(out,'SHA256SUMS'),['probe-bootargs-NOT-FINAL.bin','receipt.json'].map(n=>sha(fs.readFileSync(path.join(out,n)))+'  '+n).join('\n')+'\n',{flag:'wx'});
 }else{
  if(!o['--candidate']||!o['--candidate-sha256']||o['--out'])throw Error('Verify requires explicit candidate path/SHA only');
  const candidate=regular(o['--candidate']);if(!/^[0-9a-f]{64}$/i.test(o['--candidate-sha256'])||sha(candidate)!==o['--candidate-sha256'].toLowerCase())throw Error('Candidate SHA mismatch');
  receipt=verifyProbe(original,candidate,o['--original-sha256']);
 }
 console.log(JSON.stringify(receipt,null,2));
}
module.exports={FACTORY_SHA,SOURCE_SHA,source,parse,buildProbe,verifyProbe};
if(require.main===module)try{main(process.argv.slice(2));}catch(e){console.error(e.message);process.exitCode=1;}
