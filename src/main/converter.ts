import { spawn } from "node:child_process";
import { rm, stat } from "node:fs/promises";
import path from "node:path";
import { FFMPEG_PATH, FFPROBE_PATH } from "./binaries";
import * as jobs from "./jobs";
import type { ConvertTarget, JobResult, MediaInfo } from "@shared/types";

export class UserError extends Error {}

export const TARGET_CATEGORY: Record<ConvertTarget, "video" | "audio" | "image"> = {
  mp4: "video",
  webm: "video",
  mov: "video",
  gif: "video",
  mp3: "audio",
  wav: "audio",
  m4a: "audio",
  ogg: "audio",
  png: "image",
  jpg: "image",
  webp: "image",
  bmp: "image",
  tiff: "image",
};

const IMAGE_CODEC_ARGS: Record<string, string[]> = {
  png: ["-c:v", "png"],
  jpg: ["-c:v", "mjpeg", "-q:v", "2"],
  webp: ["-c:v", "libwebp", "-quality", "90"],
  bmp: ["-c:v", "bmp"],
  tiff: ["-c:v", "tiff"],
};

/** Targets with no alpha channel — transparency has to be flattened first. */
const OPAQUE_TARGETS = new Set<ConvertTarget>(["jpg", "bmp"]);

/** Pixel format the flattened frame is handed to the encoder in. */
const FLATTEN_PIXEL_FORMAT: Record<string, string> = {
  jpg: "yuv420p",
  bmp: "rgb24",
};

/** How long a still picture turned into a video clip lasts. */
const STILL_IMAGE_SECONDS = 5;

const AUDIO_CODEC_ARGS: Record<string, string[]> = {
  mp3: ["-c:a", "libmp3lame", "-q:a", "2"],
  wav: ["-c:a", "pcm_s16le"],
  m4a: ["-c:a", "aac", "-b:a", "192k"],
  ogg: ["-c:a", "libvorbis", "-q:a", "5"],
};

const VIDEO_CODEC_ARGS: Record<string, string[]> = {
  mp4: ["-c:v", "libx264", "-preset", "medium", "-crf", "23", "-c:a", "aac", "-b:a", "192k"],
  mov: ["-c:v", "libx264", "-preset", "medium", "-crf", "23", "-c:a", "aac", "-b:a", "192k"],
  webm: ["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "32", "-c:a", "libopus"],
};

type ProbeStream = {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  disposition?: Record<string, number>;
};

function requireBinaries(): { ffmpeg: string; ffprobe: string } {
  if (!FFMPEG_PATH || !FFPROBE_PATH) {
    throw new UserError(
      "ffmpeg/ffprobe wurden nicht gefunden. Diese Plattform wird von der mitgelieferten ffmpeg-Version nicht unterstützt.",
    );
  }
  return { ffmpeg: FFMPEG_PATH, ffprobe: FFPROBE_PATH };
}

/** Codecs that carry a single still picture rather than moving images. */
const STILL_IMAGE_CODECS = new Set(["mjpeg", "png", "bmp", "gif", "tiff", "webp"]);

/**
 * Container formats ffprobe reports for a plain image file. They are what
 * separates a real picture from the still-image stream of embedded cover art.
 */
const IMAGE_CONTAINERS = new Set([
  "png_pipe",
  "jpeg_pipe",
  "image2",
  "webp_pipe",
  "bmp_pipe",
  "tiff_pipe",
]);

/**
 * MP3s and M4As with embedded cover art carry a still-image "video" stream.
 * Treating those as video (as the web version did) makes ffmpeg encode a
 * single JPEG into a video track, so they are recognised separately.
 */
function isCoverArt(stream: ProbeStream, fileHasAudio: boolean): boolean {
  if (stream.codec_type !== "video") return false;
  if (stream.disposition?.attached_pic === 1) return true;
  // Some files omit the disposition; a still picture beside an audio track is
  // cover art either way.
  return fileHasAudio && STILL_IMAGE_CODECS.has(stream.codec_name ?? "");
}

export function probe(inputPath: string): Promise<MediaInfo> {
  const { ffprobe } = requireBinaries();

  return new Promise((resolve, reject) => {
    const proc = spawn(
      ffprobe,
      [
        "-v",
        "quiet",
        "-print_format",
        "json",
        "-show_streams",
        "-show_format",
        inputPath,
      ],
      { windowsHide: true },
    );

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    proc.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new UserError("Die Datei konnte nicht gelesen werden (kein unterstütztes Medienformat)."));
        return;
      }
      try {
        const data = JSON.parse(stdout) as {
          streams?: ProbeStream[];
          format?: { duration?: string; format_name?: string };
        };
        const streams = data.streams ?? [];
        const hasAudio = streams.some((s) => s.codec_type === "audio");
        const videoStreams = streams.filter((s) => s.codec_type === "video");

        const containers = (data.format?.format_name ?? "").split(",");
        const isImage =
          videoStreams.length > 0 &&
          !hasAudio &&
          containers.some((name) => IMAGE_CONTAINERS.has(name));

        const duration = Number(data.format?.duration);
        const picture = videoStreams[0];

        resolve({
          hasVideo: !isImage && videoStreams.some((s) => !isCoverArt(s, hasAudio)),
          hasAudio,
          isImage,
          hasCoverArt: videoStreams.some((s) => isCoverArt(s, hasAudio)),
          width: picture?.width ?? null,
          height: picture?.height ?? null,
          // A still picture reports a nominal duration (a JPEG claims 0.04 s),
          // which would make the progress bar meaningless.
          durationSeconds:
            !isImage && Number.isFinite(duration) && duration > 0 ? duration : null,
        });
      } catch {
        reject(new UserError("Die ffprobe-Ausgabe konnte nicht gelesen werden."));
      }
    });
  });
}

