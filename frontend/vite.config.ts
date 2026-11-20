import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The build's identity, shown in Settings → Updates: BUILD_COMMIT from the environment (CI / Docker), else git.
const commit = (() => {
  if (process.env.BUILD_COMMIT) return process.env.BUILD_COMMIT.slice(0, 12);
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "";
  }
})();

// The build's version: <line>.<n> as the apps workflow numbered this commit — APP_VERSION from the environment (the
// deploy: deploy/app-version.py), else the newest release tag at or before this commit on the same line (git), else the
// line's own (src/version.ts LINE_VERSION).
const version = (() => {
  const given = process.env.APP_VERSION ?? "";
  if (/^\d+\.\d+\.\d+$/.test(given)) return given;
  try {
    const line = String(JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version ?? "").split(".").slice(0, 2).join(".");
    const tag = execSync("git describe --tags --abbrev=0 --match 'apps-v[0-9]*'", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    const m = /^apps-v(\d+\.\d+\.\d+)$/.exec(tag);
    return m && m[1].startsWith(`${line}.`) ? m[1] : "";
  } catch {
    return "";
  }
})();

// Dev proxy: forward API + WS to the FastAPI backend on :8080.
export default defineConfig({
  plugins: [react()],
  define: {
    __BUILD_COMMIT__: JSON.stringify(commit),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    __APP_VERSION__: JSON.stringify(version),
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://127.0.0.1:8080", changeOrigin: true },
      "/ws": { target: "ws://127.0.0.1:8080", ws: true },
    },
  },
});
