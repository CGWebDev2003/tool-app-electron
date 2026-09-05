import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { "@shared": resolve("src/shared") },
    },
    build: {
      rollupOptions: {
        // selftest.ts is a second entry so `npm run test` can drive the real
        // main-process modules instead of a re-implementation of them.
        input: {
          index: resolve("src/main/index.ts"),
          selftest: resolve("src/main/selftest.ts"),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { "@shared": resolve("src/shared") },
    },
  },
  renderer: {
    root: "src/renderer",
    resolve: {
      alias: {
        "@renderer": resolve("src/renderer/src"),
        "@shared": resolve("src/shared"),
      },
    },
    build: {
      rollupOptions: {
        input: { index: resolve("src/renderer/index.html") },
      },
    },
    plugins: [react()],
  },
});
