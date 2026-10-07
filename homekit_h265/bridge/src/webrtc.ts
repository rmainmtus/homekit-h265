import { randomBytes } from 'node:crypto';
import dgram from 'node:dgram';
import { spawn, ChildProcess } from 'node:child_process';
import { Characteristic, Formats, Perms, Service, Access } from 'hap-nodejs';
import { MediaStreamTrack, RTCPeerConnection, RTCRtpCodecParameters, RtpPacket, RTCRtpTransceiver } from 'werift';
import { Tier, Field, hapUuid, tlv, uint, parse, one, fromBase64, videoTiers, audioTiers } from './protocol';
import { SecureVideoSFrame } from './sframe';
import { HevcAccessUnitAssembler, SFrameRtpPacketizer } from './sframeRtp';
import { addVideoRtpStreamId, replayEarlyDtls, tuneIceBuffers } from './webrtcSdp';

// Remote media follows cameraui/plugins' tested Apple relay implementation (MIT).
const videoCodec = new RTCRtpCodecParameters({mimeType: 'video/H265', clockRate: 90000, payloadType: 99,
  parameters: 'profile-id=1;tier-flag=0;level-id=153;tx-mode=SRST',
  rtcpFeedback: [{type: 'nack'}, {type: 'nack', parameter: 'pli'}, {type: 'ccm', parameter: 'fir'}]});
const audioCodec = new RTCRtpCodecParameters({mimeType: 'audio/opus', clockRate: 48000, channels: 2, payloadType: 110,
  parameters: 'minptime=20;useinbandfec=1;stereo=0;sprop-stereo=0'});
