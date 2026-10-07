import dgram from 'node:dgram';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mediaArguments, relay, startMedia } from '../media';
import { Tier } from '../protocol';
async function main() {
  const source = process.env.HEVC_TEST_RTSP;
  if (!source) throw new Error('Source required');
  const ffmpeg = process.env.FFMPEG_PATH || '/usr/bin/ffmpeg';
  const reserve = dgram.createSocket('udp4');
  await new Promise<void>(r => reserve.bind(0, '127.0.0.1', r));
  const port = reserve.address().port;
  await new Promise<void>(r => reserve.close(r));
  const audioSink = dgram.createSocket('udp4');
  await new Promise<void>(r => audioSink.bind(0, '127.0.0.1', r));
  const key = randomBytes(30), audioKey = randomBytes(30);
  const sdp = `v=0\no=- 0 0 IN IP4 127.0.0.1\ns=HEVC local decode test\nc=IN IP4 127.0.0.1\nt=0 0\nm=video ${port} RTP/SAVP 99\na=rtpmap:99 H265/90000\na=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:${key.toString('base64')}\n`;
  const receiver = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'pipe,udp,rtp,crypto',
    '-threads', '1', '-f', 'sdp', '-i', 'pipe:0', '-map', '0:v:0', '-frames:v', '12', '-threads', '1', '-progress', 'pipe:1', '-f', 'null', '-'], {stdio: ['pipe', 'pipe', 'pipe']});
  let frames = 0, errors = 0;
  receiver.stdout.on('data', b => {for (const m of b.toString().matchAll(/frame=(\d+)/g)) frames = Math.max(frames, Number(m[1]));});
  receiver.stderr.on('data', () => errors++);
  receiver.stdin.on('error', () => {}); receiver.stdin.end(sdp);
  let timer: NodeJS.Timeout;
  const ended = new Promise<void>(resolve => {receiver.once('close', () => {clearTimeout(timer); resolve();});
    receiver.once('error', () => {clearTimeout(timer); resolve();});
    timer = setTimeout(() => receiver.kill('SIGKILL'), 18000);});
  const video = await relay('127.0.0.1', '127.0.0.1', port, undefined, true);
  const audio = await relay('127.0.0.1', '127.0.0.1', audioSink.address().port);
  const tier: Tier = {id: 1, quality: 2, width: 2304, height: 2592, fps: 12, averageKbps: 2466, peakKbps: 4111, rtspUrl: source};
  let job: Awaited<ReturnType<typeof startMedia>> | undefined;
  try {
    job = await startMedia(ffmpeg, mediaArguments(tier, {id: randomBytes(16), address: '127.0.0.1',
      videoPort: port, audioPort: audioSink.address().port, videoKey: key, audioKey}, video.inputPort, audio.inputPort, 123456, 789012), video, audio, () => {});
    await ended;
    console.log(JSON.stringify({decodedFrames: frames, videoPackets: video.packets, decoderErrorChunks: errors, result: frames >= 12 ? 'PASS' : 'FAIL'}));
    if (frames < 12) process.exitCode = 1;
  } finally {job?.stop(); receiver.kill('SIGKILL'); clearTimeout(timer!); video.close(); audio.close(); audioSink.close();}
}
main().catch(() => {console.error('Local HEVC decrypt/decode test failed'); process.exitCode = 1;});
