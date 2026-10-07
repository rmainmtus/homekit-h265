import { createCipheriv, createHmac, timingSafeEqual } from 'node:crypto';

// RFC 3711, AES-CM key derivation, kdr=0. Used only for feedback diagnostics;
// FFmpeg still owns media encryption and the original feedback is forwarded.
export function derive(master: Buffer, label: number, length: number): Buffer {
  if (master.length !== 30) throw new Error('Invalid SRTP key length');
  const iv = Buffer.alloc(16); master.copy(iv, 0, 16); iv[7] ^= label;
  const cipher = createCipheriv('aes-128-ctr', master.subarray(0, 16), iv);
  return Buffer.concat([cipher.update(Buffer.alloc(length)), cipher.final()]);
}
export interface FeedbackStats {
  reports: number; lost: number; fraction: number; jitter: number;
  nack: number; pli: number; invalid: number;
}
export class FeedbackMonitor {
  readonly stats: FeedbackStats = {reports: 0, lost: 0, fraction: 0, jitter: 0, nack: 0, pli: 0, invalid: 0};
  private encryption: Buffer; private authentication: Buffer; private salt: Buffer;
  constructor(master: Buffer) {
    this.encryption = derive(master, 3, 16);
    this.authentication = derive(master, 4, 20);
    this.salt = derive(master, 5, 14);
  }
  close() {this.encryption.fill(0); this.authentication.fill(0); this.salt.fill(0);}
  observe(packet: Buffer, sourceSsrc: number) {
    if (packet.length < 22) {this.stats.invalid++; return;}
    const signed = packet.subarray(0, -10);
    const mac = createHmac('sha1', this.authentication).update(signed).digest().subarray(0, 10);
    if (!timingSafeEqual(mac, packet.subarray(-10))) {this.stats.invalid++; return;}
    const index = signed.readUInt32BE(signed.length - 4), body = signed.subarray(0, -4);
    let plain = body;
    if (index & 0x80000000) {
      const iv = Buffer.alloc(16); this.salt.copy(iv);
      const mixed = Buffer.alloc(16); body.copy(mixed, 4, 4, 8);
      mixed.writeUInt32BE(index & 0x7fffffff, 10);
      for (let i = 0; i < 16; i++) iv[i] ^= mixed[i];
      const cipher = createCipheriv('aes-128-ctr', this.encryption, iv);
      plain = Buffer.concat([body.subarray(0, 8), cipher.update(body.subarray(8)), cipher.final()]);
    }
    for (let at = 0; at + 4 <= plain.length;) {
      const length = (plain.readUInt16BE(at + 2) + 1) * 4;
      if (plain[at] >> 6 !== 2 || length < 4 || at + length > plain.length) {this.stats.invalid++; return;}
      const p = plain.subarray(at, at + length), type = p[1], count = p[0] & 31;
      if (type === 201 || type === 200) {
        const start = type === 201 ? 8 : 28;
        for (let i = 0; i < count && start + (i + 1) * 24 <= p.length; i++) {
          const b = start + i * 24;
          if (p.readUInt32BE(b) !== sourceSsrc) continue;
          this.stats.reports++; this.stats.fraction = p[b + 4];
          this.stats.lost = p.readIntBE(b + 5, 3); this.stats.jitter = p.readUInt32BE(b + 12);
        }
      } else if (p.length >= 12 && p.readUInt32BE(8) === sourceSsrc) {
        if (type === 205 && count === 1) this.stats.nack++;
        if (type === 206 && count === 1) this.stats.pli++;
      }
      at += length;
    }
  }
}
