import { readFileSync, mkdirSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import path from 'node:path';
import { HAPStorage } from 'hap-nodejs';
import { HevcAccessory } from './accessory';
import { validateConfig } from './config';
import { MotionDetector } from './motion';
async function main() {
  const filename = process.argv[2];
  if (!filename) throw new Error('Usage: npm run start:lab -- /path/to/config.local.json');
  const config = validateConfig(JSON.parse(readFileSync(filename, 'utf8').replace(/^\uFEFF/, '')));
  const storage = path.join(path.dirname(path.resolve(filename)), '.hap');
  mkdirSync(storage, {recursive: true, mode: 0o700});
  HAPStorage.setCustomStoragePath(storage);
  const privacyFile = path.join(storage, 'privacy.json');
  const privacy: Record<string, boolean> = existsSync(privacyFile) ? JSON.parse(readFileSync(privacyFile, 'utf8')) : {};
  const lab = new HevcAccessory(config, console.log, {
    get: key => privacy[key] !== false,
    set: (key, value) => {
      privacy[key] = value;
      writeFileSync(`${privacyFile}.tmp`, JSON.stringify(privacy), {mode: 0o600});
      renameSync(`${privacyFile}.tmp`, privacyFile);
    }
  });
  let advertised = false;
  const sendSetupStatus = () => {
    if (!process.send || !process.connected || !lab.accessory._accessoryInfo) return;
    try {
      process.send({ type: 'homekit-status', name: config.name, pincode: config.pincode,
        setupUri: lab.accessory.setupURI(), paired: lab.accessory._accessoryInfo.paired(),
        ready: advertised }, () => {});
    } catch { /* The launcher may already be shutting down. */ }
  };
  lab.accessory.on('advertised', () => { advertised = true; sendSetupStatus(); });
  lab.accessory.on('paired', sendSetupStatus);
  lab.accessory.on('unpaired', sendSetupStatus);
  let motion: MotionDetector | undefined;
  if (lab.nativeRecording) {
    const file = path.join(storage, 'cmaf.json');
    if (existsSync(file)) lab.nativeRecording.restore(JSON.parse(readFileSync(file, 'utf8')));
    lab.nativeRecording.onState = state => {
      writeFileSync(`${file}.tmp`, JSON.stringify(state), {mode: 0o600}); renameSync(`${file}.tmp`, file);
    };
  }
  if (lab.recording) {
    const recording = lab.recording;
    const recordingFile = path.join(storage, 'recording.json');
    if (config.motionRtspUrl) {
      motion = new MotionDetector(config.ffmpeg, config.motionRtspUrl, active => recording.setMotion(active), console.log);
      recording.onEnabled = enabled => motion!.setEnabled(enabled);
      if (lab.nativeRecording) {
        lab.nativeRecording.onMotionMask = mask => motion!.setMask(mask);
        lab.nativeRecording.refreshMotionMask();
      }
    }
    if (existsSync(recordingFile)) recording.management.deserialize(JSON.parse(readFileSync(recordingFile, 'utf8')));
    recording.management.setupStateChangeDelegate(() => {
      writeFileSync(`${recordingFile}.tmp`, JSON.stringify(recording.management.serialize()), {mode: 0o600});
      renameSync(`${recordingFile}.tmp`, recordingFile);
    });
  }
  let stopping = false;
  const health = setInterval(() => console.log('Camera health ' + JSON.stringify({
    recording: lab.recording?.diagnostics ?? null,
    motion: motion?.diagnostics ?? null,
    localSessions: lab.sessions.size,
    remoteSessions: lab.remote.sessions.size,
  })), 60000);
  health.unref();
  const stop = async () => {if (stopping) return; stopping = true; advertised = false; sendSetupStatus(); clearInterval(health); motion?.close(); await lab.close();};
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  await lab.publish();
  sendSetupStatus();
  console.log(`Pair the separate accessory ${config.name}. See your private configuration for its pairing code.`);
}
main().catch(() => {console.error('Lab startup failed. Check private configuration and port availability.'); process.exitCode = 1;});
