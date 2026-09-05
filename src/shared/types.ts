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
  "png",
  "jpg",
  "webp",
  "bmp",
  "tiff",
] as const;
export type ConvertTarget = (typeof CONVERT_TARGETS)[number];

export const DOCUMENT_TARGETS = ["pdf", "docx", "txt"] as const;
export type DocumentTarget = (typeof DOCUMENT_TARGETS)[number];

export type DocumentInfo = {
  format: DocumentTarget;
  /** Only known for PDFs. */
  pageCount: number | null;
  characterCount: number;
};

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

/** State machine of an electron-updater check, mirrored 1:1 to the renderer. */
export type UpdateStatus =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "available"; version: string }
  | { state: "not-available" }
  | { state: "downloading"; percent: number }
  | { state: "downloaded"; version: string }
  | { state: "error"; message: string };

export type MediaInfo = {
  hasVideo: boolean;
  hasAudio: boolean;
  /** The file is a single still picture rather than a video. */
  isImage: boolean;
  /** An audio file carrying embedded cover art, which can be extracted. */
  hasCoverArt: boolean;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
};
