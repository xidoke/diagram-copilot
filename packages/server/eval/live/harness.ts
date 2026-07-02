/**
 * Live-server plumbing for the eval harness v2 (DGC-75).
 *
 * T34 (`../run.ts`) never touches a running diagram-copilot server: it
 * spoon-feeds `DSL_GUIDE` as the system prompt and disallows all tools, so it
 * only measures whether the model can produce parseable arch-dsl text. This
 * harness measures the real thing a user experiences — the model discovering
 * `get_dsl_guide`/`list_icons` itself and driving `validate_dsl` /
 * `set_diagram` / `get_diagram` / `undo_diagram` against a REAL server.
 *
 * Per scenario this module:
 *   1. creates an isolated temp workspace dir and seeds any starting `.arch`
 *      files (`prepareWorkspace`),
 *   2. spawns a fresh `diagram-copilot` server on a given port pointed at
 *      that workspace (`startServer`) and waits for it to accept
 *      connections,
 *   3. drives `claude -p` against it, capturing the full tool-call
 *      transcript via `--output-format stream-json` (`runClaudeLive`),
 *   4. grades the OUTCOME by calling `get_diagram`/`list_diagrams` on the
 *      still-running server through the real MCP client SDK — not by
 *      re-reading files off disk — so "pass" means "the tool call actually
 *      applied", matching how a real session would be judged
 *      (`gradeWorkspace`),
 *   5. stops the server and deletes the temp workspace (`stopServer`).
 *
 * Isolation from the operator's own environment matters here: the real
 * diagram-copilot server for this repo runs on port 4747 against
 * `examples/`. This harness ALWAYS binds an explicit `--port`/workspace the
 * caller supplies (see `run-live.ts`, default 4950 + a fresh temp dir) and
 * never touches 4747 or the `examples/` workspace.
 */
import { execFileSync } from "node:child_process";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ARCH_EXT, parseDsl, type DiagramDoc } from "@diagram-copilot/core";
import type { SeedDiagram } from "./scenarios.js";

const HERE = dirname(fileURLToPath(import.meta.url));
/** `packages/server` — the package root two levels up from `eval/live/`. */
const SERVER_PKG_DIR = join(HERE, "..", "..");
const TSX_BIN = join(SERVER_PKG_DIR, "node_modules", ".bin", "tsx");
const SERVER_ENTRY = join(SERVER_PKG_DIR, "src", "index.ts");

/** MCP tools the model is allowed to call, granted uniformly across scenarios (realistic — a real session has all of these). */
export const ALLOWED_MCP_TOOLS = [
  "ToolSearch", // this Claude Code build defers MCP tool schemas behind ToolSearch (see docs/EVAL.md) — without it the model can never discover the diagram-copilot tools.
  "mcp__diagram-copilot__get_dsl_guide",
  "mcp__diagram-copilot__list_icons",
  "mcp__diagram-copilot__validate_dsl",
  "mcp__diagram-copilot__list_diagrams",
  "mcp__diagram-copilot__open_diagram",
  "mcp__diagram-copilot__get_diagram",
  "mcp__diagram-copilot__set_diagram",
  "mcp__diagram-copilot__undo_diagram",
  "mcp__diagram-copilot__redo_diagram",
];

/** Built-in tools with no place in a headless DSL-editing loop — blocked so the model can't wander off into the filesystem or down a skill/subagent rabbit hole (observed once in a smoke test: haiku called `Skill` unprompted, burning a turn on unrelated skill content). */
export const DISALLOWED_BUILTIN_TOOLS = [
  "Bash",
  "Read",
  "Edit",
  "Write",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "Task",
  "NotebookEdit",
  "TodoWrite",
  "Skill",
  "Agent",
];

// ---------------------------------------------------------------------------
// Temp workspace
// ---------------------------------------------------------------------------

/** Create a fresh temp workspace dir (unique per scenario) and seed any starting `.arch` files into it. */
export function prepareWorkspace(scenarioId: string, seed: SeedDiagram[] | undefined): string {
  const dir = mkdtempSync(join(tmpdir(), `diagram-copilot-eval-${scenarioId}-`));
  mkdirSync(dir, { recursive: true });
  for (const s of seed ?? []) {
    writeFileSync(join(dir, `${s.name}${ARCH_EXT}`), s.dsl, "utf8");
  }
  return dir;
}

