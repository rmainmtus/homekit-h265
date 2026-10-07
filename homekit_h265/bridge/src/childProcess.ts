import type { ChildProcess } from 'node:child_process';

type Child = Pick<ChildProcess, 'pid' | 'exitCode' | 'signalCode' | 'kill'>;

/** A failed spawn may still have a native handle before its error event arrives. */
export function signalChild(child: Child | undefined, signal: NodeJS.Signals): boolean {
  // On POSIX, signaling PID 0 targets the caller's entire process group.
  if (!child || !Number.isInteger(child.pid) || child.pid! <= 0 ||
      child.exitCode !== null || child.signalCode !== null) return false;
  try { return child.kill(signal); } catch { return false; }
}
