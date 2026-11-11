'use strict';
// Offline PC ordinary files only. No child process, serial, network or device access.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),zlib=require('node:zlib');
const PARTITION_BYTES=4194304, STORAGE_BYTES=65536;
const FACTORY_SHA='489debc75ac9c3e525f5ecb336a18521e062b8ff6c10ff6551e3d4da6eabd2ac';
const BOOTARGS='console=ttyAMA0,115200 blkdevparts=mmcblk0:4M(fastboot),4M(bootargs),12M(kernel),4M(deviceinfo),2M(atf),8M(baseparam),8M(pqparam),-(rootfs) loglevel=0';
const BOOTCMD='mmc read 0 0x8020000 0xC000 0x1000;mmc read 0 0x1FFBFC0 0x4000 0x5000; bootm 0x1FFBFC0';
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function parseEnvironment(image){
 if(!Buffer.isBuffer(image)||image.length!==PARTITION_BYTES)throw Error('Environment partition length must be exactly 4194304');
 if(typeof zlib.crc32!=='function')throw Error('Node 22.15+ zlib.crc32 required');
 const data=image.subarray(4,STORAGE_BYTES),crc=image.readUInt32LE();
 if(crc!==zlib.crc32(data))throw Error('Environment CRC32 mismatch in first 64KiB LE format');
 const end=data.indexOf(Buffer.from([0,0]));if(end<1)throw Error('Missing double-NUL environment terminator');
 if(data.subarray(end+2).some(x=>x!==0))throw Error('Nonzero hidden environment padding');
 const seen=new Set(),entries=data.subarray(0,end).toString('latin1').split('\0').map(item=>{
  const m=/^([A-Za-z_][A-Za-z0-9_]*)=([\x20-\x7e]*)$/.exec(item);
  if(!m)throw Error('Invalid ASCII environment entry');if(seen.has(m[1]))throw Error('Duplicate environment key: '+m[1]);seen.add(m[1]);return {key:m[1],value:m[2]};
 });
 for(const key of ['bootargs','bootcmd'])if(!seen.has(key))throw Error('Missing required environment key: '+key);
 return {entries,crc32:crc.toString(16).padStart(8,'0'),storageBytes:STORAGE_BYTES};
}
function validateOriginal(original,expected){
 if(typeof expected!=='string'||expected.toLowerCase()!==FACTORY_SHA)throw Error('Explicit original SHA256 must be pinned factory hash');
 const parsed=parseEnvironment(original);if(sha(original)!==FACTORY_SHA)throw Error('Actual original partition SHA256 differs from pinned factory');return parsed;
}
function construct(original,parsed){
 const image=Buffer.from(original),entries=parsed.entries.map(e=>({key:e.key,value:e.key==='bootargs'?BOOTARGS:e.key==='bootcmd'?BOOTCMD:e.value}));
 const encoded=Buffer.from(entries.map(e=>e.key+'='+e.value).join('\0')+'\0\0','ascii');
 if(encoded.length>STORAGE_BYTES-4)throw Error('Environment exceeds 64KiB storage');
 image.fill(0,4,STORAGE_BYTES);encoded.copy(image,4);image.writeUInt32LE(zlib.crc32(image.subarray(4,STORAGE_BYTES)),0);return image;
}
function verifyEnvironment(original,candidate,originalSHA256){
 const before=validateOriginal(original,originalSHA256),after=parseEnvironment(candidate);
 if(!candidate.subarray(STORAGE_BYTES).equals(original.subarray(STORAGE_BYTES)))throw Error('Environment partition tail changed after 64KiB');
 if(before.entries.length!==after.entries.length||before.entries.some((e,i)=>e.key!==after.entries[i].key))throw Error('Environment key set/order changed');
 const changes=after.entries.filter((e,i)=>e.value!==before.entries[i].value);
 if(changes.length!==2||changes[0].key!=='bootcmd'||changes[1].key!=='bootargs')throw Error('Only bootcmd and bootargs may change');
 if(after.entries.find(e=>e.key==='bootcmd').value!==BOOTCMD||after.entries.find(e=>e.key==='bootargs').value!==BOOTARGS)throw Error('Active bootargs map/bootcmd differ from exact pure-Linux plan; RAM/debug flags forbidden');
 if(!candidate.equals(construct(original,before)))throw Error('Unexpected bytes changed outside the two-key rebuild');
 return {status:'offline-environment-byte-policy-passed',onlyExpectedTwoKeysChanged:true,keyOrderPreserved:true,otherValuesPreserved:true,
  unchangedKeys:before.entries.filter(e=>!['bootargs','bootcmd'].includes(e.key)).map(e=>e.key),tailBytes:PARTITION_BYTES-STORAGE_BYTES,tailPreserved:true,
  originalSHA256:FACTORY_SHA,imageBytes:PARTITION_BYTES,imageSHA256:sha(candidate),crc32:after.crc32,crc32Format:'LE32 + 65532-byte NUL data',storageBytes:STORAGE_BYTES,
  diff:changes.map(e=>({key:e.key,before:before.entries.find(x=>x.key===e.key).value,after:e.value})),changedKeys:changes.map(e=>e.key),
  originalStoredMACPreserved:true,runtimeMACSource:'unchanged deviceinfo; generated environment retains original stored ethaddr',deviceWritesPerformed:false,
  environmentCommitPerformed:false,runtimeBootVerified:false};
}
function buildEnvironment(original,originalSHA256){
 const before=validateOriginal(original,originalSHA256),image=construct(original,before);return {image,manifest:verifyEnvironment(original,image,originalSHA256)};
}
function readRegular(file){const s=fs.lstatSync(file);if(!s.isFile()||s.size!==PARTITION_BYTES)throw Error('Input must be ordinary nonsymlink 4MiB file');return fs.readFileSync(file);}
function writeEnvironment(options){
 const originalPath=path.resolve(options.original),out=path.resolve(options.out),result=buildEnvironment(readRegular(originalPath),options.originalSHA256);
 fs.mkdirSync(out);const manifest={...result.manifest,originalPath,generatedAt:new Date().toISOString()};
 fs.writeFileSync(path.join(out,'bootargs.bin'),result.image,{flag:'wx'});
 fs.writeFileSync(path.join(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
 fs.writeFileSync(path.join(out,'SHA256SUMS'),['bootargs.bin','manifest.json'].map(n=>sha(fs.readFileSync(path.join(out,n)))+'  '+n).join('\n')+'\n',{flag:'wx'});
 return manifest;
}
function main(argv){
 const [command,...args]=argv;
 if(command==='--help'||!command){console.log('Offline ordinary-file only. No device access.\n'+
 'build --original FACTORY.bin --original-sha256 HEX --out NEW_DIRECTORY\n'+
 'verify --original FACTORY.bin --original-sha256 HEX --candidate READBACK.bin --candidate-sha256 HEX');return;}
 if(!['build','verify'].includes(command))throw Error('Expected build or verify');
 const o={};for(let i=0;i<args.length;i+=2){const k=args[i],v=args[i+1];if(!['--original','--original-sha256','--out','--candidate','--candidate-sha256'].includes(k)||!v||v.startsWith('--')||o[k])throw Error('Unknown/duplicate/missing explicit argument');o[k]=v;}
 if(!o['--original']||!o['--original-sha256'])throw Error('Original path and SHA256 required');
 let report;
 if(command==='build'){
  if(!o['--out']||o['--candidate']||o['--candidate-sha256'])throw Error('Build requires only new output directory');
  report=writeEnvironment({original:o['--original'],originalSHA256:o['--original-sha256'],out:o['--out']});
 }else{
  if(!o['--candidate']||!o['--candidate-sha256']||o['--out'])throw Error('Verify requires explicit candidate path and SHA256');
  const candidate=readRegular(o['--candidate']);if(!/^[a-f0-9]{64}$/i.test(o['--candidate-sha256'])||sha(candidate)!==o['--candidate-sha256'].toLowerCase())throw Error('Candidate SHA256 mismatch');
  report=verifyEnvironment(readRegular(o['--original']),candidate,o['--original-sha256']);
 }
 console.log(JSON.stringify(report,null,2));
}
module.exports={FACTORY_SHA,BOOTARGS,BOOTCMD,parseEnvironment,buildEnvironment,verifyEnvironment,writeEnvironment};
if(require.main===module)try{main(process.argv.slice(2));}catch(e){console.error(e.message);process.exitCode=1;}
