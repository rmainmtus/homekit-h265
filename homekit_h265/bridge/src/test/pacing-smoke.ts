import dgram from 'node:dgram';
import {readFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {relay} from '../media';
import {remoteMediaArguments} from '../webrtc';
async function main() {
  const c=JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const sockets=[dgram.createSocket('udp4'),dgram.createSocket('udp4'),dgram.createSocket('udp4')];
  for(const s of sockets){await new Promise<void>(r=>s.bind(0,'127.0.0.1',r));s.setRecvBufferSize(4*1024*1024);}
  const direct=await relay('127.0.0.1','127.0.0.1',sockets[0].address().port);
  const paced=await relay('127.0.0.1','127.0.0.1',sockets[1].address().port,undefined,true);
  const stats=[0,1].map(()=>({packets:0,bytes:0,max5ms:0,window:[] as {at:number;bytes:number}[],windowBytes:0,hash:createHash('sha256')}));
  sockets.slice(0,2).forEach((socket,i)=>socket.on('message', b=>{
    if(i===0)sockets[0].send(b,paced.inputPort,'127.0.0.1');
    const s=stats[i],now=performance.now();s.packets++;s.bytes+=b.length;s.hash.update(b);
    s.window.push({at:now,bytes:b.length});s.windowBytes+=b.length;
    while(s.window.length&&s.window[0].at<now-5)s.windowBytes-=s.window.shift()!.bytes;
    s.max5ms=Math.max(s.max5ms,s.windowBytes);
  }));
  const p=spawn(c.ffmpeg,remoteMediaArguments(c.tiers[0],direct.inputPort,sockets[2].address().port),{stdio:'ignore'});
  try {
    await new Promise(r=>setTimeout(r,15000));p.kill();
    await new Promise(r=>setTimeout(r,650));
    const hashes=stats.map(s=>s.hash.digest('hex'));
    const same=hashes[0]===hashes[1];
    console.log(JSON.stringify({identicalPackets:same,direct:{packets:stats[0].packets,max5msBytes:stats[0].max5ms},paced:{packets:stats[1].packets,max5msBytes:stats[1].max5ms},pacing:paced.pacing}));
    if(!same||stats[0].packets<100||paced.pacing!.overloads)throw new Error('Pacing comparison failed');
  } finally {p.kill();direct.close();paced.close();sockets.forEach(s=>s.close());}
}
main().catch(()=>{console.error('Real camera pacing test failed');process.exitCode=1;});
