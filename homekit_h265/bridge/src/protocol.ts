// Wire layouts: Apple HKSV Open Source Compatibility Guide, 2026-06-03,
// sections 3.1, 3.6, 4.3-4.5 and 4.16. Legacy SetupEndpoints uses HAP R17.
import { isIP } from 'node:net';

export const hapUuid = (id: string) => `0000${id}-0000-1000-8000-0026BB765291`;
export type Field = readonly [number, Buffer];
export function uint(value: number, bytes: 1 | 2 | 4): Buffer {
  if (!Number.isInteger(value) || value < 0 || value >= 2 ** (8 * bytes)) throw new Error('Invalid integer');
  const b = Buffer.alloc(bytes); b.writeUIntLE(value, 0, bytes); return b;
}
export function tlv(...fields: Field[]): Buffer {
  const out: Buffer[] = [];
  let previous = -1;
  for (const [tag, value] of fields) {
    if (tag < 1 || tag > 254) throw new Error('Invalid TLV tag');
    if (previous === tag) out.push(Buffer.from([0, 0]));
    for (let i = 0; i < value.length || i === 0; i += 255) {
      const chunk = value.subarray(i, i + 255);
      out.push(Buffer.from([tag, chunk.length]), chunk);
    }
    previous = tag;
  }
  return Buffer.concat(out);
}
export function parse(data: Buffer): Field[] {
  if (data.length > 65536) throw new Error('TLV too large');
  const out: [number, Buffer][] = [];
  let continuation = false;
  for (let i = 0; i < data.length;) {
    if (i + 2 > data.length) throw new Error('Truncated TLV header');
    const tag = data[i++], n = data[i++];
    if (i + n > data.length) throw new Error('Truncated TLV value');
    if (tag === 0 || tag === 255) {
      if (n) throw new Error('Invalid separator');
      continuation = false; continue;
    }
    const chunk = data.subarray(i, i + n); i += n;
    const last = out.at(-1);
    if (continuation && last?.[0] === tag) last[1] = Buffer.concat([last[1], chunk]);
    else out.push([tag, chunk]);
    continuation = n === 255;
  }
  return out;
}
export function one(fields: Field[], tag: number, length?: number): Buffer {
  const matches = fields.filter(f => f[0] === tag);
  if (matches.length !== 1 || (length !== undefined && matches[0][1].length !== length)) throw new Error(`Invalid field ${tag}`);
  return matches[0][1];
}
export function fromBase64(value: unknown): Buffer {
  if (typeof value !== 'string' || value.length > 90000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('Invalid base64');
  return Buffer.from(value, 'base64');
}
export interface Tier {
  id: number; quality: 2 | 3 | 4; width: number; height: number; fps: number;
  averageKbps: number; peakKbps: number; rtspUrl: string;
}
export function validateTiers(tiers: Tier[]) {
  if (!tiers.length || tiers.length > 3) throw new Error('Provide 1 to 3 genuine camera streams');
  const ids = new Set<number>(); const qualities = new Set<number>();
  for (const t of tiers) {
    if (ids.has(t.id) || qualities.has(t.quality)) throw new Error('Duplicate tier');
    ids.add(t.id); qualities.add(t.quality);
    if (![2, 3, 4].includes(t.quality)) throw new Error('Invalid quality');
    for (const [n, bytes] of [[t.id, 4], [t.width, 2], [t.height, 2], [t.fps, 1], [t.averageKbps, 4], [t.peakKbps, 4]] as const) {
      uint(n, bytes); if (!n) throw new Error('Zero tier parameter');
    }
    if (t.averageKbps > t.peakKbps) throw new Error('Average exceeds peak bitrate');
    const u = new URL(t.rtspUrl);
    if (u.protocol !== 'rtsp:' || !u.hostname) throw new Error('An RTSP source is required');
  }
}
export function videoTiers(tiers: Tier[]): Buffer {
  validateTiers(tiers);
  return tlv([1, uint(2, 1)], [2, uint(99, 1)], ...tiers.map(t => [3, tlv(
    [1, uint(t.id, 4)], [2, uint(t.quality, 1)], [3, uint(t.averageKbps, 4)],
    [4, uint(t.width, 2)], [5, uint(t.height, 2)], [6, uint(t.fps, 1)]
  )] as Field));
}
export const audioTiers = () => tlv([1, uint(3, 1)], [2, uint(110, 1)], [3, tlv(
  [1, uint(1, 4)], [2, uint(24000, 4)], [3, uint(4, 1)],
  [4, uint(2, 1)], [5, uint(20, 1)], [6, uint(1, 1)]
)]);
export function capabilities(sensor: Buffer, tiers: Tier[], version: number, configIds: Buffer[]) {
  if (sensor.length !== 16 || configIds.length !== tiers.length || configIds.some(b => b.length !== 16)) throw new Error('Invalid UUID');
  const largest = tiers.reduce((a, b) => a.width * a.height > b.width * b.height ? a : b);
  return tlv([1, uint(version, 1)], [2, tlv([1, tlv(
    [1, tlv([1, uint(largest.width, 2)], [2, uint(largest.height, 2)])],
    [2, sensor], [3, uint(1, 1)], [4, uint(1, 1)],
    ...tiers.map((t, i) => [5, tlv([1, configIds[i]], [2, uint(t.quality, 1)],
      [3, uint(t.width, 2)], [4, uint(t.height, 2)], [5, uint(t.fps, 1)],
      [6, uint(t.averageKbps, 4)], [7, uint(t.peakKbps, 4)])] as Field)
  )])]);
}
export interface Endpoint {
  id: Buffer; address: string; videoPort: number; audioPort: number;
  videoKey: Buffer; audioKey: Buffer;
}
export function endpoint(data: Buffer): Endpoint {
  const f = parse(data), a = parse(one(f, 3));
  if (one(a, 1, 1)[0] !== 0) throw new Error('Lab supports IPv4 only');
  const address = one(a, 2).toString('utf8');
  if (isIP(address) !== 4) throw new Error('Invalid IPv4 address');
  const key = (tag: number) => {
    const k = parse(one(f, tag));
    if (one(k, 1, 1)[0] !== 0) throw new Error('Only AES_CM_128_HMAC_SHA1_80 is supported');
    return Buffer.concat([one(k, 2, 16), one(k, 3, 14)]);
  };
  const videoPort = one(a, 3, 2).readUInt16LE(), audioPort = one(a, 4, 2).readUInt16LE();
  if (videoPort < 1024 || audioPort < 1024) throw new Error('Invalid media port');
  return {id: one(f, 1, 16), address, videoPort, audioPort, videoKey: key(4), audioKey: key(5)};
}
export function control(data: Buffer) {
  const f = parse(data), id = one(f, 1, 16), command = one(f, 2, 1)[0];
  if (command === 1) return {id, command} as const;
  if (command !== 2) throw new Error('Unsupported stream command');
  // Apple Home has been observed encoding small uint32 tier IDs in one byte.
  // Accept bounded little-endian integers without changing the advertised schema.
  const tierId = (tag: number) => {
    const b = one(f, tag);
    if (b.length < 1 || b.length > 4) throw new Error('Invalid tier identifier');
    return b.readUIntLE(0, b.length);
  };
  return {id, command, videoTier: tierId(3), videoSsrc: one(f, 4, 4).readUInt32LE(),
    audioTier: tierId(5), audioSsrc: one(f, 6, 4).readUInt32LE()} as const;
}
