import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';

// Adapted from cameraui/plugins (MIT); see THIRD-PARTY-LICENSE.txt.
export interface SFrameKeyData { key: Buffer; kid: bigint; }

// SFrame end-to-end media protection for the WebRTC remote path (RFC 9605), applied per frame.
// The HKSV spec only defines the key exchange (SFrame Key Data = key + kid). The viewer's
// avconferenced negotiates Apple's own suites for the camera streams: video
// CipherSFRAME_AESCM256AuthSHA512_80, audio CipherSFRAME_AESCM256AuthSHA512_32, AES-256-CTR with
// HMAC-SHA512 tags; the ids are the IANA ones from draft-barnes-sframe-iana-256 and go into the
// HKDF labels
export enum SFrameCipherSuite {
  AES_128_CTR_HMAC_SHA256_80 = 0x0001,
  AES_128_GCM_SHA256_128 = 0x0004,
  AES_256_GCM_SHA512_128 = 0x0005,
  AES_256_CTR_HMAC_SHA512_80 = 0x0006,
  AES_256_CTR_HMAC_SHA512_64 = 0x0007,
  AES_256_CTR_HMAC_SHA512_32 = 0x0008,
}

const VIDEO_SUITE = SFrameCipherSuite.AES_256_CTR_HMAC_SHA512_80;
const AUDIO_SUITE = SFrameCipherSuite.AES_256_CTR_HMAC_SHA512_32;

interface SuiteParams {
  nk: number;
  nka: number;
  nn: number;
  nt: number;
  aead: 'gcm' | 'ctr-hmac';
  hash: 'sha256' | 'sha512';
  baseKeyLength: number;
}

const SUITES: Record<SFrameCipherSuite, SuiteParams> = {
  [SFrameCipherSuite.AES_128_CTR_HMAC_SHA256_80]: { nk: 48, nka: 16, nn: 12, nt: 10, aead: 'ctr-hmac', hash: 'sha256', baseKeyLength: 16 },
  [SFrameCipherSuite.AES_128_GCM_SHA256_128]: { nk: 16, nka: 0, nn: 12, nt: 16, aead: 'gcm', hash: 'sha256', baseKeyLength: 16 },
  [SFrameCipherSuite.AES_256_GCM_SHA512_128]: { nk: 32, nka: 0, nn: 12, nt: 16, aead: 'gcm', hash: 'sha512', baseKeyLength: 32 },
  [SFrameCipherSuite.AES_256_CTR_HMAC_SHA512_80]: { nk: 96, nka: 32, nn: 12, nt: 10, aead: 'ctr-hmac', hash: 'sha512', baseKeyLength: 32 },
  [SFrameCipherSuite.AES_256_CTR_HMAC_SHA512_64]: { nk: 96, nka: 32, nn: 12, nt: 8, aead: 'ctr-hmac', hash: 'sha512', baseKeyLength: 32 },
  [SFrameCipherSuite.AES_256_CTR_HMAC_SHA512_32]: { nk: 96, nka: 32, nn: 12, nt: 4, aead: 'ctr-hmac', hash: 'sha512', baseKeyLength: 32 },
};

interface DerivedKeys {
  key: Buffer;
  salt: Buffer;
}

