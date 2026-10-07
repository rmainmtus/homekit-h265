import { signalChild } from '../childProcess';
import {readFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {HevcRecording} from '../recording';
import {videoMetadata} from '../cmafMedia';
async function main() {
  const c=JSON.parse(readFileSync(process.argv[2],'utf8'));
  const recording=new HevcRecording(c.ffmpeg,c.tiers[0],console.log);
  const abort=new AbortController(), deadline=setTimeout(()=>abort.abort(),25000);
  try {
    recording.enableNativeBuffer(); recording.updateRecordingActive(true);
    const parts: Buffer[]=[]; const durations: number[]=[]; let meta;
    for await (const segment of recording.streamClip({cmafSessionId:1n,command:{sessionId:1n,command:1},signal:abort.signal})) {
      parts.push(segment.data);
      if(segment.type==='init')meta=videoMetadata(segment.data); else durations.push(segment.duration!);
      if(durations.length===3) break;
    }
    if(durations.length!==3)throw new Error('No fragments');
    const p=spawn(c.ffmpeg,['-hide_banner','-loglevel','error','-i','pipe:0','-map','0:v:0','-frames:v','12','-f','framemd5','pipe:1']);
    let output='',errors=0;p.stdout.on('data',b=>output+=b);p.stderr.on('data',()=>errors++);p.stdin.on('error',()=>{});
    const code=await new Promise<number|null>((resolve,reject)=>{p.once('error',reject);p.once('exit',resolve);p.stdin.end(Buffer.concat(parts));setTimeout(()=>signalChild(p, 'SIGKILL'),15000).unref();});
    const frames=output.split('\n').filter(l=>/^0,/.test(l)).length;
    console.log(JSON.stringify({meta,durations,frames,errors,code}));
    if(code!==0||frames!==12||errors)throw new Error('Native recording decode failed');
  } finally {clearTimeout(deadline);abort.abort();recording.close();}
}
main().catch(()=>{console.error('Native recording smoke failed');process.exitCode=1;});
