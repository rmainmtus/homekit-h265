import { CameraController, CameraControllerServiceMap, HAPStatus } from 'hap-nodejs';
import { spawn } from 'node:child_process';
import {EventEmitter} from 'node:events';
import type {DataStreamManagement, GlobalRequestHandler} from 'hap-nodejs/dist/lib/datastream';
import {HDSSnapshotTransport} from './HDSSnapshotTransport';
import { signalChild } from './childProcess';

// Compatibility adapter for pinned hap-nodejs 0.14.3. Its recording handler
// rejects snapshot opens, so route only snapshot requests around that handler.
export function installHdsSnapshots(management: DataStreamManagement, capture: () => Promise<Buffer>, active: () => boolean) {
  const emitter = (management as unknown as {dataStreamServer: {internalEventEmitter: EventEmitter}}).dataStreamServer.internalEventEmitter;
  const handlers = emitter.listeners('dataSend-r-open') as GlobalRequestHandler[];
  if (handlers.length !== 1) throw new Error('Unexpected pinned HDS handler layout');
  const recording = handlers[0];
  const filtered: GlobalRequestHandler = (connection,id,message) => {if (message?.type !== 'ipcamera.snapshot') recording(connection,id,message);};
  management.removeRequestHandler('dataSend', 'open', recording);
  management.onRequestMessage('dataSend', 'open', filtered);
  const snapshots = new HDSSnapshotTransport(management,capture,active);
  return {closeAll: () => snapshots.closeAll(), destroy() {
    snapshots.destroy(); management.removeRequestHandler('dataSend','open',filtered);
    management.onRequestMessage('dataSend','open',recording);
  }};
}

// HAP-NodeJS routes authenticated /resource requests through CameraController.
// This adapter provides snapshots without advertising a legacy H.264 stream.
export class SnapshotController extends CameraController {
  private pending?: Promise<Buffer>;
  constructor(private capture: (height: number, width: number) => Promise<Buffer>, private enabled: () => boolean) {
    super({delegate: {
      handleSnapshotRequest: (_request, cb) => cb(HAPStatus.RESOURCE_DOES_NOT_EXIST),
      prepareStream: (_request, cb) => cb(new Error('Use HEVC RTP service')),
      handleStreamRequest: (_request, cb) => cb(new Error('Use HEVC RTP service'))
    }, streamingOptions: {supportedCryptoSuites: [0], video: {codec: {profiles: [], levels: []}, resolutions: []}}});
  }
  constructServices(): CameraControllerServiceMap {return {};}
  initWithServices(): CameraControllerServiceMap {return {};}
  configureServices() {}
  async handleSnapshotRequest(height: number, width: number): Promise<Buffer> {
    if (!this.enabled()) throw HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 4096 || height > 4096) throw HAPStatus.INVALID_VALUE_IN_REQUEST;
    // At most one decoder runs. Concurrent requests are rejected rather than queued.
    if (this.pending) throw HAPStatus.RESOURCE_BUSY;
    const pending = this.pending = this.capture(height, width);
    try {
      const buffer = await pending;
      if (!this.enabled()) throw HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE;
      return buffer;
    } finally {if (this.pending === pending) this.pending = undefined;}
  }
}
export async function captureSnapshot(ffmpeg: string, source: string, height: number, width: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1',
      '-rtsp_transport', 'tcp', '-timeout', '5000000',
      // A still image needs only video discovery; default stream probing can
      // consume the entire seven-second Home snapshot deadline on this camera.
      '-analyzeduration', '100000', '-probesize', '100000',
      // A warm relay can start between HEVC keyframes. Debian's decoder may
      // output a concealed grey frame before it has the reference pictures.
      // Wait for an independently decodable picture before returning the JPEG.
      '-skip_frame', 'nokey', '-i', source, '-an', '-sn', '-dn',
      '-frames:v', '1', '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
      '-threads', '1', '-c:v', 'mjpeg', '-f', 'image2pipe', 'pipe:1'], {shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore']});
    const chunks: Buffer[] = []; let size = 0, settled = false;
    const finish = (error?: number) => {
      if (settled) return; settled = true; clearTimeout(timer);
      signalChild(child, 'SIGKILL');
      const image = Buffer.concat(chunks);
      if (error || image.length < 4 || image.readUInt16BE(0) !== 0xffd8 || image.readUInt16BE(image.length - 2) !== 0xffd9) reject(error || HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      else resolve(image);
    };
    const timer = setTimeout(() => finish(HAPStatus.OPERATION_TIMED_OUT), 7000);
    child.stdout.on('data', (b: Buffer) => {
      size += b.length;
      if (size > 2 * 1024 * 1024) finish(HAPStatus.OUT_OF_RESOURCE); else chunks.push(b);
    });
    child.on('error', () => finish(HAPStatus.SERVICE_COMMUNICATION_FAILURE));
    child.on('close', code => finish(code === 0 ? undefined : HAPStatus.SERVICE_COMMUNICATION_FAILURE));
  });
}
