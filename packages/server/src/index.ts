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
import { createClientUpdateHandler } from "./client-updates.js";
import { MCP_PATH } from "./http.js";
import { createMcpHandler, type McpInfo } from "./mcp/handler.js";
import { createSnapshotBroker } from "./mcp/snapshot-broker.js";
import { buildWelcomeMessages, createWorkspaceWatcher, type WorkspaceWatcher } from "./workspace/watcher.js";

/** Fixed default port. Kept in sync with the MCP endpoint registration. */
export const DEFAULT_PORT = 4747;

/** Default workspace root (`~/diagram-copilot/workspace`). */
export function defaultWorkspaceDir(): string {
  return path.join(os.homedir(), "diagram-copilot", "workspace");
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
}

/** Parse argv into validated CLI options, throwing a friendly error on bad input. */
export function parseCliArgs(argv: string[]): CliOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: "string" },
      workspace: { type: "string" },
    },
  });

  let port = DEFAULT_PORT;
  if (values.port !== undefined) {
    port = Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error(`Invalid --port "${values.port}" (expected an integer 0-65535).`);
    }
  }

  return { port, workspace: values.workspace ?? defaultWorkspaceDir() };
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

  // `getWelcome` is wired to the server at creation time, but the watcher it
  // reads from is only created after `start()` succeeds (no point scanning
  // the workspace if the port is taken). The mutable ref lets each new
  // connection see whatever the watcher currently knows, once it exists.
  let watcher: WorkspaceWatcher | undefined;
  const getWelcome = (): ServerMessage[] =>
    watcher ? buildWelcomeMessages(options.workspace, watcher.getState()) : [WELCOME_WORKSPACE];

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

  const server = createServer({
    port: options.port,
    staticDir: resolveStaticDir(),
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
      },
    }),
    // Client (drawer/canvas) update frames → workspace writes with origin
    // routing + echo exclusion + baseVersion conflict handling (T21). Same
    // mutable-watcher-ref pattern: updates arriving before the watcher exists
    // are dropped with a log.
    onClientUpdate: createClientUpdateHandler(() => watcher ?? null),
    // Canvas-rendered snapshot frames → the broker settles the pending
    // get_snapshot call awaiting this correlation id (T24).
    onSnapshotResponse: (message) => void snapshotBroker.resolve(message),
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

  watcher = createWorkspaceWatcher({ dir: options.workspace, broadcast: server.broadcast });
  await watcher.start();
  const state = watcher.getState();
  console.log(
    `[server] workspace scan: ${state.diagrams.length} diagram(s) found, active "${state.active ?? "untitled"}"`,
  );

  const shutdown = () => {
    void Promise.all([watcher?.stop(), server.stop()]).then(() => process.exit(0));
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
