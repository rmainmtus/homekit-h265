import dgram from 'node:dgram';
import { ChildProcess, spawn } from 'node:child_process';
import { Endpoint, Tier } from './protocol';
import { FeedbackMonitor, FeedbackStats } from './feedback';
import { DatagramPacer } from './pacing';

export interface Relay {
  port: number; inputPort: number; packets: number; bytes: number;
  sequenceGaps: number; maxGapMs: number; feedback: number; receiveBuffer: number;
  receiver?: FeedbackStats;
  pacing?: DatagramPacer['stats'];
  close(): void;
}
async function bind(socket: dgram.Socket, address: string) {
  return new Promise<number>((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(0, address, () => {
      socket.removeListener('error', reject);
      resolve(socket.address().port);
    });
  });
}
// FFmpeg supplies SRTP encryption. This relay preserves the negotiated source
// port and forwards SRTCP feedback to FFmpeg without inspecting secret payloads.
export async function relay(local: string, remote: string, port: number, key?: Buffer, paceVideo = false): Promise<Relay> {
  const ingress = dgram.createSocket('udp4'), egress = dgram.createSocket('udp4');
  const monitor = key ? new FeedbackMonitor(key) : undefined;
  let sourceSsrc = 0;
  let closed = false, encoderPort: number | undefined, feedbackPort: number | undefined;
  let pacer: DatagramPacer | undefined;
  const close = () => {
    if (closed) return; closed = true;
    monitor?.close();
    pacer?.close();
    for (const s of [ingress, egress]) { try { s.close(); } catch {} }
  };
  try {
    const inputPort = await bind(ingress, '127.0.0.1');
    const outputPort = await bind(egress, local);
    ingress.setRecvBufferSize(4 * 1024 * 1024);
    egress.setSendBufferSize(1024 * 1024);
    egress.setRecvBufferSize(1024 * 1024);
    const r: Relay = {inputPort, port: outputPort, packets: 0, bytes: 0, sequenceGaps: 0, maxGapMs: 0,
      feedback: 0, receiveBuffer: ingress.getRecvBufferSize(), receiver: monitor?.stats, close};
    const send = (message: Buffer) => egress.send(message, port, remote, error => { if (error) close(); });
    if (paceVideo) {pacer = new DatagramPacer(send, 4_000_000, 4800, close); r.pacing = pacer.stats;}
    let previousSequence: number | undefined, previousTime: number | undefined;
    ingress.on('error', close); egress.on('error', close);
    ingress.on('message', (message, peer) => {
      if (closed || peer.address !== '127.0.0.1') return;
      if (message.length < 2) return;
      const rtcp = message[1] >= 192 && message[1] <= 223;
      if (rtcp) {
        if (feedbackPort !== undefined && peer.port !== feedbackPort) return;
        feedbackPort = peer.port;
      } else {
        if (encoderPort !== undefined && peer.port !== encoderPort) return;
        encoderPort = peer.port;
        if (message.length >= 12 && message[0] >> 6 === 2) {
          sourceSsrc = message.readUInt32BE(8);
          const sequence = message.readUInt16BE(2);
          if (previousSequence !== undefined) {
            const delta = (sequence - previousSequence + 65536) % 65536;
            if (delta > 1 && delta < 32768) r.sequenceGaps += delta - 1;
          }
          previousSequence = sequence;
          const now = performance.now();
          if (previousTime !== undefined) r.maxGapMs = Math.max(r.maxGapMs, Math.round(now - previousTime));
          previousTime = now;
        }
        r.packets++; r.bytes += message.length;
      }
      // Pace RTP and its sender reports together to preserve their order.
      if (pacer) pacer.push(message); else send(message);
    });
    egress.on('message', (message, peer) => {
      const destination = feedbackPort ?? encoderPort;
      if (closed || peer.address !== remote || peer.port !== port || destination === undefined) return;
      r.feedback++;
      monitor?.observe(message, sourceSsrc);
      ingress.send(message, destination, '127.0.0.1', error => { if (error) close(); });
    });
    return r;
  } catch (e) { close(); throw e; }
}
export function mediaArguments(tier: Tier, ep: Endpoint, videoPort: number, audioPort: number, videoSsrc: number, audioSsrc: number): string[] {
  // Never log this argument list: it contains short-lived SRTP session keys.
  const output = (port: number) => `srtp://127.0.0.1:${port}?rtcpport=${port}&pkt_size=1200`;
  return ['-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1',
    '-rtsp_transport', 'tcp', '-timeout', '10000000', '-i', tier.rtspUrl,
    '-map', '0:v:0', '-an', '-sn', '-dn', '-c:v', 'copy', '-bsf:v', 'dump_extra=freq=keyframe',
    '-payload_type', '99', '-ssrc', String(videoSsrc | 0),
    '-srtp_out_suite', 'AES_CM_128_HMAC_SHA1_80', '-srtp_out_params', ep.videoKey.toString('base64'),
    '-flush_packets', '1', '-max_delay', '0', '-f', 'rtp', output(videoPort),
    '-map', '0:a:0', '-vn', '-sn', '-dn', '-c:a', 'libopus', '-application', 'lowdelay',
    '-ar', '48000', '-ac', '1', '-b:a', '24000', '-frame_duration', '20', '-threads', '1',
    '-payload_type', '110', '-ssrc', String(audioSsrc | 0),
    '-srtp_out_suite', 'AES_CM_128_HMAC_SHA1_80', '-srtp_out_params', ep.audioKey.toString('base64'),
    '-flush_packets', '1', '-max_delay', '0', '-f', 'rtp', output(audioPort)];
}
export interface MediaJob { stop(): void; }
export async function startMedia(ffmpeg: string, args: string[], video: Relay, audio: Relay, onExit: () => void, signal?: AbortSignal): Promise<MediaJob> {
  if (signal?.aborted) throw new Error('Media startup cancelled');
  const child: ChildProcess = spawn(ffmpeg, args, {stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, shell: false});
  // Discard stderr rather than risk printing input credentials or SRTP key data.
  child.stderr?.resume();
  let stopped = false, exited = false;
  let cancelStartup: (() => void) | undefined;
  const abort = () => { job.stop(); cancelStartup?.(); };
  const job = {stop() {
    if (stopped) return; stopped = true;
    clearInterval(watchdog);
    signal?.removeEventListener('abort', abort);
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      const timer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 2000);
      timer.unref(); child.once('exit', () => clearTimeout(timer));
    }
  }};
  let last = 0, lastAudio = 0, misses = 0;
  const watchdog = setInterval(() => {
    if (video.packets === last || audio.packets === lastAudio) misses++; else misses = 0;
    last = video.packets; lastAudio = audio.packets;
    if (misses >= 3) job.stop();
  }, 5000);
  watchdog.unref();
  const ended = () => { job.stop(); if (!exited) {exited = true; onExit();} };
  child.once('exit', ended);
  child.once('error', ended);
  // Do not report a successful stream until both encrypted media paths emit data.
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const end = () => finish(new Error('Media process ended before startup'));
    const timer = setTimeout(() => finish(new Error('No media within 12 seconds')), 12000);
    const poll = setInterval(() => { if (video.packets && audio.packets) finish(); }, 100);
    const finish = (error?: Error) => {
      if (settled) return; settled = true; cancelStartup = undefined;
      clearTimeout(timer); clearInterval(poll); child.removeListener('exit', end); child.removeListener('error', end);
      if (error) { job.stop(); reject(error); } else resolve();
    };
    child.once('exit', end); child.once('error', end);
    cancelStartup = () => finish(new Error('Media startup cancelled'));
    signal?.addEventListener('abort', abort, {once: true});
    if (signal?.aborted) abort();
  });
  return job;
}
