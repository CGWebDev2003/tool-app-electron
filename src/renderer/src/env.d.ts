/// <reference types="vite/client" />

import type { ToolApi } from "../../preload";

declare global {
  interface Window {
    /** Bridge exposed by src/preload/index.ts via contextBridge. */
    api: ToolApi;
  }
}
