import { spawn, ChildProcess } from 'node:child_process';

// Decode only the camera's low-resolution substream. The recording video is copied.
export class MotionDetector {
  private child?: ChildProcess;
  private timer?: NodeJS.Timeout;
  private generation = 0;
  private enabled = false;
  private mask?: Uint8Array;
  private lastFrame?: number;
  private frameCount = 0;
  get diagnostics() {
    return {
      enabled: this.enabled,
      running: !!this.child,
      frames: this.frameCount,
      frameAgeMs: this.lastFrame === undefined ? null : Math.max(0, Date.now() - this.lastFrame),
    };
  }
  setMask(mask?: Uint8Array) {this.mask = mask;}
  constructor(private ffmpeg: string, private source: string, private motion: (active: boolean) => void,
    private log: (s: string) => void) {}
  setEnabled(enabled: boolean) {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (enabled) this.start(); else this.stop();
  }
  private start() {
    if (!this.enabled || this.child) return;
    const generation = this.generation;
    const child = this.child = spawn(this.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1',
      '-rtsp_transport', 'tcp', '-timeout', '10000000', '-i', this.source, '-an', '-sn', '-dn',
      '-vf', 'fps=2,scale=160:180', '-pix_fmt', 'gray', '-threads', '1', '-f', 'rawvideo', 'pipe:1'],
      {stdio: ['ignore', 'pipe', 'ignore'], shell: false, windowsHide: true});
    let pending = Buffer.alloc(0), previous: Buffer | undefined, holdUntil = 0, consecutive = 0;
    child.stdout!.on('data', (chunk: Buffer) => {
      if (generation !== this.generation) return;
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 28800) {
        const frame = Buffer.from(pending.subarray(0, 28800)); pending = pending.subarray(28800);
        this.lastFrame = Date.now(); this.frameCount++;
        if (previous) {
          let changed = 0;
          for (let i = 0; i < frame.length; i++) if ((!this.mask || this.mask[i]) && Math.abs(frame[i] - previous[i]) > 18) changed++;
          consecutive = changed / frame.length > 0.012 ? consecutive + 1 : 0;
          if (consecutive >= 2) holdUntil = Date.now() + 10000;
          this.motion(Date.now() < holdUntil);
        }
        previous = frame;
      }
    });
    const ended = () => {
      if (generation !== this.generation) return;
      this.stop();
      if (this.enabled) {this.log('Motion substream interrupted; retrying'); this.timer = setTimeout(() => this.start(), 10000);}
    };
    child.on('error', ended); child.on('close', ended);
    this.log('HKSV motion detector running on low-resolution substream');
  }
  private stop() {this.generation++; clearTimeout(this.timer); this.child?.kill('SIGKILL'); this.child = undefined; this.motion(false);}
  close() {this.enabled = false; this.stop();}
}
