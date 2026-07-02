/**
 * LIVE eval harness v2 (DGC-75, follow-up to T34/DGC-55's `run.ts`).
 *
 * `run.ts` measures whether the DSL_GUIDE text alone gets a fresh model to
 * emit parseable arch-dsl (guide selects, tools disallowed). This script
 * measures the thing T34 could not: whether the model, with NOTHING but the
 * MCP tool descriptions and a prompt, can drive a REAL diagram-copilot
 * server end-to-end — discover `get_dsl_guide`/`list_icons` itself, call
 * `validate_dsl`/`set_diagram`/`get_diagram`/`undo_diagram`, and land the
 * diagram it was asked for. See `eval/live/scenarios.ts` for the 10
 * scenarios and `eval/live/harness.ts` for the server-lifecycle + grading
 * plumbing (grading reads the applied state back via a real `get_diagram`
 * MCP call, not a file read).
 *
 * SAFETY: this NEVER touches the operator's real server (port 4747,
 * `examples/` workspace). Every scenario gets its own freshly spawned server
 * on `--port` (default 4950) against a throwaway temp workspace dir, torn
 * down immediately after grading.
 *
 * This is a tsx script, NOT a vitest suite — it spends real tokens per
 * scenario (haiku, cheap, but not free) and spawns real child processes, so
 * it is run by hand:
 *
 *   ./node_modules/.bin/tsx eval/run-live.ts [run-name] [--limit N] [--model haiku] [--port 4950]
 *
 * Flags:
 *   run-name (positional)  Base name for eval/results/<run-name>.md.
 *                          Defaults to live-YYYYMMDD-HHMMSS.
 *   --limit N              Only run the first N scenarios (smoke test).
 *   --model <alias>        Model alias passed to claude (default: haiku).
 *   --port <n>              Port for the throwaway eval server (default: 4950).
 *                          Must differ from the real dev server (4747).
 *   --scenario <id>        Run a single scenario by id (repeatable-free; last wins).
 *   --dry-run              Print the resolved scenario list + claude flags and
 *                          exit WITHOUT starting any server or spending tokens.
 *
 * Exit code is 0 when every scenario passed, 1 otherwise.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import {
  ALLOWED_MCP_TOOLS,
  DISALLOWED_BUILTIN_TOOLS,
  cleanupWorkspace,
  gradeWorkspace,
  prepareWorkspace,
  runClaudeLive,
  startServer,
  type ToolCallRecord,
} from "./live/harness.js";
import { LIVE_SCENARIOS, type LiveScenario, type ScenarioContext } from "./live/scenarios.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(HERE, "results");

interface CliArgs {
  runName: string;
  limit: number;
  model: string;
  port: number;
  scenarioId: string | undefined;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let runName: string | undefined;
  let limit = LIVE_SCENARIOS.length;
  let model = "haiku";
  let port = 4950;
  let scenarioId: string | undefined;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--limit") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n <= 0) throw new Error(`--limit expects a positive integer, got "${argv[i]}"`);
      limit = n;
    } else if (arg === "--model") {
      model = argv[++i] ?? model;
    } else if (arg === "--port") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n <= 0) throw new Error(`--port expects a positive integer, got "${argv[i]}"`);
      if (n === 4747) throw new Error("--port 4747 is the real diagram-copilot dev server — refusing to collide with it.");
      port = n;
    } else if (arg === "--scenario") {
      scenarioId = argv[++i];
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: tsx eval/run-live.ts [run-name] [--limit N] [--model haiku] [--port 4950] [--scenario id] [--dry-run]");
      process.exit(0);
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown flag "${arg}"`);
    } else {
      runName = arg;
    }
  }

  return { runName: runName ?? defaultRunName(), limit: Math.min(limit, LIVE_SCENARIOS.length), model, port, scenarioId, dryRun };
}

function defaultRunName(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `live-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

interface Row {
  scenario: LiveScenario;
  pass: boolean;
  notes: string;
  toolsUsed: string[];
  firstTry: boolean;
  costUsd: number | null;
  errorExcerpt: string;
}

/** Unique short tool names actually called, in first-use order (ToolSearch excluded — it's discovery plumbing, not a diagram action). */
function toolsUsed(calls: ToolCallRecord[]): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const c of calls) {
    if (c.tool === "ToolSearch") continue;
    if (!seen.has(c.tool)) {
      seen.add(c.tool);
      order.push(c.tool);
    }
  }
  return order;
}

