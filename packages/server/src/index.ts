#!/usr/bin/env node
/**
 * diagram-copilot server CLI entry (the package `bin`).
 *
 * Parses `--port` / `--workspace`, resolves the web bundle location, and
 * starts the server on a FIXED port (default 4747). If the port is busy we
 * fail loudly with recovery instructions rather than silently hopping to
 * another port — the MCP registration is pinned to a known port, so a
 * surprise port would break Claude Code's connection.
 */
import { parseArgs } from "node:util";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerMessage } from "@diagram-copilot/core";
import { createServer, WELCOME_WORKSPACE, WS_PATH } from "./server.js";
import { expandTilde } from "./mcp/tools/export-file.js";
import { createClientUpdateHandler } from "./client-updates.js";
import { MCP_PATH, createOpenHandler, createLifecycleHttpHandler } from "./http.js";
import { createEditApiHandler } from "./edit-executor.js";
import { createLifecycleOps } from "./workspace/lifecycle.js";
import { createLayoutApiHandler } from "./layout-overrides.js";
import { createNotesApiHandler, createNotesStore } from "./notes.js";
import { createDslApiHandler } from "./dsl-api.js";
import { createTemplatesApiHandler } from "./templates.js";
import { createMcpHandler, type McpInfo } from "./mcp/handler.js";
import { createSnapshotBroker } from "./mcp/snapshot-broker.js";
import { createHeadlessRenderer } from "./headless/renderer.js";
import { createHistoryStore } from "./history/store.js";
import { createUndoApiHandler } from "./history/http.js";
import { buildWelcomeMessages, createWorkspaceWatcher, type WorkspaceWatcher } from "./workspace/watcher.js";

/** Fixed default port. Kept in sync with the MCP endpoint registration. */
export const DEFAULT_PORT = 4747;

/** Default workspace root (`~/diagram-copilot/workspace`). */
export function defaultWorkspaceDir(): string {
  return path.join(os.homedir(), "diagram-copilot", "workspace");
}

/**
 * Default extra whitelist root for `export_diagram` when no `--export-root` is
 * given: an Obsidian iCloud vault. `~` is expanded by the export tool at call
 * time (see `expandTilde` in `mcp/tools/export-file.ts`), so it is kept literal
 * here. The resolved `--export-dir` is ALWAYS a root too (added in `main`).
 */
export const DEFAULT_OBSIDIAN_VAULT_ROOT =
  "~/Library/Mobile Documents/iCloud~md~obsidian/Documents/Obsidian_Vault";

/**
 * Env var declaring EXTRA `export_diagram` whitelist roots, ADDED ON TOP of
 * `--export-root` (or the Obsidian vault default) — never replaces them. This
 * lets a deployment (e.g. `pnpm dev`, which passes no CLI flags) grant an
 * extra root without editing any script or code, by exporting the var before
 * launch (DGC-81).
 */
export const EXPORT_ROOTS_ENV_VAR = "DIAGRAM_COPILOT_EXPORT_ROOTS";

/**
 * Parse {@link EXPORT_ROOTS_ENV_VAR} into a list of extra whitelist roots.
 * Entries are separated by `path.delimiter` (`:` on macOS/Linux, `;` on
 * Windows), trimmed, and empty entries — `undefined`/`""` input, or a blank
 * slot between two delimiters (`"/a::/b"`) — are dropped. A leading `~`/`~/`
 * in an entry is expanded against the home directory via {@link expandTilde}
 * (the same helper `resolveExportDestination` uses), so `~/vault` works the
 * same way it does for `--export-root`.
 */
export function parseExportRootsEnv(value: string | undefined): string[] {
  if (value === undefined) return [];
  return value
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => expandTilde(entry));
}

/**
 * Locate the built web bundle relative to this module. Resolves to
 * `packages/web/dist` from both `src/` (tsx dev) and `dist/` (built bin).
 */
export function resolveStaticDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../web/dist");
}

/**
 * This package's version, read from `package.json` at runtime (resolves from
 * both `src/` and `dist/`) so the MCP `ping` answer never drifts from the
 * published version.
 */
export function serverVersion(): string {
  const require = createRequire(import.meta.url);
  const pkg = require("../package.json") as { version: string };
  return pkg.version;
}

interface CliOptions {
  port: number;
  workspace: string;
  exportDir: string;
  /**
   * EXTRA whitelisted roots a caller-supplied `export_diagram` `path` may write
   * into, beyond the always-allowed `exportDir`. From `--export-root`
   * (repeatable, or the Obsidian vault default when absent) PLUS whatever
   * {@link EXPORT_ROOTS_ENV_VAR} declares — additive, never a replacement. May
   * contain `~` — expanded by the export tool at call time (already expanded
   * here for the env-var entries, see {@link parseExportRootsEnv}).
   */
  exportRoots: string[];
}

/**
 * Parse argv (+ env) into validated CLI options, throwing a friendly error on
 * bad input. `env` defaults to `process.env` and is only a parameter so tests
 * can pass a fake one without mutating global state.
 */
