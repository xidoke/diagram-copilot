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
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, WS_PATH } from "./server.js";

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

  // T3: the workspace path is parsed and logged only; the watcher lands later.
  console.log(`[server] workspace: ${options.workspace}`);

  const server = createServer({ port: options.port, staticDir: resolveStaticDir() });

  try {
    const { url } = await server.start();
    console.log(`[server] listening on ${url}`);
    console.log(`[server] websocket endpoint ${url.replace(/^http/, "ws")}${WS_PATH}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      reportPortInUse(options.port);
      process.exit(1);
    }
    throw error;
  }

  const shutdown = () => {
    void server.stop().then(() => process.exit(0));
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
