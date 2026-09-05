import { contextBridge, ipcRenderer } from "electron";
import type {
  ConvertTarget,
  JobProgress,
  JobResult,
  MediaInfo,
  ToolStatus,
  YoutubeFormat,
} from "@shared/types";

/** The complete surface the renderer is allowed to reach. */
const api = {
  system: {
    status: (): Promise<ToolStatus> => ipcRenderer.invoke("system:status"),
    installYtdlp: (): Promise<{ ok: true; version: string } | { ok: false; error: string }> =>
      ipcRenderer.invoke("system:installYtdlp"),
  },
  dialog: {
    pickMediaFile: (): Promise<string | null> => ipcRenderer.invoke("dialog:pickMediaFile"),
    pickSavePath: (defaultName: string, extension: string): Promise<string | null> =>
      ipcRenderer.invoke("dialog:pickSavePath", { defaultName, extension }),
  },
  youtube: {
    getTitle: (url: string): Promise<{ ok: true; title: string } | { ok: false; error: string }> =>
      ipcRenderer.invoke("youtube:getTitle", url),
    download: (args: {
      jobId: string;
      url: string;
      format: YoutubeFormat;
      savePath: string;
    }): Promise<JobResult> => ipcRenderer.invoke("youtube:download", args),
  },
  convert: {
    probe: (
      inputPath: string,
    ): Promise<{ ok: true; info: MediaInfo } | { ok: false; error: string }> =>
      ipcRenderer.invoke("convert:probe", inputPath),
    run: (args: {
      jobId: string;
      inputPath: string;
      target: ConvertTarget;
      savePath: string;
    }): Promise<JobResult> => ipcRenderer.invoke("convert:run", args),
  },
  job: {
    cancel: (jobId: string): Promise<boolean> => ipcRenderer.invoke("job:cancel", jobId),
  },
  shell: {
    revealFile: (filePath: string): Promise<void> =>
      ipcRenderer.invoke("shell:revealFile", filePath),
  },
  /** Returns an unsubscribe function. */
  onJobProgress: (listener: (progress: JobProgress) => void): (() => void) => {
    const handler = (_event: unknown, progress: JobProgress) => listener(progress);
    ipcRenderer.on("job:progress", handler);
    return () => ipcRenderer.removeListener("job:progress", handler);
  },
};

export type ToolApi = typeof api;

contextBridge.exposeInMainWorld("api", api);
