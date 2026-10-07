import {boxes} from './mp4';
export function videoMetadata(init: Buffer) {
  const moov = boxes(init).find(b => b.type === 'moov');
  if (!moov) throw new Error('Missing movie');
  for (const trak of boxes(moov.data.subarray(8)).filter(b => b.type === 'trak')) {
    const children = boxes(trak.data.subarray(8));
    const tkhd = children.find(b => b.type === 'tkhd')!.data;
    const mdia = boxes(children.find(b => b.type === 'mdia')!.data.subarray(8));
    if (mdia.find(b => b.type === 'hdlr')!.data.toString('ascii', 16, 20) !== 'vide') continue;
    const mdhd = mdia.find(b => b.type === 'mdhd')!.data;
    const minf = boxes(mdia.find(b => b.type === 'minf')!.data.subarray(8));
    const stbl = boxes(minf.find(b => b.type === 'stbl')!.data.subarray(8));
    const stsd = stbl.find(b => b.type === 'stsd')!.data;
    const entry = boxes(stsd.subarray(16)).find(b => b.type === 'hvc1');
    if (!entry) throw new Error('Recording is not native hvc1');
    const hvcc = boxes(entry.data.subarray(86)).find(b => b.type === 'hvcC')!.data.subarray(8);
    const profile = hvcc[1] & 31, space = ['', 'A', 'B', 'C'][hvcc[1] >> 6];
    let compatibility = hvcc.readUInt32BE(2), reversed = 0;
    for (let i = 0; i < 32; i++) {reversed = (reversed * 2 + (compatibility & 1)) >>> 0; compatibility >>>= 1;}
    const constraints = Array.from(hvcc.subarray(6, 12));
    while (constraints.length && constraints.at(-1) === 0) constraints.pop();
    const codec = `hvc1.${space}${profile}.${reversed.toString(16).toUpperCase()}.${hvcc[1] & 32 ? 'H' : 'L'}${hvcc[12]}`
      + constraints.map(n => `.${n.toString(16).toUpperCase()}`).join('');
    return {id: tkhd.readUInt32BE(tkhd[8] === 1 ? 28 : 20),
      timescale: mdhd.readUInt32BE(mdhd[8] === 1 ? 28 : 20),
      width: entry.data.readUInt16BE(32), height: entry.data.readUInt16BE(34), codecs: codec};
  }
  throw new Error('Missing video track');
}
export function fragmentDuration(fragment: Buffer, track: {id: number; timescale: number}) {
  const moof = boxes(fragment).find(b => b.type === 'moof')!;
  for (const traf of boxes(moof.data.subarray(8)).filter(b => b.type === 'traf')) {
    const children = boxes(traf.data.subarray(8)), tfhd = children.find(b => b.type === 'tfhd')!.data;
    if (tfhd.readUInt32BE(12) !== track.id) continue;
    const flags = tfhd.readUIntBE(9, 3);
    let at = 16 + (flags & 1 ? 8 : 0) + (flags & 2 ? 4 : 0);
    const defaultDuration = flags & 8 ? tfhd.readUInt32BE(at) : 0;
    let ticks = 0;
    for (const run of children.filter(b => b.type === 'trun')) {
      const f = run.data.readUIntBE(9, 3), count = run.data.readUInt32BE(12);
      at = 16 + (f & 1 ? 4 : 0) + (f & 4 ? 4 : 0);
      if (count > 100000) throw new Error('Sample count limit');
      for (let i = 0; i < count; i++) {
        ticks += f & 256 ? run.data.readUInt32BE(at) : defaultDuration;
        at += (f & 256 ? 4 : 0) + (f & 512 ? 4 : 0) + (f & 1024 ? 4 : 0) + (f & 2048 ? 4 : 0);
      }
    }
    const seconds = ticks / track.timescale;
    if (!(seconds > 0 && seconds <= 15)) throw new Error('Invalid fragment duration');
    return seconds;
  }
  throw new Error('Missing video fragment');
}
