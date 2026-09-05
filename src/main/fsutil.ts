import { copyFile, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

/**
 * The temp directory and the user's target folder are often on different
 * filesystems, where rename() fails with EXDEV — fall back to copy + delete.
 */
export async function moveFile(source: string, destination: string): Promise<void> {
  try {
    await rename(source, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await copyFile(source, destination);
    await rm(source, { force: true });
  }
}

/**
 * Picks the finished download out of a temp directory. yt-dlp can leave
 * fragments and metadata behind, so the largest non-partial file wins rather
 * than whatever readdir happens to list first.
 */
export async function largestFileIn(directory: string): Promise<string | null> {
  const entries = await readdir(directory);
  let best: { file: string; size: number } | null = null;

  for (const entry of entries) {
    if (/\.(part|ytdl|temp)$/i.test(entry)) continue;
    const fullPath = path.join(directory, entry);
    const stats = await stat(fullPath).catch(() => null);
    if (!stats?.isFile() || stats.size === 0) continue;
    if (!best || stats.size > best.size) best = { file: fullPath, size: stats.size };
  }

  return best?.file ?? null;
}
