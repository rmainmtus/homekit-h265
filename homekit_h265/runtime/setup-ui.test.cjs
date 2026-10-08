'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const vm = require('node:vm');
const { startSetupServer } = require('./setup-ui.cjs');

const cameraStatus = () => ({ name: 'Front camera', pincode: '123-45-678',
  setupUri: 'X-HM://0023ISYWYABCD', paired: false, ready: true, error: null });

async function fixture(t, options = {}) {
  let status = cameraStatus();
  let resets = 0;
  const app = await startSetupServer({ port: 0, host: '127.0.0.1', allowedAddress: '127.0.0.1',
    getStatus: () => status, resetPairing: async () => { resets++; }, ...options });
  t.after(() => app.close());
  return { app, setStatus: next => { status = next; }, resets: () => resets,
    request: (path, init) => request(app.port, path, init) };
}

function request(port, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, headers: res.headers, text,
          json: () => JSON.parse(text) });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function resetHeaders(f) {
  return { 'Content-Type': 'application/json',
    'X-CSRF-Token': (await f.request('/api/status')).json().csrfToken };
}

test('ingress refuses untrusted socket peers even with spoofed forwarding headers', async t => {
  const f = await fixture(t, { allowedAddress: '172.30.32.2' });
  for (const path of ['/', '/api/status', '/qr.svg', '/api/reset']) {
    const response = await f.request(path, { headers: { 'X-Forwarded-For': '172.30.32.2',
      'X-Real-IP': '172.30.32.2', Forwarded: 'for=172.30.32.2' } });
    assert.equal(response.status, 403);
    assert.doesNotMatch(response.text, /123-45-678|X-HM:|csrfToken/);
  }
  assert.equal(f.resets(), 0);
});

test('accepts the IPv4-mapped form of the configured trusted address', async t => {
  const f = await fixture(t, { allowedAddress: '::ffff:127.0.0.1' });
  assert.equal((await f.request('/api/status')).status, 200);
});

test('page uses relative ingress routes, no remote assets, and nonce-based CSP', async t => {
  const f = await fixture(t);
  const response = await f.request('/');
  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /^text\/html/);
  assert.match(response.headers['cache-control'], /no-store/);
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  const nonce = /script-src 'nonce-([^']+)'/.exec(response.headers['content-security-policy'])[1];
  assert.ok(response.text.includes('<script nonce="' + nonce + '">'));
  assert.ok(response.text.includes('<style nonce="' + nonce + '">'));
  assert.doesNotThrow(() => new vm.Script(/<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(response.text)[1]));
  assert.doesNotMatch(response.text, /(?:src|href)=["'](?:https?:|\/)/);
  assert.match(response.text, /fetch\('api\/status'/);
  assert.match(response.text, /fetch\('api\/reset'/);
  assert.match(response.text, /src = 'qr\.svg\?v='/);
  assert.match(response.text, /HomeKit Device/);
  assert.match(response.text, /home Wi-Fi/);
  assert.match(response.text, /recording history may become unavailable/);
  assert.doesNotMatch(response.text, /123-45-678|X-HM:\/\//);
});

test('status returns only allowed setup fields and never forwards stream credentials or raw errors', async t => {
  const f = await fixture(t, { getStatus: () => ({ ...cameraStatus(),
    stream_url: 'rtsp://secret-user:secret-password@192.0.2.10/main',
    identity: { privateKey: 'private-key-secret' },
    error: 'Unable to connect rtsp://secret-user:secret-password@192.0.2.10/main' }) });
  const response = await f.request('/api/status');
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(response.json()).sort(), ['csrfToken', 'error', 'name', 'paired', 'pincode', 'ready', 'setupUri']);
  assert.doesNotMatch(response.text, /secret-user|secret-password|private-key-secret|rtsp:/);
  assert.match(response.json().csrfToken, /^[a-f0-9]{64}$/);
  assert.equal(response.json().pincode, '123-45-678');
  assert.equal(response.json().setupUri, cameraStatus().setupUri);
});

test('QR endpoint generates an SVG from the actual HomeKit setup URI', async t => {
  const f = await fixture(t);
  const response = await f.request('/qr.svg?v=1');
  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /^image\/svg\+xml/);
  assert.match(response.text, /^<svg/);
  assert.match(response.text, /<path/);
  f.setStatus({ ...cameraStatus(), setupUri: 'X-HM://0023ISYWYWXYZ' });
  assert.notEqual((await f.request('/qr.svg')).text, response.text);
});

test('QR stays unavailable while waiting, paired, failed, or without a valid HomeKit URI', async t => {
  const f = await fixture(t);
  for (const change of [{ ready: false }, { paired: true }, { paired: null }, { error: 'failed' },
    { setupUri: null }, { setupUri: 'https://example.com/private' }]) {
    f.setStatus({ ...cameraStatus(), ...change });
    assert.equal((await f.request('/qr.svg')).status, 409);
  }
});

test('GET never resets pairing, and POST requires JSON, CSRF, and exact boolean confirmation', async t => {
  const f = await fixture(t);
  f.setStatus({ ...cameraStatus(), paired: true });
  const headers = await resetHeaders(f);
  assert.equal((await f.request('/api/reset')).status, 405);
  assert.equal((await f.request('/api/reset', { method: 'POST', body: '{"confirm":true}' })).status, 415);
  assert.equal((await f.request('/api/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"confirm":true}' })).status, 403);
  assert.equal((await f.request('/api/reset', { method: 'POST', headers: { ...headers, 'X-CSRF-Token': '0'.repeat(64) }, body: '{"confirm":true}' })).status, 403);
  for (const confirm of [false, 'true', 1, null]) {
    assert.equal((await f.request('/api/reset', { method: 'POST', headers, body: JSON.stringify({ confirm }) })).status, 400);
  }
  assert.equal(f.resets(), 0);
  assert.equal((await f.request('/api/reset', { method: 'POST', headers, body: '{"confirm":true}' })).status, 202);
  assert.equal(f.resets(), 1);
});

