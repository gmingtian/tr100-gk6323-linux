const fs=require('node:fs');
const path=require('node:path');
const zlib=require('node:zlib');
const crypto=require('node:crypto');
const align=(n,a)=>Math.ceil(n/a)*a;
const sha256=b=>crypto.createHash('sha256').update(b).digest('hex');
function buildInitramfs({busyboxPath,initPath}) {
 const busybox=fs.readFileSync(busyboxPath),init=Buffer.from(fs.readFileSync(initPath,'utf8').replace(/\r\n/g,'\n'));
 if(busybox.length<64||busybox.toString('hex',0,4)!=='7f454c46'||busybox[4]!==1||busybox.readUInt16LE(18)!==40)throw Error('Expected ARM32 ELF BusyBox');
 const parts=[];let inode=1,offset=0;const entries=[];
 const push=b=>{parts.push(b);offset+=b.length;};
 const pad=a=>{if(offset%a)push(Buffer.alloc(a-offset%a));};
 function add(name,mode,data=Buffer.alloc(0),major=0,minor=0) {
  if(name.startsWith('/')||name.split('/').includes('..'))throw Error('Unsafe archive path');
  if(typeof data==='string')data=Buffer.from(data);
  const fields=[inode++,mode,0,0,(mode&0xf000)===0x4000?2:1,0,data.length,0,0,major,minor,Buffer.byteLength(name)+1,0];
  push(Buffer.from('070701'+fields.map(n=>n.toString(16).padStart(8,'0')).join('')));push(Buffer.from(name+'\0'));pad(4);push(data);pad(4);
  entries.push({name,mode:mode.toString(8),bytes:data.length,major,minor});
 }
 for(const dir of ['bin','sbin','dev','dev/pts','proc','sys','run','tmp','etc','root','usr','usr/bin','usr/sbin'])add(dir,0o040755);
 add('bin/busybox',0o100755,busybox);add('init',0o100755,init);
 for(const applet of ['sh','mount','umount','cat','echo','ls','dmesg','uname','ip','ifconfig','route','udhcpc','ps','free','sleep','mkdir','mknod','chmod','ln','insmod','lsmod','modprobe','head','tail','wc','printf','setsid','cttyhack'])add('bin/'+applet,0o120777,'busybox');
 for(const [name,major,minor,mode] of [['console',5,1,0o020600],['ttyAMA0',204,64,0o020600],['tty',5,0,0o020666],['null',1,3,0o020666],['zero',1,5,0o020666],['random',1,8,0o020666],['urandom',1,9,0o020666]])add('dev/'+name,mode,Buffer.alloc(0),major,minor);
 add('etc/issue',0o100644,'TR100 RAM diagnostic Linux\n');add('TRAILER!!!',0);
 pad(512);const cpio=Buffer.concat(parts),gzip=zlib.gzipSync(cpio,{level:9});return {cpio,gzip,entries};
}
function repackAndroidBoot(original,ramdisk) {
 if(original.toString('ascii',0,8)!=='ANDROID!')throw Error('Missing Android boot header');
 const pageSize=original.readUInt32LE(36),kernelSize=original.readUInt32LE(8);
 if(original.readUInt32LE(40)!==0||original.readUInt32LE(24)!==0)throw Error('This diagnostic repacker only accepts v0 images without a second stage');
 if(pageSize<2048||pageSize>65536||(pageSize&(pageSize-1))||pageSize+kernelSize>original.length)throw Error('Invalid Android layout');
 const header=Buffer.from(original.subarray(0,pageSize)),kernel=original.subarray(pageSize,pageSize+kernelSize);
 header.writeUInt32LE(ramdisk.length,16);header.fill(0,576,608);
 const lengthWord=n=>{const b=Buffer.alloc(4);b.writeUInt32LE(n);return b;};
 const id=crypto.createHash('sha1').update(kernel).update(lengthWord(kernel.length)).update(ramdisk).update(lengthWord(ramdisk.length)).update(lengthWord(0)).digest();id.copy(header,576);
 const output=Buffer.alloc(pageSize+align(kernelSize,pageSize)+align(ramdisk.length,pageSize));
 header.copy(output);kernel.copy(output,pageSize);ramdisk.copy(output,pageSize+align(kernelSize,pageSize));return output;
}
module.exports={buildInitramfs,repackAndroidBoot};
if(require.main===module){
 const base=path.resolve(__dirname,'..'),target=path.join(base,'ram-test');
 const original=fs.readFileSync(path.join(base,'factory-backup/factory-kernel.bin'));
 const built=buildInitramfs({busyboxPath:path.join(base,'vendor-selected/bin/busybox'),initPath:path.join(target,'init')});
 const boot=repackAndroidBoot(original,built.gzip);
 fs.writeFileSync(path.join(target,'rootfs.cpio'),built.cpio);fs.writeFileSync(path.join(target,'rootfs.cpio.gz'),built.gzip);fs.writeFileSync(path.join(target,'ramboot-stock.img'),boot);
 fs.copyFileSync(path.join(target,'ramboot-stock.img'),path.join(base,'factory-backup/ramboot-stock.img'));
 const manifest={prototypeOnly:true,sourceKernelPartitionSHA256:sha256(original),bootBytes:boot.length,bootSHA256:sha256(boot),initramfsBytes:built.gzip.length,initramfsSHA256:sha256(built.gzip),kernelBytes:original.readUInt32LE(8),pageSize:original.readUInt32LE(36),kernelLoadAddress:original.readUInt32LE(12),ramdiskAddress:original.readUInt32LE(20),entries:built.entries};
 fs.writeFileSync(path.join(target,'manifest.json'),JSON.stringify(manifest,null,2));console.log(JSON.stringify({...manifest,entries:manifest.entries.length},null,2));
}
