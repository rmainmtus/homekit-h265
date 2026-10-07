// Bound packet bursts without altering SRTP bytes, timestamps or frame order.
// This is delivery pacing, not encoding or a video frame buffer.
export class DatagramPacer {
  readonly stats = {queuedBytes: 0, maxQueuedBytes: 0, maxWaitMs: 0, sent: 0, overloads: 0};
  private queue: {packet: Buffer; at: number}[] = [];
  private head = 0;
  private tokens: number;
  private last: number;
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  constructor(private send: (packet: Buffer) => void,
    readonly bytesPerSecond = 4_000_000, readonly burstBytes = 4800,
    private fail: () => void = () => {},
    private now: () => number = () => performance.now(),
    private schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout> = (fn, ms) => setTimeout(fn, ms),
    private cancel: (timer: ReturnType<typeof setTimeout>) => void = clearTimeout) {
    if (!(bytesPerSecond > 0) || burstBytes < 1500) throw new Error('Invalid pacing budget');
    this.tokens = burstBytes; this.last = now();
  }
  push(packet: Buffer) {
    if (this.closed) return;
    // Never drop arbitrary encrypted packets and continue with a damaged frame.
    // End an unhealthy stream instead of retaining >0.5 seconds of backlog.
    if (this.stats.queuedBytes + packet.length > this.bytesPerSecond * 0.5 || packet.length > this.burstBytes) {
      this.stats.overloads++; this.close(); this.fail(); return;
    }
    this.queue.push({packet, at: this.now()}); this.stats.queuedBytes += packet.length;
    this.stats.maxQueuedBytes = Math.max(this.stats.maxQueuedBytes, this.stats.queuedBytes);
    if (!this.timer) this.flush();
  }
  private flush() {
    this.timer = undefined;
    if (this.closed) return;
    const now = this.now();
    this.tokens = Math.min(this.burstBytes, this.tokens + Math.max(0, now - this.last) * this.bytesPerSecond / 1000);
    this.last = now;
    while (this.head < this.queue.length) {
      const next = this.queue[this.head];
      if (now - next.at > 500) {this.stats.overloads++; this.close(); this.fail(); return;}
      if (next.packet.length > this.tokens) break;
      this.tokens -= next.packet.length; this.head++; this.stats.queuedBytes -= next.packet.length;
      this.stats.maxWaitMs = Math.max(this.stats.maxWaitMs, Math.round(now - next.at));
      this.stats.sent++; this.send(next.packet);
      if (this.closed) return;
    }
    if (this.head === this.queue.length) {this.queue = []; this.head = 0; return;}
    if (this.head > 512) {this.queue = this.queue.slice(this.head); this.head = 0;}
    const delay = Math.max(1, Math.ceil((this.queue[this.head].packet.length - this.tokens) * 1000 / this.bytesPerSecond));
    this.timer = this.schedule(() => this.flush(), delay); this.timer.unref?.();
  }
  close() {
    this.closed = true; if (this.timer) this.cancel(this.timer);
    this.timer = undefined; this.queue = []; this.head = 0; this.stats.queuedBytes = 0;
  }
}
