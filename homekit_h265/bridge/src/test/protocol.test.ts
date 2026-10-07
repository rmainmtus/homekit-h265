import test from 'node:test';
import assert from 'node:assert/strict';
import { audioTiers, capabilities, control, endpoint, fromBase64, one, parse, Tier, tlv, uint, validateTiers, videoTiers } from '../protocol';
import { mediaArguments } from '../media';
import {tier, setupRequest} from './fixtures';
test('known HEVC TLV vector uses codec 2 and little endian dimensions', () => {
  const t = {...tier, width: 1920, height: 1080, fps: 30, averageKbps: 1700};
  assert.equal(videoTiers([t]).toString('hex'), '010102020163031a0104010000000201020304a4060000040280070502380406011e');
});
test('Opus advertises 48kHz, mono and 20ms packets', () => {
  const f = parse(audioTiers()), t = parse(one(f, 3));
  assert.equal(one(f, 1, 1)[0], 3);
  assert.equal(one(t, 3, 1)[0], 4);
  assert.equal(one(t, 5, 1)[0], 20);
  assert.equal(one(t, 6, 1)[0], 1);
});
test('TLV fragmentation preserves values and separates repeated fields', () => {
  const values = [Buffer.alloc(510, 8), Buffer.from([9]), Buffer.alloc(0)];
  assert.deepEqual(parse(tlv(...values.map(v => [3, v] as const))).map(f => f[1]), values);
});
test('malformed and duplicate singleton fields are rejected', () => {
  for (const b of [Buffer.from([1]), Buffer.from([1, 3, 0]), Buffer.from([0, 1, 0])]) assert.throws(() => parse(b));
  assert.throws(() => one(parse(tlv([1, uint(1, 1)], [1, uint(2, 1)])), 1));
  assert.throws(() => fromBase64('a!!'));
  assert.throws(() => parse(Buffer.alloc(65537)));
});
test('invalid tiers cannot advertise invented stream sizes or duplicate IDs', () => {
  assert.throws(() => validateTiers([{...tier, width: -1}]));
  assert.throws(() => validateTiers([{...tier, fps: 256}]));
  assert.throws(() => validateTiers([tier, tier]));
  assert.throws(() => validateTiers([{...tier, rtspUrl: 'file:///etc/passwd'}]));
  assert.throws(() => validateTiers([{...tier, averageKbps: 9999}]));
});
test('capabilities embed stable sensor identity and actual dimensions', () => {
  const id = Buffer.alloc(16, 3);
  const f = parse(capabilities(id, [tier], 1, [Buffer.alloc(16, 4)]));
  const sensor = parse(one(parse(one(f, 2)), 1));
  assert.deepEqual(one(sensor, 2), id);
  assert.equal(one(parse(one(sensor, 1)), 2, 2).readUInt16LE(), 2592);
});
test('endpoints require authenticated encryption key sizes and IPv4', () => {
  const ep = endpoint(setupRequest());
  assert.equal(ep.videoKey.length, 30); assert.equal(ep.videoPort, 50100);
  assert.throws(() => endpoint(setupRequest(undefined, 'localhost')));
  assert.throws(() => endpoint(setupRequest(undefined, undefined, 2)));
  assert.throws(() => endpoint(tlv([1, Buffer.alloc(3)])));
});
test('RTP control start validates tier and SSRC fields', () => {
  const start = tlv([1, Buffer.alloc(16)], [2, uint(2, 1)], [3, uint(1, 4)], [4, uint(0xf1234567, 4)], [5, uint(1, 4)], [6, uint(42, 4)]);
  assert.equal(control(start).videoSsrc, 0xf1234567);
  assert.throws(() => control(tlv([1, Buffer.alloc(16)], [2, uint(2, 1)])));
  assert.throws(() => control(tlv([1, Buffer.alloc(16)], [2, uint(0, 1)])));
});
test('media launch copies video, converts only audio, and encrypts both outputs', () => {
  const args = mediaArguments(tier, endpoint(setupRequest()), 51000, 51001, 0xf1234567, 42);
  assert.equal(args[args.indexOf('-c:v') + 1], 'copy');
  assert.equal(args[args.indexOf('-c:a') + 1], 'libopus');
  assert.equal(args.filter(a => a === '-srtp_out_params').length, 2);
  assert.equal(args.includes('-vf'), false);
  assert.equal(args.includes('libx264'), false);
  assert.equal(args.includes('libx265'), false);
});
test('Apple compact tier IDs are accepted, but empty or oversized IDs are rejected', () => {
  const command = (tier: Buffer) => tlv([1, Buffer.alloc(16)], [2, uint(2, 1)], [3, tier],
    [4, uint(12345, 4)], [5, uint(1, 1)], [6, uint(54321, 4)]);
  assert.equal(control(command(uint(1, 1))).videoTier, 1);
  assert.equal(control(command(uint(257, 2))).videoTier, 257);
  assert.throws(() => control(command(Buffer.alloc(0))));
  assert.throws(() => control(command(Buffer.alloc(5))));
});
