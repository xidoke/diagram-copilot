/**
 * arch-dsl guide eval harness (DGC-55 / T34).
 *
 * For each prompt in `./prompts.ts` this drives the `claude` CLI once with the
 * DSL_GUIDE as the system prompt, captures the model's output, strips any code
 * fence, runs it through the real `parseDsl`, and reports whether the model
 * produced valid arch-dsl ON THE FIRST TRY. This measures how good the guide
 * is at getting a fresh model to emit correct DSL without a self-correction
 * loop — the whole point of the `get_dsl_guide` tool.
 *
 * This is a tsx script, NOT a vitest suite: each run spends real tokens on the
 * Anthropic API, so it is run by hand, not in CI.
 *
 * Run it (from packages/server):
 *   ./node_modules/.bin/tsx eval/run.ts [run-name] [--limit N] [--model haiku]
 * or from the repo root:
 *   pnpm --filter @diagram-copilot/server exec tsx eval/run.ts [run-name] [--limit N]
 *
 * Flags:
 *   run-name (positional)  Base name for eval/results/<run-name>.md.
 *                          Defaults to run-YYYYMMDD-HHMMSS.
 *   --limit N              Only run the first N prompts (smoke test; cheaper).
 *   --model <alias>        Model alias passed to claude (default: haiku).
 *   --dry-run              Print the resolved claude invocation + system prompt
 *                          and exit WITHOUT calling the API (free; for review).
 *
 * Exit code is 0 when every prompt passed, 1 otherwise (so it can gate a run).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDsl } from "@diagram-copilot/core";
import { DSL_GUIDE } from "../src/mcp/tools/guide.js";
import { PROMPTS, type EvalPrompt } from "./prompts.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(HERE, "results");

/** Instruction appended after the guide so the model emits bare DSL, no tools. */
const OUTPUT_INSTRUCTION = `You are generating an arch-dsl architecture diagram for the user's request.
Output ONLY the raw arch-dsl document. No code fences, no markdown, no prose,
no explanation before or after. Do not call any tools — just write the DSL.`;

const SYSTEM_PROMPT = `${DSL_GUIDE}\n\n${OUTPUT_INSTRUCTION}`;

