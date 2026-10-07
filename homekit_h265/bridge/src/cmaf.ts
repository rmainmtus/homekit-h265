import crypto from 'node:crypto';
import {Accessory, Characteristic, Formats, Perms, Service, HAPStatus, HapStatusError} from 'hap-nodejs';
import {CMAFIngest} from './CMAFIngest';
import {createClientCSR, generateClientKey} from './SecureVideoCredentials';
import * as T from './SecureVideoTypes';
import {fromBase64, hapUuid} from './protocol';
import type {HevcRecording} from './recording';
import type {SecureVideoIngestCredentials} from './cmafInterfaces';
import {motionMask} from './zones';

// This state contains private keys and Apple upload credentials. Never log it.
export interface CmafState {
  privateKey?: string; certificate?: string; ca?: string;
  publishingPoint?: string; keys: {number: string; key: string}[];
  current?: string; sequence: string;
  zones?: string; zonesActive?: boolean;
}
export class NativeRecording {
  readonly buffer = new Service('Camera Buffer Management', hapUuid('8000'));
  readonly keys = new Service('Camera Key Management', hapUuid('8050'));
  readonly certificates = new Service('Camera Client Certificate Management', hapUuid('8080'));
  readonly motionZones = new Service('Camera Motion Zones', hapUuid('8021'));
  private zoneValue?: T.CameraZonesValue;
  onMotionMask?: (mask?: Uint8Array) => void;
  private credentials: SecureVideoIngestCredentials = {keys: []};
  private events: T.CameraBufferEvent[] = [];
  private sequence = 0n;
  private timer?: NodeJS.Timeout;
  private ingest: CMAFIngest;
  onState?: (state: CmafState) => void;
  constructor(accessory: Accessory, private recording: HevcRecording, sensorUUID: string, private log: (message: string) => void, private dimensions = {width: 2304, height: 2592}, directUpload = false) {
    this.motionZones.addCharacteristic(Characteristic.Version).updateValue('17.99');
    this.motionZones.addCharacteristic(Characteristic.Active).updateValue(0).onSet(value => {
      this.onMotionMask?.(motionMask(this.zoneValue,!!value,dimensions.width,dimensions.height));
    }).on('change',()=>this.save());
    this.tlv(this.motionZones,'Camera Zones','8022',[Perms.PAIRED_READ,Perms.PAIRED_WRITE],value=>{
      const zones=value.length?T.decodeCameraZones(value):undefined;
      motionMask(zones,true,dimensions.width,dimensions.height);
      this.zoneValue=zones; this.refreshMotionMask(); this.save(); this.log('CMAF motion zones updated');
    },()=>this.zoneValue?T.encodeCameraZones(this.zoneValue):Buffer.alloc(0));
    this.ingest = new CMAFIngest(recording, {
      sensorUUID, media: {codecs: 'hvc1', width: 1, height: 1, bitrate: 1},
      credentials: () => this.credentials,
      reportSessionStart: session => {this.log('CMAF encrypted clip upload started'); this.event({type: 1, cmafSessionId: session});},
      reportSessionStop: session => {this.log('CMAF clip upload completed'); this.event({type: 2, cmafSessionId: session});},
      reportError: (session, error, detail) => {
        // Only extract the numeric status; URLs and response bodies may contain credentials.
        this.log(`CMAF upload failed: code=${error}${detail?.match(/-> (\d{3})/) ? ` HTTP=${detail.match(/-> (\d{3})/)![1]}` : ''}`);
        this.event({type: 4, cmafSessionId: session, error});
      },
    });
    const sequence = this.characteristic(this.buffer, 'Buffer Event Sequence Number', '8015', Formats.UINT32, [Perms.PAIRED_READ, Perms.NOTIFY]);
    sequence.updateValue(0);
    sequence.on('subscribe',()=>this.log('CMAF hub subscribed to event sequence'));
    this.tlv(this.buffer, 'Buffer Event Command', '8014', [Perms.PAIRED_READ, Perms.PAIRED_WRITE, Perms.WRITE_RESPONSE], value => {
      const r = T.decodeBufferEventCommand(value);
      if (r.command !== 1 && r.command !== 2) throw new Error('Invalid event command');
      this.log(`CMAF event ${r.command === 1 ? 'query' : 'acknowledgement'}`);
      if (r.command === 2) {this.events = this.events.filter(e => e.sequenceNumber > (r.sequenceNumber ?? this.sequence)); return T.encodeBufferEventCommandResponse([]);}
      return T.encodeBufferEventCommandResponse(this.events.filter(e => e.sequenceNumber >= (r.sequenceNumber ?? 0n)).slice(0, Number(r.limit === undefined ? 128n : r.limit > 128n ? 128n : r.limit)));
    });
    this.tlv(this.buffer, 'Buffer Upload Command', '8013', [Perms.PAIRED_READ, Perms.PAIRED_WRITE, Perms.WRITE_RESPONSE], value => {
      const r = T.decodeBufferUploadCommand(value);
      if (![1, 2, 3].includes(r.command) || (r.stop !== undefined && r.start !== undefined && r.stop < r.start)) throw new Error('Invalid upload command');
      if (!recording.enabled && r.command !== 3) throw new Error('Recording disabled');
      this.log(`CMAF upload command=${r.command}`);
      return T.encodeBufferUploadCommandResponse(this.ingest.handleUploadCommand(r));
    });
    this.tlv(this.buffer, 'Buffer Activity Command', '8017', [Perms.PAIRED_WRITE], value => {
      const r = T.decodeBufferActivityCommand(value);
      if (r.activity !== 1 && r.activity !== 2) throw new Error('Invalid activity');
      this.log(`CMAF buffer activity=${r.activity}`);
      clearTimeout(this.timer);
      const delay = Math.max(0, Number((r.start >> 32n) - 2208988800n) * 1000 + Number(r.start & 0xffffffffn) * 1000 / 4294967296 - Date.now());
      if (delay > 3600000 || r.duration > 3600000n) throw new Error('Activity window too long');
      this.timer = setTimeout(() => {
        recording.setNativeActivity(r.activity === 1);
        this.timer = setTimeout(() => recording.setNativeActivity(false), Number(r.duration));
        this.timer.unref();
      }, delay); this.timer.unref();
    });
    this.tlv(this.buffer, 'Camera Recording Publishing Point', '8016', [Perms.PAIRED_READ, Perms.PAIRED_WRITE], value => {
      const p = value.length ? T.decodeCameraRecordingPublishingPoint(value) : undefined;
      if (p) {
        const u = new URL(p.url);
        if (u.protocol !== 'https:' || u.username || u.password || !u.pathname.endsWith('/') || !p.serverCACertificates.length) throw new Error('Invalid publishing point');
      }
      this.credentials.publishingPoint = p; this.save(); this.log(`CMAF publishing point ${p ? 'received' : 'cleared'}`);
    }, () => this.credentials.publishingPoint ? T.encodeCameraRecordingPublishingPoint(this.credentials.publishingPoint) : Buffer.alloc(0));
    const keyId = this.characteristic(this.keys, 'Camera Key ID', '8052', Formats.TLV8, [Perms.PAIRED_READ, Perms.NOTIFY]).updateValue('');
    this.tlv(this.keys, 'Camera Key', '8051', [Perms.PAIRED_WRITE, Perms.TIMED_WRITE], value => {
      if (!value.length) {this.credentials.keys = []; this.credentials.currentKeyNumber = undefined; keyId.updateValue('');}
      else {
        const k = T.decodeCameraKey(value);
        if (k.key.length !== 32) throw new Error('Invalid camera key length');
        this.credentials.keys = [...this.credentials.keys.filter(v => v.keyNumber !== k.keyNumber), k].slice(-4);
        this.credentials.currentKeyNumber = k.keyNumber; keyId.updateValue(T.encodeCameraKeyID(k.keyNumber).toString('base64'));
      }
      this.save(); this.log('CMAF camera key updated');
    });
    const status = this.characteristic(this.certificates, 'Camera Client Certificate Status', '8083', Formats.TLV8, [Perms.PAIRED_READ, Perms.NOTIFY]);
    status.updateValue(T.encodeCameraClientCertificateStatus(true).toString('base64'));
    this.tlv(this.certificates, 'Camera Client CSR', '8081', [Perms.PAIRED_READ, Perms.PAIRED_WRITE, Perms.WRITE_RESPONSE], value => {
      const nonce = T.decodeCameraClientCSRRequest(value);
      if (!nonce.length || nonce.length > 1024) throw new Error('Invalid nonce');
      this.credentials.privateKey ??= generateClientKey().export({type: 'pkcs8', format: 'pem'}).toString();
      const csr = createClientCSR(crypto.createPrivateKey(this.credentials.privateKey), 'HomeKit HEVC Camera', nonce);
      this.save(); this.log('CMAF certificate signing request answered');
      return T.encodeCameraClientCSRResponse(csr.csr, csr.nonceSignature);
    });
    this.tlv(this.certificates, 'Camera Client Certificate', '8082', [Perms.PAIRED_READ, Perms.PAIRED_WRITE, Perms.TIMED_WRITE], value => {
      const c = value.length ? T.decodeCameraClientCertificate(value) : undefined;
      if (c && (!this.credentials.privateKey || !new crypto.X509Certificate(c.clientCertificate).checkPrivateKey(crypto.createPrivateKey(this.credentials.privateKey)))) throw new Error('Certificate key mismatch');
      this.credentials.clientCertificate = c?.clientCertificate; this.credentials.ca = c?.ca;
      status.updateValue(T.encodeCameraClientCertificateStatus(!c).toString('base64'));
      this.save(); this.log(`CMAF client certificate ${c ? 'installed' : 'cleared'}`);
    }, () => this.credentials.clientCertificate ? T.encodeCameraClientCertificate({clientCertificate: this.credentials.clientCertificate, ca: this.credentials.ca}) : Buffer.alloc(0));
    // Keep motion zones and native buffering for HDS. Advertising optional CMAF
    // services makes the hub redirect uploads to the unverified cloud endpoint.
    for (const service of directUpload ? [this.buffer, this.keys, this.certificates, this.motionZones] : [this.motionZones]) accessory.addService(service);
    recording.motion.getCharacteristic(Characteristic.MotionDetected).on('change', change => this.event({type: 3, active: !!change.newValue}));
    recording.onRecordingState = enabled => {if (!enabled) this.ingest.destroy();};
    recording.enableNativeBuffer();
  }
  private characteristic(s: Service, name: string, id: string, format: Formats, perms: Perms[]) {
    const c = new Characteristic(name, hapUuid(id), {format, perms}); s.addCharacteristic(c); return c;
  }
  private tlv(s: Service, name: string, id: string, perms: Perms[], set: (value: Buffer) => Buffer | void, get?: () => Buffer) {
    const c = this.characteristic(s, name, id, Formats.TLV8, perms).updateValue('');
    const responses = new WeakMap<object, string>();
    if (perms.includes(Perms.PAIRED_READ)) c.onGet((_context, connection) => get ? get().toString('base64') : connection ? responses.get(connection) ?? '' : '');
    c.onSet((value, _context, connection) => {
      try {
        const data = fromBase64(value); if (data.length > 65536) throw new Error('TLV limit');
        const result = set(data);
        if (result && perms.includes(Perms.WRITE_RESPONSE)) {
          const encoded = result.toString('base64'); if (connection) responses.set(connection, encoded); return encoded;
        }
      } catch {this.log(`CMAF rejected ${name}`); throw new HapStatusError(HAPStatus.INVALID_VALUE_IN_REQUEST);}
    }); return c;
  }
  private event(e: Omit<Extract<T.CameraBufferEvent, {type: 1}>, 'sequenceNumber'> | Omit<Extract<T.CameraBufferEvent, {type: 2}>, 'sequenceNumber'> | Omit<Extract<T.CameraBufferEvent, {type: 3}>, 'sequenceNumber'> | Omit<Extract<T.CameraBufferEvent, {type: 4}>, 'sequenceNumber'>) {
    this.events.push({...e, sequenceNumber: ++this.sequence} as T.CameraBufferEvent); this.events = this.events.slice(-128);
    this.buffer.characteristics.find(c => c.UUID === hapUuid('8015'))!.updateValue(Number(this.sequence & 0xffffffffn)); this.save();
  }
  serialize(): CmafState {
    const c = this.credentials;
    return {privateKey: c.privateKey, certificate: c.clientCertificate?.toString('base64'), ca: c.ca?.toString('base64'),
      publishingPoint: c.publishingPoint ? T.encodeCameraRecordingPublishingPoint(c.publishingPoint).toString('base64') : undefined,
      keys: c.keys.map(k => ({number: k.keyNumber.toString(), key: k.key.toString('base64')})), current: c.currentKeyNumber?.toString(), sequence: this.sequence.toString(),
      zones: this.zoneValue?T.encodeCameraZones(this.zoneValue).toString('base64'):undefined,zonesActive:!!this.motionZones.getCharacteristic(Characteristic.Active).value};
  }
  restore(s: CmafState) {
    this.credentials = {privateKey: s.privateKey, clientCertificate: s.certificate ? Buffer.from(s.certificate, 'base64') : undefined,
      ca: s.ca ? Buffer.from(s.ca, 'base64') : undefined, publishingPoint: s.publishingPoint ? T.decodeCameraRecordingPublishingPoint(Buffer.from(s.publishingPoint, 'base64')) : undefined,
      keys: s.keys.slice(-4).map(k => ({keyNumber: BigInt(k.number), key: Buffer.from(k.key, 'base64')})), currentKeyNumber: s.current === undefined ? undefined : BigInt(s.current)};
    this.sequence = BigInt(s.sequence);
    this.zoneValue=s.zones?T.decodeCameraZones(Buffer.from(s.zones,'base64')):undefined;
    this.motionZones.getCharacteristic(Characteristic.Active).updateValue(s.zonesActive?1:0);
    this.refreshMotionMask();
    this.buffer.characteristics.find(c => c.UUID === hapUuid('8015'))!.updateValue(Number(this.sequence & 0xffffffffn));
    this.keys.characteristics.find(c => c.UUID === hapUuid('8052'))!.updateValue(this.credentials.currentKeyNumber === undefined ? '' : T.encodeCameraKeyID(this.credentials.currentKeyNumber).toString('base64'));
    const expired = !this.credentials.clientCertificate || Date.parse(new crypto.X509Certificate(this.credentials.clientCertificate).validTo) < Date.now() + 86400000;
    this.certificates.characteristics.find(c => c.UUID === hapUuid('8083'))!.updateValue(T.encodeCameraClientCertificateStatus(expired).toString('base64'));
  }
  private save() {this.onState?.(this.serialize());}
  refreshMotionMask() {this.onMotionMask?.(motionMask(this.zoneValue,!!this.motionZones.getCharacteristic(Characteristic.Active).value,this.dimensions.width,this.dimensions.height));}
  close() {clearTimeout(this.timer); this.ingest.destroy();}
}
