import test from 'node:test';
import assert from 'node:assert/strict';
import { SnapshotController } from '../snapshot';
test('snapshot adapter adds no legacy services and rejects invalid dimensions', async () => {
  const c = new SnapshotController(async () => Buffer.from('image'), () => true);
  assert.deepEqual(c.constructServices(), {});
  await assert.rejects(c.handleSnapshotRequest(100, 0));
  await assert.rejects(c.handleSnapshotRequest(100, 99999));
});
test('snapshot checks privacy before and after capture and bounds concurrent decoders', async () => {
  let enabled = true, finish!: (b: Buffer) => void;
  const c = new SnapshotController(() => new Promise(resolve => {finish = resolve;}), () => enabled);
  const request = c.handleSnapshotRequest(480, 640);
  await assert.rejects(c.handleSnapshotRequest(480, 640));
  enabled = false; finish(Buffer.from('image'));
  await assert.rejects(request);
  await assert.rejects(c.handleSnapshotRequest(480, 640));
});
