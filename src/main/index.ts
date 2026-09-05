import { app, BrowserWindow, shell } from "electron";
import path from "node:path";
import { registerIpcHandlers } from "./ipc";
import * as jobs from "./jobs";

const isDev = !app.isPackaged;

// Ships alongside out/main/index.js in both dev and packaged builds (see the
// "resources" entry in electron-builder.yml's files list).
const ICON_PATH = path.join(__dirname, "../../resources/icon.png");

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 820,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#0a0a0a",
    title: "CG Tool App",
    icon: ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      // The renderer never touches Node directly — everything goes through the
      // narrow preload bridge.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  window.once("ready-to-show", () => window.show());

  // External links open in the real browser, never in an app window.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:$/.test(new URL(url).protocol)) shell.openExternal(url);
    return { action: "deny" };
  });

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    window.loadFile(path.join(__dirname, "../renderer/index.html"));
  }

  return window;
}

// A second instance would fight over the same userData directory.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const [existing] = BrowserWindow.getAllWindows();
    if (existing) {
      if (existing.isMinimized()) existing.restore();
      existing.focus();
    }
  });

  app.whenReady().then(() => {
    registerIpcHandlers();
    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  // Don't leave orphaned ffmpeg/yt-dlp processes behind.
  app.on("before-quit", () => jobs.cancelAll());
}