interface RemoteSession {
  id: Buffer; pc: RTCPeerConnection; video: MediaStreamTrack; audio: MediaStreamTrack;
  vt: RTCRtpTransceiver; at: RTCRtpTransceiver; crypto: SecureVideoSFrame;
  answered: boolean; closed: boolean; starting: boolean; sockets: dgram.Socket[];
  timer: NodeJS.Timeout; watchdog?: NodeJS.Timeout; child?: ChildProcess;
  frames: number; audioPackets: number; lastVideo: number; lastAudio: number; mediaReady: boolean;
}
export function candidates(fields: Field[]): {candidate: string; sdpMid?: string; sdpMLineIndex?: number}[] {
  const values = fields.filter(([tag]) => tag === 3);
  if (values.length > 32) throw new Error('Too many candidates');
  return values.map(([, value]) => {
    const f = parse(value), candidate = one(f, 1).toString();
    if (candidate.length > 4096) throw new Error('Candidate too large');
    const mid = f.find(([t]) => t === 2)?.[1];
    const line = f.find(([t]) => t === 3)?.[1];
    if (line && line.length !== 2) throw new Error('Invalid candidate index');
    return {candidate, sdpMid: mid?.toString(), sdpMLineIndex: line?.readUInt16LE()};
  });
}
export class RemoteViewing {
  readonly service = new Service('HEVC Remote Stream', hapUuid('8033'));
  readonly sessions = new Map<string, RemoteSession>();
  private enabled: boolean;
  private count: Characteristic;
  constructor(private address: string, private ffmpeg: string, private tier: Tier, sensor: Buffer,
    private active: () => boolean, private log: (message: string) => void,
    private privacy?: {get(key: string): boolean; set(key: string, value: boolean): void}) {
    this.enabled = privacy?.get('remote') ?? true;
    this.char('Sensor UUID', '805B', Formats.DATA, [Perms.PAIRED_READ]).onGet(() => sensor.toString('base64'));
    this.char('WebRTC Video Tiers', '8059', Formats.TLV8, [Perms.PAIRED_READ, Perms.NOTIFY]).onGet(() => videoTiers([tier]).toString('base64'));
    this.char('WebRTC Audio Tiers', '805A', Formats.TLV8, [Perms.PAIRED_READ, Perms.NOTIFY]).onGet(() => audioTiers().toString('base64'));
    this.count = this.char('WebRTC Active Sessions', '8057', Formats.UINT8, [Perms.PAIRED_READ, Perms.NOTIFY]);
    this.count.updateValue(0);
    this.char('Streaming Enabled', '8041', Formats.BOOL, [Perms.PAIRED_READ, Perms.PAIRED_WRITE, Perms.NOTIFY, Perms.TIMED_WRITE])
      .setProps({adminOnlyAccess: [Access.WRITE]}).onGet(() => this.enabled).onSet(value => {
        this.enabled = !!value; privacy?.set('remote', this.enabled); if (!this.enabled) this.stopAll();
      });
    this.handler('WebRTC Solicit Offer', '8053', b => this.solicit(b));
    this.handler('WebRTC Provide Answer', '8054', b => this.control('answer', b));
    this.handler('WebRTC Reoffer', '8058', b => this.control('reoffer', b));
    this.handler('WebRTC Update Session', '805C', b => this.control('update', b));
    this.handler('WebRTC Streaming Control', '8056', b => this.control('end', b));
  }
  private char(name: string, id: string, format: Formats, perms: Perms[]) {
    const c = new Characteristic(name, hapUuid(id), {format, perms}); this.service.addCharacteristic(c); return c;
  }
  private handler(name: string, id: string, fn: (b: Buffer) => Promise<Buffer>) {
    const replies = new WeakMap<object, string>();
    this.char(name, id, Formats.TLV8, [Perms.PAIRED_READ, Perms.PAIRED_WRITE, Perms.WRITE_RESPONSE])
      .onGet((_context, connection) => connection ? replies.get(connection) ?? '' : '')
      .onSet(async (value, _context, connection) => {
        if (!connection) throw new Error('Authenticated connection required');
        const reply = (await fn(fromBase64(value))).toString('base64');
        replies.set(connection, reply); return reply;
      });
  }
  async solicit(data: Buffer): Promise<Buffer> {
    // Parse options even though the sender always applies SFrame encryption.
    const f = parse(data); for (const [, options] of f) parse(options);
    if (!this.active() || !this.enabled) return tlv([4, uint(1, 1)]);
    if (this.sessions.size >= 6) return tlv([4, uint(2, 1)]);
    const id = randomBytes(16), key = id.toString('hex');
    const pc = new RTCPeerConnection({codecs: {video: [videoCodec], audio: [audioCodec]},
      iceUseIpv6: false, iceServers: [], iceInterfaceAddresses: {udp4: this.address}});
    const video = new MediaStreamTrack({kind: 'video'}), audio = new MediaStreamTrack({kind: 'audio'});
    const vt = pc.addTransceiver(video, {direction: 'sendonly'}), at = pc.addTransceiver(audio, {direction: 'sendonly'});
    const s: RemoteSession = {id, pc, video, audio, vt, at, crypto: new SecureVideoSFrame(true),
      answered: false, closed: false, starting: false, sockets: [], frames: 0, audioPackets: 0,
      lastVideo: Date.now(), lastAudio: Date.now(), mediaReady: false,
      timer: setTimeout(() => void this.stop(key), 60000)};
    s.timer.unref(); this.sessions.set(key, s); this.count.updateValue(this.sessions.size);
    const gathered: Field[] = [];
    pc.onIceCandidate.subscribe(c => {
      const j = c?.toJSON(); if (!j?.candidate || gathered.length >= 32) return;
      const fields: Field[] = [[1, Buffer.from(j.candidate)]];
      if (j.sdpMid !== undefined && j.sdpMid !== null) fields.push([2, Buffer.from(j.sdpMid)]);
      if (j.sdpMLineIndex !== undefined && j.sdpMLineIndex !== null) fields.push([3, uint(j.sdpMLineIndex, 2)]);
      gathered.push([3, tlv(...fields)]);
    });
    pc.iceConnectionStateChange.subscribe(state => this.log(`Remote ICE: ${state}`));
    pc.connectionStateChange.subscribe(state => {
      this.log(`Remote connection: ${state}`);
      if (state === 'connected') void this.start(s).catch(() => {this.log('Remote media startup failed'); void this.stop(key);});
      else if (['failed', 'closed', 'disconnected'].includes(state)) void this.stop(key);
    });
    try {
      const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
      tuneIceBuffers(pc);
      if (s.closed || !this.active() || !this.enabled) throw new Error('Session stopped');
      replayEarlyDtls(pc, n => this.log(`Remote DTLS replay: ${n}`));
      const sdp = addVideoRtpStreamId(pc.localDescription?.sdp ?? offer.sdp, this.tier);
      const kid = Buffer.alloc(8); kid.writeBigUInt64LE(s.crypto.senderKey!.kid);
      this.log('Remote encrypted offer prepared');
      return tlv([1, id], [2, Buffer.from(sdp)], ...gathered, [4, uint(0, 1)],
        [5, tlv([1, s.crypto.senderKey!.key], [2, kid])]);
    } catch {await this.stop(key); this.log('Remote offer failed'); return tlv([4, uint(2, 1)]);}
  }
  async control(kind: 'answer' | 'reoffer' | 'update' | 'end', data: Buffer): Promise<Buffer> {
    const f = parse(data), id = one(f, 1, 16), key = id.toString('hex'), s = this.sessions.get(key);
    const statusTag = kind === 'reoffer' ? 3 : 2;
    const reply = (status: number) => tlv([1, id], [statusTag, uint(status, 1)]);
    if (!s || s.closed) return reply(1);
    try {
      if (kind === 'end') {
        if (one(f, 2, 1)[0] !== 1) throw new Error('Invalid end command');
        await this.stop(key); return reply(0);
      }
      if (!this.active() || !this.enabled) throw new Error('Streaming disabled');
      if (kind === 'answer') {
        if (s.answered) return reply(2);
        const sdp = one(f, 2).toString();
        if (sdp.length > 60000 || !sdp.startsWith('v=0')) throw new Error('Invalid SDP');
        const ice = candidates(f);
        await s.pc.setRemoteDescription({type: 'answer', sdp}); s.answered = true;
        for (const c of ice) await s.pc.addIceCandidate(c);
        this.log('Remote relay answer accepted');
      } else if (kind === 'reoffer') {
        const sdp = one(f, 2).toString();
        if (sdp.length > 60000 || !sdp.startsWith('v=0')) throw new Error('Invalid SDP');
        await s.pc.setRemoteDescription({type: 'offer', sdp});
        const answer = await s.pc.createAnswer(); await s.pc.setLocalDescription(answer);
        return tlv([1, id], [2, Buffer.from(s.pc.localDescription?.sdp ?? answer.sdp)], [3, uint(0, 1)]);
      } else {
        // Receive keys are accepted for protocol compatibility; talkback remains disabled.
        for (const [tag, value] of f) {
          if (tag !== 2 && tag !== 3) continue;
          const k = parse(value);
          if (tag === 2) {one(k, 1, 32); one(k, 2, 8);} else one(k, 1, 8);
        }
      }
      return reply(0);
    } catch {this.log(`Remote ${kind} failed`); await this.stop(key); return reply(3);}
  }
  private async start(s: RemoteSession) {
    if (s.starting || s.child || s.closed) return; s.starting = true;
    const assembler = new HevcAccessUnitAssembler();
    const videoCryptor = s.crypto.videoStream(s.vt.sender.ssrc), audioCryptor = s.crypto.audioStream(s.at.sender.ssrc);
    const vp = new SFrameRtpPacketizer({ssrc: s.vt.sender.ssrc, payloadType: s.vt.sender.codec?.payloadType ?? 99, maxPayload: 1200});
    const ap = new SFrameRtpPacketizer({ssrc: s.at.sender.ssrc, payloadType: s.at.sender.codec?.payloadType ?? 110, maxPayload: 1200});
    const bind = async (video: boolean) => {
      const socket = dgram.createSocket('udp4'); s.sockets.push(socket);
      socket.on('error', () => void this.stop(s.id.toString('hex')));
      await new Promise<void>((resolve, reject) => {socket.once('error', reject); socket.bind(0, '127.0.0.1', () => {socket.off('error', reject); resolve();});});
      socket.setRecvBufferSize(4 * 1024 * 1024);
      socket.on('message', (b, peer) => {
        if (s.closed || peer.address !== '127.0.0.1' || b.length < 12 || b[0] >> 6 !== 2 || (b[1] >= 192 && b[1] <= 223)) return;
        try {
          const rtp = RtpPacket.deSerialize(b);
          if (video) {
            const frame = assembler.push(rtp); if (!frame) return;
            for (const p of vp.packetize(videoCryptor.protectFrame(frame.data), frame.timestamp, frame.marker)) s.video.writeRtp(p);
            s.frames++; s.lastVideo = Date.now();
          } else {
            for (const p of ap.packetize(audioCryptor.protectFrame(rtp.payload), rtp.header.timestamp, rtp.header.marker)) s.audio.writeRtp(p);
            s.audioPackets++; s.lastAudio = Date.now();
          }
          if (!s.mediaReady && s.frames && s.audioPackets) {
            s.mediaReady = true;
            this.log('Remote HEVC passthrough ready with SFrame encryption');
          }
        } catch {this.log('Remote media packet rejected'); void this.stop(s.id.toString('hex'));}
      });
      return socket.address().port;
    };
    const vport = await bind(true), aport = await bind(false);
    if (s.closed || !this.active() || !this.enabled) {await this.stop(s.id.toString('hex')); return;}
    s.child = spawn(this.ffmpeg, remoteMediaArguments(this.tier, vport, aport), {stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true});
    s.lastVideo = s.lastAudio = Date.now();
    s.child.stderr?.resume(); // Input URLs may contain credentials.
    s.child.on('error', () => void this.stop(s.id.toString('hex')));
    s.child.on('exit', () => void this.stop(s.id.toString('hex')));
    clearTimeout(s.timer);
    s.timer = setTimeout(() => void this.stop(s.id.toString('hex')), 30 * 60 * 1000); s.timer.unref();
    s.watchdog = setInterval(() => {
      this.log(`Remote HEVC: frames=${s.frames} audio=${s.audioPackets}`);
      // Audio may continue even when the video pipeline freezes. Check both
      // paths so a dead picture cannot occupy a session indefinitely.
      const now = Date.now();
      if (now - s.lastVideo > 20000 || now - s.lastAudio > 20000) {
        this.log(`Remote media stalled: video=${now - s.lastVideo > 20000} audio=${now - s.lastAudio > 20000}`);
        void this.stop(s.id.toString('hex'));
      }
    }, 10000); s.watchdog.unref();
    this.log('Remote media process launched; waiting for video and audio');
  }
  async stop(key: string) {
    const s = this.sessions.get(key); if (!s) return;
    this.sessions.delete(key); s.closed = true; clearTimeout(s.timer); clearInterval(s.watchdog);
    for (const socket of s.sockets) {try {socket.close();} catch {}}
    const child = s.child;
    if (child && child.exitCode === null) {
      child.kill('SIGTERM'); const timer = setTimeout(() => {if (child.exitCode === null) child.kill('SIGKILL');}, 2000);
      timer.unref(); child.once('exit', () => clearTimeout(timer));
    }
    await s.pc.close().catch(() => undefined); s.crypto.senderKey?.key.fill(0);
    this.count.updateValue(this.sessions.size); this.log('Remote session stopped');
  }
  async stopAll() {await Promise.all([...this.sessions.keys()].map(key => this.stop(key)));}
}
export function remoteMediaArguments(tier: Tier, vport: number, aport: number): string[] {
  const out = (p: number) => `rtp://127.0.0.1:${p}?rtcpport=${p}&pkt_size=1200`;
  return ['-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1', '-rtsp_transport', 'tcp', '-timeout', '10000000', '-i', tier.rtspUrl,
    '-map', '0:v:0', '-an', '-sn', '-dn', '-c:v', 'copy', '-bsf:v', 'dump_extra=freq=keyframe', '-payload_type', '99',
    '-flush_packets', '1', '-max_delay', '0', '-f', 'rtp', out(vport),
    '-map', '0:a:0', '-vn', '-sn', '-dn', '-c:a', 'libopus', '-application', 'lowdelay', '-ar', '48000', '-ac', '1', '-b:a', '24000',
    '-frame_duration', '20', '-threads', '1', '-payload_type', '110', '-flush_packets', '1', '-max_delay', '0', '-f', 'rtp', out(aport)];
}