export function cleanupWorkspace(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

export interface LiveServer {
  proc: ChildProcess;
  port: number;
  logs: string;
  stop(): Promise<void>;
}

/** Poll `http://127.0.0.1:{port}/` until it responds (any status) or `timeoutMs` elapses. */
async function waitForServer(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/`);
      return;
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  throw new Error(`server did not come up on port ${port} within ${timeoutMs}ms: ${String(lastError)}`);
}

/** Spawn a fresh diagram-copilot server on `port`, pointed at `workspaceDir`. Resolves once it accepts connections. */
export async function startServer(port: number, workspaceDir: string): Promise<LiveServer> {
  let logs = "";
  const proc = spawn(TSX_BIN, [SERVER_ENTRY, "--port", String(port), "--workspace", workspaceDir], {
    cwd: SERVER_PKG_DIR,
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout?.on("data", (chunk: Buffer) => (logs += chunk.toString()));
  proc.stderr?.on("data", (chunk: Buffer) => (logs += chunk.toString()));

  const exitedEarly = new Promise<never>((_, reject) => {
    proc.once("exit", (code) => reject(new Error(`server exited early (code ${code}) — logs:\n${logs}`)));
  });

  try {
    await Promise.race([waitForServer(port, 10_000), exitedEarly]);
  } catch (err) {
    proc.kill("SIGKILL");
    throw err;
  }

  return {
    proc,
    port,
    get logs() {
      return logs;
    },
    async stop() {
      await new Promise<void>((resolve) => {
        proc.once("exit", () => resolve());
        proc.kill("SIGTERM");
        // Belt-and-braces: force-kill if it hasn't exited soon (a hung watcher).
        setTimeout(() => {
          if (!proc.killed) proc.kill("SIGKILL");
        }, 2_000);
      });
    },
  } as LiveServer;
}

// ---------------------------------------------------------------------------
// claude -p invocation + transcript parsing
// ---------------------------------------------------------------------------

export interface ToolCallRecord {
  /** Short tool name (e.g. "set_diagram"), with any `mcp__diagram-copilot__` prefix stripped. Built-ins (e.g. "ToolSearch") kept as-is. */
  tool: string;
  input: Record<string, unknown>;
  /** `true` when the tool_result carried `is_error: true` (a real tool error OR a denied/unavailable tool). */
  isError: boolean;
  /** First line of the tool's result text, for compact reporting. */
  resultSummary: string;
}

export interface ClaudeRunResult {
  ok: boolean;
  toolCalls: ToolCallRecord[];
  /** Final assistant text (the `result` event), or the CLI error message when the call itself failed. */
  finalText: string;
  costUsd: number | null;
  rawLog: string;
}

function shortToolName(name: string): string {
  const prefix = "mcp__diagram-copilot__";
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

function firstLine(s: string): string {
  return (s.split("\n")[0] ?? "").trim();
}

/** Run `claude -p <prompt>` against the server's MCP endpoint and return the parsed tool-call transcript. */
export function runClaudeLive(opts: {
  prompt: string;
  mcpConfigPath: string;
  model: string;
  cwd: string;
  timeoutMs?: number;
}): ClaudeRunResult {
  const args = [
    "-p",
    opts.prompt,
    "--mcp-config",
    opts.mcpConfigPath,
    "--strict-mcp-config",
    "--allowedTools",
    ALLOWED_MCP_TOOLS.join(" "),
    "--disallowedTools",
    DISALLOWED_BUILTIN_TOOLS.join(" "),
    "--model",
    opts.model,
    // Isolate from the operator's own hooks/skills/CLAUDE.md — a clean,
    // deterministic run driven only by the MCP tool descriptions + prompt,
    // like a fresh Claude Code session would see against this server.
    "--setting-sources",
    "",
    "--output-format",
    "stream-json",
    "--verbose",
  ];

  let raw: string;
  try {
    raw = execFileSync("claude", args, {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      timeout: opts.timeoutMs ?? 240_000,
      cwd: opts.cwd,
    });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    raw = e.stdout ?? "";
    if (raw.length === 0) {
      return {
        ok: false,
        toolCalls: [],
        finalText: `CLI error: ${firstLine(e.stderr || e.message || "unknown claude CLI error")}`,
        costUsd: null,
        rawLog: e.stderr ?? "",
      };
    }
    // Fall through: the process errored (e.g. timeout) but we got partial
    // stream-json — still worth parsing for a diagnostic transcript.
  }

  const toolCalls: ToolCallRecord[] = [];
  const pendingById = new Map<string, { tool: string; input: Record<string, unknown> }>();
  let finalText = "";
  let costUsd: number | null = null;
  let sawResult = false;
  let resultIsError = false;

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (event["type"] === "assistant") {
      const message = event["message"] as { content?: unknown[] } | undefined;
      for (const block of message?.content ?? []) {
        const b = block as Record<string, unknown>;
        if (b["type"] === "tool_use") {
          const id = String(b["id"]);
          pendingById.set(id, {
            tool: shortToolName(String(b["name"])),
            input: (b["input"] as Record<string, unknown>) ?? {},
          });
        }
      }
    } else if (event["type"] === "user") {
      const message = event["message"] as { content?: unknown[] } | undefined;
      for (const block of message?.content ?? []) {
        const b = block as Record<string, unknown>;
        if (b["type"] !== "tool_result") continue;
        const toolUseId = String(b["tool_use_id"]);
        const pending = pendingById.get(toolUseId);
        if (pending === undefined) continue; // e.g. the ToolSearch-internal tool_reference-only result
        const content = b["content"];
        let resultText: string;
        if (typeof content === "string") resultText = content;
        else if (Array.isArray(content)) {
          resultText = content
            .map((c) => (typeof c === "object" && c !== null && "text" in c ? String((c as { text: unknown }).text) : ""))
            .join(" ");
        } else resultText = "";
        toolCalls.push({
          tool: pending.tool,
          input: pending.input,
          isError: b["is_error"] === true,
          resultSummary: firstLine(resultText),
        });
        pendingById.delete(toolUseId);
      }
    } else if (event["type"] === "result") {
      sawResult = true;
      resultIsError = event["is_error"] === true;
      finalText = String(event["result"] ?? "");
      const cost = event["total_cost_usd"];
      costUsd = typeof cost === "number" ? cost : null;
    }
  }

  return {
    ok: sawResult && !resultIsError,
    toolCalls,
    finalText: finalText || "(no final text — see rawLog)",
    costUsd,
    rawLog: raw,
  };
}

// ---------------------------------------------------------------------------
// Grading via the real MCP client (get_diagram / list_diagrams)
// ---------------------------------------------------------------------------

export interface GradedState {
  finalDsl: string | null;
  finalDoc: DiagramDoc | null;
  finalDiagramNames: string[];
}

/** Extract the fenced DSL body from `get_diagram`'s `Diagram "name" (vN):\n\n\`\`\`\n<dsl>\n\`\`\`` text. */
function extractFencedDsl(text: string): string | null {
  const match = /```\n([\s\S]*?)\n```/.exec(text);
  return match ? match[1]! : null;
}

/** Connect to the running server via the real MCP SDK client and read back `name` (or the active diagram). */
export async function gradeWorkspace(port: number, name?: string): Promise<GradedState> {
  const client = new Client({ name: "eval-grader", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
  await client.connect(transport);
  try {
    const listResult = await client.callTool({ name: "list_diagrams", arguments: {} });
    const listText = extractResultText(listResult);
    const finalDiagramNames = parseListDiagramsNames(listText);

    const getResult = await client.callTool({ name: "get_diagram", arguments: name ? { name } : {} });
    const getText = extractResultText(getResult);
    if (getResult.isError === true) {
      return { finalDsl: null, finalDoc: null, finalDiagramNames };
    }
    const dsl = extractFencedDsl(getText);
    if (dsl === null) return { finalDsl: null, finalDoc: null, finalDiagramNames };
    const parsed = parseDsl(dsl);
    return { finalDsl: dsl, finalDoc: parsed.ok ? parsed.doc : null, finalDiagramNames };
  } finally {
    await client.close();
  }
}

function extractResultText(result: { content?: unknown }): string {
  const content = result.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => (typeof c === "object" && c !== null && "text" in c ? String((c as { text: unknown }).text) : ""))
    .join("\n");
}

/** `list_diagrams` renders one name per line as `"<name> (vN)  * active"`; pull out the bare names. */
function parseListDiagramsNames(text: string): string[] {
  const names: string[] = [];
  for (const line of text.split("\n")) {
    const match = /^(.+?)\s+\(v\d+\)/.exec(line.trim());
    if (match) names.push(match[1]!);
  }
  return names;
}
