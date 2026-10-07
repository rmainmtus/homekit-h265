import { spawn, ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { Characteristic, Service, CameraRecordingDelegate, CameraRecordingConfiguration, CameraRecordingOptions, RecordingPacket } from 'hap-nodejs';
import { RecordingManagement } from 'hap-nodejs/dist/lib/camera/RecordingManagement';
import { Mp4Framer, recordingFragment } from './mp4';
import type { Tier } from './protocol';
import {videoMetadata, fragmentDuration} from './cmafMedia';
import type {CMAFClipRequest, CMAFSegment} from './cmafInterfaces';

type Fragment = {data: Buffer; at: number; sequence: number; duration: number};
export function recordingOptions(tier: Tier): CameraRecordingOptions {
  // Negotiation envelope adapted from camera.ui accessory.ts:createRecordingOptions
  // (MIT; commit 082c2b9c66ad831bf03aa0128d123fe553d24d54). See THIRD-PARTY-LICENSE.txt.
  // HKSV3 retains the legacy HDS negotiation envelope used by camera.ui's
  // SecureVideoController integration. The actual HEVC format/dimensions are
  // described by CameraCapabilities and hvc1; these tuples do not resize video.
  // tvOS rejects negotiation when only our native 2304x2592@12 tuple is offered.
  return {prebufferLength: 8000, mediaContainerConfiguration: {type: 0, fragmentLength: 4000},
    video: {type: 0, parameters: {profiles: [1], levels: [0, 1, 2]}, resolutions: [[1280, 720, 30], [1920, 1080, 30]]},
    audio: {codecs: [{type: 0, audioChannels: 1, bitrateMode: 0, samplerate: 3}]}};
}

export function recordingArguments(source: string, audio: boolean, bitrate = 32): string[] {
  return ['-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1',
    '-rtsp_transport', 'tcp', '-timeout', '10000000', '-i', source,
    '-map', '0:v:0', '-c:v', 'copy', '-tag:v', 'hvc1',
    ...(audio ? ['-map', '0:a:0', '-c:a', 'aac', '-ar', '32000', '-ac', '1', '-b:a', `${bitrate}k`] : ['-an']),
    '-sn', '-dn', '-threads', '1', '-movflags', '+empty_moov+default_base_moof+frag_keyframe',
    '-f', 'mp4', 'pipe:1'];
}

export class HevcRecording implements CameraRecordingDelegate {
  readonly management: RecordingManagement;
  readonly motion = new Service.MotionSensor('Camera Motion', 'hevc-motion');
  private active = false;
  private allowed = true;
  private motionAllowed = true;
  private nativeBuffer = false;
  private nativeActivity = true;
  onRecordingState?: (enabled: boolean) => void;
  private config?: CameraRecordingConfiguration;
  private child?: ChildProcess;
  private restart?: NodeJS.Timeout;
  private watchdog?: NodeJS.Timeout;
  private init?: Buffer;
  private fragments: Fragment[] = [];
  private sequence = 0;
  private generation = 0;
  private changed = new EventEmitter();
  private stream?: {id: number; stop: boolean};
  private disposed = false;
  private reconfigure = false;
  private lastFragment = 0;
  private lastMediaFragment?: number;
  onEnabled?: (enabled: boolean) => void;
  constructor(private ffmpeg: string, private tier: Tier, private log: (s: string) => void) {
    this.management = new RecordingManagement(recordingOptions(tier), this, new Set([1]));
    for (const type of [Characteristic.SupportedCameraRecordingConfiguration,
      Characteristic.SupportedVideoRecordingConfiguration, Characteristic.SupportedAudioRecordingConfiguration]) {
      const characteristic = this.management.recordingManagementService.getCharacteristic(type);
      characteristic.onGet(() => {
        this.log(`HKSV hub read ${characteristic.displayName}`);
        return characteristic.value!;
      });
    }
    this.motion.getCharacteristic(Characteristic.MotionDetected).on('subscribe', () => this.log('HKSV controller subscribed to motion'));
    this.motion.setCharacteristic(Characteristic.MotionDetected, false).setCharacteristic(Characteristic.StatusActive, true);
    this.management.sensorServices.push(this.motion);
    this.management.recordingManagementService.addLinkedService(this.motion);
    this.management.recordingManagementService.getCharacteristic(Characteristic.RecordingAudioActive)
      .on('change', () => this.reset());
    this.management.operatingModeService.getCharacteristic(Characteristic.HomeKitCameraActive)
      .on('change', () => this.reset());
  }
  get enabled(): boolean {
    return this.recordingAllowed && (this.nativeBuffer ? this.nativeActivity : !!this.config);
  }
  get diagnostics() {
    return {
      enabled: this.enabled,
      running: !!this.child,
      bufferReady: !!this.init && this.fragments.length > 0,
      bufferedFragments: this.fragments.length,
      fragmentAgeMs: this.lastMediaFragment === undefined ? null : Math.max(0, Date.now() - this.lastMediaFragment),
      streamActive: !!this.stream && !this.stream.stop,
    };
  }
  get motionEnabled(): boolean {
    return this.recordingAllowed && this.motionAllowed;
  }
  private get recordingAllowed(): boolean {
    // Motion must reach Home before the hub selects a recording configuration.
    return !this.disposed && this.allowed && this.active
      && !!this.management.operatingModeService.getCharacteristic(Characteristic.HomeKitCameraActive).value;
  }
  updateRecordingActive(active: boolean) {
    this.active = active; this.log(`HKSV recording ${active ? 'enabled' : 'disabled'} by Home`); this.reset();
  }
  updateRecordingConfiguration(config?: CameraRecordingConfiguration) {
    if (config && (config.audioCodec.type !== 0 || config.audioCodec.samplerate !== 3 ||
      config.mediaContainerConfiguration.type !== 0 || config.mediaContainerConfiguration.fragmentLength < 1000)) {
      throw new Error('Unsupported recording configuration');
    }
    this.config = config;
    this.log(config ? `HKSV hub configuration: ${config.videoCodec.resolution.join('x')}, fragments ${config.mediaContainerConfiguration.fragmentLength}ms` : 'HKSV configuration cleared');
    // Apply a non-privacy configuration change after the current event finishes.
    if (!this.stream || !config) this.reset(); else this.reconfigure = true;
  }
  setPrivacy(allowed: boolean) { if (this.allowed !== allowed) {this.allowed = allowed; this.reset();} }
  enableNativeBuffer() {this.nativeBuffer = true; this.reset();}
  setNativeActivity(allowed: boolean) {if (allowed !== this.nativeActivity) {this.nativeActivity = allowed; this.reset();}}
  setMotionAllowed(allowed: boolean) {
    this.motionAllowed = allowed;
    this.onEnabled?.(this.motionEnabled);
    if (!this.motionEnabled) this.setMotion(false);
  }
  setMotion(active: boolean) {
    const value = this.motionEnabled && active;
    const c = this.motion.getCharacteristic(Characteristic.MotionDetected);
    if (c.value !== value) {c.updateValue(value); this.log(`HKSV motion ${value ? 'detected' : 'cleared'}`);}
  }
  private reset() {
    this.reconfigure = false;
    this.stopPipeline();
    this.onRecordingState?.(this.enabled);
    this.onEnabled?.(this.motionEnabled);
    if (this.enabled) this.start();
    if (!this.motionEnabled) this.setMotion(false);
  }
  private start() {
    if (!this.enabled || this.child) return;
    const generation = this.generation;
    const audio = !!this.management.recordingManagementService.getCharacteristic(Characteristic.RecordingAudioActive).value;
    const child = this.child = spawn(this.ffmpeg, recordingArguments(this.tier.rtspUrl, audio,
      Math.min(128, Math.max(16, this.config?.audioCodec.bitrate || 32))),
      {stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, shell: false});
    const parser = new Mp4Framer(); let ftyp: Buffer | undefined, moof: Buffer | undefined;
    this.lastFragment = Date.now();
    const failed = () => {
      if (generation !== this.generation) return;
      this.log('HKSV buffer interrupted; retrying in 5 seconds'); this.stopPipeline();
      if (this.enabled) this.restart = setTimeout(() => this.start(), 5000);
    };
    child.stdout!.on('data', (chunk: Buffer) => {
      if (generation !== this.generation) return;
      try {
        for (const box of parser.push(chunk)) {
          if (box.type === 'ftyp') ftyp = box.data;
          if (box.type === 'moov') {
            if (!ftyp || !box.data.includes(Buffer.from('hvc1'))) throw new Error('HEVC initialization missing');
            this.init = Buffer.concat([ftyp, box.data]);
            this.log(`HKSV native HEVC buffer ready; audio=${audio}`); this.changed.emit('data');
          }
          if (box.type === 'moof') moof = box.data;
          if (box.type === 'mdat') {
            if (!moof || !this.init) throw new Error('Fragment without initialization');
            const data = Buffer.concat([moof, box.data]);
            const duration = fragmentDuration(data, videoMetadata(this.init));
            const f = {data, at: Date.now() - duration * 1000, sequence: ++this.sequence, duration};
            moof = undefined; this.lastFragment = Date.now(); this.lastMediaFragment = this.lastFragment; this.fragments.push(f);
            while (this.fragments.length > 10 || this.fragments.reduce((n, v) => n + v.data.length, 0) > 16 * 1024 * 1024) this.fragments.shift();
            this.changed.emit('data');
          }
        }
      } catch {failed();}
    });
    child.on('error', failed); child.on('close', failed);
    this.watchdog = setInterval(() => {if (Date.now() - this.lastFragment > 15000) failed();}, 5000);
    this.watchdog.unref();
  }
  private stopPipeline() {
    this.generation++; clearTimeout(this.restart); clearInterval(this.watchdog);
    const child = this.child; this.child = undefined;
    try {child?.kill('SIGKILL');} catch { /* A failed spawn has no process to stop. */ }
    if (this.stream) this.stream.stop = true;
    this.init = undefined; this.fragments = []; this.changed.emit('data');
  }
  private wait(signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {clearTimeout(timer); this.changed.off('data', done); signal?.removeEventListener('abort', done);};
      const done = () => {cleanup(); resolve();};
      const timer = setTimeout(() => {cleanup(); reject(new Error('Recording fragment timeout'));}, 12000);
      this.changed.once('data', done); signal?.addEventListener('abort', done, {once: true});
      if (signal?.aborted) done();
    });
  }
  async *handleRecordingStreamRequest(id: number, signal?: AbortSignal): AsyncGenerator<RecordingPacket> {
    if (!this.enabled || this.stream) throw new Error('Recording unavailable');
    const stream = this.stream = {id, stop: false};
    const offsets = new Map<number, bigint>(); let count = 0;
    const started = Date.now(), generation = this.generation;
    try {
      while (!this.init && !stream.stop && !signal?.aborted) await this.wait(signal);
      if (stream.stop || signal?.aborted || !this.init) return;
      this.log(`HKSV encrypted HDS recording ${id} started`);
      yield {data: this.init, isLast: false};
      let next = this.fragments[0]?.sequence ?? this.sequence + 1;
      while (!stream.stop && !signal?.aborted && this.enabled && generation === this.generation) {
        if (this.fragments.length && next < this.fragments[0].sequence) throw new Error('Hub fell behind recording buffer');
        const f = this.fragments.find(v => v.sequence === next);
        if (!f) {await this.wait(signal); continue;}
        next++; count++;
        const last = Date.now() - started >= 60000;
        yield {data: recordingFragment(f.data, offsets, f.at), isLast: last};
        if (last) break;
      }
    } finally {
      this.log(`HKSV recording ${id}: ${count} video fragments sent`);
      if (this.stream === stream) {this.stream = undefined; if (this.reconfigure) this.reset();}
    }
  }
  closeRecordingStream(id: number, reason?: number) {
    this.log(`HKSV hub closed recording ${id}, reason=${reason ?? 'disconnect'}`);
    if (this.stream?.id === id) {this.stream.stop = true; this.changed.emit('data');}
  }
  acknowledgeStream(id: number) {this.log(`HKSV hub acknowledged recording ${id}`);}
  async *streamClip(request: CMAFClipRequest): AsyncGenerator<CMAFSegment> {
    const generation = this.generation, offsets = new Map<number, bigint>();
    const fromNtp = (n?: bigint) => n === undefined ? undefined : Number((n >> 32n) - 2208988800n) * 1000 + Number(n & 0xffffffffn) * 1000 / 4294967296;
    const start = fromNtp(request.command.start), stop = fromNtp(request.command.stop);
    while (this.enabled && generation === this.generation && !request.signal.aborted && (!this.init || !this.fragments.length)) await this.wait(request.signal);
    if (!this.enabled || generation !== this.generation || request.signal.aborted || !this.init) return;
    const first = this.fragments.find(f => start === undefined || f.at + f.duration * 1000 > start);
    if (!first) throw new Error('Requested recording outside retained buffer');
    const media = videoMetadata(this.init);
    yield {type: 'init', data: this.init, startedAt: new Date(first.at), media: {...media, codecs: media.codecs + (this.init.includes(Buffer.from('mp4a')) ? ',mp4a.40.2' : ''), bitrate: this.tier.peakKbps * 1000}};
    let next = first.sequence;
    while (this.enabled && generation === this.generation && !request.signal.aborted) {
      if (this.fragments.length && next < this.fragments[0].sequence) throw new Error('Upload fell behind buffer');
      const f = this.fragments.find(v => v.sequence === next);
      if (!f) {await this.wait(request.signal); continue;}
      if (stop !== undefined && f.at >= stop) return;
      const last = stop !== undefined && f.at + f.duration * 1000 >= stop;
      yield {type: 'media', data: recordingFragment(f.data, offsets, f.at), duration: f.duration, last};
      next++; if (last) return;
    }
  }
  close() {this.disposed = true; this.stopPipeline(); this.onEnabled?.(false); this.management.destroy();}
}
