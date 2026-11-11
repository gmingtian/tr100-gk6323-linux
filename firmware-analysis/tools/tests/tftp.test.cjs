const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dgram = require('node:dgram');
let startTftp;
try { ({ startTftp } = require('../tftp-server.cjs')); } catch(e) { if(e.code !== 'MODULE_NOT_FOUND') throw e; }
function packet(op, number, payload = Buffer.alloc(0)) {
  const b = Buffer.alloc(4 + payload.length); b.writeUInt16BE(op); b.writeUInt16BE(number, 2); payload.copy(b,4); return b;
}
function request(op, filename) { return Buffer.concat([Buffer.from([0,op]),Buffer.from(filename+'\0octet\0')]); }
async function fixture(t) {
  assert.equal(typeof startTftp, 'function', 'TFTP server factory is not implemented');
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'tr100-tftp-test-'));
  const server = await startTftp({host:'127.0.0.1',port:0,root,allowedPeer:'127.0.0.1',writeNames:['backup.bin'],timeoutMs:200,maxRetries:5});
  const client = dgram.createSocket('udp4');
  await new Promise(resolve=>client.bind(0,'127.0.0.1',resolve));
  const queue=[],waiters=[];
  client.on('message',(data,peer)=>{const item={data,peer};if(waiters.length)waiters.shift()(item);else queue.push(item);});
  const receive=()=>queue.length?Promise.resolve(queue.shift()):new Promise((resolve,reject)=>{let timer=setTimeout(()=>reject(Error('TFTP response timeout')),1500);waiters.push(value=>{clearTimeout(timer);resolve(value);});});
  const send=(b,port=server.address().port)=>client.send(b,port,'127.0.0.1');
  t.after(async()=>{client.close();await server.close();const relative=path.relative(os.tmpdir(),fs.realpathSync(root));assert.ok(!path.isAbsolute(relative)&&!relative.startsWith('..')&&path.basename(root).startsWith('tr100-tftp-test-'));fs.rmSync(root,{recursive:true,force:true});});
  return {root,server,receive,send};
}
test('RRQ retries a lost packet and terminates an exact block multiple with an empty data packet',async t=>{
  const {root,receive,send}=await fixture(t);
  const input=Buffer.alloc(1024);for(let i=0;i<input.length;i++)input[i]=i%251;
  fs.writeFileSync(path.join(root,'kernel.bin'),input);
  send(request(1,'kernel.bin'));
  let first=await receive();assert.equal(first.data.readUInt16BE(0),3);assert.equal(first.data.readUInt16BE(2),1);
  const retry=await receive();assert.deepEqual(retry.data,first.data,'unacknowledged block must be retransmitted');
  send(packet(4,1),first.peer.port);
  const second=await receive();assert.equal(second.data.readUInt16BE(2),2);
  send(packet(4,2),second.peer.port);
  const last=await receive();assert.deepEqual(last.data,Buffer.from([0,3,0,3]));
  assert.deepEqual(Buffer.concat([first.data.subarray(4),second.data.subarray(4)]),input);
  send(packet(4,3),last.peer.port);
});
test('WRQ acknowledges duplicate data without writing it twice',async t=>{
  const {root,receive,send}=await fixture(t);
  send(request(2,'backup.bin'));
  const start=await receive();assert.deepEqual(start.data,Buffer.from([0,4,0,0]));
  const block=Buffer.alloc(512,0x37);
  send(packet(3,1,block),start.peer.port);assert.deepEqual((await receive()).data,Buffer.from([0,4,0,1]));
  send(packet(3,1,block),start.peer.port);assert.deepEqual((await receive()).data,Buffer.from([0,4,0,1]));
  send(packet(3,2,Buffer.from('end')),start.peer.port);assert.deepEqual((await receive()).data,Buffer.from([0,4,0,2]));
  assert.deepEqual(fs.readFileSync(path.join(root,'backup.bin')),Buffer.concat([block,Buffer.from('end')]));
});
test('server refuses path traversal and uploads outside the explicit allowlist',async t=>{
  const {receive,send}=await fixture(t);
  for(const [op,name] of [[1,'../outside'],[2,'../backup.bin'],[2,'unapproved.bin']]) {
    send(request(op,name));const response=await receive();assert.equal(response.data.readUInt16BE(0),5);assert.equal(response.data.readUInt16BE(2),2);
  }
});
test('WRQ negotiates block size and survives the 16-bit block-number rollover used by large backups',async t=>{
  const {root,receive,send}=await fixture(t);
  send(Buffer.concat([Buffer.from([0,2]),Buffer.from('backup.bin\0octet\0blksize\x008\0')]));
  const start=await receive();
  assert.deepEqual(start.data,Buffer.concat([Buffer.from([0,6]),Buffer.from('blksize\x008\0')]));
  const body=Buffer.alloc(8,0x5a);
  for(let i=1;i<=65536;i++){
    const number=i&65535;
    send(packet(3,number,body),start.peer.port);
    const ack=await receive();assert.equal(ack.data.readUInt16BE(0),4);assert.equal(ack.data.readUInt16BE(2),number);
  }
  send(packet(3,1,Buffer.from('e')),start.peer.port);
  assert.deepEqual((await receive()).data,Buffer.from([0,4,0,1]));
  assert.deepEqual(fs.readFileSync(path.join(root,'backup.bin')),Buffer.concat([Buffer.alloc(524288,0x5a),Buffer.from('e')]));
});
