'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { EventEmitter, once } = require('node:events');
const { PassThrough } = require('node:stream');
const {
  DEFAULTS, SetupError, validateOptions, validPin, createPairing, atomicJson, parseProbe,
  probeCamera, bridgeConfig, relayConfig, prepare, pipeSafeLogs, waitForRelay, assertPortAvailable, supervise,
} = require('./launcher.cjs');

const options = () => ({ ...DEFAULTS, address: '192.0.2.20',
  stream_url: 'rtsp://camera-user:super-secret@192.0.2.10/main',
  motion_url: 'rtsp://camera-user:super-secret@192.0.2.10/sub' });
const metadata = () => ({ streams: [
  { codec_type: 'video', codec_name: 'hevc', width: 2304, height: 2592, avg_frame_rate: '12/1', r_frame_rate: '12/1' },
  { codec_type: 'audio', codec_name: 'aac' },
] });
const media = () => parseProbe(JSON.stringify(metadata()));
const fakeProbe = async () => media();
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

function workspace(t, selected = options()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'homekit-h265-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'options.json'), JSON.stringify(selected));
  return dir;
}

function diskSnapshot(dir) {
  return fs.readdirSync(dir).sort().map(name => {
    const file = path.join(dir, name);
    return [name, fs.statSync(file).isDirectory() ? diskSnapshot(file) : fs.readFileSync(file).toString('base64')];
  });
}

function mockChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.signals = [];
  child.kill = signal => { child.signals.push(signal); return true; };
  return child;
}

test('options validate mandatory RTSP, audio-independent settings, and recording motion source', () => {
  assert.equal(validateOptions(options()).port, 36460);
  for (const override of [
    { address: '' }, { address: '127.0.0.1' }, { address: '0.0.0.0' }, { address: '224.0.0.1' },
    { address: 'https://homeassistant.local' }, { stream_url: 'ffmpeg:rtsp://camera' },
    { stream_url: 'rtsp://camera/main#exec=bad' }, { stream_url: 'rtsp://camera/main\nsecret' },
    { motion_url: '' }, { recording: 'true' }, { port: 80 }, { port: 18554 },
    { average_kbps: 63 }, { average_kbps: 9000 }, { peak_kbps: 100001 },
  ]) assert.throws(() => validateOptions({ ...options(), ...override }), SetupError);
  assert.equal(validateOptions({ ...options(), recording: false, motion_url: '' }).recording, false);
});

test('fresh installs get independent cryptographic identities and safe PINs', () => {
  const one = createPairing(true), two = createPairing(true);
  assert.notEqual(one.identity, two.identity); assert.notEqual(one.username, two.username);
  assert.ok(validPin(one.pincode)); assert.equal(parseInt(one.username.slice(0, 2), 16) & 3, 2);
  for (const code of ['000-00-000', '111-11-111', '222-22-222', '123-45-678', '876-54-321']) assert.equal(validPin(code), false);
});

test('first startup persists identity; restart and camera name changes preserve it byte for byte', async t => {
  const dir = workspace(t);
  const first = await prepare({ dataDir: dir, probe: fakeProbe });
  const saved = fs.readFileSync(path.join(dir, 'pairing.json'));
  assert.equal(first.fresh, true);
  fs.writeFileSync(path.join(dir, 'options.json'), JSON.stringify({ ...options(), name: 'Front gate' }));
  const second = await prepare({ dataDir: dir, probe: fakeProbe });
  assert.equal(second.fresh, false); assert.deepEqual(second.state, first.state);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'pairing.json')), saved);
  assert.equal(second.config.name, 'Front gate');
  assert.equal(second.config.tiers[0].id, 1);
  assert.equal(second.config.tiers[0].quality, 2);
  assert.equal(second.config.directUpload, false);
  assert.equal(second.config.nativeRecording, true);
  assert.equal(second.config.tiers[0].rtspUrl, 'rtsp://127.0.0.1:18554/main');
  assert.equal(second.config.motionRtspUrl, options().motion_url);
  if (process.platform !== 'win32') {
    for (const file of ['pairing.json', 'go2rtc.json', 'config.local.json']) assert.equal(fs.statSync(path.join(dir, file)).mode & 0o777, 0o600);
  }
});

