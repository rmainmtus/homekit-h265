import test from 'node:test';
import assert from 'node:assert/strict';
import { Characteristic, uuid } from 'hap-nodejs';
import { Mp4Framer, boxes, recordingFragment } from '../mp4';
import { HevcAccessory, LabConfig } from '../accessory';
import { recordingArguments } from '../recording';
import { hapUuid, tlv, uint } from '../protocol';
import { tier } from './fixtures';

function box(type: string, ...parts: Buffer[]) {
  const payload = Buffer.concat(parts), header = Buffer.alloc(8);
  header.writeUInt32BE(8 + payload.length); header.write(type, 4); return Buffer.concat([header, payload]);
}
function fragment(time: bigint) {
  const tfhd = Buffer.alloc(8); tfhd.writeUInt32BE(1, 4);
  const tfdt = Buffer.alloc(12); tfdt[0] = 1; tfdt.writeBigUInt64BE(time, 4);
  return Buffer.concat([box('moof', box('traf', box('tfhd', tfhd), box('tfdt', tfdt))), box('mdat', Buffer.from([1, 2, 3]))]);
}
test('recording fragments survive arbitrary pipe chunk boundaries; malformed boxes are bounded', () => {
  const source = fragment(1000n), parser = new Mp4Framer(), parsed = [];
  for (const byte of source) parsed.push(...parser.push(Buffer.from([byte])));
  assert.deepEqual(Buffer.concat(parsed.map(v => v.data)), source);
  assert.throws(() => new Mp4Framer().push(Buffer.alloc(8)));
  const huge = Buffer.alloc(8); huge.writeUInt32BE(0xffffffff);
  assert.throws(() => new Mp4Framer().push(huge));
});
test('prft identifies track and wall-clock; per-event decode times are rebased without altering shared buffer', () => {
  const offsets = new Map<number, bigint>(), original = fragment(90000n);
  const copy = Buffer.from(original);
  const a = boxes(recordingFragment(original, offsets, 1700000000000));
  assert.equal(a[0].type, 'prft'); assert.equal(a[0].data.readUInt32BE(12), 1);
  assert.equal(a[0].data.readBigUInt64BE(16) >> 32n, 3908988800n);
  assert.equal(a[0].data.readBigUInt64BE(24), 0n);
  const b = boxes(recordingFragment(fragment(180000n), offsets, 1700000001000));
  assert.equal(b[0].data.readBigUInt64BE(24), 90000n);
  assert.deepEqual(original, copy);
  assert.throws(() => recordingFragment(fragment(80000n), offsets, 1700000000000));
});
test('recording copies HEVC as hvc1 and completely omits audio when disabled', () => {
  const args = recordingArguments('rtsp://127.0.0.1/test', false);
  assert.equal(args[args.indexOf('-c:v') + 1], 'copy');
  assert.equal(args[args.indexOf('-tag:v') + 1], 'hvc1');
  assert.ok(args.includes('-an')); assert.ok(!args.includes('-c:a'));
  assert.ok(recordingArguments('rtsp://127.0.0.1/test', true).includes('aac'));
});

