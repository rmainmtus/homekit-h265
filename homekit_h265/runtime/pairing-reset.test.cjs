'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPairing } = require('./launcher.cjs');
const { PairingResetError, backupAndResetPairing } = require('./pairing-reset.cjs');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'homekit-pairing-reset-'));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  const state = createPairing(true);
  const hap = path.join(dir, '.hap');
  const accessoryFile = `AccessoryInfo.${state.username.replaceAll(':', '')}.json`;
  fs.mkdirSync(hap);
  fs.writeFileSync(path.join(dir, 'pairing.json'), JSON.stringify(state, null, 2));
  fs.writeFileSync(path.join(dir, 'config.local.json'), JSON.stringify({ username: state.username, pincode: state.pincode }));
  fs.writeFileSync(path.join(dir, 'options.json'), '{"name":"Camera"}');
  fs.writeFileSync(path.join(hap, accessoryFile), JSON.stringify({ pairedClients: { controller: 'private-test-key' }, pairedAdminClients: 1 }));
  fs.writeFileSync(path.join(hap, 'IdentifierCache.json'), '{"stable":"ids"}');
  fs.mkdirSync(path.join(hap, 'nested'));
  fs.writeFileSync(path.join(hap, 'nested', 'recording-state.json'), '{"state":true}');
  return { dir, state, hap, accessoryFile };
}

function snapshot(dir) {
  return fs.readdirSync(dir).sort().map(name => {
    const full = path.join(dir, name), stat = fs.lstatSync(full);
    return [name, stat.isSymbolicLink() ? ['symlink', fs.readlinkSync(full)] : stat.isDirectory() ? snapshot(full) : fs.readFileSync(full).toString('base64')];
  });
}

test('confirmed reset archives the entire HomeKit store before removing it and preserves identity/PIN/options', t => {
  const { dir, state, hap } = fixture(t);
  const homeKitBefore = snapshot(hap);
  const identity = fs.readFileSync(path.join(dir, 'pairing.json'));
  const config = fs.readFileSync(path.join(dir, 'config.local.json'));
  const options = fs.readFileSync(path.join(dir, 'options.json'));
  const { backupName } = backupAndResetPairing(dir, state.username);
  assert.equal(fs.existsSync(hap), false);
  const backup = path.join(dir, 'pairing-backups', backupName);
  assert.deepEqual(snapshot(path.join(backup, '.hap')), homeKitBefore);
  assert.deepEqual(fs.readFileSync(path.join(backup, 'pairing.json')), identity);
  assert.deepEqual(fs.readFileSync(path.join(backup, 'config.local.json')), config);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'pairing.json')), identity);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'config.local.json')), config);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'options.json')), options);
  const info = JSON.parse(fs.readFileSync(path.join(backup, 'reset-info.json')));
  assert.equal(info.username, state.username); assert.equal(info.identitySha256.length, 64);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(backup).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(backup, 'pairing.json')).mode & 0o777, 0o600);
  }
});

test('reset refuses mismatched identity, unrelated accessories, corrupt state, or an unpaired camera without mutations', t => {
  for (const kind of ['identity', 'extra-accessory', 'corrupt', 'unpaired']) {
    const f = fixture(t);
    if (kind === 'identity') fs.writeFileSync(path.join(f.dir, 'pairing.json'), JSON.stringify(createPairing(true)));
    if (kind === 'extra-accessory') fs.writeFileSync(path.join(f.hap, 'AccessoryInfo.112233445566.json'), '{}');
    if (kind === 'corrupt') fs.writeFileSync(path.join(f.hap, f.accessoryFile), 'private invalid JSON');
    if (kind === 'unpaired') fs.writeFileSync(path.join(f.hap, f.accessoryFile), '{"pairedClients":{}}');
    const before = snapshot(f.dir);
    assert.throws(() => backupAndResetPairing(f.dir, f.state.username), PairingResetError);
    assert.deepEqual(snapshot(f.dir), before, kind);
  }
});

test('a backup destination failure leaves original HomeKit pairing untouched', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dir, 'pairing-backups'), 'not a directory');
  const before = snapshot(f.dir);
  assert.throws(() => backupAndResetPairing(f.dir, f.state.username), PairingResetError);
  assert.deepEqual(snapshot(f.dir), before);
});

test('backup write failure never moves the active HomeKit store or reveals filesystem error text', t => {
  const f = fixture(t), before = snapshot(f.hap);
  const originalOpen = fs.openSync;
  t.mock.method(fs, 'openSync', (filename, ...args) => {
    if (String(filename).includes('pairing-backups')) throw new Error('rtsp://username:private-password@camera/main');
    return originalOpen(filename, ...args);
  });
  assert.throws(() => backupAndResetPairing(f.dir, f.state.username), error => {
    assert.ok(error instanceof PairingResetError);
    assert.doesNotMatch(error.message, /username|private-password|rtsp:/); return true;
  });
  assert.deepEqual(snapshot(f.hap), before);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, 'pairing.json'))).username, f.state.username);
});

test('directory links and hard-linked state are rejected without changing the target', t => {
  for (const kind of ['directory-link', 'hard-link']) {
    const f = fixture(t);
    const external = path.join(f.dir, 'external'); fs.mkdirSync(external);
    const externalFile = path.join(external, 'private.json'); fs.writeFileSync(externalFile, 'outside state');
    if (kind === 'directory-link') fs.symlinkSync(external, path.join(f.hap, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    else fs.linkSync(externalFile, path.join(f.hap, 'linked.json'));
    const before = snapshot(f.dir);
    assert.throws(() => backupAndResetPairing(f.dir, f.state.username), PairingResetError);
    assert.deepEqual(snapshot(f.dir), before);
  }
});

test('a linked data root is rejected before any HomeKit state is changed', t => {
  const f = fixture(t), link = `${f.dir}-link`;
  fs.symlinkSync(f.dir, link, process.platform === 'win32' ? 'junction' : 'dir');
  t.after(() => fs.rmSync(link, { recursive: true, force: true }));
  const before = snapshot(f.dir);
  assert.throws(() => backupAndResetPairing(link, f.state.username), PairingResetError);
  assert.deepEqual(snapshot(f.dir), before);
});

test('subsequent confirmed resets retain every earlier backup', t => {
  const f = fixture(t);
  const first = backupAndResetPairing(f.dir, f.state.username);
  const oldBackup = path.join(f.dir, 'pairing-backups', first.backupName);
  const before = snapshot(oldBackup);
  fs.mkdirSync(f.hap);
  fs.writeFileSync(path.join(f.hap, f.accessoryFile), '{"pairedClients":{"new-controller":"new-key"}}');
  const second = backupAndResetPairing(f.dir, f.state.username);
  assert.notEqual(first.backupName, second.backupName);
  assert.deepEqual(snapshot(oldBackup), before);
  assert.equal(fs.readdirSync(path.join(f.dir, 'pairing-backups')).length, 2);
});

test('invalid storage paths and malformed accessory identifiers fail safely', t => {
  const f = fixture(t), before = snapshot(f.dir);
  for (const [dir, username] of [['.', f.state.username], [f.dir, '../outside'], [f.dir, '00:11:22']]) {
    assert.throws(() => backupAndResetPairing(dir, username), PairingResetError);
  }
  assert.deepEqual(snapshot(f.dir), before);
});
