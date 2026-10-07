import test from 'node:test';
import assert from 'node:assert/strict';
import { SecureVideoSFrame, SFrameReceiver, SFrameCipherSuite } from '../sframe';
import { SFrameRtpPacketizer, SFrameRtpDepacketizer } from '../sframeRtp';
import { addVideoRtpStreamId } from '../webrtcSdp';
import { RemoteViewing, remoteMediaArguments, candidates } from '../webrtc';
import { one, parse, tlv, uint } from '../protocol';
import { tier } from './fixtures';

test('encrypted video survives RTP fragmentation; tampering fails authentication', () => {
  const frame = new SecureVideoSFrame(true), ssrc = 23456;
  const keys = new Map([[frame.senderKey!.kid, frame.senderKey!.key]]);
  const encrypt = frame.videoStream(ssrc), decrypt = new SFrameReceiver(keys, ssrc, SFrameCipherSuite.AES_256_CTR_HMAC_SHA512_80);
  const plain = Buffer.alloc(14000, 0x5a), sealed = encrypt.protectFrame(plain);
  assert.notDeepEqual(sealed.subarray(0, plain.length), plain);
  const packetizer = new SFrameRtpPacketizer({ssrc, payloadType: 99, maxPayload: 1200});
  const depacketizer = new SFrameRtpDepacketizer();
  let received: Buffer | undefined;
  const packets = packetizer.packetize(sealed, 1234, true);
  for (const packet of packets) received = depacketizer.push(packet) ?? received;
  assert.deepEqual(decrypt.unprotectFrame(received!), plain);
  received![received!.length - 1] ^= 1;
  assert.throws(() => decrypt.unprotectFrame(received!));
  assert.ok(packets.every(p => p.payload.length <= 1200));
  assert.equal(packets.filter(p => p.header.marker).length, 1);
  assert.notDeepEqual(encrypt.protectFrame(plain), sealed);
});
test('audio keys are bound to their stream SSRC', () => {
  const frame = new SecureVideoSFrame(true), keys = new Map([[frame.senderKey!.kid, frame.senderKey!.key]]);
  const bytes = frame.audioStream(111).protectFrame(Buffer.from('opus frame'));
  assert.equal(new SFrameReceiver(keys, 111, SFrameCipherSuite.AES_256_CTR_HMAC_SHA512_32).unprotectFrame(bytes).toString(), 'opus frame');
  assert.throws(() => new SFrameReceiver(keys, 222, SFrameCipherSuite.AES_256_CTR_HMAC_SHA512_32).unprotectFrame(bytes));
});
test('remote SDP carries Apple-required stream identifier and real bitrate', () => {
  const result = addVideoRtpStreamId('v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 99\r\nc=IN IP4 0.0.0.0\r\na=mid:0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 110\r\n', tier);
  assert.match(result, /b=AS:4111/); assert.match(result, /a=rid:1 send max-width=2304;max-height=2592;max-fps=12;max-br=4111000/);
  assert.ok(result.indexOf('a=simulcast') < result.indexOf('m=audio'));
});
test('remote ffmpeg copies video and keeps unencrypted intermediate packets on loopback', () => {
  const args = remoteMediaArguments(tier, 10000, 10001);
  assert.equal(args[args.indexOf('-c:v') + 1], 'copy');
  assert.deepEqual(args.filter(a => a.startsWith('rtp://')), ['rtp://127.0.0.1:10000?rtcpport=10000&pkt_size=1200', 'rtp://127.0.0.1:10001?rtcpport=10001&pkt_size=1200']);
});
test('privacy rejects remote offers before creating any sockets', async () => {
  const remote = new RemoteViewing('127.0.0.1', 'unused', tier, Buffer.alloc(16), () => false, () => {});
  assert.equal(one(parse(await remote.solicit(tlv([1, tlv([1, uint(1, 1)])]))), 4)[0], 1);
  assert.equal(remote.sessions.size, 0);
});
test('malformed ICE index is rejected and unknown session does not allocate resources', async () => {
  assert.throws(() => candidates([[3, tlv([1, Buffer.from('candidate:example')], [3, Buffer.alloc(1)])]]));
  const remote = new RemoteViewing('127.0.0.1', 'unused', tier, Buffer.alloc(16), () => true, () => {});
  assert.equal(one(parse(await remote.control('end', tlv([1, Buffer.alloc(16)], [2, uint(1, 1)]))), 2)[0], 1);
  assert.equal(remote.sessions.size, 0);
});
test('offer advertises HEVC, SFrame key and cleans up without touching local sessions', {timeout: 15000}, async () => {
  const remote = new RemoteViewing('127.0.0.1', 'unused', tier, Buffer.alloc(16), () => true, () => {});
  try {
    const f = parse(await remote.solicit(tlv([1, tlv([1, uint(1, 1)])])));
    assert.equal(one(f, 4)[0], 0);
    assert.match(one(f, 2).toString(), /H265\/90000/);
    assert.equal(one(parse(one(f, 5)), 1).length, 32);
    const response = await remote.control('end', tlv([1, one(f, 1)], [2, uint(1, 1)]));
    assert.equal(one(parse(response), 2)[0], 0); assert.equal(remote.sessions.size, 0);
  } finally {await remote.stopAll();}
});
