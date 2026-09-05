import type { ChildProcess } from "node:child_process";

/**
 * Tracks the child process behind each running job so the renderer can cancel
 * a long download or conversion.
 */
const running = new Map<string, ChildProcess>();
const canceled = new Set<string>();

export function register(jobId: string, proc: ChildProcess): void {
  running.set(jobId, proc);
}

export function unregister(jobId: string): void {
  running.delete(jobId);
}

export function cancel(jobId: string): boolean {
  canceled.add(jobId);
  const proc = running.get(jobId);
  if (!proc) return false;
  // SIGTERM lets yt-dlp/ffmpeg clean up their partial files.
  proc.kill(process.platform === "win32" ? undefined : "SIGTERM");
  return true;
}

export function wasCanceled(jobId: string): boolean {
  return canceled.has(jobId);
}

export function clear(jobId: string): void {
  running.delete(jobId);
  canceled.delete(jobId);
}

export function cancelAll(): void {
  for (const jobId of [...running.keys()]) cancel(jobId);
}
