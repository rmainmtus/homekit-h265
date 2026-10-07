// ISO BMFF fragment framing. HEVC HDS interoperability: HAP-NodeJS PR #1132.
export function boxes(data: Buffer): {type: string; data: Buffer}[] {
  const out = [];
  for (let at = 0; at < data.length;) {
    if (at + 8 > data.length) throw new Error('Truncated MP4 header');
    const size = data.readUInt32BE(at);
    if (size < 8 || at + size > data.length) throw new Error('Invalid MP4 size');
    out.push({type: data.toString('ascii', at + 4, at + 8), data: data.subarray(at, at + size)});
    at += size;
  }
  return out;
}

export class Mp4Framer {
  private pending = Buffer.alloc(0);
  push(chunk: Buffer): {type: string; data: Buffer}[] {
    this.pending = Buffer.concat([this.pending, chunk]);
    if (this.pending.length > 8 * 1024 * 1024) throw new Error('MP4 buffer limit');
    const out = [];
    while (this.pending.length >= 8) {
      const size = this.pending.readUInt32BE(0);
      if (size < 8 || size > 8 * 1024 * 1024) throw new Error('MP4 box limit');
      if (size > this.pending.length) break;
      const data = Buffer.from(this.pending.subarray(0, size));
      out.push({type: data.toString('ascii', 4, 8), data});
      this.pending = this.pending.subarray(size);
    }
    return out;
  }
}

export function recordingFragment(fragment: Buffer, offsets: Map<number, bigint>, startedAt: number): Buffer {
  const out = Buffer.from(fragment);
  let first: {id: number; time: bigint} | undefined;
  for (const box of boxes(out)) {
    if (box.type !== 'moof') continue;
    for (const traf of boxes(box.data.subarray(8)).filter(b => b.type === 'traf')) {
      const children = boxes(traf.data.subarray(8));
      const tfhd = children.find(b => b.type === 'tfhd')?.data;
      const tfdt = children.find(b => b.type === 'tfdt')?.data;
      if (!tfhd || tfhd.length < 16 || !tfdt || tfdt.length < 16) throw new Error('Missing track timestamp');
      const id = tfhd.readUInt32BE(12), version = tfdt[8];
      if (version > 1 || (version === 1 && tfdt.length < 20)) throw new Error('Invalid track timestamp');
      const current = version === 1 ? tfdt.readBigUInt64BE(12) : BigInt(tfdt.readUInt32BE(12));
      if (!offsets.has(id)) offsets.set(id, current);
      const time = current - offsets.get(id)!;
      if (time < 0n) throw new Error('Recording clock moved backwards');
      if (version === 1) tfdt.writeBigUInt64BE(time, 12); else tfdt.writeUInt32BE(Number(time), 12);
      first ??= {id, time};
    }
  }
  if (!first) throw new Error('No recording tracks');
  const ms = BigInt(Math.round(startedAt));
  const ntp = ((ms / 1000n + 2208988800n) << 32n) | ((ms % 1000n << 32n) / 1000n);
  const prft = Buffer.alloc(32);
  prft.writeUInt32BE(32); prft.write('prft', 4); prft[8] = 1;
  prft.writeUInt32BE(first.id, 12); prft.writeBigUInt64BE(ntp, 16); prft.writeBigUInt64BE(first.time, 24);
  return Buffer.concat([prft, out]);
}