export function parseCliArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CliOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: "string" },
      workspace: { type: "string" },
      "export-dir": { type: "string" },
      // Repeatable: each `--export-root DIR` adds a whitelist root for
      // `export_diagram`. Absent → the Obsidian vault default.
      "export-root": { type: "string", multiple: true },
    },
  });

  let port = DEFAULT_PORT;
  if (values.port !== undefined) {
    port = Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error(`Invalid --port "${values.port}" (expected an integer 0-65535).`);
    }
  }

  const workspace = values.workspace ?? defaultWorkspaceDir();
  // Default lives under the resolved workspace (not the package default),
  // so `--workspace foo` without `--export-dir` saves to `foo/exports`.
  const exportDir = values["export-dir"] ?? path.join(workspace, "exports");

  // Extra whitelist roots for `export_diagram` beyond `exportDir` (which the
  // tool always allows implicitly): the `--export-root` entries (or the
  // Obsidian vault default when none are given), PLUS anything declared via
  // `DIAGRAM_COPILOT_EXPORT_ROOTS` — additive, so declaring an extra root
  // never requires touching a flag or script (DGC-81).
  const cliRoots = values["export-root"] ?? [DEFAULT_OBSIDIAN_VAULT_ROOT];
  const envRoots = parseExportRootsEnv(env[EXPORT_ROOTS_ENV_VAR]);
  const exportRoots = [...cliRoots, ...envRoots];

  return { port, workspace, exportDir, exportRoots };
}

function reportPortInUse(port: number): void {
  console.error(`\nPort ${port} is already in use — diagram-copilot will not switch ports.`);
  console.error("Another server is likely already running, or something else holds the port.\n");
  console.error("Start on a different port:");
  console.error(`  diagram-copilot-server --port <PORT>\n`);
  console.error("Then point the MCP endpoint at the same port so Claude Code can reach it:");
  console.error(`  claude mcp add diagram-copilot --transport http http://127.0.0.1:<PORT>/mcp\n`);
}

