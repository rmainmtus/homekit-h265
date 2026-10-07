'use strict';

// Home Assistant owns /data. No camera URL or child exception is printed here.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

class SetupError extends Error {}
const DEFAULTS = Object.freeze({
  name: 'HEVC Camera', address: '', stream_url: '', motion_url: '', port: 36460,
  recording: true, average_kbps: 4000, peak_kbps: 8000, relay_port: 18554,
});
const invalid = message => { throw new SetupError(message); };
const cancelled = signal => { if (signal?.aborted) invalid('Startup cancelled.'); };

function readJson(filename, message) {
  try {
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.size > 65536) invalid(message);
    return JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''));
  } catch { invalid(message); }
}

function rtspUrl(value, field, required) {
  if (!required && value === '') return '';
  if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x20\x7f]/.test(value)) {
    invalid(`Set ${field} to an RTSP camera URL. Percent-encode special characters in credentials.`);
  }
  try {
    const url = new URL(value);
    if (url.protocol !== 'rtsp:' || !url.hostname || url.hash || (url.port && Number(url.port) === 0)) throw new Error();
  } catch { invalid(`Set ${field} to an RTSP camera URL without a fragment.`); }
  return value;
}

function validateOptions(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('The app options must be a JSON object.');
  const options = { ...DEFAULTS, ...input };
  if (typeof options.name !== 'string' || !options.name.trim() || options.name.length > 64 || /[\x00-\x1f\x7f]/.test(options.name)) {
    invalid('Set name to 1–64 printable characters.');
  }
  options.name = options.name.trim();
  if (net.isIP(options.address) !== 4 || /^(?:0|127)\./.test(options.address) || Number(options.address.split('.')[0]) >= 224) {
    invalid('Set address to the Home Assistant host LAN IPv4 address, not a URL or loopback address.');
  }
  for (const field of ['port', 'relay_port']) {
    if (!Number.isInteger(options[field]) || options[field] < 1024 || options[field] > 65535) invalid(`${field} must be an integer from 1024 to 65535.`);
  }
  if (options.port === options.relay_port) invalid('port and relay_port must be different.');
  if (typeof options.recording !== 'boolean') invalid('recording must be true or false.');
  for (const field of ['average_kbps', 'peak_kbps']) {
    if (!Number.isInteger(options[field]) || options[field] < 64 || options[field] > 100000) invalid(`${field} must be an integer from 64 to 100000.`);
  }
  if (options.average_kbps > options.peak_kbps) invalid('average_kbps must not exceed peak_kbps.');
  options.stream_url = rtspUrl(options.stream_url, 'stream_url', true);
  options.motion_url = rtspUrl(options.motion_url, 'motion_url', options.recording);
  return options;
}

function validPin(pin) {
  if (typeof pin !== 'string' || !/^\d{3}-\d{2}-\d{3}$/.test(pin)) return false;
  const digits = pin.replaceAll('-', '');
  return !/^(\d)\1{7}$/.test(digits) && digits !== '12345678' && digits !== '87654321';
}

