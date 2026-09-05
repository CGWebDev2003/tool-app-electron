import { app } from "electron";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { access, chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import ffmpegStatic from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import type { YtdlpSource } from "@shared/types";
import { readConfig, updateConfig } from "./config";

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

type VersionCheck = { ok: true; version: string } | { ok: false; reason: string };

/**
 * Turns a spawn failure into a concrete reason. Windows deserves special care:
 * when Defender blocks process creation, CreateProcess answers with
 * ERROR_VIRUS_INFECTED, which libuv cannot map and reports as "UNKNOWN". On
 * that platform an unmapped spawn error is therefore almost always a blocked
 * executable, not a mystery.
 */
export function describeSpawnError(error: NodeJS.ErrnoException): string {
  if (error.code === "ENOENT") {
    return "Die Datei wurde nicht gefunden (möglicherweise von einem Virenscanner entfernt).";
  }
  if (error.code === "EACCES" || error.code === "EPERM") {
    return "Keine Ausführungsrechte für die Datei.";
  }
  if (process.platform === "win32" && (error.code === "UNKNOWN" || /UNKNOWN/.test(error.message))) {
    return (
      "Windows hat das Starten der Datei blockiert. Das meldet der Virenscanner, wenn er die " +
      "Datei für Schadsoftware hält — bei yt-dlp ist das ein bekannter Fehlalarm."
    );
  }
  return error.message;
}

/**
 * Runs `<binary> --version`, keeping the real failure reason. The reason is
 * what tells a user whether the file is missing, blocked, or simply broken,
 * so it must not be collapsed into a plain null.
 */
function checkVersion(binary: string, flag = "--version"): Promise<VersionCheck> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let proc: ReturnType<typeof spawn>;

    try {
      // On Windows spawn can throw synchronously instead of emitting "error",
      // which would otherwise escape this promise as a raw "spawn UNKNOWN".
      proc = spawn(binary, [flag], { windowsHide: true });
    } catch (error) {
      resolve({ ok: false, reason: describeSpawnError(error as NodeJS.ErrnoException) });
      return;
    }

    proc.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    proc.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));

    proc.on("error", (error: NodeJS.ErrnoException) => {
      resolve({ ok: false, reason: describeSpawnError(error) });
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve({ ok: true, version: stdout.trim().split("\n")[0] });
        return;
      }
      const detail = stderr.trim().split("\n").slice(-1)[0] || `Beendet mit Code ${code}`;
      resolve({ ok: false, reason: detail });
    });
  });
}

async function runVersion(binary: string, flag = "--version"): Promise<string | null> {
  const result = await checkVersion(binary, flag);
  return result.ok ? result.version : null;
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
  const configured = readConfig().ytdlpPath;
  if (configured) {
    candidates.push({ path: configured, source: "manual" });
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

/** First bytes of an executable, per platform — an HTML error page has none of them. */
function looksExecutable(header: Buffer): boolean {
  if (process.platform === "win32") return header.subarray(0, 2).toString("latin1") === "MZ";
  if (process.platform === "darwin") {
    const magic = header.readUInt32BE(0);
    // Mach-O (both endians) and the universal-binary wrapper.
    return [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(magic);
  }
  return header.subarray(0, 4).toString("latin1") === "\x7fELF";
}

/**
 * Verifies the binary actually runs. Windows virus scanners inspect a freshly
 * written file and briefly lock it, so a single immediate attempt is not proof
 * of failure.
 */
async function verifyRuns(binaryPath: string): Promise<VersionCheck> {
  let last: VersionCheck = { ok: false, reason: "Nicht geprüft." };

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 700));
    last = await checkVersion(binaryPath);
    if (last.ok) return last;
  }

  return last;
}

/** Turns a failed verification into something the user can act on. */
async function explainVerifyFailure(binaryPath: string, reason: string): Promise<string> {
  const stillThere = await access(binaryPath, fsConstants.F_OK)
    .then(() => true)
    .catch(() => false);

  const manualHint =
    process.platform === "win32"
      ? 'yt-dlp separat installieren ("winget install yt-dlp.yt-dlp") und hier auf ' +
        '"Manuell auswählen" klicken'
      : process.platform === "darwin"
        ? 'yt-dlp separat installieren ("brew install yt-dlp") und hier auf "Manuell auswählen" ' +
          "klicken"
        : 'yt-dlp über die Paketverwaltung installieren und hier auf "Manuell auswählen" klicken';

  if (!stillThere) {
    return (
      "Die heruntergeladene Datei wurde sofort wieder entfernt — das macht praktisch immer ein " +
      "Virenscanner. Entweder yt-dlp dort als Ausnahme eintragen und es erneut versuchen, " +
      `oder ${manualHint}.`
    );
  }

  const defenderHint =
    process.platform === "win32"
      ? " Unter Windows steht der Vorgang in der Windows-Sicherheit unter „Viren- und " +
        "Bedrohungsschutz“ → „Schutzverlauf“; dort lässt sich die Datei auch zulassen."
      : "";

  return (
    `${reason} Die Datei selbst liegt unter ${binaryPath}.${defenderHint} ` +
    `Alternativ ${manualHint}.`
  );
}

