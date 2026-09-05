import { app } from "electron";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

type Config = {
  /** yt-dlp binary the user picked by hand, when the automatic install failed. */
  ytdlpPath?: string;
};

function configPath(): string {
  return path.join(app.getPath("userData"), "config.json");
}

export function readConfig(): Config {
  try {
    return JSON.parse(readFileSync(configPath(), "utf8")) as Config;
  } catch {
    // Missing or damaged config is not worth reporting — defaults apply.
    return {};
  }
}

export function updateConfig(patch: Config): void {
  const next = { ...readConfig(), ...patch };
  mkdirSync(path.dirname(configPath()), { recursive: true });
  writeFileSync(configPath(), `${JSON.stringify(next, null, 2)}\n`, "utf8");
}
