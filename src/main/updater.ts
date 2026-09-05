import { app, BrowserWindow } from "electron";
import { autoUpdater } from "electron-updater";
import type { UpdateStatus } from "@shared/types";

let latestStatus: UpdateStatus = { state: "idle" };

function broadcast(status: UpdateStatus): void {
  latestStatus = status;
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send("update:status", status);
  }
}

export function currentUpdateStatus(): UpdateStatus {
  return latestStatus;
}

/**
 * Wires electron-updater to GitHub releases (see the `publish` block in
 * electron-builder.yml). Auto-download keeps the flow to a single click —
 * the user only decides when to restart into the new version.
 */
export function initAutoUpdater(): void {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => broadcast({ state: "checking" }));
  autoUpdater.on("update-available", (info) =>
    broadcast({ state: "available", version: info.version }),
  );
  autoUpdater.on("update-not-available", () => broadcast({ state: "not-available" }));
  autoUpdater.on("download-progress", (progress) =>
    broadcast({ state: "downloading", percent: Math.round(progress.percent) }),
  );
  autoUpdater.on("update-downloaded", (info) =>
    broadcast({ state: "downloaded", version: info.version }),
  );
  autoUpdater.on("error", (error) =>
    broadcast({ state: "error", message: error.message || String(error) }),
  );

  // Unpackaged (dev) runs have no update feed and would just error out.
  if (app.isPackaged) {
    void autoUpdater.checkForUpdates().catch(() => undefined);
  }
}

export async function checkForUpdates(): Promise<void> {
  if (!app.isPackaged) {
    broadcast({ state: "error", message: "Updates sind nur in installierten Builds verfügbar." });
    return;
  }
  await autoUpdater.checkForUpdates().catch((error: Error) =>
    broadcast({ state: "error", message: error.message }),
  );
}

export function quitAndInstall(): void {
  autoUpdater.quitAndInstall();
}