/**
 * Downloads the latest yt-dlp release into userData. YouTube breaks older
 * versions regularly, so this doubles as the update path.
 */
export async function installYtdlp(
  onProgress?: (percent: number | null, message: string) => void,
): Promise<{ path: string; version: string }> {
  const target = managedYtdlpPath();
  const assetName = ytdlpAssetName();
  const downloadUrl = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${assetName}`;

  onProgress?.(null, "yt-dlp wird heruntergeladen...");

  await mkdir(path.dirname(target), { recursive: true });
  const tempPath = `${target}.download`;
  await rm(tempPath, { force: true });

  let response: Response;
  try {
    response = await fetch(downloadUrl, { redirect: "follow" });
  } catch (error) {
    throw new Error(
      `github.com ist nicht erreichbar (${(error as Error).message}). Prüfe Internetverbindung, ` +
        "Firewall oder Proxy.",
    );
  }

  if (!response.ok || !response.body) {
    throw new Error(
      `Der Download von ${assetName} wurde mit HTTP ${response.status} abgelehnt.`,
    );
  }

  const totalBytes = Number(response.headers.get("content-length")) || 0;
  let receivedBytes = 0;

  // Counting inside the pipeline rather than on a "data" listener keeps the
  // stream paused until the destination is attached.
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      receivedBytes += chunk.length;
      const percent = totalBytes ? Math.round((receivedBytes / totalBytes) * 100) : null;
      onProgress?.(percent, "yt-dlp wird heruntergeladen...");
      callback(null, chunk);
    },
  });

  try {
    await pipeline(
      Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      counter,
      createWriteStream(tempPath),
    );

    const size = (await stat(tempPath)).size;
    if (size === 0) {
      throw new Error("Der Download war leer.");
    }
    // A connection cut mid-transfer otherwise leaves a plausible-looking file.
    if (totalBytes && size !== totalBytes) {
      throw new Error(
        `Der Download ist unvollständig (${size} von ${totalBytes} Bytes). Bitte erneut versuchen.`,
      );
    }

    const handle = await open(tempPath, "r");
    const header = Buffer.alloc(8);
    await handle.read(header, 0, 8, 0);
    await handle.close();

    if (!looksExecutable(header)) {
      // Captive portals and proxies answer with an HTML page under a 200.
      const preview = (await readFile(tempPath, "latin1")).slice(0, 120).replace(/\s+/g, " ");
      throw new Error(
        "Die heruntergeladene Datei ist kein Programm — vermutlich hat ein Proxy oder " +
          `Netzwerkfilter die Anfrage beantwortet. Anfang der Datei: "${preview}"`,
      );
    }

    if (process.platform !== "win32") {
      await chmod(tempPath, 0o755);
    }
    // Windows refuses to rename onto an existing file.
    await rm(target, { force: true });
    await rename(tempPath, target);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }

  onProgress?.(null, "Installation wird geprüft...");
  const verified = await verifyRuns(target);
  if (!verified.ok) {
    // The file stays in place on purpose: it is the evidence, and a scanner
    // exception can make it work without downloading it again.
    throw new Error(await explainVerifyFailure(target, verified.reason));
  }

  updateConfig({ ytdlpPath: undefined });
  onProgress?.(100, `yt-dlp ${verified.version} ist bereit.`);
  return { path: target, version: verified.version };
}

/**
 * Escape hatch when the automatic install cannot work: the user points at a
 * yt-dlp they installed themselves, and it is remembered.
 */
export async function useManualYtdlp(
  binaryPath: string,
): Promise<{ ok: true; version: string } | { ok: false; error: string }> {
  const check = await checkVersion(binaryPath);
  if (!check.ok) {
    return { ok: false, error: `Diese Datei lässt sich nicht als yt-dlp starten: ${check.reason}` };
  }

  updateConfig({ ytdlpPath: binaryPath });
  return { ok: true, version: check.version };
}
