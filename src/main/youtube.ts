import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ffmpegDirectory, resolveYtdlp } from "./binaries";
import { largestFileIn, moveFile } from "./fsutil";
import { sanitizeFilename } from "./filename";
import * as jobs from "./jobs";
import type { JobResult, YoutubeFormat } from "@shared/types";

const ALLOWED_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "www.youtu.be",
]);

export class UserError extends Error {}

export function isValidYoutubeUrl(value: string): boolean {
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    return ALLOWED_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Extensions yt-dlp can produce per format, used for the save dialog default. */
export const FORMAT_EXTENSION: Record<YoutubeFormat, string> = {
  video: "mp4",
  audio_m4a: "m4a",
  audio_mp3: "mp3",
};

async function ytdlpBinary(): Promise<string> {
  const info = await resolveYtdlp();
  if (!info.available || !info.path) {
    throw new UserError(
      'yt-dlp ist nicht installiert. Klicke auf "yt-dlp installieren", um es automatisch einzurichten.',
    );
  }
  return info.path;
}

function baseArgs(): string[] {
  const args = ["--no-playlist", "--no-warnings", "--ignore-config"];
  const ffmpegDir = ffmpegDirectory();
  // Without this yt-dlp would look for a system ffmpeg, which is exactly what
  // the web version failed on. We ship our own.
  if (ffmpegDir) args.push("--ffmpeg-location", ffmpegDir);
  return args;
}

function formatArgs(format: YoutubeFormat): string[] {
  switch (format) {
    case "audio_m4a":
      return ["-f", "bestaudio[ext=m4a]/bestaudio/best", "-x", "--audio-format", "m4a"];
    case "audio_mp3":
      return ["-f", "bestaudio/best", "-x", "--audio-format", "mp3", "--audio-quality", "192K"];
    case "video":
    default:
      // Because ffmpeg is always available we can merge separate video/audio
      // streams and are no longer capped at the 720p progressive formats.
      return ["-f", "bv*+ba/b", "--merge-output-format", "mp4"];
  }
}

function runYtdlp(
  binary: string,
  args: string[],
  options: { jobId?: string; onStdout?: (line: string) => void } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(binary, args, { windowsHide: true });
    if (options.jobId) jobs.register(options.jobId, proc);

    let stdout = "";
    let stderr = "";
    let stdoutBuffer = "";

    proc.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      if (!options.onStdout) return;
      stdoutBuffer += text;
      const lines = stdoutBuffer.split(/\r?\n|\r/);
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) options.onStdout(line);
    });
    proc.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));

    proc.on("error", (error) => {
      if (options.jobId) jobs.unregister(options.jobId);
      reject(error);
    });
    proc.on("close", (code) => {
      if (options.jobId) jobs.unregister(options.jobId);
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `yt-dlp wurde mit Code ${code} beendet.`));
    });
  });
}

/**
 * Maps a raw yt-dlp failure onto something a user can act on. Order matters:
 * the first matching rule wins, so connection problems are classified before
 * the content rules, which would otherwise claim ambiguous wording.
 */
const ERROR_RULES: Array<[RegExp, string]> = [
  [
    /unable to connect|connection (refused|reset|aborted)|tunnel connection failed|unable to download webpage|proxy|urlopen|network is unreachable|timed out|getaddrinfo|temporary failure in name resolution/i,
    "Keine Verbindung zu YouTube möglich. Prüfe deine Internetverbindung (oder deine Proxy-Einstellungen).",
  ],
  [
    /nsig extraction failed|unable to extract|player response|failed to extract any player response|update to the latest version/i,
    'YouTube hat sich geändert und yt-dlp ist zu alt. Klicke auf "yt-dlp aktualisieren".',
  ],
  [
    /sign in to confirm you'?re not a bot|cookies are no longer valid/i,
    "YouTube verlangt eine Bestätigung, dass du kein Bot bist. Versuche es später erneut.",
  ],
  [
    /private video|members-only|login required|sign in to confirm your age|age-restricted|confirm your age/i,
    "Das Video ist privat, altersbeschränkt oder erfordert eine Anmeldung.",
  ],
  [
    /requested format is not available|no video formats found/i,
    "Das gewählte Format ist für dieses Video nicht verfügbar.",
  ],
  [
    /video unavailable|has been removed|does not exist|not available in your country|blocked it in your country|video is not available/i,
    "Das Video ist nicht verfügbar (gelöscht oder in deiner Region gesperrt).",
  ],
  [
    /no space left on device/i,
    "Auf dem Ziellaufwerk ist kein Speicherplatz mehr frei.",
  ],
  [
    /permission denied|access is denied|EACCES/i,
    "Keine Schreibrechte für den gewählten Speicherort.",
  ],
];

