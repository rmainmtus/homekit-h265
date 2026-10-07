import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {Characteristic} from 'hap-nodejs';
import {HevcAccessory, LabConfig} from '../accessory';
import {tier} from './fixtures';
import {hapUuid, tlv, uint} from '../protocol';
import {deriveClipKey, sealSegment, buildMediaPlaylist} from '../CMAFIngest';
import {createClientCSR, generateClientKey} from '../SecureVideoCredentials';
import {decodeBufferEventCommandResponse} from '../SecureVideoTypes';
const config: LabConfig = {name:'CMAF Test',identity:'cmaf-test',username:'02:AB:CD:EF:12:39',pincode:'321-45-987',
  address:'127.0.0.1',port:36463,ffmpeg:'nonexistent',tiers:[tier],capabilitiesVersion:1,recording:true,nativeRecording:true,directUpload:true};
test('encrypted recording segments authenticate and recover exact native bytes', () => {
  const key = deriveClipKey(7n, Buffer.alloc(32, 42)), source = crypto.randomBytes(8192);
  const encrypted = sealSegment(key, source);
  const decrypt = (data: Buffer) => {
    const c = crypto.createDecipheriv('aes-256-gcm',key.contentKey,data.subarray(0,16));
    c.setAuthTag(data.subarray(-16)); return Buffer.concat([c.update(data.subarray(16,-16)),c.final()]);
  };
  assert.deepEqual(decrypt(encrypted),source);
  encrypted[25] ^= 1; assert.throws(()=>decrypt(encrypted));
  assert.match(buildMediaPlaylist(key,[1.5,2.25],true),/#EXT-X-TARGETDURATION:3/);
});
test('certificate nonce proof verifies against the CSR key', () => {
  const key=generateClientKey(), nonce=crypto.randomBytes(32), value=createClientCSR(key,'HEVC Lab',nonce);
  assert.equal(value.csr[0],0x30);
  assert.ok(crypto.verify('sha256',nonce,{key:crypto.createPublicKey(key),dsaEncoding:'ieee-p1363'},value.nonceSignature));
  assert.equal(crypto.verify('sha256',Buffer.alloc(32),{key:crypto.createPublicKey(key),dsaEncoding:'ieee-p1363'},value.nonceSignature),false);
});
test('native upload services bound event queues, acknowledge events, retain keys and reject disabled uploads', async () => {
  const lab=new HevcAccessory(config,()=>{}), native=lab.nativeRecording!;
  try {
    const service=lab.recording!.management.recordingManagementService;
    assert.equal(service.characteristics.some(c=>c.UUID===Characteristic.SupportedVideoRecordingConfiguration.UUID),true);
    assert.equal(service.characteristics.some(c=>c.UUID===Characteristic.SelectedCameraRecordingConfiguration.UUID),true);
    assert.equal(service.characteristics.some(c=>c.UUID===Characteristic.Active.UUID),true);
    const key = native.keys.characteristics.find(c => c.UUID === hapUuid('8051'))!;
    await key.handleSetRequest(tlv([1,Buffer.alloc(32,4)],[2,Buffer.from('0900000000000000','hex')]).toString('base64'));
    assert.equal(native.serialize().current,'9');
    const state=native.serialize(); native.restore(state); assert.deepEqual(native.serialize(),state);
    const motion=lab.recording!.motion.getCharacteristic(Characteristic.MotionDetected);
    for(let i=0;i<150;i++) motion.updateValue(!!(i%2));
    const query=native.buffer.characteristics.find(c => c.UUID === hapUuid('8014'))!;
    const result=await query.handleSetRequest(tlv([1,uint(1,1)]).toString('base64'));
    const events=decodeBufferEventCommandResponse(Buffer.from(result as string,'base64'));
    assert.equal(events.length,128);
    await query.handleSetRequest(tlv([1,uint(2,1)]).toString('base64'));
    const empty=await query.handleSetRequest(tlv([1,uint(1,1)]).toString('base64'));
    assert.equal(decodeBufferEventCommandResponse(Buffer.from(empty as string,'base64')).length,0);
    await assert.rejects(native.buffer.characteristics.find(c => c.UUID === hapUuid('8013'))!.handleSetRequest(tlv([1,Buffer.from('0100000000000000','hex')],[2,uint(1,1)]).toString('base64')));
    assert.equal(lab.recording!.enabled,false);
    const states: boolean[]=[];
    const onState=lab.recording!.onRecordingState;
    lab.recording!.onRecordingState=enabled=>{states.push(enabled);onState?.(enabled);};
    lab.recording!.updateRecordingActive(true);
    assert.equal(lab.recording!.enabled,true,'native buffering does not wait for legacy configuration');
    lab.recording!.setPrivacy(false);
    assert.equal(lab.recording!.enabled,false);
    assert.deepEqual(states,[true,false]);
    await assert.rejects(native.buffer.getCharacteristic('Buffer Upload Command')!.handleSetRequest(tlv([1,Buffer.from('0200000000000000','hex')],[2,uint(1,1)]).toString('base64')));
  } finally {await lab.close();}
});