/** First-try = the model's FIRST set_diagram call succeeded (no error-correction retry needed). */
function computeFirstTry(calls: ToolCallRecord[]): boolean {
  const firstSet = calls.find((c) => c.tool === "set_diagram");
  return firstSet !== undefined && !firstSet.isError;
}

async function runOne(scenario: LiveScenario, model: string, port: number): Promise<Row> {
  const workspaceDir = prepareWorkspace(scenario.id, scenario.seed);
  const server = await startServer(port, workspaceDir);
  try {
    const mcpConfigDir = mkdtempSync(join(tmpdir(), `diagram-copilot-eval-cfg-`));
    const mcpConfigPath = join(mcpConfigDir, "mcp.json");
    writeFileSync(
      mcpConfigPath,
      JSON.stringify({ mcpServers: { "diagram-copilot": { type: "http", url: `http://127.0.0.1:${port}/mcp` } } }),
      "utf8",
    );

    const claudeResult = runClaudeLive({ prompt: scenario.prompt, mcpConfigPath, model, cwd: workspaceDir });
    cleanupWorkspace(mcpConfigDir);

    const graded = await gradeWorkspace(port, scenario.gradeDiagram);
    const ctx: ScenarioContext = {
      toolCalls: claudeResult.toolCalls,
      finalDsl: graded.finalDsl,
      finalDoc: graded.finalDoc,
      finalDiagramNames: graded.finalDiagramNames,
    };
    const verdict = scenario.assert(ctx);

    let errorExcerpt = "";
    if (!claudeResult.ok) {
      errorExcerpt = `claude CLI: ${claudeResult.finalText}`;
    } else if (!verdict.pass) {
      const erroredCall = claudeResult.toolCalls.find((c) => c.isError);
      errorExcerpt = erroredCall ? `${erroredCall.tool} errored: ${erroredCall.resultSummary}` : "";
    }

    return {
      scenario,
      pass: claudeResult.ok && verdict.pass,
      notes: verdict.notes,
      toolsUsed: toolsUsed(claudeResult.toolCalls),
      firstTry: computeFirstTry(claudeResult.toolCalls),
      costUsd: claudeResult.costUsd,
      errorExcerpt,
    };
  } finally {
    await server.stop();
    cleanupWorkspace(workspaceDir);
  }
}

function printConsoleTable(rows: Row[]): void {
  const header = ["#", "scenario", "pass", "first-try", "tools used"];
  const data = rows.map((r, i) => [
    String(i + 1),
    r.scenario.title,
    r.pass ? "PASS" : "FAIL",
    r.firstTry ? "yes" : "no",
    r.toolsUsed.join(", "),
  ]);
  const widths = header.map((h, c) => Math.max(h.length, ...data.map((row) => row[c]!.length)));
  const fmt = (cols: string[]) => cols.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  console.log(fmt(header));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of data) console.log(fmt(row));
}

function mdEscape(s: string): string {
  return s.replace(/\|/g, "\\|");
}

