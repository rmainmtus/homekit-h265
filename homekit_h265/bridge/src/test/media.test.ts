import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, unlink, rmdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Relay, startMedia} from '../media';

const idleRelay = (): Relay => ({port: 0, inputPort: 0, packets: 0, bytes: 0,
  sequenceGaps: 0, maxGapMs: 0, feedback: 0, receiveBuffer: 0, close() {}});
const pause = () => new Promise(resolve => setTimeout(resolve, 20));
const alive = (pid: number) => {try {process.kill(pid, 0); return true;} catch {return false;}};

test('aborting media startup promptly rejects and terminates the actual child process', {timeout: 10000}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hevc-media-cancel-'));
  const pidFile = path.join(directory, 'child.pid');
  const controller = new AbortController();
  let pid: number | undefined, exits = 0;
  const childScript = "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);";
  const starting = startMedia(process.execPath, ['-e', childScript, pidFile], idleRelay(), idleRelay(), () => {exits++;}, controller.signal);
  // Attach a rejection observer immediately, including if child startup itself fails.
  const outcome = starting.then(() => undefined, error => error as Error);
  try {
    const deadline = Date.now() + 4000;
    while (pid === undefined && Date.now() < deadline) {
      try {pid = Number(await readFile(pidFile, 'utf8'));} catch {await pause();}
    }
    assert.ok(pid, 'test child started');
    assert.equal(alive(pid), true);
    controller.abort();
    const error = await Promise.race([outcome, new Promise<undefined>(resolve => setTimeout(resolve, 1000))]);
    assert.match(error?.message ?? '', /cancelled/);
    const stoppedBy = Date.now() + 3500;
    while ((alive(pid) || exits === 0) && Date.now() < stoppedBy) await pause();
    assert.equal(alive(pid), false, 'cancelled child did not keep its upstream process alive');
    assert.equal(exits, 1);
  } finally {
    controller.abort();
    if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
    await unlink(pidFile).catch(() => undefined);
    await rmdir(directory);
  }
});

test('an already cancelled media request is rejected before launch', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(startMedia('does-not-exist', [], idleRelay(), idleRelay(), () => {}, controller.signal), /cancelled/);
});
