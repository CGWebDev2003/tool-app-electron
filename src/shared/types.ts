export const YOUTUBE_FORMATS = ["video", "audio_m4a", "audio_mp3"] as const;
export type YoutubeFormat = (typeof YOUTUBE_FORMATS)[number];

export const CONVERT_TARGETS = [
  "mp4",
  "webm",
  "mov",
  "gif",
  "mp3",
  "wav",
  "m4a",
  "ogg",
] as const;
export type ConvertTarget = (typeof CONVERT_TARGETS)[number];

/** Result shape shared by every long-running job. */
export type JobResult =
  | { ok: true; outputPath: string }
  | { ok: false; error: string; canceled?: boolean };

export type JobProgress = {
  jobId: string;
  /** 0..100, or null while the total size/duration is still unknown. */
  percent: number | null;
  message: string;
};

export type ToolStatus = {
  ffmpeg: { available: boolean; path: string | null };
  ytdlp: { available: boolean; path: string | null; source: YtdlpSource; version: string | null };
};

/** Where the yt-dlp binary came from — decides whether we may auto-update it. */
export type YtdlpSource = "managed" | "manual" | "system" | "env" | "none";

export type MediaInfo = {
  hasVideo: boolean;
  hasAudio: boolean;
  durationSeconds: number | null;
};