function renderMarkdown(rows: Row[], runName: string, model: string, port: number): string {
  const passed = rows.filter((r) => r.pass).length;
  const firstTry = rows.filter((r) => r.firstTry).length;
  const total = rows.length;
  const totalCost = rows.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
  const lines: string[] = [];
  lines.push(`# arch-dsl LIVE eval (v2) — ${runName}`);
  lines.push("");
  lines.push(`- date: ${new Date().toISOString()}`);
  lines.push(`- model: \`${model}\` (real MCP tool calls against a live server on port ${port})`);
  lines.push(`- scenarios: ${total}`);
  lines.push(`- **pass rate: ${passed}/${total} (${total === 0 ? 0 : Math.round((passed / total) * 100)}%)**`);
  lines.push(`- first-try rate (first set_diagram call succeeded, no self-correction): ${firstTry}/${total}`);
  lines.push(`- total cost: $${totalCost.toFixed(4)}`);
  lines.push("");
  lines.push("| # | scenario | category | pass | first-try | tools used | notes |");
  lines.push("|---|----------|----------|------|-----------|------------|-------|");
  rows.forEach((r, i) => {
    lines.push(
      `| ${i + 1} | ${r.scenario.title} | ${r.scenario.category} | ${r.pass ? "PASS" : "FAIL"} | ${r.firstTry ? "yes" : "no"} | ${r.toolsUsed.join(", ") || "(none)"} | ${mdEscape(r.notes)} |`,
    );
  });
  lines.push("");
  lines.push("## Details");
  rows.forEach((r, i) => {
    lines.push("");
    lines.push(`### ${i + 1}. ${r.scenario.title} (\`${r.scenario.id}\`) — ${r.pass ? "PASS" : "FAIL"}`);
    lines.push("");
    lines.push(`- category: ${r.scenario.category}`);
    lines.push(`- first-try: ${r.firstTry ? "yes" : "no"}`);
    lines.push(`- tools used: ${r.toolsUsed.join(", ") || "(none)"}`);
    lines.push(`- notes: ${r.notes}`);
    if (r.errorExcerpt) lines.push(`- error excerpt: ${mdEscape(r.errorExcerpt)}`);
    lines.push(`- cost: ${r.costUsd === null ? "n/a" : `$${r.costUsd.toFixed(4)}`}`);
    lines.push("");
    lines.push("prompt:");
    lines.push("");
    lines.push("```");
    lines.push(r.scenario.prompt);
    lines.push("```");
  });
  lines.push("");
  return lines.join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  let selected = LIVE_SCENARIOS.slice(0, args.limit);
  if (args.scenarioId !== undefined) {
    selected = LIVE_SCENARIOS.filter((s) => s.id === args.scenarioId);
    if (selected.length === 0) {
      throw new Error(`No scenario with id "${args.scenarioId}". Known ids: ${LIVE_SCENARIOS.map((s) => s.id).join(", ")}`);
    }
  }

  console.log(
    `arch-dsl LIVE eval v2 · model=${args.model} · scenarios=${selected.length}/${LIVE_SCENARIOS.length} · port=${args.port} · run=${args.runName}`,
  );

  if (args.dryRun) {
    console.log("\n--- claude flags (per scenario) ---");
    console.log(`claude -p "<prompt>" --mcp-config <tmp>/mcp.json --strict-mcp-config \\`);
    console.log(`  --allowedTools "${ALLOWED_MCP_TOOLS.join(" ")}" \\`);
    console.log(`  --disallowedTools "${DISALLOWED_BUILTIN_TOOLS.join(" ")}" \\`);
    console.log(`  --model ${args.model} --setting-sources "" --output-format stream-json --verbose`);
    console.log("\n--- SCENARIOS ---");
    selected.forEach((s, i) => {
      console.log(`\n[${i + 1}] ${s.id} — ${s.title} (category: ${s.category})`);
      if (s.seed) console.log(`  seed: ${s.seed.map((d) => d.name).join(", ")}`);
      if (s.gradeDiagram) console.log(`  grades diagram: ${s.gradeDiagram}`);
      console.log(`  prompt: ${s.prompt}`);
    });
    return;
  }

  const rows: Row[] = [];
  for (const [i, scenario] of selected.entries()) {
    process.stdout.write(`[${i + 1}/${selected.length}] ${scenario.title} … `);
    try {
      const row = await runOne(scenario, args.model, args.port);
      rows.push(row);
      console.log(row.pass ? `PASS (${row.notes})` : `FAIL — ${row.notes}`);
    } catch (err) {
      console.log(`ERROR — ${String((err as Error).message ?? err)}`);
      rows.push({
        scenario,
        pass: false,
        notes: `harness error: ${String((err as Error).message ?? err)}`,
        toolsUsed: [],
        firstTry: false,
        costUsd: null,
        errorExcerpt: String((err as Error).stack ?? err),
      });
    }
  }

  console.log("");
  printConsoleTable(rows);
  const passed = rows.filter((r) => r.pass).length;
  const firstTry = rows.filter((r) => r.firstTry).length;
  console.log(`\npass rate: ${passed}/${rows.length} (${Math.round((passed / rows.length) * 100)}%)`);
  console.log(`first-try rate: ${firstTry}/${rows.length}`);

  mkdirSync(RESULTS_DIR, { recursive: true });
  const outPath = join(RESULTS_DIR, `${args.runName}.md`);
  writeFileSync(outPath, renderMarkdown(rows, args.runName, args.model, args.port), "utf8");
  console.log(`report: ${outPath}`);

  process.exitCode = passed === rows.length ? 0 : 1;
}

main();