test('reset is refused unless the current camera is ready and paired', async t => {
  const f = await fixture(t);
  const headers = await resetHeaders(f);
  for (const change of [{ paired: false }, { paired: null }, { paired: true, ready: false }, { paired: true, error: 'bad' }]) {
    f.setStatus({ ...cameraStatus(), ...change });
    assert.equal((await f.request('/api/reset', { method: 'POST', headers, body: '{"confirm":true}' })).status, 409);
  }
  assert.equal(f.resets(), 0);
});

test('CSRF tokens are unique to each running server', async t => {
  const first = await fixture(t);
  const second = await fixture(t);
  second.setStatus({ ...cameraStatus(), paired: true });
  const headers = await resetHeaders(first);
  assert.equal((await second.request('/api/reset', { method: 'POST', headers, body: '{"confirm":true}' })).status, 403);
  assert.equal(second.resets(), 0);
});

test('reset rejects oversized and malformed bodies without calling the reset handler', async t => {
  const f = await fixture(t);
  f.setStatus({ ...cameraStatus(), paired: true });
  const headers = await resetHeaders(f);
  assert.equal((await f.request('/api/reset', { method: 'POST', headers, body: '{' })).status, 400);
  assert.equal((await f.request('/api/reset', { method: 'POST', headers, body: JSON.stringify({ confirm: true, padding: 'x'.repeat(2000) }) })).status, 413);
  assert.equal(f.resets(), 0);
});

test('concurrent reset requests cannot invoke the handler twice', async t => {
  let release;
  let called;
  const started = new Promise(resolve => { called = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  let resets = 0;
  const f = await fixture(t, { getStatus: async () => ({ ...cameraStatus(), paired: true }),
    resetPairing: async () => { resets++; called(); await pending; } });
  const headers = await resetHeaders(f);
  const first = f.request('/api/reset', { method: 'POST', headers, body: '{"confirm":true}' });
  await started;
  assert.equal((await f.request('/api/reset', { method: 'POST', headers, body: '{"confirm":true}' })).status, 409);
  release();
  assert.equal((await first).status, 202);
  assert.equal(resets, 1);
});

test('handler failures do not reveal exception details, and unknown routes do not reset', async t => {
  const f = await fixture(t, { getStatus: () => ({ ...cameraStatus(), paired: true }),
    resetPairing: async () => { throw new Error('rtsp://private-user:private-password@192.0.2.1/main'); } });
  const headers = await resetHeaders(f);
  const response = await f.request('/api/reset', { method: 'POST', headers, body: '{"confirm":true}' });
  assert.equal(response.status, 500);
  assert.doesNotMatch(response.text, /private-user|private-password|rtsp:/);
  assert.equal((await f.request('/not-a-route')).status, 404);
});