test('native accessory accepts hub HDS selection and keeps optional cloud ingest disabled by default', async () => {
  const lab = new HevcAccessory({name:'HDS negotiation',identity:'hds-negotiation',username:'02:AB:CD:EF:12:48',
    pincode:'321-45-987',address:'127.0.0.1',port:36468,ffmpeg:'nonexistent',tiers:[tier],
    capabilitiesVersion:1,recording:true,nativeRecording:true},()=>{});
  try {
    const rm=lab.recording!.management;
    assert.ok(lab.accessory.services.some(s=>s.UUID===hapUuid('8021')),'native motion zones remain');
    for (const id of ['8000','8050','8080']) assert.ok(!lab.accessory.services.some(s=>s.UUID===hapUuid(id)),'direct upload must be opt-in');
    const selected=tlv(
      [1,tlv([1,uint(4000,4)],[2,Buffer.from([1,0,0,0,0,0,0,0])],[3,tlv([1,uint(0,1)],[2,tlv([1,uint(4000,4)])])])],
      [2,tlv([1,uint(0,1)],[2,tlv([1,uint(1,1)],[2,uint(2,1)],[3,uint(2000,4)],[4,uint(4000,4)])],
        [3,tlv([1,uint(1920,2)],[2,uint(1080,2)],[3,uint(30,1)])])],
      [3,tlv([1,uint(0,1)],[2,tlv([1,uint(1,1)],[2,uint(0,1)],[3,uint(3,1)],[4,uint(32,4)])])]
    ).toString('base64');
    const characteristic=rm.recordingManagementService.characteristics.find(c=>c.UUID===Characteristic.SelectedCameraRecordingConfiguration.UUID);
    assert.ok(characteristic,'hub selection must be published, including when CMAF is enabled');
    await characteristic.handleSetRequest(selected);
    assert.equal(rm.serialize()!.selectedConfiguration,selected);
    assert.equal(await characteristic.handleGetRequest(),selected);
    const args=recordingArguments(tier.rtspUrl,false);
    assert.equal(args[args.indexOf('-c:v')+1],'copy');
    assert.ok(!args.includes('-vf') && !args.includes('-s') && !args.includes('-r'));
  } finally {await lab.close();}
});
test('opt-in recording links HDS and motion while preserving HEVC live service and global privacy', async () => {
  const config: LabConfig = {name: 'Recording Test', identity: 'recording-test', username: '02:AB:CD:EF:12:36',
    pincode: '321-45-987', address: '127.0.0.1', port: 36462, ffmpeg: 'nonexistent', tiers: [tier], capabilitiesVersion: 1, recording: true};
  const lab = new HevcAccessory(config, () => {});
  try {
    const rm = lab.recording!.management;
    const live = lab.accessory.services.find(s => s.UUID === hapUuid('8031'))!;
    assert.ok(live.linkedServices.includes(rm.dataStreamManagement.getService()));
    assert.ok(rm.recordingManagementService.linkedServices.includes(lab.recording!.motion));
    assert.equal(lab.recording!.enabled, false);
    lab.recording!.setMotion(true);
    assert.equal(lab.recording!.motion.getCharacteristic(Characteristic.MotionDetected).value, false);
    let detectorEnabled = false;
    lab.recording!.onEnabled = enabled => {detectorEnabled = enabled;};
    lab.recording!.updateRecordingActive(true);
    assert.equal(detectorEnabled, true);
    assert.equal(lab.recording!.enabled, false, 'media still waits for hub configuration');
    lab.recording!.setMotion(true);
    assert.equal(lab.recording!.motion.getCharacteristic(Characteristic.MotionDetected).value, true);
    const contributing = lab.recording!.motion.characteristics.find(c => c.UUID === hapUuid('8086'))!;
    assert.equal(contributing.value, tlv([1, tlv([1, uuid.write(uuid.generate(`${config.identity}/sensor`))])]).toString('base64'));
    const motionEnabled = lab.recording!.motion.characteristics.find(c => c.UUID === hapUuid('8087'))!;
    await motionEnabled.handleSetRequest(false);
    assert.equal(detectorEnabled, false);
    assert.equal(contributing.value, '');
    lab.recording!.setMotion(true);
    assert.equal(lab.recording!.motion.getCharacteristic(Characteristic.MotionDetected).value, false);
    await motionEnabled.handleSetRequest(true);
    assert.equal(detectorEnabled, true);
    await lab.accessory.services.find(s => s.UUID === hapUuid('8032'))!.getCharacteristic(Characteristic.HomeKitCameraActive).handleSetRequest(false);
    assert.equal(!!rm.operatingModeService.getCharacteristic(Characteristic.HomeKitCameraActive).value, false);
    assert.equal(detectorEnabled, false);
    assert.equal(lab.recording!.motion.getCharacteristic(Characteristic.MotionDetected).value, false);
  } finally {await lab.close();}
});
