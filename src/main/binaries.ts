import { app } from "electron";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, rename, rm, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import ffmpegStatic from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import type { YtdlpSource } from "@shared/types";

/**
 * ffmpeg-static and ffprobe-static resolve their binary relative to their own
 * location inside node_modules. In a packaged build that is inside app.asar,
 * which the OS cannot exec — electron-builder unpacks them (see asarUnpack in
 * electron-builder.yml) and we have to point at the unpacked copy ourselves.
 */
function unpackedPath(binaryPath: string): string {
  return binaryPath.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}

export const FFMPEG_PATH: string | null = process.env.FFMPEG_PATH
  ? process.env.FFMPEG_PATH
  : ffmpegStatic
    ? unpackedPath(ffmpegStatic)
    : null;

export const FFPROBE_PATH: string | null = process.env.FFPROBE_PATH
  ? process.env.FFPROBE_PATH
  : ffprobeStatic?.path
    ? unpackedPath(ffprobeStatic.path)
    : null;

/** yt-dlp needs to find ffmpeg for merging and audio extraction. */
export function ffmpegDirectory(): string | null {
  return FFMPEG_PATH ? path.dirname(FFMPEG_PATH) : null;
}

export async function ffmpegAvailable(): Promise<boolean> {
  if (!FFMPEG_PATH || !FFPROBE_PATH) return false;
  // ffmpeg and ffprobe use a single-dash -version and exit non-zero on the
  // GNU-style --version that yt-dlp expects.
  const [ffmpegOk, ffprobeOk] = await Promise.all([
    runVersion(FFMPEG_PATH, "-version"),
    runVersion(FFPROBE_PATH, "-version"),
  ]);
  return ffmpegOk !== null && ffprobeOk !== null;
}

function ytdlpFilename(): string {
  return process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
}

/**
 * Asset name of the self-contained yt-dlp build for this platform. These are
 * PyInstaller bundles, so no Python installation is required on the machine.
 */
function ytdlpAssetName(): string {
  if (process.platform === "win32") {
    return process.arch === "ia32" ? "yt-dlp_x86.exe" : "yt-dlp.exe";
  }
  if (process.platform === "darwin") return "yt-dlp_macos";
  return process.arch === "arm64" ? "yt-dlp_linux_aarch64" : "yt-dlp_linux";
}

/** Binary we download and update ourselves, kept out of the read-only app bundle. */
export function managedYtdlpPath(): string {
  return path.join(app.getPath("userData"), "bin", ytdlpFilename());
}

function runVersion(binary: string, flag = "--version"): Promise<string | null> {
  return new Promise((resolve) => {
    let stdout = "";
    const proc = spawn(binary, [flag], { windowsHide: true });
    proc.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    proc.on("error", () => resolve(null));
    proc.on("close", (code) => resolve(code === 0 ? stdout.trim().split("\n")[0] : null));
  });
}

export type YtdlpInfo = {
  available: boolean;
  path: string | null;
  source: YtdlpSource;
  version: string | null;
};

/**
 * Prefers an explicit override, then our own managed copy, then a yt-dlp that
 * happens to be on PATH. Only the managed copy is ours to update.
 */
export async function resolveYtdlp(): Promise<YtdlpInfo> {
  const candidates: Array<{ path: string; source: YtdlpSource }> = [];
  if (process.env.YTDLP_PATH) {
    candidates.push({ path: process.env.YTDLP_PATH, source: "env" });
  }
  candidates.push({ path: managedYtdlpPath(), source: "managed" });
  candidates.push({ path: ytdlpFilename(), source: "system" });

  for (const candidate of candidates) {
    const version = await runVersion(candidate.path);
    if (version !== null) {
      return { available: true, path: candidate.path, source: candidate.source, version };
    }
  }

  return { available: false, path: null, source: "none", version: null };
}

/**
 * Downloads the latest yt-dlp release into userData. YouTube breaks older
 * versions regularly, so this doubles as the update path.
 */
export async function installYtdlp(
  onProgress?: (percent: number | null, message: string) => void,
): Promise<{ path: string; version: string }> {
  const target = managedYtdlpPath();
  const downloadUrl = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${ytdlpAssetName()}`;

  onProgress?.(null, "yt-dlp wird heruntergeladen...");

  await mkdir(path.dirname(target), { recursive: true });
  const tempPath = `${target}.download`;
  await rm(tempPath, { force: true });

  const response = await fetch(downloadUrl, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`Download fehlgeschlagen (HTTP ${response.status}).`);
  }

  const totalBytes = Number(response.headers.get("content-length")) || 0;
  let receivedBytes = 0;
  const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
  source.on("data", (chunk: Buffer) => {
    receivedBytes += chunk.length;
    const percent = totalBytes ? Math.round((receivedBytes / totalBytes) * 100) : null;
    onProgress?.(percent, "yt-dlp wird heruntergeladen...");
  });

  try {
    await pipeline(source, createWriteStream(tempPath));
    if ((await stat(tempPath)).size === 0) {
      throw new Error("Der Download war leer.");
    }
    if (process.platform !== "win32") {
      await chmod(tempPath, 0o755);
    }
    // Windows refuses to rename onto an existing file.
    await rm(target, { force: true });
    await rename(tempPath, target);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }

  const version = await runVersion(target);
  if (version === null) {
    throw new Error("Die heruntergeladene yt-dlp-Datei ist nicht ausführbar.");
  }

  onProgress?.(100, `yt-dlp ${version} ist bereit.`);
  return { path: target, version };
}