test('invalid options never touch an existing installation', async t => {
  const dir = workspace(t);
  await prepare({ dataDir: dir, probe: fakeProbe });
  fs.writeFileSync(path.join(dir, 'options.json'), JSON.stringify({ ...options(), address: '' }));
  const before = diskSnapshot(dir);
  await assert.rejects(prepare({ dataDir: dir, probe: () => { throw new Error('must not probe'); } }), /LAN IPv4/);
  assert.deepEqual(diskSnapshot(dir), before);
});

test('failed camera validation cannot create a pairing or alter a previous pairing', async t => {
  const dir = workspace(t);
  const fail = async () => { throw new SetupError('Camera validation failed.'); };
  const before = diskSnapshot(dir);
  await assert.rejects(prepare({ dataDir: dir, probe: fail }), /Camera validation failed/);
  assert.deepEqual(diskSnapshot(dir), before);
  await prepare({ dataDir: dir, probe: fakeProbe });
  const after = diskSnapshot(dir);
  await assert.rejects(prepare({ dataDir: dir, probe: fail }));
  assert.deepEqual(diskSnapshot(dir), after);
});

test('invalid generated bridge configuration does not persist identity', async t => {
  const dir = workspace(t), before = diskSnapshot(dir);
  await assert.rejects(prepare({ dataDir: dir, probe: fakeProbe, validateBridge: () => { throw new Error('private-config'); } }), /generated bridge configuration/);
  assert.deepEqual(diskSnapshot(dir), before);
});

test('recording service graph cannot be changed once identity is stored', async t => {
  const dir = workspace(t);
  await prepare({ dataDir: dir, probe: fakeProbe });
  fs.writeFileSync(path.join(dir, 'options.json'), JSON.stringify({ ...options(), recording: false }));
  const before = diskSnapshot(dir);
  await assert.rejects(prepare({ dataDir: dir, probe: fakeProbe }), /fixed after the first start/);
  assert.deepEqual(diskSnapshot(dir), before);
});

test('orphan HomeKit data and corrupt pairing state stop startup instead of silently replacing identity', async t => {
  for (const existing of ['.hap', 'config.local.json', 'pairing.json']) {
    const dir = workspace(t);
    if (existing === '.hap') fs.mkdirSync(path.join(dir, existing));
    else fs.writeFileSync(path.join(dir, existing), '{broken-json-secret');
    const before = diskSnapshot(dir);
    await assert.rejects(prepare({ dataDir: dir, probe: fakeProbe }), /Migration is required|saved pairing state/);
    assert.deepEqual(diskSnapshot(dir), before);
  }
});

test('identity atomic create refuses overwrite and cleans its temporary file', t => {
  const dir = workspace(t), filename = path.join(dir, 'pairing.json');
  const state = createPairing(true);
  atomicJson(filename, state, true);
  assert.throws(() => atomicJson(filename, createPairing(true), true));
  assert.deepEqual(JSON.parse(fs.readFileSync(filename)), state);
  assert.equal(fs.readdirSync(dir).filter(name => name.endsWith('.tmp')).length, 0);
});

test('probe uses actual HEVC dimensions, audio, and bounded integer advertisement of fractional frame rates', () => {
  assert.deepEqual(media(), { width: 2304, height: 2592, fps: 12, measuredFps: 12, audio: 'aac' });
  const fraction = metadata(); fraction.streams[0].avg_frame_rate = '30000/1001';
  assert.equal(parseProbe(JSON.stringify(fraction)).fps, 30);
  fraction.streams[0].avg_frame_rate = '0/0';
  assert.equal(parseProbe(JSON.stringify(fraction)).fps, 12);
  for (const mutate of [
    data => { data.streams[0].codec_name = 'h264'; },
    data => { data.streams.pop(); },
    data => { data.streams[0].width = 0; },
    data => { data.streams[0].avg_frame_rate = '0/0'; data.streams[0].r_frame_rate = '0/0'; },
  ]) { const data = metadata(); mutate(data); assert.throws(() => parseProbe(JSON.stringify(data)), SetupError); }
});