function beBytes(value: bigint, length: number): Buffer {
  const out = Buffer.alloc(length);
  let v = value;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function minBytes(value: bigint): Buffer {
  if (value === 0n) {
    return Buffer.alloc(1);
  }
  const bytes: number[] = [];
  let v = value;
  while (v > 0n) {
    bytes.unshift(Number(v & 0xffn));
    v >>= 8n;
  }
  return Buffer.from(bytes);
}

const RTP_STREAM_LABEL = Buffer.from('SFrame 1.0 RTP Stream');

// Apple's RFC cryptor (AVConference VCCryptorRFCCompliant) first turns the group key into a per-stream
// base key, HKDF-SHA512 with the big-endian SSRC as salt and "SFrame 1.0 RTP Stream" as info, 64 bytes,
// and only then runs the RFC 9605 derivation on that base key
export function deriveStreamBaseKey(key: Buffer, ssrc: number): Buffer {
  const salt = Buffer.alloc(4);
  salt.writeUInt32BE(ssrc >>> 0);
  return Buffer.from(hkdfSync('sha512', key, salt, RTP_STREAM_LABEL, 64));
}

export function deriveKeys(baseKey: Buffer, kid: bigint, suite: SFrameCipherSuite): DerivedKeys {
  const params = SUITES[suite];
  const suffix = Buffer.concat([beBytes(kid, 8), beBytes(BigInt(suite), 2)]);
  const keyLabel = Buffer.concat([Buffer.from('SFrame 1.0 Secret key '), suffix]);
  const saltLabel = Buffer.concat([Buffer.from('SFrame 1.0 Secret salt '), suffix]);
  const empty = Buffer.alloc(0);
  return {
    key: Buffer.from(hkdfSync(params.hash, baseKey, empty, keyLabel, params.nk)),
    salt: Buffer.from(hkdfSync(params.hash, baseKey, empty, saltLabel, params.nn)),
  };
}

// RFC 9605 4.3: config byte X|KKK|Y|CCC, then KID bytes (if extended), then CTR bytes (if extended)
export function encodeHeader(kid: bigint, ctr: bigint): Buffer {
  let config = 0;
  const extra: Buffer[] = [];

  if (kid <= 7n) {
    config |= Number(kid) << 4;
  } else {
    const kidBytes = minBytes(kid);
    config |= 0x80 | ((kidBytes.length - 1) << 4);
    extra.push(kidBytes);
  }

  if (ctr <= 7n) {
    config |= Number(ctr);
  } else {
    const ctrBytes = minBytes(ctr);
    config |= 0x08 | (ctrBytes.length - 1);
    extra.push(ctrBytes);
  }

  return Buffer.concat([Buffer.from([config]), ...extra]);
}

function nonce(salt: Buffer, ctr: bigint): Buffer {
  const counter = beBytes(ctr, salt.length);
  const out = Buffer.alloc(salt.length);
  for (let i = 0; i < salt.length; i++) {
    out[i] = salt[i] ^ counter[i];
  }
  return out;
}

export function seal(keys: DerivedKeys, suite: SFrameCipherSuite, header: Buffer, plaintext: Buffer, ctr: bigint): Buffer {
  const params = SUITES[suite];
  const iv = nonce(keys.salt, ctr);

  if (params.aead === 'gcm') {
    const cipher = createCipheriv(keys.key.length === 32 ? 'aes-256-gcm' : 'aes-128-gcm', keys.key, iv);
    cipher.setAAD(header);
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([header, ct, cipher.getAuthTag()]);
  }

  const encKey = keys.key.subarray(0, params.nka);
  const authKey = keys.key.subarray(params.nka);
  const counter = Buffer.concat([iv, Buffer.alloc(4)]);
  const cipher = createCipheriv(ctrAlgorithm(encKey), encKey, counter);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = computeCtrTag(authKey, header, ct, iv, params);
  return Buffer.concat([header, ct, tag]);
}

function ctrAlgorithm(encKey: Buffer): string {
  return encKey.length === 32 ? 'aes-256-ctr' : 'aes-128-ctr';
}

function open(keys: DerivedKeys, suite: SFrameCipherSuite, buffer: Buffer): Buffer {
  const params = SUITES[suite];
  const { header, ctr, offset } = decodeHeader(buffer);
  const iv = nonce(keys.salt, ctr);
  const body = buffer.subarray(offset);

  if (params.aead === 'gcm') {
    const tag = body.subarray(body.length - params.nt);
    const ct = body.subarray(0, body.length - params.nt);
    const decipher = createDecipheriv(keys.key.length === 32 ? 'aes-256-gcm' : 'aes-128-gcm', keys.key, iv);
    decipher.setAAD(header);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  }

  const encKey = keys.key.subarray(0, params.nka);
  const authKey = keys.key.subarray(params.nka);
  const ct = body.subarray(0, body.length - params.nt);
  const tag = body.subarray(body.length - params.nt);
  const expected = computeCtrTag(authKey, header, ct, iv, params);
  if (!tag.equals(expected)) {
    throw new Error('SFrame auth tag mismatch');
  }
  const counter = Buffer.concat([iv, Buffer.alloc(4)]);
  const decipher = createDecipheriv(ctrAlgorithm(encKey), encKey, counter);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

// RFC 9605 4.5.1: HMAC over aad_len || ct_len || tag_len || nonce || aad || ct, truncated to Nt
function computeCtrTag(authKey: Buffer, aad: Buffer, ct: Buffer, iv: Buffer, params: SuiteParams): Buffer {
  const lengths = Buffer.alloc(24);
  lengths.writeBigUInt64BE(BigInt(aad.length), 0);
  lengths.writeBigUInt64BE(BigInt(ct.length), 8);
  lengths.writeBigUInt64BE(BigInt(params.nt), 16);
  const hmac = createHmac(params.hash, authKey);
  hmac.update(Buffer.concat([lengths, iv, aad, ct]));
  return hmac.digest().subarray(0, params.nt);
}

function decodeHeader(buffer: Buffer): { header: Buffer; kid: bigint; ctr: bigint; offset: number } {
  const config = buffer[0];
  let offset = 1;

  let kid: bigint;
  if (config & 0x80) {
    const len = ((config >> 4) & 0x07) + 1;
    kid = BigInt(`0x${buffer.subarray(offset, offset + len).toString('hex') || '0'}`);
    offset += len;
  } else {
    kid = BigInt((config >> 4) & 0x07);
  }

  let ctr: bigint;
  if (config & 0x08) {
    const len = (config & 0x07) + 1;
    ctr = BigInt(`0x${buffer.subarray(offset, offset + len).toString('hex') || '0'}`);
    offset += len;
  } else {
    ctr = BigInt(config & 0x07);
  }

  return { header: buffer.subarray(0, offset), kid, ctr, offset };
}

// one sender key per WebRTC session, the viewer derives a separate cryptor per RTP stream from it
export class SecureVideoSFrame {
  public readonly senderKey?: SFrameKeyData;

  private readonly receiveKeys = new Map<bigint, Buffer>();

  constructor(private enabled: boolean) {
    if (enabled) {
      this.senderKey = { key: randomBytes(SUITES[VIDEO_SUITE].baseKeyLength), kid: 0x100n };
    }
  }

  public videoStream(ssrc: number): SFrameStream {
    return this.stream(ssrc, VIDEO_SUITE);
  }

  public audioStream(ssrc: number): SFrameStream {
    return this.stream(ssrc, AUDIO_SUITE);
  }

  public addReceiveKeys(keys: SFrameKeyData[]): void {
    for (const { kid, key } of keys) {
      this.receiveKeys.set(kid, key);
    }
  }

  public removeReceiveKeys(kids: bigint[]): void {
    for (const kid of kids) {
      this.receiveKeys.delete(kid);
    }
  }

  // talkback audio from the viewer, protected with the receive keys announced per session and derived
  // per stream like our own sender key
  public audioReceiver(ssrc: number): SFrameReceiver {
    return new SFrameReceiver(this.enabled ? this.receiveKeys : undefined, ssrc, AUDIO_SUITE);
  }

  private stream(ssrc: number, suite: SFrameCipherSuite): SFrameStream {
    if (!this.enabled || !this.senderKey) {
      return new SFrameStream();
    }
    return new SFrameStream(deriveKeys(deriveStreamBaseKey(this.senderKey.key, ssrc), this.senderKey.kid, suite), suite, this.senderKey.kid);
  }
}

export class SFrameReceiver {
  private readonly streams = new Map<bigint, DerivedKeys>();

  constructor(
    private groupKeys: Map<bigint, Buffer> | undefined,
    private ssrc: number,
    private suite: SFrameCipherSuite,
  ) {}

  public unprotectFrame(ciphertext: Buffer): Buffer {
    if (!this.groupKeys) {
      return ciphertext;
    }
    const { kid } = decodeHeader(ciphertext);
    let keys = this.streams.get(kid);
    if (!keys) {
      const groupKey = this.groupKeys.get(kid);
      if (!groupKey) {
        throw new Error(`no SFrame receive key for kid ${kid}`);
      }
      keys = deriveKeys(deriveStreamBaseKey(groupKey, this.ssrc), kid, this.suite);
      this.streams.set(kid, keys);
    }
    return open(keys, this.suite, ciphertext);
  }
}

export class SFrameStream {
  private counter = 0n;

  constructor(
    private keys?: DerivedKeys,
    private suite: SFrameCipherSuite = VIDEO_SUITE,
    private kid = 0n,
  ) {}

  public protectFrame(plaintext: Buffer): Buffer {
    if (!this.keys) {
      return plaintext;
    }
    const ctr = this.counter++;
    const header = encodeHeader(this.kid, ctr);
    return seal(this.keys, this.suite, header, plaintext, ctr);
  }
}
