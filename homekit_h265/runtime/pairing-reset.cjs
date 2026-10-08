'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

class PairingResetError extends Error {}
const fail = message => { throw new PairingResetError(message); };
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

function regularDirectory(filename) {
  const stat = fs.lstatSync(filename);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(fs.realpathSync(filename), path.resolve(filename))) {
    fail('Pairing reset refused: app storage must use real directories, without symbolic links.');
  }
  return stat;
}

function regularFile(filename, maxBytes = 1048576) {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes || stat.nlink > 1) {
    fail('Pairing reset refused: unexpected file in app storage.');
  }
  return fs.readFileSync(filename);
}

function inspectTree(directory) {
  let files = 0, directories = 0, bytes = 0;
  function visit(current, depth = 0) {
    if (++directories > 256 || depth > 32) fail('Pairing reset refused: HomeKit state is unexpectedly large.');
    regularDirectory(current);
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const filename = path.join(current, entry.name);
      const stat = fs.lstatSync(filename);
      if (stat.isSymbolicLink()) fail('Pairing reset refused: HomeKit state contains a symbolic link.');
      if (stat.isDirectory()) visit(filename, depth + 1);
      else if (stat.isFile() && stat.nlink === 1) {
        files++; bytes += stat.size;
        if (files > 4096 || bytes > 32 * 1024 * 1024) fail('Pairing reset refused: HomeKit state is unexpectedly large.');
      } else fail('Pairing reset refused: HomeKit state contains an unexpected file.');
    }
  }
  visit(directory);
}

/** Call only after this app's bridge and relay have stopped and closed. */
function backupAndResetPairing(dataDir, expectedUsername) {
  try {
    if (!path.isAbsolute(dataDir) || !/^(?:[0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(expectedUsername)) {
      fail('Pairing reset refused: invalid app storage or accessory identity.');
    }
    const root = path.resolve(dataDir);
    regularDirectory(root);
    const hap = path.join(root, '.hap');
    const before = regularDirectory(hap);
    const pairingBytes = regularFile(path.join(root, 'pairing.json'));
    const pairing = JSON.parse(pairingBytes.toString('utf8'));
    if (pairing.username !== expectedUsername) fail('Pairing reset refused: accessory identity changed.');
    const accessoryFilename = `AccessoryInfo.${expectedUsername.replaceAll(':', '')}.json`;
    const accessoryFiles = fs.readdirSync(hap).filter(name => /^AccessoryInfo\.[^.]+\.json$/.test(name));
    if (accessoryFiles.length !== 1 || accessoryFiles[0] !== accessoryFilename) {
      fail('Pairing reset refused: HomeKit storage does not contain exactly this accessory.');
    }
    const accessory = JSON.parse(regularFile(path.join(hap, accessoryFilename)).toString('utf8'));
    if (!accessory.pairedClients || typeof accessory.pairedClients !== 'object' ||
        Array.isArray(accessory.pairedClients) || Object.keys(accessory.pairedClients).length === 0) {
      fail('This camera has no saved controller pairing to reset.');
    }
    inspectTree(hap);
    const configFilename = path.join(root, 'config.local.json');
    const configBytes = fs.existsSync(configFilename) ? regularFile(configFilename) : undefined;
    const backups = path.join(root, 'pairing-backups');
    if (!fs.existsSync(backups)) fs.mkdirSync(backups, { mode: 0o700 });
    regularDirectory(backups);
    const stamp = new Date().toISOString().replaceAll(':', '-');
    const backup = fs.mkdtempSync(path.join(backups, `${stamp}-`));
    fs.chmodSync(backup, 0o700);
    const save = (name, bytes) => {
      const fd = fs.openSync(path.join(backup, name), 'wx', 0o600);
      try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    };
    // Preserve the existing identity/config alongside the full HomeKit directory.
    save('pairing.json', pairingBytes);
    if (configBytes) save('config.local.json', configBytes);
    save('reset-info.json', JSON.stringify({ version: 1, createdAt: stamp, username: expectedUsername,
      operation: 'User-confirmed HomeKit pairing reset', identitySha256: crypto.createHash('sha256').update(pairingBytes).digest('hex') }));
    const after = regularDirectory(hap);
    if (before.ino !== after.ino || before.dev !== after.dev) fail('Pairing reset refused: HomeKit storage changed during backup.');
    // Atomic same-volume move: all old keys/state become the backup before the
    // launcher can create fresh unpaired HomeKit state. Never delete backups.
    fs.renameSync(hap, path.join(backup, '.hap'));
    return { backupName: path.basename(backup) };
  } catch (error) {
    if (error instanceof PairingResetError) throw error;
    fail('Pairing reset could not create a complete backup. Existing backups and pairing identity were preserved.');
  }
}

module.exports = { PairingResetError, backupAndResetPairing };