test('ffprobe is shell-free, TCP-only, and discards all stderr, including camera credentials', async () => {
  let invocation;
  const result = await probeCamera(options().stream_url, { spawnImpl: (command, args, spawnOptions) => {
    invocation = { command, args, spawnOptions };
    const child = mockChild();
    queueMicrotask(() => { child.stdout.write(JSON.stringify(metadata())); child.emit('close', 0); });
    return child;
  } });
  assert.equal(result.width, 2304);
  assert.equal(invocation.command, '/usr/bin/ffprobe');
  assert.equal(invocation.spawnOptions.shell, false);
  assert.deepEqual(invocation.spawnOptions.stdio, ['ignore', 'pipe', 'ignore']);
  assert.equal(invocation.args[invocation.args.indexOf('-rtsp_transport') + 1], 'tcp');
  assert.equal(invocation.args.at(-1), options().stream_url);
});

test('ffprobe failures are redacted and oversized responses are killed', async () => {
  for (const failure of ['spawn', 'exit', 'size']) {
    let child;
    await assert.rejects(probeCamera(options().stream_url, { maxBytes: 50, spawnImpl: () => {
      child = mockChild();
      queueMicrotask(() => {
        if (failure === 'spawn') child.emit('error', new Error(options().stream_url));
        else if (failure === 'exit') child.emit('close', 1);
        else child.stdout.write('x'.repeat(51));
      });
      return child;
    } }), error => {
      assert.ok(error instanceof SetupError); assert.doesNotMatch(error.message, /super-secret|camera-user|rtsp:/); return true;
    });
    assert.ok(child.signals.includes('SIGKILL'));
  }
});

test('ffprobe timeout and cancellation kill the actual child process', async t => {
  for (const action of ['timeout', 'abort']) {
    const controller = new AbortController();
    let child;
    const promise = probeCamera(options().stream_url, {
      timeoutMs: action === 'timeout' ? 75 : 10000, signal: controller.signal,
      spawnImpl: (_command, _args, spawnOptions) => {
        child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], spawnOptions);
        t.after(() => { try { child.kill('SIGKILL'); } catch {} });
        return child;
      },
    });
    const closed = once(child, 'close');
    if (action === 'abort') controller.abort();
    await assert.rejects(promise, action === 'timeout' ? /timed out/ : /cancelled/);
    await closed;
    assert.ok(child.signalCode !== null || child.exitCode !== null);
  }
});

test('cancelled validation cannot persist fresh identity', async t => {
  const dir = workspace(t), controller = new AbortController(), before = diskSnapshot(dir);
  await assert.rejects(prepare({ dataDir: dir, signal: controller.signal,
    probe: async () => { controller.abort(); return media(); } }), /cancelled/);
  assert.deepEqual(diskSnapshot(dir), before);
});

test('relay only exposes local RTSP and permits no command or transcoding source modules', () => {
  const config = relayConfig(options());
  assert.deepEqual(config.app.modules, ['rtsp']);
  assert.equal(config.api.listen, ''); assert.equal(config.webrtc.listen, '');
  assert.equal(config.rtsp.listen, '127.0.0.1:18554');
  assert.equal(config.streams.main, options().stream_url);
  assert.equal(config.ffmpeg, undefined);
  assert.equal(config.preload, undefined);
});

test('live-only config leaves native/direct upload controls absent, preserving backend validation contract', () => {
  const config = bridgeConfig({ ...options(), recording: false, motion_url: '' }, createPairing(false), media());
  assert.equal(config.recording, false); assert.equal(config.nativeRecording, undefined);
  assert.equal(config.directUpload, undefined); assert.equal(config.motionRtspUrl, undefined);
});