export function buildFfmpegArgs(
  target: ConvertTarget,
  info: MediaInfo,
  inputPath: string,
  outputPath: string,
): string[] {
  const common = ["-hide_banner", "-loglevel", "error", "-progress", "pipe:1", "-nostats"];
  const category = TARGET_CATEGORY[target];

  if (category === "image") {
    // A video contributes its first frame, an audio file its cover art, and an
    // image itself — all three reduce to "take one picture from the input".
    if (!info.isImage && !info.hasVideo && !info.hasCoverArt) {
      throw new UserError(
        info.hasAudio
          ? "Die Datei enthält kein Bild. Nur Audiodateien mit eingebettetem Cover lassen sich in ein Bild umwandeln."
          : "Die Datei enthält kein Bild.",
      );
    }

    if (OPAQUE_TARGETS.has(target) && info.width && info.height) {
      // JPG and BMP have no alpha channel. Without this the transparent parts
      // would silently turn black instead of being composited onto white.
      return [
        ...common,
        "-f",
        "lavfi",
        "-i",
        `color=white:s=${info.width}x${info.height}`,
        "-i",
        inputPath,
        "-filter_complex",
        `[0][1]overlay=format=auto,format=${FLATTEN_PIXEL_FORMAT[target]}`,
        "-frames:v",
        "1",
        ...IMAGE_CODEC_ARGS[target],
        "-y",
        outputPath,
      ];
    }

    return [
      ...common,
      "-i",
      inputPath,
      "-map",
      "0:v:0",
      "-frames:v",
      "1",
      ...IMAGE_CODEC_ARGS[target],
      "-y",
      outputPath,
    ];
  }

  if (info.isImage && category === "video") {
    if (target === "gif") {
      // Keeps the original size: unlike a video, a picture is not shrunk to a
      // manageable frame size.
      return [
        ...common,
        "-i",
        inputPath,
        "-filter_complex",
        "[0:v]split[a][b];[a]palettegen[p];[b][p]paletteuse",
        "-frames:v",
        "1",
        "-y",
        outputPath,
      ];
    }

    // A still picture held for a few seconds, so the result is playable.
    return [
      ...common,
      "-loop",
      "1",
      "-i",
      inputPath,
      "-t",
      String(STILL_IMAGE_SECONDS),
      "-r",
      "25",
      "-vf",
      // h264 and vp9 need even dimensions.
      "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p",
      ...VIDEO_CODEC_ARGS[target],
      "-an",
      "-y",
      outputPath,
    ];
  }

  if (category === "audio") {
    if (!info.hasAudio) {
      throw new UserError("Die Datei enthält keine Audiospur.");
    }
    return [...common, "-i", inputPath, "-vn", ...AUDIO_CODEC_ARGS[target], "-y", outputPath];
  }

  if (target === "gif") {
    if (!info.hasVideo) {
      throw new UserError("Aus einer reinen Audiodatei kann kein GIF erstellt werden.");
    }
    // Two-pass palette generation in a single filter graph — without it GIFs
    // come out badly dithered against the default 216-colour web palette.
    return [
      ...common,
      "-i",
      inputPath,
      "-filter_complex",
      "[0:v]fps=12,scale=480:-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5",
      "-an",
      "-loop",
      "0",
      "-y",
      outputPath,
    ];
  }

  if (info.hasVideo) {
    return [
      ...common,
      "-i",
      inputPath,
      ...VIDEO_CODEC_ARGS[target],
      // Required for playback in QuickTime and most browsers.
      ...(target === "webm" ? [] : ["-pix_fmt", "yuv420p"]),
      ...(info.hasAudio ? [] : ["-an"]),
      "-y",
      outputPath,
    ];
  }

  if (info.hasAudio) {
    // Audio-only source going to a video container: give it a black picture so
    // players have something to show.
    return [
      ...common,
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=1280x720:r=25",
      "-i",
      inputPath,
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-shortest",
      ...VIDEO_CODEC_ARGS[target],
      ...(target === "webm" ? [] : ["-pix_fmt", "yuv420p"]),
      "-y",
      outputPath,
    ];
  }

  throw new UserError("Die Datei enthält weder eine Video- noch eine Audiospur.");
}

