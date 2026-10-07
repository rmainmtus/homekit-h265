import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {HevcRecording} from '../recording';
import {installHdsSnapshots} from '../snapshot';
import {tier} from './fixtures';
test('HDS snapshot opens receive exactly one response, share capture, preserve recording routing and obey privacy', async () => {
  const recording=new HevcRecording('nonexistent',tier,()=>{});
  const management=recording.management.dataStreamManagement;
  const emitter=(management as unknown as {dataStreamServer:{internalEventEmitter:EventEmitter}}).dataStreamServer.internalEventEmitter;
  const responses: unknown[][]=[], events: unknown[][]=[];
  const connection=Object.assign(new EventEmitter(),{sendResponse:(...a:unknown[])=>responses.push(a),sendEvent:(...a:unknown[])=>events.push(a)});
  let active=true, captures=0;
  const jpeg=Buffer.from([255,216,255,217]);
  const installed=installHdsSnapshots(management,async()=>{captures++;return jpeg;},()=>active);
  try {
    emitter.emit('dataSend-r-open',connection,1,{type:'ipcamera.snapshot',target:'controller',streamId:10});
    emitter.emit('dataSend-r-open',connection,2,{type:'ipcamera.snapshot',target:'controller',streamId:11});
    await new Promise(r=>setImmediate(r));
    assert.equal(responses.length,2); assert.equal(captures,1); assert.equal(events.length,2);
    assert.equal(responses[0][3],0);
    assert.deepEqual((events[0][2] as {packets:{data:Buffer}[]}).packets[0].data,jpeg);
    active=false; installed.closeAll();
    emitter.emit('dataSend-r-open',connection,3,{type:'ipcamera.snapshot',target:'controller',streamId:12});
    assert.equal(responses.length,3); assert.notEqual(responses[2][3],0);
    emitter.emit('dataSend-r-open',connection,4,{type:'ipcamera.recording',target:'controller',streamId:13});
    assert.equal(responses.length,4); assert.notEqual(responses[3][3],0);
  } finally {installed.destroy();recording.close();}
});