test('child logs redact RTSP URLs even across chunks and drop huge lines', () => {
  const stream = new PassThrough(), lines = [];
  pipeSafeLogs(stream, line => lines.push(line));
  stream.write('failure rtsp://camera-user:super-');
  stream.write('secret@192.0.2.10/main\nCamera health {"motion":true}\n');
  stream.write('x'.repeat(8192)); stream.write('\nnext line\n');
  assert.deepEqual(lines, ['failure [redacted URL]', 'Camera health {"motion":true}', 'next line']);
});

function preparedStub() {
  return { options: options(), state: createPairing(true), media: media(), dataDir: '/data' };
}

function supervisorHarness(overrides = {}) {
  const children = [], logs = [], calls = [], controller = new AbortController();
  const promise = supervise(preparedStub(), {
    signal: controller.signal, log: message => logs.push(message), checkPort: async () => {}, waitReady: async () => {},
    graceMs: 20,
    spawnImpl: (executable, args, spawnOptions) => {
      const child = mockChild(); children.push(child); calls.push({ executable, args, spawnOptions }); return child;
    },
    kill: (child, signal) => { child.kill(signal); if (signal === 'SIGTERM') queueMicrotask(() => child.emit('close', 0)); },
    ...overrides,
  });
  return { children, logs, calls, controller, promise };
}

test('a failed relay terminates its sibling bridge and exits nonzero for the enabled Supervisor Watchdog', async () => {
  const h = supervisorHarness(); await nextTurn();
  assert.equal(h.children.length, 2);
  assert.equal(h.calls[0].spawnOptions.stdio, 'ignore');
  assert.equal(h.calls[0].spawnOptions.shell, false);
  h.children[0].emit('close', 1);
  assert.equal(await h.promise, 1);
  assert.ok(h.children[1].signals.includes('SIGTERM'));
  assert.ok(h.children[1].signals.includes('SIGKILL'));
  assert.ok(h.logs.some(line => line.startsWith('RTSP relay stopped unexpectedly')));
});

test('bridge crash terminates relay and never prints child exception text', async () => {
  const h = supervisorHarness(); await nextTurn();
  h.children[1].emit('error', new Error(options().stream_url));
  assert.equal(await h.promise, 1);
  assert.ok(h.children[0].signals.includes('SIGTERM'));
  assert.doesNotMatch(h.logs.join('\n'), /super-secret|camera-user/);
});

test('a requested stop terminates both services and exits normally', async () => {
  const h = supervisorHarness(); await nextTurn();
  h.controller.abort();
  assert.equal(await h.promise, 0);
  assert.equal(h.children.length, 2);
  for (const child of h.children) assert.ok(child.signals.includes('SIGTERM'));
  assert.doesNotMatch(h.logs.join('\n'), /stopped unexpectedly/);
});

test('signal while relay is starting never launches the bridge', async () => {
  const h = supervisorHarness({ waitReady: (_port, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new SetupError('Startup cancelled.')), { once: true });
  }) });
  await nextTurn(); h.controller.abort();
  assert.equal(await h.promise, 0); assert.equal(h.children.length, 1);
});

test('children ignoring graceful termination are killed after bounded grace period', async () => {
  const h = supervisorHarness({ kill: (child, signal) => child.kill(signal), graceMs: 15 });
  await nextTurn(); h.controller.abort();
  assert.equal(await h.promise, 0);
  for (const child of h.children) assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
});

test('unavailable port blocks all process startup without leaking raw error text', async () => {
  const h = supervisorHarness({ checkPort: async () => { throw new Error('private config'); } });
  assert.equal(await h.promise, 1); assert.equal(h.children.length, 0);
  assert.doesNotMatch(h.logs.join('\n'), /private config/);
});

test('relay readiness checks actual listener and detects port conflicts', async t => {
  const server = net.createServer(socket => socket.destroy());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = server.address().port;
  await waitForRelay(port, { timeoutMs: 1000 });
  await assert.rejects(assertPortAvailable('127.0.0.1', port), /configured port is unavailable/);
  await new Promise(resolve => server.close(resolve));
  await assertPortAvailable('127.0.0.1', port);
  await assert.rejects(waitForRelay(port, { timeoutMs: 30 }), /did not start/);
});
