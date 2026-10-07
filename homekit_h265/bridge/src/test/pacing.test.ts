import test from 'node:test';
import assert from 'node:assert/strict';
import { DatagramPacer } from '../pacing';
function harness() {
  let now = 0, callback: (() => void) | undefined, due = 0, failures = 0;
  const output: {at: number; packet: Buffer}[] = [];
  const p = new DatagramPacer(packet => output.push({at: now, packet}), 4_000_000, 4800,
    () => failures++, () => now, (fn, ms) => {callback = fn; due = now + ms; return {unref() {}} as any;}, () => {callback = undefined;});
  return {p, output, failures: () => failures, advance(ms: number) {
    const end = now + ms;
    while (callback && due <= end) {now = due; const fn = callback; callback = undefined; fn();}
    now = end;
  }};
}
test('600KB burst is spread out with identical encrypted bytes in order and bounded delay', () => {
  const h = harness(); const input = Array.from({length: 500}, (_, i) => {const b = Buffer.alloc(1200); b.writeUInt32BE(i); return b;});
  input.forEach(b => h.p.push(b));
  assert.equal(h.output.length, 4);
  h.advance(200);
  assert.deepEqual(h.output.map(x => x.packet), input);
  assert.ok(h.output.at(-1)!.at >= 140 && h.output.at(-1)!.at <= 200);
  const bursts = new Map<number, number>();
  h.output.forEach(x => bursts.set(x.at, (bursts.get(x.at) ?? 0) + x.packet.length));
  assert.ok(Math.max(...bursts.values()) <= 4800);
  assert.equal(h.p.stats.queuedBytes, 0); assert.equal(h.failures(), 0);
});
test('ordinary spaced packets are sent immediately and idle time cannot create a huge burst', () => {
  const h = harness(); h.p.push(Buffer.alloc(1200)); h.advance(5000);
  for(let i=0;i<8;i++) h.p.push(Buffer.alloc(1200));
  assert.equal(h.output.filter(x => x.at===5000).length,4);
  h.advance(5); assert.equal(h.output.length,9);
});
test('queue overload fails closed rather than dropping packets and running with unbounded delay', () => {
  const h = harness(); for(let i=0;i<2000;i++)h.p.push(Buffer.alloc(1200));
  assert.equal(h.failures(),1); assert.equal(h.p.stats.queuedBytes,0);
  h.advance(1000); assert.equal(h.output.length,4);
});
test('closing prevents queued packets being sent after the session stops', () => {
  const h = harness(); for(let i=0;i<50;i++)h.p.push(Buffer.alloc(1200));
  h.p.close(); h.advance(1000); assert.equal(h.output.length,4);
});