function validatePairing(state) {
  if (!state || state.version !== 1 || typeof state.identity !== 'string' ||
      !/^homekit-h265-[a-f0-9-]{36}$/.test(state.identity) ||
      typeof state.username !== 'string' || !/^(?:[0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(state.username) ||
      !validPin(state.pincode) || typeof state.recording !== 'boolean') {
    invalid('The saved pairing state is invalid. Restore the app backup; it will not be replaced automatically.');
  }
  return state;
}

function createPairing(recording) {
  const mac = crypto.randomBytes(6);
  mac[0] = (mac[0] | 2) & 0xfe; // Locally administered unicast identity.
  let pincode;
  do {
    const digits = String(crypto.randomInt(100000000)).padStart(8, '0');
    pincode = `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`;
  } while (!validPin(pincode));
  return { version: 1, identity: `homekit-h265-${crypto.randomUUID()}`,
    username: [...mac].map(byte => byte.toString(16).padStart(2, '0').toUpperCase()).join(':'), pincode, recording };
}

function savedPairing(dataDir, options) {
  const filename = path.join(dataDir, 'pairing.json');
  if (!fs.existsSync(filename)) {
    if (fs.existsSync(path.join(dataDir, '.hap')) || fs.existsSync(path.join(dataDir, 'config.local.json'))) {
      invalid('Existing HomeKit data has no pairing.json. Migration is required; no new identity will be generated.');
    }
    return undefined;
  }
  const state = validatePairing(readJson(filename, 'Cannot read saved pairing state. Restore the app backup; it will not be replaced automatically.'));
  if (state.recording !== options.recording) {
    invalid('recording is fixed after the first start to preserve HomeKit history. Restore its original value; use Apple Home recording and privacy controls instead.');
  }
  return state;
}

function atomicJson(filename, value, exclusive = false) {
  const temporary = `${filename}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    // link publishes the complete identity atomically without replacing a concurrent writer.
    if (exclusive) fs.linkSync(temporary, filename);
    else fs.renameSync(temporary, filename);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function parseProbe(stdout) {
  let streams;
  try { streams = JSON.parse(stdout).streams; } catch { invalid('Camera validation returned invalid metadata.'); }
  if (!Array.isArray(streams)) invalid('Camera validation returned no streams.');
  const video = streams.find(stream => stream.codec_type === 'video');
  const audio = streams.find(stream => stream.codec_type === 'audio');
  if (!video || video.codec_name !== 'hevc') invalid('The main stream must use H.265/HEVC. Set the camera codec to H.265; this app does not convert video.');
  if (!audio || typeof audio.codec_name !== 'string' || !/^[a-z0-9_]+$/.test(audio.codec_name)) {
    invalid('The main stream needs an audio track for HomeKit streaming. Enable camera audio and restart the app.');
  }
  for (const field of ['width', 'height']) {
    if (!Number.isInteger(video[field]) || video[field] < 1 || video[field] > 65535) invalid('The camera did not report valid video dimensions.');
  }
  function frameRate(value) {
    if (typeof value !== 'string' || !/^\d+(?:\/\d+)?$/.test(value)) return NaN;
    const [numerator, denominator = '1'] = value.split('/');
    return Number(numerator) / Number(denominator);
  }
  let measuredFps = frameRate(video.avg_frame_rate);
  if (!Number.isFinite(measuredFps) || measuredFps <= 0) measuredFps = frameRate(video.r_frame_rate);
  if (!Number.isFinite(measuredFps) || measuredFps < 0.5 || measuredFps > 255) invalid('The camera did not report a supported frame rate.');
  return { width: video.width, height: video.height, fps: Math.round(measuredFps), measuredFps, audio: audio.codec_name };
}

function probeCamera(url, { spawnImpl = spawn, signal, timeoutMs = 25000, maxBytes = 1048576, ffprobe = '/usr/bin/ffprobe' } = {}) {
  cancelled(signal);
  return new Promise((resolve, reject) => {
    let child, settled = false, bytes = 0, chunks = [];
    const timer = setTimeout(() => finish(new SetupError('Camera validation timed out. Check the RTSP URL, camera availability, and credentials.')), timeoutMs);
    const abort = () => finish(new SetupError('Startup cancelled.'));
    function finish(error, value) {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      // A failed spawn can retain a process handle before its asynchronous error,
      // but has no PID. Never pass that handle to ChildProcess.kill: PID 0 can
      // signal the launcher's entire process group on Unix.
      // ffprobe has no descendants; a hard stop bounds every timeout/cancellation.
      try { if (Number.isInteger(child?.pid) && child.pid > 0) child.kill('SIGKILL'); } catch {}
      if (error) reject(error); else resolve(value);
    }
    signal?.addEventListener('abort', abort, { once: true });
    try {
      child = spawnImpl(ffprobe, ['-v', 'error', '-rtsp_transport', 'tcp', '-timeout', '8000000',
        '-analyzeduration', '4000000', '-probesize', '4000000', '-show_entries',
        'stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate', '-of', 'json', '-i', url],
      { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, shell: false });
      child.once('error', () => finish(new SetupError('Camera validation could not start. Check the app installation.')));
      child.stdout.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > maxBytes) { chunks = []; finish(new SetupError('Camera validation returned too much data.')); }
        else if (!settled) chunks.push(chunk);
      });
      child.once('close', code => {
        if (settled) return;
        if (code !== 0) return finish(new SetupError('Camera validation failed. Check the RTSP URL, camera availability, and credentials.'));
        try { finish(undefined, parseProbe(Buffer.concat(chunks).toString('utf8'))); }
        catch (error) { finish(error instanceof SetupError ? error : new SetupError('Camera validation failed.')); }
      });
      if (signal?.aborted) abort();
    } catch { finish(new SetupError('Camera validation could not start. Check the app installation.')); }
  });
}

function bridgeConfig(options, state, media) {
  return { name: options.name, identity: state.identity, username: state.username, pincode: state.pincode,
    address: options.address, port: options.port, ffmpeg: '/usr/bin/ffmpeg', capabilitiesVersion: 1,
    recording: state.recording,
    ...(state.recording ? { nativeRecording: true, directUpload: false, motionRtspUrl: options.motion_url } : {}),
    tiers: [{ id: 1, quality: 2, width: media.width, height: media.height, fps: media.fps,
      averageKbps: options.average_kbps, peakKbps: options.peak_kbps,
      rtspUrl: `rtsp://127.0.0.1:${options.relay_port}/main` }] };
}

function relayConfig(options) {
  return { app: { modules: ['rtsp'] }, api: { listen: '' }, webrtc: { listen: '' },
    rtsp: { listen: `127.0.0.1:${options.relay_port}`, default_query: 'video&audio' },
    streams: { main: options.stream_url }, log: { level: 'error' } };
}

async function prepare({ dataDir = '/data', probe = probeCamera, validateBridge, signal } = {}) {
  const options = validateOptions(readJson(path.join(dataDir, 'options.json'), 'Cannot read app options. Save the Configuration tab and try again.'));
  const previous = savedPairing(dataDir, options);
  const media = await probe(options.stream_url, { signal });
  cancelled(signal);
  const state = previous || createPairing(options.recording);
  const config = bridgeConfig(options, state, media);
  if (validateBridge) {
    try { validateBridge(config); } catch { invalid('The generated bridge configuration is invalid. Check the app options.'); }
  }
  // Invalid options, corrupt state, failed media probes, and aborted starts never change persistent files.
  try {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    if (!previous) atomicJson(path.join(dataDir, 'pairing.json'), state, true);
    atomicJson(path.join(dataDir, 'go2rtc.json'), relayConfig(options));
    atomicJson(path.join(dataDir, 'config.local.json'), config);
  } catch { invalid('Cannot save app state. Existing pairing data has been preserved; check the app storage.'); }
  return { options, state, media, config, dataDir, fresh: !previous };
}

function safeLine(line) {
  return line.replace(/\b(?:rtsps?|https?):\/\/[^\s<>"']+/gi, '[redacted URL]')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

function pipeSafeLogs(stream, log) {
  let pending = '', dropping = false;
  stream?.setEncoding('utf8');
  stream?.on('data', chunk => {
    // Bound partial lines, including malicious camera names returned by a dependency.
    for (const part of chunk.split(/(?<=\n)/)) {
      if (!dropping) pending += part;
      if (pending.length > 4096) { pending = ''; dropping = true; }
      if (part.endsWith('\n')) {
        if (!dropping && pending.trim()) log(safeLine(pending.trim()));
        pending = ''; dropping = false;
      }
    }
  });
  stream?.on('end', () => { if (!dropping && pending.trim()) log(safeLine(pending.trim())); });
}

function waitForRelay(port, { signal, timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    let socket, retry, done = false;
    const timeout = setTimeout(() => finish(new SetupError('The local RTSP relay did not start. Check relay_port for a conflict.')), timeoutMs);
    const abort = () => finish(new SetupError('Startup cancelled.'));
    function finish(error) {
      if (done) return; done = true;
      clearTimeout(timeout); clearTimeout(retry); socket?.destroy(); signal?.removeEventListener('abort', abort);
      error ? reject(error) : resolve();
    }
    function attempt() {
      if (done) return;
      socket = net.connect({ host: '127.0.0.1', port });
      socket.setTimeout(500, () => socket.destroy(new Error('timeout')));
      socket.once('connect', () => finish());
      socket.once('error', () => { socket.destroy(); if (!done) retry = setTimeout(attempt, 100); });
    }
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort(); else attempt();
  });
}

function killTree(child, signal) {
  // Missing/zero/negative PIDs are failed spawns, never process-group targets.
  if (!Number.isInteger(child?.pid) || child.pid <= 0) return;
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch { /* Already stopped. */ }
}

function assertPortAvailable(address, port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', () => reject(new SetupError('A configured port is unavailable or address is not assigned to this host. Check address, port, and relay_port.')));
    server.listen({ host: address, port, exclusive: true }, () => server.close(resolve));
  });
}

async function supervise(prepared, {
  spawnImpl = spawn, waitReady = waitForRelay, signal, log = console.log, kill = killTree, checkPort = assertPortAvailable,
  graceMs = 5000, node = process.execPath, relay = '/usr/local/bin/go2rtc',
  standalone = '/opt/homekit-h265/bridge/dist/standalone.js',
} = {}) {
  const children = [];
  const startup = new AbortController();
  let stopping, stoppingStarted = false, exitCode = 0, finish;
  const finished = new Promise(resolve => { finish = resolve; });
  const stop = code => {
    if (stoppingStarted) return stopping;
    stoppingStarted = true; exitCode = code; startup.abort();
    stopping = (async () => {
      for (const entry of children) kill(entry.child, 'SIGTERM');
      let deadline;
      await Promise.race([Promise.all(children.map(entry => entry.closed)), new Promise(resolve => { deadline = setTimeout(resolve, graceMs); })]);
      clearTimeout(deadline);
      // Also reap descendants if a bridge crashes before it can stop its FFmpeg jobs.
      for (const entry of children) kill(entry.child, 'SIGKILL');
      finish(exitCode);
    })();
    return stopping;
  };
  const abort = () => { void stop(0); };
  signal?.addEventListener('abort', abort, { once: true });
  function start(label, executable, args, stdio) {
    if (signal?.aborted || stoppingStarted) throw new SetupError('Startup cancelled.');
    const child = spawnImpl(executable, args, { stdio, detached: process.platform !== 'win32', windowsHide: true, shell: false });
    let closed;
    const entry = { child, closed: new Promise(resolve => { closed = resolve; }) };
    children.push(entry);
    const failed = () => { closed(); if (!stoppingStarted) { log(`${label} stopped unexpectedly. Restarting the app is required.`); void stop(1); } };
    child.once('error', failed);
    child.once('close', failed);
    if (label === 'HomeKit bridge') {
      pipeSafeLogs(child.stdout, log); pipeSafeLogs(child.stderr, log);
    }
    return child;
  }
  try {
    if (signal?.aborted) abort();
    else {
      await checkPort('127.0.0.1', prepared.options.relay_port);
      await checkPort(prepared.options.address, prepared.options.port);
      start('RTSP relay', relay, ['-config', path.join(prepared.dataDir, 'go2rtc.json')], 'ignore');
      await waitReady(prepared.options.relay_port, { signal: startup.signal });
      if (!stoppingStarted) {
        start('HomeKit bridge', node, [standalone, path.join(prepared.dataDir, 'config.local.json')], ['ignore', 'pipe', 'pipe']);
        log(`Camera source validated: HEVC ${prepared.media.width}x${prepared.media.height}, ${prepared.media.measuredFps.toFixed(2)} fps, audio ${prepared.media.audio}.`);
        log(`HomeKit pairing code: ${prepared.state.pincode}`);
        log('HomeKit bridge starting. Keep this app and its backup to preserve pairing and recording history.');
      }
    }
  } catch (error) {
    if (!stoppingStarted) { log(error instanceof SetupError ? error.message : 'A camera service could not start. Check the app installation and configured ports.'); void stop(1); }
  }
  await finished;
  signal?.removeEventListener('abort', abort);
  return exitCode;
}

async function main() {
  process.umask(0o077);
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  try {
    const { validateConfig } = require('/opt/homekit-h265/bridge/dist/config.js');
    const prepared = await prepare({ validateBridge: validateConfig, signal: abort.signal });
    return await supervise(prepared, { signal: abort.signal });
  } catch (error) {
    if (abort.signal.aborted) return 0;
    console.error(error instanceof SetupError ? error.message : 'App startup failed. Check the saved options and app installation.');
    return 1;
  } finally {
    process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
  }
}

module.exports = { DEFAULTS, SetupError, validateOptions, validatePairing, validPin, createPairing, savedPairing,
  atomicJson, parseProbe, probeCamera, bridgeConfig, relayConfig, prepare, safeLine, pipeSafeLogs, waitForRelay, killTree, assertPortAvailable, supervise };
if (require.main === module) main().then(code => { process.exitCode = code; });
