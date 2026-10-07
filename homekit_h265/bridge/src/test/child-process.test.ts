import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { signalChild } from '../childProcess';

test('failed spawn cannot be signaled before its asynchronous error event', async () => {
  const child = spawn('homekit-h265-nonexistent-test-executable', [], { stdio: 'ignore' });
  const closed = new Promise<void>(resolve => { child.on('error', () => {}); child.once('close', () => resolve()); });
  let calls = 0;
  child.kill = () => { calls++; return false; };
  assert.equal(child.pid, undefined);
  assert.equal(signalChild(child, 'SIGKILL'), false);
  assert.equal(calls, 0, 'failed spawn must never reach the native kill handle');
  await closed;
});

test('zero, negative and exited process identities never receive signals', () => {
  let calls = 0;
  const child = { pid: 123, exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null, kill: () => { calls++; return true; } };
  for (const pid of [0, -1, NaN]) assert.equal(signalChild({ ...child, pid }, 'SIGKILL'), false);
  assert.equal(signalChild({ ...child, exitCode: 0 }, 'SIGKILL'), false);
  assert.equal(signalChild({ ...child, signalCode: 'SIGTERM' }, 'SIGKILL'), false);
  assert.equal(signalChild(undefined, 'SIGKILL'), false);
  assert.equal(calls, 0);
});

test('live child permits graceful termination and later hard-stop escalation', () => {
  const signals: unknown[] = [];
  const child = { pid: 123, exitCode: null, signalCode: null,
    kill: (signal?: NodeJS.Signals | number) => { signals.push(signal); return true; } };
  assert.equal(signalChild(child, 'SIGTERM'), true);
  assert.equal(signalChild(child, 'SIGKILL'), true);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});