interface CliArgs {
  runName: string;
  limit: number;
  model: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let runName: string | undefined;
  let limit = PROMPTS.length;
  let model = "haiku";
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--limit") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error(`--limit expects a positive integer, got "${argv[i]}"`);
      }
      limit = n;
    } else if (arg === "--model") {
      model = argv[++i] ?? model;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: tsx eval/run.ts [run-name] [--limit N] [--model haiku] [--dry-run]");
      process.exit(0);
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown flag "${arg}"`);
    } else {
      runName = arg;
    }
  }

  return { runName: runName ?? defaultRunName(), limit: Math.min(limit, PROMPTS.length), model, dryRun };
}

/** run-YYYYMMDD-HHMMSS in local time (a normal script may use Date). */
function defaultRunName(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `run-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * Strip a Markdown code fence the model may have wrapped the DSL in, despite
 * being told not to. Handles ```dsl / ```arch / bare ``` and leading/trailing
 * stray fence lines. Leaves un-fenced text untouched.
 */
function stripFence(raw: string): string {
  let s = raw.trim();
  const full = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(s);
  if (full) return full[1]!.trim();
  s = s.replace(/^```[^\n]*\n?/, "").replace(/\n?```\s*$/, "");
  return s.trim();
}

interface CallResult {
  ok: boolean;
  /** stdout from claude (empty when the call itself failed). */
  raw: string;
  /** DSL after fence-stripping (what parseDsl saw). */
  dsl: string;
  /** Present when the CLI invocation itself failed (auth, not found, timeout). */
  callError?: string;
}

/** Invoke the claude CLI once for a single prompt and return its stdout. */
function callClaude(prompt: string, model: string): CallResult {
  try {
    const raw = execFileSync(
      "claude",
      [
        "-p",
        prompt,
        "--append-system-prompt",
        SYSTEM_PROMPT,
        "--model",
        model,
        "--output-format",
        "text",
        // Use no MCP servers at all (ignore the project's .mcp.json) so the
        // eval never spins up the diagram-copilot server / touches port 4747.
        "--strict-mcp-config",
        // Belt-and-braces: deny the built-in tools so the model can only reply
        // with text (it has no diagram to read here anyway).
        "--disallowedTools",
        "Bash Read Edit Write Glob Grep WebFetch WebSearch Task NotebookEdit TodoWrite",
      ],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 180_000, cwd: HERE },
    );
    return { ok: true, raw, dsl: stripFence(raw) };
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message?: string };
    return {
      ok: false,
      raw: e.stdout ?? "",
      dsl: "",
      callError: (e.stderr || e.message || "unknown claude CLI error").trim(),
    };
  }
}

interface Row {
  prompt: EvalPrompt;
  pass: boolean;
  /** One-line failure summary (parse error or call error), or "" on pass. */
  error: string;
  raw: string;
  dsl: string;
  nodes: number;
  edges: number;
  groups: number;
}

function evaluate(prompt: EvalPrompt, model: string): Row {
  const call = callClaude(prompt.prompt, model);
  if (!call.ok) {
    return { prompt, pass: false, error: `CLI error: ${firstLine(call.callError ?? "")}`, raw: call.raw, dsl: "", nodes: 0, edges: 0, groups: 0 };
  }
  const parsed = parseDsl(call.dsl);
  if (parsed.ok) {
    return {
      prompt,
      pass: true,
      error: "",
      raw: call.raw,
      dsl: call.dsl,
      nodes: parsed.doc.nodes.length,
      edges: parsed.doc.edges.length,
      groups: parsed.doc.groups.length,
    };
  }
  const error =
    parsed.parseErrors.length > 0
      ? `line ${parsed.parseErrors[0]!.line}, col ${parsed.parseErrors[0]!.column}: ${parsed.parseErrors[0]!.message}`
      : `model: ${parsed.modelErrors[0]?.path ? parsed.modelErrors[0]!.path + " — " : ""}${parsed.modelErrors[0]?.message}`;
  return { prompt, pass: false, error: firstLine(error), raw: call.raw, dsl: call.dsl, nodes: 0, edges: 0, groups: 0 };
}

function firstLine(s: string): string {
  return s.split("\n")[0]!.trim();
}

/** Fixed-width console table: # | prompt | first-try | error. */
function printConsoleTable(rows: Row[]): void {
  const header = ["#", "prompt", "first-try", "error"];
  const data = rows.map((r, i) => [
    String(i + 1),
    r.prompt.title,
    r.pass ? "PASS" : "FAIL",
    r.pass ? "—" : r.error,
  ]);
  const widths = header.map((h, c) => Math.max(h.length, ...data.map((row) => row[c]!.length)));
  const fmt = (cols: string[]) => cols.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  console.log(fmt(header));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of data) console.log(fmt(row));
}

/** Markdown report written to eval/results/<run>.md. */
function renderMarkdown(rows: Row[], runName: string, model: string): string {
  const passed = rows.filter((r) => r.pass).length;
  const total = rows.length;
  const pct = total === 0 ? 0 : Math.round((passed / total) * 100);
  const lines: string[] = [];
  lines.push(`# arch-dsl guide eval — ${runName}`);
  lines.push("");
  lines.push(`- date: ${new Date().toISOString()}`);
  lines.push(`- model: \`${model}\` (first-try, no self-correction loop)`);
  lines.push(`- prompts: ${total}`);
  lines.push(`- **pass rate: ${passed}/${total} (${pct}%)**`);
  lines.push("");
  lines.push("| # | prompt | first-try | error |");
  lines.push("|---|--------|-----------|-------|");
  rows.forEach((r, i) => {
    lines.push(`| ${i + 1} | ${r.prompt.title} | ${r.pass ? "PASS" : "FAIL"} | ${r.pass ? "—" : mdEscape(r.error)} |`);
  });
  lines.push("");
  lines.push("## Details");
  rows.forEach((r, i) => {
    lines.push("");
    lines.push(`### ${i + 1}. ${r.prompt.title} — ${r.pass ? "PASS" : "FAIL"}`);
    if (r.pass) {
      lines.push(`_${r.nodes} nodes · ${r.edges} edges · ${r.groups} groups_`);
    } else {
      lines.push(`**error:** ${r.error}`);
    }
    lines.push("");
    lines.push("prompt:");
    lines.push("");
    lines.push("```");
    lines.push(r.prompt.prompt);
    lines.push("```");
    lines.push("");
    lines.push(r.pass ? "model output (parsed):" : "model output (raw):");
    lines.push("");
    lines.push("```");
    lines.push((r.pass ? r.dsl : r.raw || "(no output)").trimEnd());
    lines.push("```");
  });
  lines.push("");
  return lines.join("\n");
}

function mdEscape(s: string): string {
  return s.replace(/\|/g, "\\|");
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const selected = PROMPTS.slice(0, args.limit);

  console.log(`arch-dsl guide eval · model=${args.model} · prompts=${selected.length}/${PROMPTS.length} · run=${args.runName}`);

  if (args.dryRun) {
    console.log("\n--- SYSTEM PROMPT (DSL_GUIDE + instruction) ---\n");
    console.log(SYSTEM_PROMPT);
    console.log("\n--- claude args (per prompt) ---");
    console.log(`claude -p "<prompt>" --append-system-prompt "<system>" --model ${args.model} --output-format text --strict-mcp-config --disallowedTools "..."`);
    console.log("\n--- PROMPTS ---");
    selected.forEach((p, i) => console.log(`\n[${i + 1}] ${p.title}\n${p.prompt}`));
    return;
  }

  const rows: Row[] = [];
  for (const [i, prompt] of selected.entries()) {
    process.stdout.write(`[${i + 1}/${selected.length}] ${prompt.title} … `);
    const row = evaluate(prompt, args.model);
    rows.push(row);
    console.log(row.pass ? `PASS (${row.nodes}n/${row.edges}e/${row.groups}g)` : `FAIL — ${row.error}`);
  }

  console.log("");
  printConsoleTable(rows);
  const passed = rows.filter((r) => r.pass).length;
  console.log(`\npass rate: ${passed}/${rows.length} (${Math.round((passed / rows.length) * 100)}%)`);

  mkdirSync(RESULTS_DIR, { recursive: true });
  const outPath = join(RESULTS_DIR, `${args.runName}.md`);
  writeFileSync(outPath, renderMarkdown(rows, args.runName, args.model), "utf8");
  console.log(`report: ${outPath}`);

  process.exitCode = passed === rows.length ? 0 : 1;
}

main();
