import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import dgram from 'node:dgram';
import type { HAPConnection } from 'hap-nodejs/dist/lib/util/eventedhttp';
import { HevcAccessory, LabConfig } from '../accessory';
import { one, parse, tlv, uint, hapUuid } from '../protocol';
import { relay } from '../media';
import { setupRequest, tier } from './fixtures';
const config: LabConfig = {name: 'HEVC Lab Test', identity: 'unit-test-hevc', username: '02:AB:CD:EF:12:34', pincode: '321-45-987', address: '127.0.0.1', port: 36460, ffmpeg: 'nonexistent-lab-ffmpeg', tiers: [tier], capabilitiesVersion: 1};
const owner = () => Object.assign(new EventEmitter(), {remoteAddress: '127.0.0.1'}) as unknown as HAPConnection;
const status = (s: string) => one(parse(Buffer.from(s, 'base64')), 2, 1)[0];
const startRequest = (id: Buffer) => tlv([1, id], [2, uint(2, 1)], [3, uint(1, 1)],
  [4, uint(1, 4)], [5, uint(1, 1)], [6, uint(1, 4)]);
test('stopping a session cancels media while startup is still pending', async () => {
  let signal: AbortSignal | undefined;
  const lab = new HevcAccessory(config, () => {}, undefined, async (_ffmpeg, _args, _video, _audio, _exit, received) => {
    signal = received;
    return new Promise((_resolve, reject) => received!.addEventListener('abort', () => reject(new Error('cancelled')), {once: true}));
  });
  const peer = owner(), id = Buffer.alloc(16, 11);
  try {
    await lab.setup(setupRequest(id), peer);
    const starting = lab.command(startRequest(id), peer);
    assert.equal(signal?.aborted, false);
    lab.stop(id.toString('hex'));
    assert.equal(signal?.aborted, true);
    assert.equal(status(await starting), 4);
    assert.equal(lab.sessions.size, 0);
  } finally {lab.stopAll();}
});
test('a cancelled process exit cannot stop a replacement with the same session ID', async () => {
  let exit!: () => void, complete!: () => void, stopped = 0;
  const lab = new HevcAccessory(config, () => {}, undefined, async (_ffmpeg, _args, _video, _audio, onExit) => {
    exit = onExit;
    return new Promise(resolve => {complete = () => resolve({stop() {stopped++;}});});
  });
  const peer = owner(), id = Buffer.alloc(16, 12), key = id.toString('hex');
  try {
    await lab.setup(setupRequest(id), peer);
    const starting = lab.command(startRequest(id), peer);
    lab.stop(key);
    await lab.setup(setupRequest(id), peer);
    const replacement = lab.sessions.get(key);
    exit();
    assert.equal(lab.sessions.get(key), replacement);
    complete();
    assert.equal(status(await starting), 4);
    assert.equal(stopped, 1);
    assert.equal(lab.sessions.get(key), replacement);
  } finally {lab.stopAll();}
});
test('a cancelled startup rejection cannot stop a replacement with the same session ID', async () => {
  let reject!: (error: Error) => void;
  const lab = new HevcAccessory(config, () => {}, undefined, () => new Promise((_resolve, failed) => {reject = failed;}));
  const peer = owner(), id = Buffer.alloc(16, 13), key = id.toString('hex');
  try {
    await lab.setup(setupRequest(id), peer);
    const starting = lab.command(startRequest(id), peer);
    lab.stop(key);
    await lab.setup(setupRequest(id), peer);
    const replacement = lab.sessions.get(key);
    reject(new Error('previous process failed'));
    assert.equal(status(await starting), 4);
    assert.equal(lab.sessions.get(key), replacement);
  } finally {lab.stopAll();}
});
test('sender uses advertised accessory SSRCs rather than the controller identifiers', async () => {
  let args: string[] = [];
  const lab = new HevcAccessory(config, () => {}, undefined, async (_ffmpeg, received) => {
    args = received; return {stop() {}};
  });
  const peer = owner(), id = Buffer.alloc(16, 8);
  try {
    const response = parse(Buffer.from(await lab.setup(setupRequest(id), peer), 'base64'));
    const video = one(response, 6, 4).readUInt32LE(), audio = one(response, 7, 4).readUInt32LE();
    const request = tlv([1, id], [2, uint(2, 1)], [3, uint(1, 1)],
      [4, uint((video + 1) >>> 0, 4)], [5, uint(1, 1)], [6, uint((audio + 1) >>> 0, 4)]);
    assert.equal(status(await lab.command(request, peer)), 0);
    const values = args.flatMap((v, i) => v === '-ssrc' ? [args[i + 1]] : []);
    assert.deepEqual(values, [String(video | 0), String(audio | 0)]);
  } finally {lab.stopAll();}
});
test('rejects requests redirecting traffic away from paired connection peer', async () => {
  const lab = new HevcAccessory(config, () => {});
  assert.equal(status(await lab.setup(setupRequest(undefined, '192.168.1.99'), owner())), 2);
  assert.equal(lab.sessions.size, 0);
});
test('five sessions reserve ports and a sixth is busy; disconnect cleans them up', async () => {
  const lab = new HevcAccessory(config, () => {}), peer = owner();
  try {
    for (let i = 1; i <= 5; i++) assert.equal(status(await lab.setup(setupRequest(Buffer.alloc(16, i)), peer)), 0);
    assert.equal(status(await lab.setup(setupRequest(Buffer.alloc(16, 6)), peer)), 1);
    peer.emit('closed'); assert.equal(lab.sessions.size, 0);
  } finally {lab.stopAll();}
});
test('another paired connection cannot end someone else\'s session', async () => {
  const lab = new HevcAccessory(config, () => {}), peer = owner(), id = Buffer.alloc(16, 7);
  try {
    await lab.setup(setupRequest(id), peer);
    const end = tlv([1, id], [2, uint(1, 1)]);
    assert.equal(status(await lab.command(end, owner())), 1);
    assert.equal(lab.sessions.size, 1);
    assert.equal(status(await lab.command(end, peer)), 2);
    assert.equal(lab.sessions.size, 0);
  } finally {lab.stopAll();}
});
test('privacy mode stops all sessions and rejects further setup', async () => {
  const lab = new HevcAccessory(config, () => {}), peer = owner();
  await lab.setup(setupRequest(), peer);
  const service = lab.accessory.services.find(s => s.UUID === hapUuid('8032'))!;
  const c = service.characteristics.find(c => c.UUID === hapUuid('8041'))!;
  await c.handleSetRequest(false);
  assert.equal(lab.sessions.size, 0);
  assert.equal(status(await lab.setup(setupRequest(), peer)), 2);
});
test('no recording services or legacy H264 advertisement are fabricated', () => {
  const lab = new HevcAccessory(config, () => {});
  assert.equal(lab.accessory.services.some(s => s.UUID === hapUuid('0204')), false);
  assert.ok(lab.accessory.services.some(s => s.UUID === hapUuid('8031')));
});
test('remote service shares sensor identity and links to local stream and recording transport', () => {
  const lab = new HevcAccessory({...config, recording: true}, () => {});
  const local = lab.accessory.services.find(s => s.UUID === hapUuid('8031'))!;
  const remote = lab.remote.service;
  assert.ok(local.linkedServices.includes(remote));
  assert.ok(remote.linkedServices.includes(local));
  assert.ok(remote.linkedServices.includes(lab.recording!.management.dataStreamManagement.getService()));
  assert.ok(remote.characteristics.some(c => c.UUID === hapUuid('8053')));
  lab.recording!.close();
});
test('encrypted relay forwards packet bytes and reverse feedback unchanged', async () => {
  const receiver = dgram.createSocket('udp4'), encoder = dgram.createSocket('udp4');
  await new Promise<void>(r => receiver.bind(0, '127.0.0.1', r));
  await new Promise<void>(r => encoder.bind(0, '127.0.0.1', r));
  const r = await relay('127.0.0.1', '127.0.0.1', receiver.address().port);
  try {
    const payload = Buffer.from('opaque encrypted media');
    const received = new Promise<Buffer>(resolve => receiver.once('message', resolve));
    encoder.send(payload, r.inputPort, '127.0.0.1');
    assert.deepEqual(await received, payload);
    const feedback = new Promise<Buffer>(resolve => encoder.once('message', resolve));
    receiver.send(Buffer.from('feedback'), r.port, '127.0.0.1');
    assert.deepEqual(await feedback, Buffer.from('feedback'));
    assert.equal(r.packets, 1);
  } finally {r.close(); receiver.close(); encoder.close();}
});
test('an RTCP packet arriving first does not block RTP from a separate FFmpeg socket', async () => {
  const receiver = dgram.createSocket('udp4'), rtp = dgram.createSocket('udp4'), rtcp = dgram.createSocket('udp4');
  for (const s of [receiver, rtp, rtcp]) await new Promise<void>(r => s.bind(0, '127.0.0.1', r));
  const r = await relay('127.0.0.1', '127.0.0.1', receiver.address().port);
  try {
    const report = Buffer.from([0x80, 200, 0, 1, 1, 2, 3, 4]);
    const media = Buffer.from([0x80, 227, 0, 1, 1, 2, 3, 4]);
    let received = new Promise<Buffer>(resolve => receiver.once('message', resolve));
    rtcp.send(report, r.inputPort, '127.0.0.1'); assert.deepEqual(await received, report);
    received = new Promise<Buffer>(resolve => receiver.once('message', resolve));
    rtp.send(media, r.inputPort, '127.0.0.1'); assert.deepEqual(await received, media);
    const feedback = new Promise<Buffer>(resolve => rtcp.once('message', resolve));
    receiver.send(report, r.port, '127.0.0.1'); assert.deepEqual(await feedback, report);
    assert.equal(r.packets, 1);
  } finally {r.close(); for (const s of [receiver, rtp, rtcp]) s.close();}
});
