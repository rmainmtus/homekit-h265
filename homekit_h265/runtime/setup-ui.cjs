'use strict';

const http = require('node:http');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const QRCode = require('../bridge/node_modules/qrcode');

const GENERIC_ERROR = 'The camera service needs attention. Check the app log for details.';

function safeStatus(value) {
  const status = value && typeof value === 'object' ? value : {};
  return {
    name: typeof status.name === 'string' ? status.name.slice(0, 64) : 'HEVC Camera',
    pincode: typeof status.pincode === 'string' && /^\d{3}-\d{2}-\d{3}$/.test(status.pincode)
      ? status.pincode : null,
    setupUri: typeof status.setupUri === 'string' && /^X-HM:\/\/[A-Z0-9]{1,64}$/.test(status.setupUri)
      ? status.setupUri : null,
    paired: status.paired === true ? true : status.paired === false ? false : null,
    ready: status.ready === true,
    // Upstream errors can contain camera URLs. Never forward raw errors to the browser.
    error: status.error ? GENERIC_ERROR : null,
  };
}

function page(nonce) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>HomeKit H.265 · Camera setup</title>
  <style nonce="${nonce}">
    :root{font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#203344;background:#f2f5f6;font-synthesis:none;--surface:#fff;--muted:#607483;--line:#dfe7eb;--accent:#007d73;--soft:#e8f5f1;--danger:#a53330;--shadow:0 12px 40px #2033440b}
    *{box-sizing:border-box}body{margin:0;line-height:1.55}button{font:inherit;cursor:pointer}button:disabled{cursor:default;opacity:.5}button:focus-visible,summary:focus-visible,a:focus-visible{outline:3px solid #35b8ad;outline-offset:4px}[hidden]{display:none!important}
    .shell{width:min(880px,100%);margin:auto;padding:36px 24px 28px}.brand{display:flex;align-items:center;gap:10px;color:var(--muted);font-size:.82rem;font-weight:650;letter-spacing:.02em}.mark{display:grid;place-items:center;width:31px;height:31px;border-radius:10px;background:var(--accent);color:white;font-size:17px;font-weight:800}
    h1{font-size:clamp(1.85rem,4vw,2.6rem);line-height:1.14;letter-spacing:-.045em;margin:27px 0 10px}h2{font-size:1.16rem;letter-spacing:-.02em;margin:0 0 8px}p{margin:0}.intro{color:var(--muted);max-width:570px}.status{display:flex;align-items:center;gap:9px;margin:24px 0 18px;font-size:.9rem;font-weight:650}.dot{width:9px;height:9px;border-radius:50%;background:#94a7b1}.status[data-state=ready] .dot,.status[data-state=paired] .dot{background:#18a680}.status[data-state=error] .dot{background:#d46a43}
    .layout{display:grid;grid-template-columns:minmax(270px,1fr) minmax(260px,1fr);gap:20px;align-items:stretch}.card{padding:27px;border:1px solid var(--line);border-radius:22px;background:var(--surface);box-shadow:var(--shadow)}.pair-card{text-align:center}.camera-name{font-size:.95rem;font-weight:650;overflow-wrap:anywhere}.qr-frame{width:240px;height:240px;max-width:100%;margin:20px auto 15px;border-radius:16px;background:white;display:grid;place-items:center;border:1px solid #e4ebee;overflow:hidden}.qr-frame img{display:block;width:100%;height:100%;object-fit:contain}.qr-placeholder{padding:20px;color:#607483;font-size:.92rem}.qr-symbol{display:block;font-size:38px;line-height:1.1;margin-bottom:13px;color:#82949e}.paired-symbol{font-size:64px;color:#00826e}.hint{font-size:.82rem;color:var(--muted)}.pin-row{display:flex;justify-content:center;align-items:center;gap:10px;margin:10px 0 4px}.pin{font-size:1.22rem;letter-spacing:.12em;font-variant-numeric:tabular-nums;font-weight:650}.copy{padding:6px 10px;border:1px solid var(--line);border-radius:9px;color:var(--accent);background:var(--surface);font-size:.82rem;font-weight:650}.steps{list-style:none;counter-reset:steps;margin:23px 0;padding:0;display:grid;gap:22px}.steps li{position:relative;padding-left:37px;font-size:.92rem;color:var(--muted)}.steps li:before{counter-increment:steps;content:counter(steps);position:absolute;left:0;top:1px;display:grid;place-items:center;width:24px;height:24px;border-radius:50%;background:var(--soft);color:var(--accent);font-size:.8rem;font-weight:750}.steps strong{display:block;color:inherit;font-weight:700;margin-bottom:2px}.note{padding:13px 14px;border-radius:12px;background:var(--soft);font-size:.82rem;color:var(--accent)}.message{margin-top:14px;font-size:.86rem;color:var(--muted);min-height:1.4em}.help{margin-top:20px;padding:17px 21px;border:1px solid var(--line);border-radius:16px;background:var(--surface)}summary{cursor:pointer;font-size:.9rem;font-weight:650}.help p{margin:13px 0;color:var(--muted);font-size:.87rem}.reset{border:1px solid #dbb8b5;border-radius:9px;background:transparent;color:var(--danger);padding:8px 12px;font-size:.85rem;font-weight:650}.footer{margin-top:23px;color:var(--muted);font-size:.77rem;text-align:center}
    dialog{width:min(460px,calc(100% - 32px));padding:28px;border:1px solid var(--line);border-radius:20px;background:var(--surface);color:inherit;box-shadow:0 24px 90px #0003}dialog::backdrop{background:#14253680}dialog h2{font-size:1.35rem}dialog p{margin-top:14px;font-size:.92rem;color:var(--muted)}.confirm-label{display:flex;align-items:flex-start;gap:10px;margin:20px 0;font-size:.88rem}.confirm-label input{margin-top:5px;accent-color:var(--danger)}.actions{display:flex;justify-content:flex-end;gap:10px;margin-top:22px}.cancel,.confirm{padding:9px 14px;border-radius:10px;border:1px solid var(--line);background:var(--surface);color:inherit;font-weight:650;font-size:.88rem}.confirm{background:var(--danger);border-color:var(--danger);color:white}
    @media(max-width:640px){.shell{padding:24px 18px}.layout{grid-template-columns:1fr}.card{padding:23px}.steps{gap:18px}.qr-frame{margin-top:16px}h1{margin-top:23px}}
    @media(prefers-color-scheme:dark){:root{color:#e2edf1;background:#14212b;--surface:#1c2b36;--muted:#adbec8;--line:#334651;--accent:#74d6bf;--soft:#263d40;--danger:#ffa6a0;--shadow:none}.mark{background:#008777;color:white}.confirm{background:#a53330;border-color:#a53330;color:white}.reset{border-color:#875957}.dot{background:#8c9da7}}
  </style>
</head>
<body>
  <main class="shell">
    <div class="brand"><span class="mark" aria-hidden="true">H</span> HomeKit H.265</div>
    <h1>Connect your camera<br>to Apple Home.</h1>
    <p class="intro">Keep your camera’s original video quality, with a familiar place to view it.</p>
    <div id="status" class="status" data-state="waiting" role="status"><span class="dot" aria-hidden="true"></span><span id="status-label">Waiting for camera</span></div>
    <div class="layout">
      <section class="card pair-card" aria-label="Camera pairing">
        <div id="camera-name" class="camera-name">HEVC Camera</div>
        <div class="qr-frame">
          <img id="qr-code" alt="HomeKit setup QR code. Scan this in the Apple Home app." hidden>
          <div id="qr-placeholder" class="qr-placeholder"><span id="qr-symbol" class="qr-symbol" aria-hidden="true">▧</span><span id="qr-message">Your setup code will appear when the camera is ready.</span></div>
        </div>
        <div id="pin-section" hidden>
          <p class="hint">Or enter the setup code manually</p>
          <div class="pin-row"><span id="pin" class="pin"></span><button id="copy-pin" class="copy" type="button" aria-label="Copy HomeKit setup code" disabled>Copy</button></div>
        </div>
        <p id="message" class="message" aria-live="polite">Starting the camera service…</p>
      </section>
      <section class="card" aria-labelledby="steps-title">
        <h2 id="steps-title">Pair in Apple Home</h2>
        <p class="hint">Keep your iPhone or iPad on your home Wi-Fi for setup.</p>
        <ol class="steps">
          <li><strong>Open the Home app</strong>Use Apple Home on your iPhone or iPad.</li>
          <li><strong>Tap +, then Add Accessory</strong>Scan the QR code shown here, or choose the option to enter a setup code.</li>
          <li><strong>Choose a room and finish setup</strong>Open the camera in Home to check the live picture and recording options.</li>
        </ol>
        <p class="note">Pair directly in <strong>Apple Home</strong>. Do not add this camera using Home Assistant’s <strong>HomeKit Device</strong> integration.</p>
      </section>
    </div>
    <details class="help">
      <summary>Troubleshooting</summary>
      <p>Already paired but need to start again? Remove this camera’s old entry from Apple Home, or from Home Assistant’s HomeKit Device integration if it was added there by mistake. Reset affects only this app’s pairing. You will need to pair this camera again, and its recording history may become unavailable.</p>
      <button id="reset-pairing" class="reset" type="button" disabled>Reset this camera’s pairing…</button>
      <p class="hint">Reset is available while this camera is ready and paired.</p>
    </details>
    <p class="footer">HomeKit H.265 · A community app for Home Assistant</p>
  </main>
  <dialog id="reset-dialog" aria-labelledby="reset-title">
    <h2 id="reset-title">Reset this camera’s pairing?</h2>
    <p>This resets only this app’s pairing with Apple Home. Other Home accessories are unaffected.</p>
    <p>You will need to pair this camera again. Its recording history may become unavailable.</p>
    <label class="confirm-label"><input id="confirm-reset" type="checkbox"><span>I understand this affects this camera’s pairing and recording history.</span></label>
    <div class="actions"><button id="cancel-reset" class="cancel" type="button">Cancel</button><button id="submit-reset" class="confirm" type="button" disabled>Reset pairing</button></div>
  </dialog>
  <script nonce="${nonce}">
    'use strict';
    const el = id => document.getElementById(id);
    const setText = (id, text) => { if (el(id).textContent !== text) el(id).textContent = text; };
    let csrfToken = '', currentPin = '', displayedUri = null, resetting = false, pairedReady = false;
    function render(status) {
      const state = status.error ? 'error' : status.ready && status.paired === true ? 'paired' : status.ready && status.paired === false && status.setupUri ? 'ready' : 'waiting';
      el('status').dataset.state = state;
      setText('status-label', {waiting:'Waiting for camera', ready:'Ready to pair', paired:'Already paired', error:'Needs attention'}[state]);
      el('camera-name').textContent = status.name || 'HEVC Camera';
      const canPair = state === 'ready' && !!status.setupUri;
      el('qr-code').hidden = !canPair;
      el('qr-placeholder').hidden = canPair;
      el('qr-symbol').textContent = state === 'paired' ? '✓' : '▧';
      el('qr-symbol').className = state === 'paired' ? 'qr-symbol paired-symbol' : 'qr-symbol';
      el('qr-message').textContent = state === 'paired' ? 'This camera is paired.' : state === 'error' ? 'Camera setup is unavailable.' : 'Your setup code will appear when the camera is ready.';
      if (canPair && displayedUri !== status.setupUri) {
        displayedUri = status.setupUri;
        el('qr-code').src = 'qr.svg?v=' + Date.now();
      } else if (!canPair) {
        displayedUri = null;
        el('qr-code').removeAttribute('src');
      }
      currentPin = status.pincode || '';
      el('pin').textContent = currentPin;
      el('pin-section').hidden = !canPair || !currentPin;
      el('copy-pin').disabled = !canPair || !currentPin;
      setText('message', status.error || (state === 'paired' ? 'If this camera is missing from Apple Home, open Troubleshooting below.' : state === 'ready' ? 'Scan the code with the Home app to continue.' : 'Starting the camera service…'));
      pairedReady = status.ready === true && status.paired === true && !status.error;
      el('reset-pairing').disabled = resetting || !pairedReady;
    }
    async function refresh() {
      try {
        const response = await fetch('api/status', {cache:'no-store', credentials:'same-origin'});
        if (!response.ok) throw new Error('Status unavailable');
        const status = await response.json();
        csrfToken = status.csrfToken;
        render(status);
      } catch (_) {
        csrfToken = '';
        render({error:'Cannot reach the camera service. Reopen this page in Home Assistant.'});
      }
    }
    el('qr-code').addEventListener('error', () => {
      displayedUri = null;
      el('qr-code').hidden = true;
      el('qr-placeholder').hidden = false;
      el('qr-message').textContent = 'Loading the setup code. Retrying…';
    });
    el('copy-pin').addEventListener('click', async () => {
      try {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(currentPin);
        } else {
          // Local Home Assistant commonly uses HTTP, where Clipboard API is unavailable.
          const selection = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(el('pin'));
          selection.removeAllRanges();
          selection.addRange(range);
          if (!document.execCommand('copy')) throw new Error('Copy unavailable');
          selection.removeAllRanges();
        }
        el('copy-pin').textContent = 'Copied';
        setTimeout(() => { el('copy-pin').textContent = 'Copy'; }, 1800);
      } catch (_) { el('message').textContent = 'Select the setup code above to copy it manually.'; }
    });
    el('reset-pairing').addEventListener('click', () => {
      if (!pairedReady || resetting) return;
      el('confirm-reset').checked = false;
      el('submit-reset').disabled = true;
      el('reset-dialog').showModal();
    });
    el('cancel-reset').addEventListener('click', () => el('reset-dialog').close());
    el('confirm-reset').addEventListener('change', () => { el('submit-reset').disabled = !el('confirm-reset').checked; });
    el('submit-reset').addEventListener('click', async () => {
      if (!el('confirm-reset').checked || resetting || !csrfToken) return;
      resetting = true;
      el('submit-reset').disabled = true;
      el('reset-pairing').disabled = true;
      el('reset-dialog').close();
      el('message').textContent = 'Resetting this camera’s pairing…';
      try {
        const response = await fetch('api/reset', {method:'POST', credentials:'same-origin', headers:{'Content-Type':'application/json', 'X-CSRF-Token':csrfToken}, body:JSON.stringify({confirm:true})});
        if (!response.ok) throw new Error('Reset failed');
        render({name:el('camera-name').textContent, ready:false});
      } catch (_) { el('message').textContent = 'Pairing could not be reset. Check the app log, then try again.'; }
      finally { resetting = false; el('reset-pairing').disabled = !pairedReady; }
    });
    async function poll() { await refresh(); setTimeout(poll, 2500); }
    poll();
  </script>
</body>
</html>`;
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let failed = false;
    const chunks = [];
    const fail = code => {
      if (failed) return;
      failed = true;
      chunks.length = 0;
      const error = new Error('Invalid request');
      error.statusCode = code;
      reject(error);
    };
    request.on('data', chunk => {
      if (failed) return;
      size += chunk.length;
      if (size > 1024) { fail(413); return; }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (failed) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (_) { fail(400); }
    });
    request.on('error', () => fail(400));
    request.on('aborted', () => fail(400));
  });
}

async function startSetupServer({ port, host = '0.0.0.0', getStatus, resetPairing,
  allowedAddress = '172.30.32.2' }) {
  if (typeof getStatus !== 'function' || typeof resetPairing !== 'function') {
    throw new TypeError('Setup server requires status and reset handlers');
  }
  const csrfToken = randomBytes(32).toString('hex');
  let resetting = false;
  const normalizeAddress = address => String(address || '').replace(/^::ffff:/, '');
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store, max-age=0');
    response.setHeader('Pragma', 'no-cache');
    response.setHeader('Expires', '0');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'SAMEORIGIN');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'");
    const send = (code, body, type = 'application/json; charset=utf-8') => {
      response.writeHead(code, { 'Content-Type': type });
      response.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
    };
    // Deliberately ignore X-Forwarded-For and other client-controlled headers.
    if (normalizeAddress(request.socket.remoteAddress) !== normalizeAddress(allowedAddress)) {
      send(403, { error: 'Open this page through Home Assistant.' });
      return;
    }
    let pathname;
    try { pathname = new URL(request.url, 'http://localhost').pathname; }
    catch (_) { send(400, { error: 'Invalid request.' }); return; }
    try {
      if (request.method === 'GET' && pathname === '/') {
        const nonce = randomBytes(18).toString('base64');
        response.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'`);
        send(200, page(nonce), 'text/html; charset=utf-8');
      } else if (request.method === 'GET' && pathname === '/api/status') {
        send(200, { ...safeStatus(await getStatus()), csrfToken });
      } else if (request.method === 'GET' && pathname === '/qr.svg') {
        const status = safeStatus(await getStatus());
        if (!status.ready || status.paired !== false || status.error || !status.setupUri) {
          send(409, { error: 'The setup code is not available.' });
          return;
        }
        const svg = await QRCode.toString(status.setupUri, {
          type: 'svg', errorCorrectionLevel: 'M', margin: 2, width: 260,
          color: { dark: '#142536', light: '#ffffff' },
        });
        send(200, svg, 'image/svg+xml; charset=utf-8');
      } else if (pathname === '/api/reset') {
        if (request.method !== 'POST') {
          response.setHeader('Allow', 'POST');
          send(405, { error: 'Use POST to request a pairing reset.' });
          return;
        }
        if (String(request.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
          send(415, { error: 'A JSON confirmation is required.' });
          return;
        }
        const supplied = request.headers['x-csrf-token'];
        if (typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied)
          || !timingSafeEqual(Buffer.from(supplied), Buffer.from(csrfToken))) {
          send(403, { error: 'Reload this page before resetting the pairing.' });
          return;
        }
        const body = await readJson(request);
        if (!body || typeof body !== 'object' || Array.isArray(body) || body.confirm !== true) {
          send(400, { error: 'Explicit confirmation is required.' });
          return;
        }
        if (resetting) { send(409, { error: 'A pairing reset is already in progress.' }); return; }
        const status = safeStatus(await getStatus());
        if (!status.ready || status.paired !== true || status.error) {
          send(409, { error: 'Reset is available only while the camera is ready and paired.' });
          return;
        }
        // Recheck after the asynchronous status read so simultaneous requests cannot both reset.
        if (resetting) { send(409, { error: 'A pairing reset is already in progress.' }); return; }
        resetting = true;
        try {
          await resetPairing();
          send(202, { ok: true });
        } finally { resetting = false; }
      } else {
        send(404, { error: 'Not found.' });
      }
    } catch (error) {
      if (!response.headersSent) {
        send(error && error.statusCode === 413 ? 413 : error && error.statusCode === 400 ? 400 : 500,
          { error: 'The request could not be completed. Check the app log.' });
      } else { response.end(); }
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.removeListener('error', reject); resolve(); });
  });
  let closing;
  return {
    port: server.address().port,
    close() {
      if (!closing) closing = new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
      return closing;
    },
  };
}

module.exports = { startSetupServer };