export function describeYtdlpError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  for (const [pattern, text] of ERROR_RULES) {
    if (pattern.test(message)) return text;
  }

  // Fall back to yt-dlp's own last ERROR line, which is the most specific part
  // of its output, rather than the warnings that precede it.
  const lines = message.split("\n").map((line) => line.trim()).filter(Boolean);
  const errorLine = [...lines].reverse().find((line) => line.startsWith("ERROR:"));
  return (errorLine ?? lines[lines.length - 1] ?? "Download fehlgeschlagen.")
    .replace(/^ERROR:\s*/, "")
    .slice(0, 300);
}

export async function getTitle(url: string): Promise<string> {
  if (!isValidYoutubeUrl(url)) {
    throw new UserError("Ungültige YouTube-URL.");
  }

  const binary = await ytdlpBinary();
  try {
    const stdout = await runYtdlp(binary, [
      ...baseArgs(),
      "--skip-download",
      "--print",
      "%(title)s",
      url.trim(),
    ]);
    return sanitizeFilename(stdout.trim().split("\n")[0] || "video");
  } catch (error) {
    throw new UserError(describeYtdlpError(error));
  }
}

const PROGRESS_PATTERN = /\[download\]\s+(\d{1,3}(?:\.\d+)?)%/;

export async function download(options: {
  jobId: string;
  url: string;
  format: YoutubeFormat;
  savePath: string;
  onProgress: (percent: number | null, message: string) => void;
}): Promise<JobResult> {
  const { jobId, url, format, savePath, onProgress } = options;

  if (!isValidYoutubeUrl(url)) {
    return { ok: false, error: "Ungültige YouTube-URL." };
  }

  let binary: string;
  try {
    binary = await ytdlpBinary();
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }

  // Download into a scratch directory: the real extension only becomes known
  // after yt-dlp finishes merging/converting.
  const tempDir = path.join(os.tmpdir(), `tool-app-yt-${randomUUID()}`);
  await mkdir(tempDir, { recursive: true });
  const cleanup = () => rm(tempDir, { recursive: true, force: true }).catch(() => {});

  try {
    onProgress(null, "Video wird abgerufen...");

    await runYtdlp(
      binary,
      [
        ...baseArgs(),
        ...formatArgs(format),
        "--newline",
        "--no-part",
        "-o",
        path.join(tempDir, "download.%(ext)s"),
        url.trim(),
      ],
      {
        jobId,
        onStdout: (line) => {
          const match = PROGRESS_PATTERN.exec(line);
          if (match) {
            onProgress(Math.min(100, Math.round(Number(match[1]))), "Video wird heruntergeladen...");
          } else if (/\[(ExtractAudio|Merger|VideoConvertor)\]/.test(line)) {
            onProgress(null, "Datei wird verarbeitet...");
          }
        },
      },
    );

    if (jobs.wasCanceled(jobId)) {
      await cleanup();
      return { ok: false, error: "Abgebrochen.", canceled: true };
    }

    const produced = await largestFileIn(tempDir);
    if (!produced) {
      await cleanup();
      return { ok: false, error: "Der Download hat keine Datei ergeben." };
    }

    // Honour the extension yt-dlp actually produced rather than the guess the
    // save dialog was seeded with.
    const actualExt = path.extname(produced);
    const chosenExt = path.extname(savePath);
    const finalPath =
      actualExt && actualExt.toLowerCase() !== chosenExt.toLowerCase()
        ? path.join(path.dirname(savePath), `${path.basename(savePath, chosenExt)}${actualExt}`)
        : savePath;

    onProgress(100, "Datei wird gespeichert...");
    await moveFile(produced, finalPath);
    await cleanup();

    return { ok: true, outputPath: finalPath };
  } catch (error) {
    await cleanup();
    if (jobs.wasCanceled(jobId)) {
      return { ok: false, error: "Abgebrochen.", canceled: true };
    }
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, error: "yt-dlp konnte nicht gestartet werden." };
    }
    return { ok: false, error: describeYtdlpError(error) };
  } finally {
    jobs.clear(jobId);
  }
}
