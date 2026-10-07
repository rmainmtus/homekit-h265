import { randomBytes } from 'node:crypto';
import { Accessory, Categories, Characteristic, Formats, Perms, Service, uuid, HAPStatus, HapStatusError, Access, MDNSAdvertiser } from 'hap-nodejs';
import type { HAPConnection } from 'hap-nodejs/dist/lib/util/eventedhttp';
import { audioTiers, capabilities, control, Endpoint, endpoint, fromBase64, hapUuid, Tier, tlv, uint, validateTiers, parse } from './protocol';
import { mediaArguments, MediaJob, Relay, relay, startMedia } from './media';
import { captureSnapshot, SnapshotController, installHdsSnapshots } from './snapshot';
import { HevcRecording } from './recording';
import { RemoteViewing } from './webrtc';
import { NativeRecording } from './cmaf';

export interface LabConfig {
  name: string; identity: string; username: string; pincode: string;
  address: string; port: number; ffmpeg: string; tiers: Tier[];
  capabilitiesVersion: number;
  recording?: boolean;
  nativeRecording?: boolean;
  /** Experimental accessory-to-cloud uploads; leave off for hub-managed HDS. */
  directUpload?: boolean;
  motionRtspUrl?: string;
}
export interface PrivacyStore { get(key: string): boolean; set(key: string, value: boolean): void; }
interface Session {
  ep: Endpoint; owner: HAPConnection; video: Relay; audio: Relay;
  timer: NodeJS.Timeout; closed: () => void; job?: MediaJob; starting?: boolean;
  abort?: AbortController;
  videoSsrc: number; audioSsrc: number;
  stats?: NodeJS.Timeout;
}
const b64 = (b: Buffer) => b.toString('base64');
const fail = () => new HapStatusError(HAPStatus.INVALID_VALUE_IN_REQUEST);
export class HevcAccessory {
  readonly accessory: Accessory;
  readonly sessions = new Map<string, Session>();
  readonly recording?: HevcRecording;
  readonly nativeRecording?: NativeRecording;
  private hdsSnapshots?: ReturnType<typeof installHdsSnapshots>;
  readonly remote: RemoteViewing;
  private setupResponses = new WeakMap<HAPConnection, string>();
  private controlResponses = new WeakMap<HAPConnection, string>();
  private pending = new Set<string>();
  private generation = 0;
  private globalEnabled = true;
  private streamEnabled = true;
  private streamService: Service;
  private log: (message: string) => void;
  constructor(readonly config: LabConfig, log: (message: string) => void = console.log, private privacy?: PrivacyStore,
    private launchMedia: typeof startMedia = startMedia) {
    validateTiers(config.tiers); this.log = log;
    this.globalEnabled = privacy?.get('global') ?? true;
    this.streamEnabled = privacy?.get('stream') ?? true;
    this.accessory = new Accessory(config.name, uuid.generate(config.identity));
    this.accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Local HEVC Lab')
      .setCharacteristic(Characteristic.Model, config.recording ? 'HEVC with experimental HKSV' : 'Experimental RTP only')
      .setCharacteristic(Characteristic.SerialNumber, config.identity)
      .setCharacteristic(Characteristic.FirmwareRevision, '0.1.0');
    const sensor = uuid.write(uuid.generate(`${config.identity}/sensor`));
    const cap = new Service('Camera Capabilities', hapUuid('8010'));
    cap.addCharacteristic(Characteristic.Version).updateValue('17.99');
    this.custom(cap, 'Camera Capabilities', '8011', Formats.TLV8, [Perms.PAIRED_READ])
      .onGet(() => b64(capabilities(sensor, config.tiers, config.capabilitiesVersion,
        config.tiers.map(t => uuid.write(uuid.generate(`${config.identity}/tier/${t.id}`))))));
    this.accessory.addService(cap);
    const global = new Service('Camera Global Operating Mode', hapUuid('8032'));
    global.addCharacteristic(Characteristic.HomeKitCameraActive).onGet(() => this.globalEnabled).onSet(value => {
      this.globalEnabled = !!value; this.applyPrivacy();
    });
    global.addCharacteristic(Characteristic.CameraOperatingModeIndicator).updateValue(true);
    this.enabled(global, () => this.globalEnabled, value => {this.globalEnabled = value; this.applyPrivacy();});
    this.accessory.addService(global);
    const stream = this.streamService = new Service('HEVC RTP Stream', hapUuid('8031'));
    stream.setPrimaryService(true);
    this.enabled(stream, () => this.streamEnabled, value => {this.streamEnabled = value; this.applyPrivacy();});
    stream.addCharacteristic(Characteristic.StatusActive).updateValue(true);
    this.custom(stream, 'Sensor UUID', '805B', Formats.DATA, [Perms.PAIRED_READ]).onGet(() => b64(sensor));
    this.custom(stream, 'Supported Video Stream Tiers', '8043', Formats.TLV8, [Perms.PAIRED_READ, Perms.NOTIFY]).onGet(() => b64(videoTiers(config.tiers)));
    this.custom(stream, 'Supported Audio Stream Tiers', '8044', Formats.TLV8, [Perms.PAIRED_READ, Perms.NOTIFY]).onGet(() => b64(audioTiers()));
    stream.addCharacteristic(Characteristic.SupportedRTPConfiguration).onGet(() => b64(tlv([2, uint(0, 1)])));
    stream.addCharacteristic(Characteristic.SetupEndpoints)
      .onGet((_context, connection) => {
        const response = connection && this.setupResponses.get(connection);
        this.log(`Setup Endpoints read: ${response ? 'prepared response' : 'no response for connection'}`);
        return response || b64(tlv([2, uint(2, 1)]));
      })
      .onSet(async (value, _context, connection) => {
        if (!connection) throw fail();
        await this.setup(fromBase64(value), connection);
      });
    this.custom(stream, 'RTP Streaming Control', '8045', Formats.TLV8, [Perms.PAIRED_READ, Perms.PAIRED_WRITE, Perms.WRITE_RESPONSE])
      .onGet((_context, connection) => connection ? this.controlResponses.get(connection) || '' : '')
      .onSet(async (value, _context, connection) => {
        if (!connection) throw fail();
        return this.command(fromBase64(value), connection);
      });
    this.accessory.addService(stream);
    if (config.recording) {
      this.recording = new HevcRecording(config.ffmpeg, config.tiers[0], log);
      const contributing = this.custom(this.recording.motion, 'Contributing Sensors', '8086', Formats.TLV8,
        [Perms.PAIRED_READ, Perms.NOTIFY]).updateValue('');
      this.recording.motion.getCharacteristic(Characteristic.MotionDetected).on('change', change => {
        contributing.updateValue(change.newValue ? b64(tlv([1, tlv([1, sensor])])) : '');
      });
      this.custom(this.recording.motion, 'Motion Enabled', '8087', Formats.BOOL,
        [Perms.PAIRED_READ, Perms.PAIRED_WRITE, Perms.NOTIFY, Perms.TIMED_WRITE])
        .setProps({adminOnlyAccess: [Access.WRITE]})
        .updateValue(privacy?.get('motion') ?? true)
        .onSet(value => {privacy?.set('motion', !!value); this.recording!.setMotionAllowed(!!value);});
      this.recording.setMotionAllowed(privacy?.get('motion') ?? true);
      const management = this.recording.management;
      // Native HEVC still uses HDS recording negotiation on tvOS 27. CMAF is
      // optional and must not remove the fields required by RecordingManagement.
      const dataService = management.dataStreamManagement.getService();
      stream.addLinkedService(dataService);
      for (const service of [management.recordingManagementService, management.operatingModeService, dataService, this.recording.motion]) this.accessory.addService(service);
      management.operatingModeService.getCharacteristic(Characteristic.HomeKitCameraActive).on('change', change => {
        if (this.globalEnabled === !!change.newValue) return;
        this.globalEnabled = !!change.newValue;
        global.getCharacteristic(Characteristic.HomeKitCameraActive).updateValue(this.globalEnabled);
        this.applyPrivacy();
      });
    }
    this.remote = new RemoteViewing(config.address, config.ffmpeg, config.tiers[0], sensor, () => this.active(), log, privacy);
    this.remote.service.addLinkedService(stream);
    stream.addLinkedService(this.remote.service);
    if (this.recording) this.remote.service.addLinkedService(this.recording.management.dataStreamManagement.getService());
    this.accessory.addService(this.remote.service);
    if (config.nativeRecording && this.recording) this.nativeRecording = new NativeRecording(this.accessory, this.recording,
      uuid.generate(`${config.identity}/sensor`), log, config.tiers[0], config.directUpload === true);
    this.applyPrivacy();
    if (this.recording) this.hdsSnapshots = installHdsSnapshots(this.recording.management.dataStreamManagement, async () => {
      this.log('Home requested an HDS camera preview');
      // Reuse the buffered live relay. A separate direct camera connection can
      // time out even while the main relay and recording feed remain healthy.
      const image = await captureSnapshot(config.ffmpeg, config.tiers[0].rtspUrl, 720, 640);
      this.log('HDS camera preview captured'); return image;
    }, () => this.active() && !!this.recording?.management.operatingModeService.getCharacteristic(Characteristic.EventSnapshotsActive).value);
    this.accessory.configureController(new SnapshotController(async (height, width) => {
      this.log('Home requested a camera snapshot');
      const image = await captureSnapshot(config.ffmpeg, config.tiers[0].rtspUrl, height, width);
      this.log('Camera snapshot delivered');
      return image;
    }, () => this.active()));
  }
  private custom(service: Service, name: string, id: string, format: Formats, perms: Perms[]) {
    const c = new Characteristic(name, hapUuid(id), {format, perms});
    service.addCharacteristic(c); return c;
  }
  private enabled(service: Service, get: () => boolean, set: (value: boolean) => void) {
    this.custom(service, 'Streaming Enabled', '8041', Formats.BOOL,
      [Perms.PAIRED_READ, Perms.PAIRED_WRITE, Perms.NOTIFY, Perms.TIMED_WRITE])
      .setProps({adminOnlyAccess: [Access.WRITE]}).onGet(get).onSet(value => set(!!value));
  }
  private applyPrivacy() {
    this.privacy?.set('global', this.globalEnabled);
    this.privacy?.set('stream', this.streamEnabled);
    const active = this.globalEnabled && this.streamEnabled;
    this.streamService?.getCharacteristic(Characteristic.StatusActive).updateValue(active);
    if (!active) this.stopAll();
    if (!active) void this.remote?.stopAll();
    if (!active) this.hdsSnapshots?.closeAll();
    this.recording?.setPrivacy(this.globalEnabled);
    const recordingActive = this.recording?.management.operatingModeService.getCharacteristic(Characteristic.HomeKitCameraActive);
    if (recordingActive && recordingActive.value !== this.globalEnabled) recordingActive.updateValue(this.globalEnabled);
  }
  private active() { return this.globalEnabled && this.streamEnabled; }
  async setup(data: Buffer, owner: HAPConnection): Promise<string> {
    let ep: Endpoint;
    try { ep = endpoint(data); } catch { throw fail(); }
    const id = ep.id.toString('hex');
    const reply = (status: number) => {
      const value = b64(tlv([1, ep.id], [2, uint(status, 1)]));
      this.setupResponses.set(owner, value); return value;
    };
    // Avoid allowing even a paired peer to turn the camera into a UDP reflector.
    const peer = owner.remoteAddress.replace(/^::ffff:/, '');
    if (!this.active() || ep.address !== peer) return reply(2);
    if (this.sessions.has(id) || this.pending.has(id) || this.sessions.size + this.pending.size >= 5) return reply(1);
    const generation = this.generation;
    this.pending.add(id);
    let video: Relay | undefined, audio: Relay | undefined;
    try {
      video = await relay(this.config.address, ep.address, ep.videoPort, ep.videoKey, true);
      audio = await relay(this.config.address, ep.address, ep.audioPort, ep.audioKey);
      if (!this.active() || generation !== this.generation) throw new Error('Accessory stopped');
      const closed = () => {this.log('Controller connection closed'); this.stop(id);};
      const timer = setTimeout(() => {this.log('Prepared session expired'); this.stop(id);}, 30000); timer.unref();
      owner.once('closed', closed);
      const videoSsrc = randomBytes(4).readUInt32LE(), audioSsrc = randomBytes(4).readUInt32LE();
      const session: Session = {ep, owner, video, audio, timer, closed, videoSsrc, audioSsrc};
      this.sessions.set(id, session);
      const key = (b: Buffer) => tlv([1, uint(0, 1)], [2, b.subarray(0, 16)], [3, b.subarray(16)]);
      const response = b64(tlv([1, ep.id], [2, uint(0, 1)], [3, tlv([1, uint(0, 1)],
        [2, Buffer.from(this.config.address)], [3, uint(video.port, 2)], [4, uint(audio.port, 2)])],
        [4, key(ep.videoKey)], [5, key(ep.audioKey)], [6, uint(videoSsrc, 4)], [7, uint(audioSsrc, 4)]));
      this.setupResponses.set(owner, response);
      this.log('Prepared encrypted HEVC session'); return response;
    } catch {
      video?.close(); audio?.close(); return reply(2);
    } finally { this.pending.delete(id); }
  }
  async command(data: Buffer, owner: HAPConnection): Promise<string> {
    let c: ReturnType<typeof control>;
    try { c = control(data); } catch {
      try {this.log(`Rejected RTP control fields: ${parse(data).map(([tag, value]) => `${tag}:${value.length}`).join(',')}`);} catch {this.log('Malformed RTP control TLV');}
      throw fail();
    }
    this.log(`RTP control: command=${c.command} videoTier=${c.videoTier ?? '-'} audioTier=${c.audioTier ?? '-'}`);
    const id = c.id.toString('hex');
    const reply = (status: number) => {
      this.log(`RTP control result=${status}`);
      const response = b64(tlv([1, c.id], [2, uint(status, 1)]));
      this.controlResponses.set(owner, response); return response;
    };
    const s = this.sessions.get(id);
    if (!s || s.owner !== owner) return reply(1);
    if (c.command === 1) {
      const started = !!s.job || !!s.starting;
      this.stop(id); return reply(started ? 0 : 2);
    }
    if (!this.active()) {this.stop(id); return reply(4);}
    if (s.starting || s.job) return reply(3);
    const tier = this.config.tiers.find(t => t.id === c.videoTier);
    if (!tier || c.audioTier !== 1) return reply(4);
    s.starting = true;
    s.abort = new AbortController();
    this.log(`SSRC negotiation: video matches setup=${c.videoSsrc === s.videoSsrc}, audio matches setup=${c.audioSsrc === s.audioSsrc}`);
    try {
      const job = await this.launchMedia(this.config.ffmpeg,
        mediaArguments(tier, s.ep, s.video.inputPort, s.audio.inputPort, s.videoSsrc, s.audioSsrc),
        s.video, s.audio, () => {if (this.sessions.get(id) === s) this.stop(id);}, s.abort.signal);
      if (this.sessions.get(id) !== s) {job.stop(); return reply(4);}
      s.job = job; s.starting = false; clearTimeout(s.timer);
      // Hard limit protects this experimental service if a controller disappears.
      s.timer = setTimeout(() => this.stop(id), 10 * 60 * 1000); s.timer.unref();
      s.stats = setInterval(() => this.log(`Video transport: packets=${s.video.packets} localLoss=${s.video.sequenceGaps} maxGapMs=${s.video.maxGapMs} buffer=${s.video.receiveBuffer} pacing=${JSON.stringify(s.video.pacing)} receiver=${JSON.stringify(s.video.receiver)} audio=${JSON.stringify(s.audio.receiver)}`), 10000);
      s.stats.unref();
      this.log(`HEVC passthrough started: ${tier.width}x${tier.height} @ ${tier.fps} fps; audio converted to Opus`);
      return reply(0);
    } catch {
      if (this.sessions.get(id) === s) this.stop(id);
      this.log('HEVC media startup failed (no secrets logged)'); return reply(4);
    }
  }
  stop(id: string) {
    const s = this.sessions.get(id); if (!s) return;
    this.sessions.delete(id); clearTimeout(s.timer);
    clearInterval(s.stats);
    s.owner.removeListener('closed', s.closed); s.abort?.abort(); s.job?.stop();
    s.video.close(); s.audio.close(); s.ep.videoKey.fill(0); s.ep.audioKey.fill(0);
    this.setupResponses.delete(s.owner); this.controlResponses.delete(s.owner);
    this.log('HEVC session stopped');
  }
  stopAll() { this.generation++; for (const id of [...this.sessions.keys()]) this.stop(id); }
  async publish() {
    await this.accessory.publish({username: this.config.username, pincode: this.config.pincode,
      category: Categories.IP_CAMERA, port: this.config.port, bind: this.config.address,
      advertiser: MDNSAdvertiser.CIAO});
    this.log(`Experimental HEVC accessory published; HKSV recording ${this.recording ? 'available for hub negotiation' : 'disabled'}; encrypted remote WebRTC available`);
  }
  async close() { this.stopAll(); this.hdsSnapshots?.destroy(); this.nativeRecording?.close(); await this.remote.stopAll(); this.recording?.close(); await this.accessory.unpublish(); }
}
// Local import kept explicit so the codec advertised above can be audited easily.
import { videoTiers } from './protocol';
