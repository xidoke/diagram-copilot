/**
 * E2E for the headless export race (DGC-101): after `open_diagram` (or a
 * `set_diagram` that changes direction), an IMMEDIATE `export_diagram` on the
 * headless path must return pixels of the CURRENT diagram — never the
 * previously rendered one. Before the render gate (web snapshotResponder),
 * the reused hidden canvas answered the instant its connection state named
 * the new diagram, capturing the OLD DOM: a PNG with the right name and the
 * wrong image.
 *
 * This suite exercises the REAL stack — built server (`dist/index.js`) on a
 * dedicated port (4854, never 4747), the built web bundle, a real hidden
 * headless Chrome, real MCP tool calls over Streamable HTTP — so it is
 * gated behind an env flag and skipped in the normal unit run:
 *
 *   pnpm -r build   # the server serves packages/web/dist — build first
 *   DGC_E2E=1 pnpm --filter @diagram-copilot/server exec vitest run test/e2e-export-race.test.ts
 *
 * Signal design: diagram `a` is a 6-node chain laid out `direction right`
 * (much wider than tall); `b` is the same chain `direction down` (much
 * taller than wide). Orientation of the exported PNG therefore identifies
 * WHICH content was rasterized without any pixel-diff flakiness, and the
 * five immediate exports of `b` must also all agree with each other.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { pngDimensions } from "../src/mcp/tools/snapshot.js";

const E2E = process.env.DGC_E2E === "1";

/** Dedicated E2E port — NEVER 4747 (a live server may be serving another session). */
const PORT = 4854;

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_PKG_DIR = join(HERE, "..");
const SERVER_BIN = join(SERVER_PKG_DIR, "dist", "index.js");

/** 6-node chain, laid out left→right: the export is much WIDER than tall. */
const DSL_A = [
  "direction right",
  "",
  "N1",
  "N2",
  "N3",
  "N4",
  "N5",
  "N6",
  "",
  "N1 > N2",
  "N2 > N3",
  "N3 > N4",
  "N4 > N5",
  "N5 > N6",
  "",
].join("\n");

/** The same chain top→bottom: much TALLER than wide. */
const DSL_B = DSL_A.replace("direction right", "direction down");

/** DSL_B flipped back to `direction right` — the set_diagram version-race probe. */
const DSL_B_WIDE = DSL_A;

interface Dims {
  width: number;
  height: number;
}

describe.runIf(E2E)("e2e: headless export returns the CURRENT diagram's pixels (DGC-101)", () => {
  let workspaceDir: string;
  let proc: ChildProcess;
  let logs = "";
  let client: Client;

  /** Call an MCP tool; throw with the tool's text on isError so failures read well. */
  async function call(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const result = await client.callTool({ name, arguments: args });
    const text = Array.isArray(result.content)
      ? result.content
          .map((c) => (typeof c === "object" && c !== null && "text" in c ? String((c as { text: unknown }).text) : ""))
          .join("\n")
      : "";
    if (result.isError === true) {
      throw new Error(`${name} failed: ${text}\n--- server logs tail ---\n${logs.slice(-2000)}`);
    }
    return text;
  }

  /** `export_diagram` → parse the written path out of the receipt → PNG IHDR dims. */
  async function exportDims(): Promise<Dims> {
    const text = await call("export_diagram");
    const match = / to (.+\.png) \(PNG/.exec(text);
    if (!match) throw new Error(`could not parse export path from: ${text}`);
    const dims = pngDimensions(readFileSync(match[1]!).toString("base64"));
    if (!dims) throw new Error(`exported file is not a valid PNG: ${match[1]}`);
    return dims;
  }

  beforeAll(async () => {
    workspaceDir = mkdtempSync(join(tmpdir(), "dgc-101-e2e-"));
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(join(workspaceDir, "a.arch"), DSL_A, "utf8");
    writeFileSync(join(workspaceDir, "b.arch"), DSL_B, "utf8");

    proc = spawn(
      process.execPath,
      [
        SERVER_BIN,
        "--port",
        String(PORT),
        "--workspace",
        workspaceDir,
        "--export-dir",
        path.join(workspaceDir, "exports"),
      ],
      { cwd: SERVER_PKG_DIR, stdio: ["ignore", "pipe", "pipe"] },
    );
    proc.stdout?.on("data", (chunk: Buffer) => (logs += chunk.toString()));
    proc.stderr?.on("data", (chunk: Buffer) => (logs += chunk.toString()));

    const deadline = Date.now() + 15_000;
    for (;;) {
      try {
        await fetch(`http://127.0.0.1:${PORT}/`);
        break;
      } catch {
        if (Date.now() > deadline) {
          throw new Error(`server did not come up on ${PORT}. Logs:\n${logs}`);
        }
        await new Promise((r) => setTimeout(r, 150));
      }
    }

    client = new Client({ name: "dgc-101-e2e", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`)));
  }, 30_000);

  afterAll(async () => {
    await client?.close().catch(() => {});
    if (proc !== undefined) {
      // SIGTERM (not SIGKILL) so the server's shutdown hook reaps the hidden
      // Chrome instead of orphaning it.
      await new Promise<void>((resolve) => {
        proc.once("exit", () => resolve());
        proc.kill("SIGTERM");
        setTimeout(() => {
          proc.kill("SIGKILL");
          resolve();
        }, 5_000).unref();
      });
    }
    rmSync(workspaceDir, { recursive: true, force: true });
  }, 20_000);

  it("open A → export, then open B → export IMMEDIATELY, five times: all five are B", async () => {
    // First export launches the hidden canvas (ensureClient waits for a full
    // settle, so this one was always correct) and keeps it connected — every
    // later call takes the fast path where the race lived.
    await call("open_diagram", { name: "a" });
    const first = await exportDims();
    expect(first.width).toBeGreaterThan(first.height); // a = wide chain

    const bDims: Dims[] = [];
    for (let i = 0; i < 5; i += 1) {
      // Re-poison the canvas with a (and prove it renders a again)...
      await call("open_diagram", { name: "a" });
      const aDims = await exportDims();
      expect(aDims.width, `iteration ${i}: a must export wide`).toBeGreaterThan(aDims.height);

      // ...then the racing pair: open b and export with NO settling delay.
      await call("open_diagram", { name: "b" });
      const dims = await exportDims();
      expect(dims.height, `iteration ${i}: expected b (tall), got ${dims.width}×${dims.height} — previous diagram's pixels`).toBeGreaterThan(dims.width);
      bDims.push(dims);
    }

    // All five immediate captures must agree — no mid-layout half-states.
    for (const dims of bDims) {
      expect(dims).toEqual(bDims[0]);
    }
  }, 120_000);

  it("set_diagram direction flip (same name, version bump) → export IMMEDIATELY reflects the new direction", async () => {
    await call("open_diagram", { name: "b" });
    await exportDims(); // ensure b (tall) is what the canvas currently shows

    // Same diagram NAME — only the version moves. The old name-only gate
    // passed instantly and exported the old orientation.
    await call("set_diagram", { name: "b", dsl: DSL_B_WIDE });
    const wide = await exportDims();
    expect(wide.width, `expected b to export WIDE right after the flip, got ${wide.width}×${wide.height}`).toBeGreaterThan(wide.height);

    await call("set_diagram", { name: "b", dsl: DSL_B });
    const tall = await exportDims();
    expect(tall.height, `expected b to export TALL right after flipping back, got ${tall.width}×${tall.height}`).toBeGreaterThan(tall.width);
  }, 60_000);
});
