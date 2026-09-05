import { BrowserWindow, dialog, ipcMain, shell } from "electron";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ffmpegAvailable,
  FFMPEG_PATH,
  installYtdlp,
  resolveYtdlp,
  useManualYtdlp,
} from "./binaries";
import * as converter from "./converter";
import * as youtube from "./youtube";
import * as jobs from "./jobs";
import { sanitizeFilename } from "./filename";
import {
  CONVERT_TARGETS,
  YOUTUBE_FORMATS,
  type ConvertTarget,
  type JobProgress,
  type JobResult,
  type ToolStatus,
  type YoutubeFormat,
} from "@shared/types";

const VIDEO_EXTENSIONS = ["mp4", "mkv", "mov", "webm", "avi", "flv", "wmv", "m4v", "mpg", "mpeg"];
const AUDIO_EXTENSIONS = ["mp3", "wav", "m4a", "aac", "ogg", "opus", "flac", "wma"];
const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "bmp", "tif", "tiff"];

function isYoutubeFormat(value: unknown): value is YoutubeFormat {
  return typeof value === "string" && (YOUTUBE_FORMATS as readonly string[]).includes(value);
}

function isConvertTarget(value: unknown): value is ConvertTarget {
  return typeof value === "string" && (CONVERT_TARGETS as readonly string[]).includes(value);
}

/** Sends progress back to the window that started the job. */
function progressSender(window: BrowserWindow | null, jobId: string) {
  return (percent: number | null, message: string) => {
    if (!window || window.isDestroyed()) return;
    const payload: JobProgress = { jobId, percent, message };
    window.webContents.send("job:progress", payload);
  };
}

function windowFor(event: Electron.IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender);
}

export function registerIpcHandlers(): void {
  ipcMain.handle("system:status", async (): Promise<ToolStatus> => {
    const [ffmpegOk, ytdlp] = await Promise.all([ffmpegAvailable(), resolveYtdlp()]);
    return {
      ffmpeg: { available: ffmpegOk, path: FFMPEG_PATH },
      ytdlp: {
        available: ytdlp.available,
        path: ytdlp.path,
        source: ytdlp.source,
        version: ytdlp.version,
      },
    };
  });

  ipcMain.handle(
    "system:installYtdlp",
    async (event): Promise<{ ok: true; version: string } | { ok: false; error: string }> => {
      const send = progressSender(windowFor(event), "ytdlp-install");
      try {
        const result = await installYtdlp(send);
        return { ok: true, version: result.version };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, error: `yt-dlp konnte nicht installiert werden: ${message}` };
      }
    },
  );

  ipcMain.handle(
    "system:pickYtdlp",
    async (event): Promise<{ ok: true; version: string } | { ok: false; error: string }> => {
      const window = windowFor(event);
      const options: Electron.OpenDialogOptions = {
        title: "yt-dlp auswählen",
        properties: ["openFile"],
        filters:
          process.platform === "win32"
            ? [
                { name: "Programme", extensions: ["exe"] },
                { name: "Alle Dateien", extensions: ["*"] },
              ]
            : [{ name: "Alle Dateien", extensions: ["*"] }],
      };
      const picked = window
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options);
      if (picked.canceled || !picked.filePaths[0]) {
        return { ok: false, error: "" };
      }
      return useManualYtdlp(picked.filePaths[0]);
    },
  );

  ipcMain.handle("dialog:pickMediaFile", async (event): Promise<string | null> => {
    const window = windowFor(event);
    const options: Electron.OpenDialogOptions = {
      title: "Datei auswählen",
      properties: ["openFile"],
      filters: [
        {
          name: "Medien",
          extensions: [...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS, ...IMAGE_EXTENSIONS],
        },
        { name: "Video", extensions: VIDEO_EXTENSIONS },
        { name: "Audio", extensions: AUDIO_EXTENSIONS },
        { name: "Bilder", extensions: IMAGE_EXTENSIONS },
        { name: "Alle Dateien", extensions: ["*"] },
      ],
    };
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle(
    "dialog:pickSavePath",
    async (event, args: { defaultName: string; extension: string }): Promise<string | null> => {
      const window = windowFor(event);
      const extension = String(args.extension || "").replace(/^\./, "");
      const base = sanitizeFilename(String(args.defaultName || "datei"));
      const options: Electron.SaveDialogOptions = {
        title: "Speichern unter",
        defaultPath: `${base}.${extension}`,
        filters: [
          { name: extension.toUpperCase(), extensions: [extension] },
          { name: "Alle Dateien", extensions: ["*"] },
        ],
      };
      const result = window
        ? await dialog.showSaveDialog(window, options)
        : await dialog.showSaveDialog(options);
      return result.canceled ? null : (result.filePath ?? null);
    },
  );

  ipcMain.handle(
    "youtube:getTitle",
    async (_event, url: unknown): Promise<{ ok: true; title: string } | { ok: false; error: string }> => {
      try {
        const title = await youtube.getTitle(String(url ?? ""));
        return { ok: true, title };
      } catch (error) {
        return { ok: false, error: (error as Error).message };
      }
    },
  );

  ipcMain.handle(
    "youtube:download",
    async (
      event,
      args: { jobId: string; url: string; format: string; savePath: string },
    ): Promise<JobResult> => {
      if (!isYoutubeFormat(args?.format)) {
        return { ok: false, error: "Ungültiges Format." };
      }
      if (typeof args.savePath !== "string" || !args.savePath) {
        return { ok: false, error: "Kein Speicherort gewählt." };
      }
      return youtube.download({
        jobId: String(args.jobId),
        url: String(args.url ?? ""),
        format: args.format,
        savePath: args.savePath,
        onProgress: progressSender(windowFor(event), String(args.jobId)),
      });
    },
  );

  ipcMain.handle(
    "convert:probe",
    async (_event, inputPath: unknown) => {
      try {
        const info = await converter.probe(String(inputPath ?? ""));
        return { ok: true as const, info };
      } catch (error) {
        return { ok: false as const, error: (error as Error).message };
      }
    },
  );

  ipcMain.handle(
    "convert:run",
    async (
      event,
      args: { jobId: string; inputPath: string; target: string; savePath: string },
    ): Promise<JobResult> => {
      if (!isConvertTarget(args?.target)) {
        return { ok: false, error: "Ungültiges Zielformat." };
      }
      if (typeof args.inputPath !== "string" || !args.inputPath) {
        return { ok: false, error: "Keine Datei ausgewählt." };
      }
      if (typeof args.savePath !== "string" || !args.savePath) {
        return { ok: false, error: "Kein Speicherort gewählt." };
      }
      return converter.convert({
        jobId: String(args.jobId),
        inputPath: args.inputPath,
        target: args.target,
        savePath: args.savePath,
        onProgress: progressSender(windowFor(event), String(args.jobId)),
      });
    },
  );

  ipcMain.handle(
    "file:writeBytes",
    async (
      _event,
      args: { filePath: string; data: Uint8Array },
    ): Promise<{ ok: true } | { ok: false; error: string }> => {
      try {
        await writeFile(String(args?.filePath ?? ""), Buffer.from(args.data));
        return { ok: true };
      } catch (error) {
        return { ok: false, error: (error as Error).message };
      }
    },
  );

  ipcMain.handle("job:cancel", (_event, jobId: unknown) => jobs.cancel(String(jobId ?? "")));

  ipcMain.handle("shell:revealFile", (_event, filePath: unknown) => {
    const target = String(filePath ?? "");
    if (target) shell.showItemInFolder(path.resolve(target));
  });
}
