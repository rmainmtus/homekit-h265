import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHmac } from 'node:crypto';
import { derive, FeedbackMonitor } from '../feedback';
const master = Buffer.from('E1F97A0D3E018BE0D64FA32C06DE41390EC675AD498AFEEBB6960B3AABE6', 'hex');
test('SRTP key derivation matches RFC 3711 B.3 independent vector', () => {
  assert.equal(derive(master, 0, 16).toString('hex'), 'c61e7a93744f39ee10734afe3ff7a087');
});
test('authenticated receiver report exposes metrics; tampering is rejected', () => {
  const report = Buffer.alloc(32); report.set([0x81, 201, 0, 7]);
  report.writeUInt32BE(9, 4); report.writeUInt32BE(123, 8);
  report[12] = 16; report.writeIntBE(5, 13, 3); report.writeUInt32BE(180, 20);
  const iv = Buffer.alloc(16); derive(master, 5, 14).copy(iv);
  iv[7] ^= 9; iv[13] ^= 7;
  const cipher = createCipheriv('aes-128-ctr', derive(master, 3, 16), iv);
  const index = Buffer.from('80000007', 'hex');
  const encrypted = Buffer.concat([report.subarray(0, 8), cipher.update(report.subarray(8)), cipher.final(), index]);
  const packet = Buffer.concat([encrypted, createHmac('sha1', derive(master, 4, 20)).update(encrypted).digest().subarray(0, 10)]);
  const monitor = new FeedbackMonitor(master); monitor.observe(packet, 123);
  assert.deepEqual(monitor.stats, {reports: 1, lost: 5, fraction: 16, jitter: 180, nack: 0, pli: 0, invalid: 0});
  packet[8] ^= 1; monitor.observe(packet, 123);
  assert.equal(monitor.stats.invalid, 1); assert.equal(monitor.stats.reports, 1);
  monitor.observe(Buffer.alloc(3), 123); assert.equal(monitor.stats.invalid, 2);
  monitor.close();
});
