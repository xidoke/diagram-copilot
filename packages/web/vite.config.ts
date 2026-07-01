import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // Dev-mode: the web app runs on :4700 while the diagram-copilot server
    // owns :4747 — same-origin fetches (`/api/*`, `/export`) must be proxied
    // or the browser blocks them with CORS (found in T25 e2e). In production
    // the server serves the bundle itself, so everything is same-origin and
    // the proxy is never involved.
    proxy: {
      "/api": "http://localhost:4747",
      "/export": "http://localhost:4747",
    },
  },
  resolve: {
    alias: [
      // `monaco-editor`'s package.json only has a "module" field, no
      // "main"/"exports". Vite's transform-time import analysis statically
      // resolves every import specifier in a file — including a dynamic
      // `import("monaco-editor")` (see `Drawer.tsx`'s
      // `configureSelfHostedMonaco`) — even under vitest's Node test
      // environment, whose SSR-context resolver hardcodes
      // `mainFields: ["main"]` with no config knob to add "module" back.
      // Point the *bare* specifier straight at the same ESM entry
      // "module" would've resolved to: alias resolution is a plain
      // filesystem lookup, not subject to that package-entry-field
      // restriction. `^monaco-editor$` (exact match only) so this doesn't
      // also swallow the unrelated deep import
      // `monaco-editor/esm/vs/editor/editor.worker?worker` — a plain
      // string key would prefix-match that too. The production client
      // build is unaffected (it already resolved here via "module").
      { find: /^monaco-editor$/, replacement: "monaco-editor/esm/vs/editor/editor.main.js" },
    ],
  },
});
