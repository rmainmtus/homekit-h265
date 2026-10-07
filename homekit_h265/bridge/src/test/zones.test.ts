import test from 'node:test';
import assert from 'node:assert/strict';
import {motionMask} from '../zones';
import type {CameraZonesValue} from '../SecureVideoTypes';
test('motion zones select sensor-space polygons and inverted exteriors without affecting video',()=>{
  const zones:CameraZonesValue={version:2,zones:[{method:1,polygons:[{identifier:'test',vertices:[{x:0,y:0},{x:50,y:0},{x:50,y:100},{x:0,y:100}]}]}]};
  const normal=motionMask(zones,true,100,100)!;
  assert.equal(normal.reduce((a,b)=>a+b,0),14400);
  assert.equal(normal[0],1);assert.equal(normal[159],0);
  zones.zones[0].method=2;
  const inverted=motionMask(zones,true,100,100)!;
  assert.equal(inverted[0],0);assert.equal(inverted[159],1);
  assert.equal(motionMask(zones,false,100,100),undefined);
  zones.zones[0].polygons[0].vertices[0].x=-1;
  assert.throws(()=>motionMask(zones,true,100,100));
});