async function main(): Promise<void> {
  let options: CliOptions;
  try {
    options = parseCliArgs(process.argv.slice(2));
  } catch (error) {
    console.error(String((error as Error).message));
    process.exit(1);
  }

  console.log(`[server] workspace: ${options.workspace}`);
  console.log(`[server] export dir: ${options.exportDir}`);
  console.log(`[server] export roots: ${[options.exportDir, ...options.exportRoots].join(", ")}`);

  // `getWelcome` is wired to the server at creation time, but the watcher it
  // reads from is only created after `start()` succeeds (no point scanning
  // the workspace if the port is taken). The mutable ref lets each new
  // connection see whatever the watcher currently knows, once it exists.
  let watcher: WorkspaceWatcher | undefined;
  const getWelcome = (): ServerMessage[] =>
    watcher ? buildWelcomeMessages(options.workspace, watcher.getState()) : [WELCOME_WORKSPACE];

  // Undo/redo safety net (T31): a per-diagram snapshot ring persisted under the
  // workspace's `.history/`. Created up front so its `onApplied` hook can be
  // handed to the watcher below; the MCP tools and `/api/undo` read it back via
  // the same mutable-watcher-ref pattern.
  const history = createHistoryStore({ dir: options.workspace });

  // Live facts for MCP tools — same mutable-watcher-ref pattern as
  // `getWelcome`, so `ping` (and later T19/T20 tools) always answer from the
  // watcher's current state.
  const getMcpInfo = (): McpInfo => ({
    version: serverVersion(),
    workspaceDir: options.workspace,
    active: watcher?.getState().active ?? null,
  });

  // Correlates get_snapshot requests with client-rendered PNG responses
  // (T24). Shared between the MCP tool (createRequest) and the WS hub's
  // snapshot-response route (resolve).
  const snapshotBroker = createSnapshotBroker();

  // Headless render fallback (DGC-82): when get_snapshot / export_diagram
  // find no connected canvas, this launches a hidden system-Chrome page at
  // THIS server's own URL — it registers as a normal WS client and renders
  // with the exact same canvas code, then is reaped after an idle period.
  // `server` and `watcher` are referenced lazily (arrow bodies run at
  // fallback time, long after both consts initialize).
  const headless = createHeadlessRenderer({
    url: () => `http://127.0.0.1:${server.port}`,
    getActive: () => watcher?.getState().active ?? null,
    log: (line) => console.log(`[server] headless: ${line}`),
  });

  // Per-diagram markdown notes (DGC-63): one store bound to the workspace dir,
  // shared by the MCP tools (get_notes/set_notes) and the `/api/notes/:name`
  // HTTP handler below so both go through the same sanitize + 1 MB cap.
  const notesStore = createNotesStore(options.workspace);

  // Rename + trash/restore (DGC-65). Bound to the workspace dir, driving the
  // watcher through the same mutable-ref so its ops move `.arch` + sidecars and
  // immediately reconcile/broadcast. Shared by the MCP tools and the
  // `/api/rename` + `/api/trash` HTTP routes below.
  const lifecycle = createLifecycleOps(options.workspace, () => watcher ?? null);

  const server = createServer({
    port: options.port,
    staticDir: resolveStaticDir(),
    // `POST /export` (T29 / DGC-49) writes saved diagram images here; the
    // dir itself is created lazily by `saveExport` on first use, not here.
    exportDir: options.exportDir,
    getWelcome,
    // Same mutable-watcher-ref pattern as `getWelcome`/`getMcpInfo`: the
    // watcher is created after the port is secured, so tools read `null` until
    // then and the live `WorkspaceOps` (list/open) afterwards.
    mcpHandler: createMcpHandler({
      getInfo: getMcpInfo,
      getWorkspace: () => watcher ?? null,
      // `server` is referenced lazily (arrow bodies run at tool-call time,
      // long after this const initializes), so the self-reference is safe.
      snapshot: {
        broker: snapshotBroker,
        broadcast: (message) => server.broadcast(message),
        clientCount: () => server.clients.size,
        getActive: () => watcher?.getState().active ?? null,
        // No client connected → launch the hidden canvas (DGC-82).
        ensureClient: (target) => headless.ensureClient(target),
      },
      getHistory: () => history,
      // Notes read/write store for get_notes/set_notes (DGC-63).
      notes: notesStore,
      // Rename/delete/list_trash/restore tools (DGC-65).
      getLifecycle: () => lifecycle,
      // `export_diagram` (F2) — render-to-file destinations: default dir plus
      // the whitelist a caller `path` may write into.
      exportPaths: { dir: options.exportDir, roots: options.exportRoots },
    }),
    // `POST /api/open` (T36 / DGC-57) — diagram picker's open/create action.
    openHandler: createOpenHandler(() => watcher ?? null),
    // `POST /api/rename` + `/api/trash` (DGC-65) — picker's rename/delete actions.
    lifecycleHandler: createLifecycleHttpHandler(() => lifecycle),
    // `POST /api/edit` (DGC-78) — visual editing: canvas gestures (Delete key,
    // inline rename) write back to the DSL through the shared edit executor.
    editHandler: createEditApiHandler(() => watcher ?? null),
    // Layout-override sidecar API — reads/writes `<name>.layout.json` next to
    // each diagram in the workspace the CLI just resolved.
    apiHandler: createLayoutApiHandler(options.workspace),
    // Per-diagram markdown notes API — reads/writes `<name>.notes.md` next to
    // each diagram (DGC-63). Same workspace the CLI just resolved.
    notesHandler: createNotesApiHandler(options.workspace),
    // Template gallery API — "New from template ▸" in the picker (DGC-66/F6).
    // Same mutable-watcher-ref pattern as `openHandler`: `use` needs the live
    // watcher to create+activate the new diagram, so it reads `null` until
    // `watcher` below is assigned.
    templatesHandler: createTemplatesApiHandler(() => watcher ?? null),
    // Raw DSL read API (`GET /api/dsl/:name`, DGC-79) — reads `<name>.arch`
    // verbatim from the workspace the CLI just resolved, for the diff overlay.
    dslHandler: createDslApiHandler(options.workspace),
    // Web ⌘Z / Undo button → same undo logic as the MCP tool, over HTTP (T31).
    undoHandler: createUndoApiHandler(() => watcher ?? null, () => history),
    // Client (drawer/canvas) update frames → workspace writes with origin
    // routing + echo exclusion + baseVersion conflict handling (T21). Same
    // mutable-watcher-ref pattern: updates arriving before the watcher exists
    // are dropped with a log.
    onClientUpdate: createClientUpdateHandler(() => watcher ?? null),
    // Canvas-rendered snapshot frames → the broker settles the pending
    // get_snapshot call awaiting this correlation id (T24). Any snapshot
    // traffic also keeps the hidden headless canvas alive: once it is
    // connected the tools take the normal fast path (clientCount > 0) and
    // never re-enter ensureClient, so this is where its idle clock resets.
    onSnapshotResponse: (message) => {
      headless.touch();
      void snapshotBroker.resolve(message);
    },
  });

  try {
    const { url } = await server.start();
    console.log(`[server] listening on ${url}`);
    console.log(`[server] websocket endpoint ${url.replace(/^http/, "ws")}${WS_PATH}`);
    console.log(`[server] mcp endpoint ${url}${MCP_PATH} (streamable http, stateless)`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      reportPortInUse(options.port);
      process.exit(1);
    }
    throw error;
  }

  watcher = createWorkspaceWatcher({
    dir: options.workspace,
    broadcast: server.broadcast,
    // Record every successful update as a pre-apply snapshot for undo/redo.
    onApplied: history.onApplied,
  });
  await watcher.start();
  const state = watcher.getState();
  console.log(
    `[server] workspace scan: ${state.diagrams.length} diagram(s) found, active "${state.active ?? "untitled"}"`,
  );

  const shutdown = () => {
    void Promise.all([watcher?.stop(), headless.close(), server.stop()]).then(() =>
      process.exit(0),
    );
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Run only when executed directly as the bin, not when imported (e.g. tests).
const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  void main();
}
