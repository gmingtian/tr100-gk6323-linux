const dgram = require('node:dgram');
const fs = require('node:fs');
const path = require('node:path');

const header = (op,n) => {const b=Buffer.alloc(4);b.writeUInt16BE(op);b.writeUInt16BE(n,2);return b;};
const errorPacket = (code,text) => Buffer.concat([header(5,code),Buffer.from(text+'\0')]);

async function startTftp({host,port=69,root,allowedPeer,writeNames=[],timeoutMs=1000,maxRetries=8,onEvent=()=>{}}) {
  root=fs.realpathSync(root);
  const listener=dgram.createSocket('udp4'), transfers=new Map(), uploads=new Set(writeNames);
  let closing=false;
  const emit=event=>onEvent({...event,time:new Date().toISOString()});
  function allowedName(name) {return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/.test(name)&&name!=='.'&&name!=='..';}
  function reject(peer,code,text) {listener.send(errorPacket(code,text),peer.port,peer.address);}
  listener.on('message',(request,peer)=>{
    emit({type:'request',peer:peer.address,port:peer.port,bytes:request.length,opcode:request.length>=2?request.readUInt16BE(0):null});
    if(closing||peer.address!==allowedPeer||request.length<4)return;
    const op=request.readUInt16BE(0);if(op!==1&&op!==2)return;
    const fields=request.subarray(2).toString('ascii').split('\0'),name=fields[0],mode=fields[1]?.toLowerCase();
    if(!allowedName(name)||(op===2&&!uploads.has(name)))return reject(peer,2,'Access denied');
    if(mode!=='octet')return reject(peer,4,'Only octet is supported');
    const key=peer.address+':'+peer.port;
    if(transfers.has(key)){transfers.get(key).resend();return;}
    const options={};for(let i=2;i+1<fields.length&&fields[i];i+=2)options[fields[i].toLowerCase()]=fields[i+1];
    let blockSize=512;const negotiated={};
    if(options.blksize!==undefined){const size=Number(options.blksize);if(!Number.isInteger(size)||size<8||size>65464)return reject(peer,8,'Invalid block size');blockSize=Math.min(size,8192);negotiated.blksize=String(blockSize);}
    const filename=path.join(root,name),part=filename+'.part';
    let input,fd;
    try {
      if(op===1){const actual=fs.realpathSync(filename);if(!actual.startsWith(root+path.sep))return reject(peer,2,'Access denied');input=fs.readFileSync(actual);if(input.length>64*1024*1024)return reject(peer,3,'File too large');}
      else {if(fs.existsSync(filename)||fs.existsSync(part))return reject(peer,6,'File already exists');fd=fs.openSync(part,'wx');}
    }catch(e){return reject(peer,e.code==='ENOENT'?1:2,'File unavailable');}
    if(options.tsize!==undefined)negotiated.tsize=op===1?String(input.length):options.tsize;
    const socket=dgram.createSocket('udp4');let timer=null,last=null,retries=0,closed=false,bytes=0,block=op===1?1:0,offset=0,complete=false,waitingOack=Object.keys(negotiated).length>0&&op===1,lastProgress=0;
    const close=()=>{if(closed)return;closed=true;clearTimeout(timer);if(fd!==undefined){fs.closeSync(fd);fd=undefined;}transfers.delete(key);socket.close();};
    const arm=()=>{clearTimeout(timer);timer=setTimeout(()=>{if(complete){close();return;}if(++retries>maxRetries){emit({type:'timeout',name,bytes});close();return;}if(last)socket.send(last,peer.port,peer.address);arm();},complete?8000:timeoutMs);};
    const send=b=>{last=b;retries=0;socket.send(b,peer.port,peer.address);arm();};
    const sendData=()=>send(Buffer.concat([header(3,block),input.subarray(offset,offset+blockSize)]));
    transfers.set(key,{close,resend:()=>{if(last)socket.send(last,peer.port,peer.address);}});
    socket.on('error',e=>{emit({type:'error',name,error:e.message});close();});
    socket.on('message',(message,remote)=>{
      if(closed||remote.address!==peer.address||remote.port!==peer.port||message.length<4)return;
      const kind=message.readUInt16BE(0),number=message.readUInt16BE(2);
      if(kind===5){emit({type:'peer-error',name,message:message.subarray(4).toString()});close();return;}
      if(op===1&&kind===4){
        if(waitingOack){if(number!==0)return;waitingOack=false;sendData();return;}
        if(number!==block)return;
        const sent=Math.min(blockSize,input.length-offset);bytes+=sent;
        if(sent<blockSize){emit({type:'complete',direction:'download',name,bytes});close();return;}
        offset+=sent;block=(block+1)&65535;sendData();
      }else if(op===2&&kind===3){
        if(complete){socket.send(header(4,block),peer.port,peer.address);return;}
        const wanted=(block+1)&65535;
        if(number!==wanted){socket.send(header(4,block),peer.port,peer.address);return;}
        const data=message.subarray(4);
        if(data.length>blockSize||bytes+data.length>64*1024*1024){socket.send(errorPacket(3,'Invalid or excessive data'),peer.port,peer.address);close();return;}
        try {fs.writeSync(fd,data);bytes+=data.length;block=number;
          if(data.length<blockSize){fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(part,filename);complete=true;emit({type:'complete',direction:'upload',name,bytes});}
          send(header(4,block));
        }catch(e){socket.send(errorPacket(3,'Write failed'),peer.port,peer.address);emit({type:'error',name,error:e.message});close();}
      }
      if(bytes-lastProgress>=1024*1024){lastProgress=bytes;emit({type:'progress',name,bytes});}
    });
    socket.bind(0,host,()=>{
      emit({type:'start',direction:op===1?'download':'upload',name,blockSize});
      if(Object.keys(negotiated).length){const body=Object.entries(negotiated).flat().join('\0')+'\0';send(Buffer.concat([Buffer.from([0,6]),Buffer.from(body)]));}
      else if(op===1)sendData();else send(header(4,0));
    });
  });
  await new Promise((resolve,reject)=>{listener.once('error',reject);listener.bind(port,host,resolve);});
  listener.on('error',e=>emit({type:'listener-error',error:e.message}));
  return {address:()=>listener.address(),close:async()=>{closing=true;for(const transfer of [...transfers.values()])transfer.close();await new Promise(resolve=>listener.close(resolve));}};
}
module.exports={startTftp};
if(require.main===module){
  const [host,root,allowedPeer]=process.argv.slice(2);
  if(!host||!root||!allowedPeer)throw Error('Usage: node tftp-server.cjs HOST ROOT ALLOWED_PEER');
  const writes=['factory-fastboot.bin','factory-bootargs.bin','factory-deviceinfo.bin','factory-atf.bin','factory-kernel.bin'];
  startTftp({host,root,allowedPeer,writeNames:writes,onEvent:e=>console.log(JSON.stringify(e))}).then(server=>{
    console.log(JSON.stringify({type:'ready',pid:process.pid,execPath:process.execPath,...server.address(),allowedPeer,root:path.resolve(root)}));
    const timer=setTimeout(()=>server.close().then(()=>console.log('TFTP_CLOSED')),10*60*1000);
    process.on('SIGINT',()=>{clearTimeout(timer);server.close().then(()=>process.exit(0));});
  }).catch(e=>{console.error(e.message);process.exitCode=1;});
}
