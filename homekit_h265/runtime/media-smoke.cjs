'use strict';

// Run only inside the built Linux image:
// docker run --rm --init --network none --entrypoint node homekit-h265:test \
//   /opt/homekit-h265/runtime/media-smoke.cjs
// This uses synthetic pictures/audio, ephemeral loopback ports, and temporary state.
// It does not publish a HomeKit accessory or access a real camera or /data.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { DEFAULTS, parseProbe, prepare, probeCamera, waitForRelay } = require('./launcher.cjs');

const FFMPEG = '/usr/bin/ffmpeg';
const FFPROBE = '/usr/bin/ffprobe';
const GO2RTC = '/usr/local/bin/go2rtc';
const OVERALL_MS = 90000;
const OUTPUT_LIMIT = 1048576;

async function main() {
  assert.equal(process.platform, 'linux', 'Run this smoke test inside the Linux app image.');
  const { validateConfig } = require('../bridge/dist/config.js');
  const { captureSnapshot } = require('../bridge/dist/snapshot.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'homekit-h265-media-smoke-'));
  // go2rtc QuoteSplit has deliberately simple quoting. Use only the generated safe path.
  assert.match(dir, /^\/[A-Za-z0-9_./-]+$/);
  const controller = new AbortController();
  const tracked = [], reservations = [];
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, OVERALL_MS);
  const stop = () => controller.abort();
  process.once('SIGTERM', stop); process.once('SIGINT', stop);

  function killGroup(child, signal) {
    if (!child.pid) return;
    try { process.kill(-child.pid, signal); } catch { /* Already exited. */ }
  }

  function launch(label, executable, args) {
    controller.signal.throwIfAborted();
    const child = spawn(executable, args, { cwd: dir, detached: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const entry = { child, label, stdout: '', stderr: '', closed: undefined, done: false, code: undefined, error: undefined };
    tracked.push(entry);
    entry.closed = new Promise(resolve => {
      child.on('error', error => { entry.error = error; });
      child.once('close', code => { entry.code = code; entry.done = true; resolve(); });
    });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (entry.stdout.length + chunk.length > OUTPUT_LIMIT) {
        entry.error = new Error(`${label} exceeded its output limit.`);
        killGroup(child, 'SIGKILL');
      } else entry.stdout += chunk;
    });
    child.stderr.on('data', chunk => { entry.stderr = (entry.stderr + chunk).slice(-16384); });
    return entry;
  }

  async function run(label, executable, args, timeoutMs = 20000) {
    const entry = launch(label, executable, args);
    let expired = false;
    const kill = () => killGroup(entry.child, 'SIGKILL');
    const timer = setTimeout(() => { expired = true; kill(); }, timeoutMs);
    controller.signal.addEventListener('abort', kill, { once: true });
    try {
      if (controller.signal.aborted) kill();
      await entry.closed;
      if (controller.signal.aborted) throw new Error(timedOut ? 'Media smoke test exceeded its 90 second deadline.' : 'Media smoke test interrupted.');
      if (expired) throw new Error(`${label} timed out.`);
      if (entry.error || entry.code !== 0) throw new Error(`${label} failed. ${entry.stderr.slice(-4096)}`);
      return entry.stdout;
    } finally {
      clearTimeout(timer); controller.signal.removeEventListener('abort', kill);
    }
  }

  async function reservePort() {
    const server = net.createServer();
    reservations.push(server);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve);
    });
    return { port: server.address().port, release: () => new Promise(resolve => server.close(resolve)) };
  }

  function assertRunning(entry) {
    assert.equal(entry.done, false, `${entry.label} exited early. ${entry.stderr.slice(-4096)}`);
  }

  try {
    console.log('Media smoke: generating a small synthetic HEVC + AAC fixture.');
    const fixture = path.join(dir, 'fixture.mp4');
    await run('Fixture encoder', FFMPEG, [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=10',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=32000',
      '-map', '0:v:0', '-map', '1:a:0', '-t', '4',
      '-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-x265-params', 'log-level=error:pools=none:frame-threads=1:keyint=10:min-keyint=10:scenecut=0:bframes=0',
      '-threads', '1', '-tag:v', 'hvc1', '-c:a', 'aac', '-ac', '1', '-b:a', '64k',
      '-movflags', '+faststart', fixture,
    ], 25000);

    // Holding both reservations simultaneously ensures the selected ports differ.
    const sourcePort = await reservePort(), relayPort = await reservePort();
    assert.notEqual(sourcePort.port, relayPort.port);
    const sourceUrl = `rtsp://127.0.0.1:${sourcePort.port}/fixture`;
    const sourceFile = path.join(dir, 'source-relay.json');
    // Pinned v1.9.14 exec.go replaces {output} with a private RTSP publish URL,
    // waits for that ANNOUNCE, and closes the producer when its consumer closes:
    // https://github.com/AlexxIT/go2rtc/blob/v1.9.14/internal/exec/exec.go
    // Unlike the production relay, this fixture-only process enables exec.
    fs.writeFileSync(sourceFile, JSON.stringify({
      app: { modules: ['rtsp', 'exec'] }, api: { listen: '' }, webrtc: { listen: '' },
      rtsp: { listen: `127.0.0.1:${sourcePort.port}`, default_query: 'video&audio' },
      exec: { allow_paths: [FFMPEG] },
      streams: { fixture: `exec:${FFMPEG} -hide_banner -loglevel error -nostdin -re -stream_loop -1 -i ${fixture} -map 0:v:0 -map 0:a:0 -c copy -f rtsp -rtsp_transport tcp {output}#starttimeout=15#killtimeout=2` },
      log: { level: 'error' },
    }), { mode: 0o600 });
    await sourcePort.release();
    const source = launch('Synthetic source relay', GO2RTC, ['-config', sourceFile]);
    await waitForRelay(sourcePort.port, { signal: controller.signal, timeoutMs: 8000 });
    assertRunning(source);

    console.log('Media smoke: probing source and generating the real launcher configuration.');
    fs.writeFileSync(path.join(dir, 'options.json'), JSON.stringify({
      ...DEFAULTS, name: 'Synthetic smoke camera', address: '192.0.2.20',
      stream_url: sourceUrl, motion_url: sourceUrl, relay_port: relayPort.port,
    }), { mode: 0o600 });
    const prepared = await prepare({ dataDir: dir, validateBridge: validateConfig,
      signal: controller.signal,
      probe: (url, { signal }) => probeCamera(url, { signal, timeoutMs: 18000 }),
    });
    assert.equal(prepared.media.width, 160); assert.equal(prepared.media.height, 120);
    assert.equal(prepared.media.fps, 10); assert.equal(prepared.media.audio, 'aac');
    assert.equal(prepared.config.directUpload, false);
    assert.equal(prepared.config.nativeRecording, true);
    const productionFile = path.join(dir, 'go2rtc.json');
    assert.deepEqual(JSON.parse(fs.readFileSync(productionFile)).app.modules, ['rtsp']);

    await relayPort.release();
    const relay = launch('Production relay', GO2RTC, ['-config', productionFile]);
    await waitForRelay(relayPort.port, { signal: controller.signal, timeoutMs: 8000 });
    assertRunning(source); assertRunning(relay);
    const relayUrl = prepared.config.tiers[0].rtspUrl;
    const relayed = await probeCamera(relayUrl, { signal: controller.signal, timeoutMs: 18000 });
    assert.equal(relayed.width, 160); assert.equal(relayed.height, 120);
    assert.equal(relayed.fps, 10); assert.equal(relayed.audio, 'aac');

    console.log('Media smoke: copying native HEVC + audio through both relays.');
    const capture = path.join(dir, 'captured.mkv');
    await run('Passthrough capture', FFMPEG, [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-rtsp_transport', 'tcp', '-timeout', '8000000', '-i', relayUrl,
      '-map', '0:v:0', '-map', '0:a:0', '-c:v', 'copy', '-c:a', 'copy',
      '-t', '3', '-f', 'matroska', capture,
    ]);
    assertRunning(source); assertRunning(relay);
    const result = await run('Captured media probe', FFPROBE, [
      '-v', 'error', '-count_packets', '-show_entries',
      'stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,nb_read_packets', '-of', 'json', capture,
    ]);
    const captured = parseProbe(result);
    assert.equal(captured.width, 160); assert.equal(captured.height, 120); assert.equal(captured.audio, 'aac');
    const streams = JSON.parse(result).streams;
    for (const type of ['video', 'audio']) {
      const stream = streams.find(item => item.codec_type === type);
      assert.ok(Number(stream.nb_read_packets) >= 10, `Too few ${type} packets survived the relay.`);
    }
    // Decoding the small result catches corrupt packetization that metadata alone misses.
    await run('Captured media decode', FFMPEG, [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-xerror', '-threads', '1', '-i', capture,
      '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-',
    ]);
    console.log('Media smoke: checking preview pictures while the relay is already streaming.');
    const warm = launch('Warm preview consumer', FFMPEG, [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-progress', 'pipe:1',
      '-rtsp_transport', 'tcp', '-timeout', '8000000', '-i', relayUrl,
      '-map', '0:v:0', '-an', '-c:v', 'copy', '-f', 'null', '-',
    ]);
    const warmDeadline = Date.now() + 12000;
    while (!/frame=(?:[2-9]\d|\d{3,})\b/.test(warm.stdout)) {
      controller.signal.throwIfAborted(); assertRunning(warm);
      assert.ok(Date.now() < warmDeadline, 'Preview consumer did not receive enough frames.');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      controller.signal.throwIfAborted();
      const jpeg = await captureSnapshot(FFMPEG, relayUrl, 120, 160);
      const snapshot = path.join(dir, `preview-${attempt}.jpg`);
      fs.writeFileSync(snapshot, jpeg);
      const statistics = await run('Preview image decode', FFMPEG, [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-i', snapshot,
        '-vf', 'signalstats,metadata=print:file=-', '-frames:v', '1', '-f', 'null', '-',
      ]);
      const low = Number(statistics.match(/lavfi\.signalstats\.YLOW=(\d+)/)?.[1]);
      const high = Number(statistics.match(/lavfi\.signalstats\.YHIGH=(\d+)/)?.[1]);
      // The generated test pattern has broad contrast. A valid JPEG header
      // alone cannot catch the nearly uniform grey image from a missing keyframe.
      assert.ok(high - low >= 70, `Preview ${attempt} lost the test pattern (contrast ${high - low}).`);
      assertRunning(warm);
    }
    console.log('Media smoke passed: native HEVC/audio relay, decoded media, and three non-grey previews from an active stream.');
  } catch (error) {
    // These processes see only generated fixture paths and localhost URLs, never credentials.
    for (const entry of tracked) {
      if (entry.label.includes('relay') && entry.stderr.trim()) console.error(`${entry.label}: ${entry.stderr.slice(-4096).trim()}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout); controller.abort();
    process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
    for (const server of reservations) { try { server.close(); } catch {} }
    for (const entry of tracked) killGroup(entry.child, 'SIGTERM');
    let deadline;
    await Promise.race([
      Promise.all(tracked.map(entry => entry.closed)),
      new Promise(resolve => { deadline = setTimeout(resolve, 1000); }),
    ]);
    clearTimeout(deadline);
    // Includes the source relay's exec FFmpeg child; v1.9.14 also sets its Pdeathsig.
    for (const entry of tracked) killGroup(entry.child, 'SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(`Media smoke failed: ${error.message}`);
  process.exitCode = 1;
});