function runFfmpeg(
  args: string[],
  jobId: string,
  durationSeconds: number | null,
  onProgress: (percent: number | null, message: string) => void,
): Promise<void> {
  const { ffmpeg } = requireBinaries();

  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, args, { windowsHide: true });
    jobs.register(jobId, proc);

    let stderr = "";
    let stdoutBuffer = "";

    // `-progress pipe:1` emits `key=value` lines; out_time_us tracks position.
    proc.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const [key, value] = line.split("=");
        if (key !== "out_time_us" && key !== "out_time_ms") continue;
        const micros = key === "out_time_us" ? Number(value) : Number(value) * 1000;
        if (!Number.isFinite(micros) || !durationSeconds) {
          onProgress(null, "Datei wird konvertiert...");
          continue;
        }
        const percent = Math.min(99, Math.round((micros / 1_000_000 / durationSeconds) * 100));
        onProgress(Math.max(0, percent), "Datei wird konvertiert...");
      }
    });
    proc.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));

    proc.on("error", (error) => {
      jobs.unregister(jobId);
      reject(error);
    });
    proc.on("close", (code) => {
      jobs.unregister(jobId);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `ffmpeg wurde mit Code ${code} beendet.`));
    });
  });
}

export async function convert(options: {
  jobId: string;
  inputPath: string;
  target: ConvertTarget;
  savePath: string;
  onProgress: (percent: number | null, message: string) => void;
}): Promise<JobResult> {
  const { jobId, inputPath, target, savePath, onProgress } = options;

  // Checked before anything else: ffmpeg would truncate the file it is reading,
  // and the error cleanup below must never be allowed to delete the source.
  if (path.resolve(inputPath) === path.resolve(savePath)) {
    return { ok: false, error: "Quell- und Zieldatei dürfen nicht identisch sein." };
  }

  // Only a run that reached ffmpeg can have left a partial output behind, so
  // nothing is deleted for a failure that happened before that.
  let outputStarted = false;
  const discardPartialOutput = async () => {
    if (outputStarted) await rm(savePath, { force: true }).catch(() => {});
  };

  try {
    onProgress(null, "Datei wird analysiert...");
    const info = await probe(inputPath);

    const args = buildFfmpegArgs(target, info, inputPath, savePath);
    outputStarted = true;
    await runFfmpeg(args, jobId, info.durationSeconds, onProgress);

    if (jobs.wasCanceled(jobId)) {
      await discardPartialOutput();
      return { ok: false, error: "Abgebrochen.", canceled: true };
    }

    const stats = await stat(savePath).catch(() => null);
    if (!stats || stats.size === 0) {
      await discardPartialOutput();
      return { ok: false, error: "Die Konvertierung hat eine leere Datei ergeben." };
    }

    onProgress(100, "Fertig.");
    return { ok: true, outputPath: savePath };
  } catch (error) {
    // A run that was interrupted or failed leaves a truncated file behind.
    await discardPartialOutput();

    if (jobs.wasCanceled(jobId)) {
      return { ok: false, error: "Abgebrochen.", canceled: true };
    }

    if (error instanceof UserError) {
      return { ok: false, error: error.message };
    }
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, error: "ffmpeg konnte nicht gestartet werden." };
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error("conversion failed", message);
    return {
      ok: false,
      error: message.split("\n").filter(Boolean).slice(-1)[0] || "Konvertierung fehlgeschlagen.",
    };
  } finally {
    jobs.clear(jobId);
  }
}
