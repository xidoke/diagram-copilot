/**
 * Scenario set for the LIVE eval harness v2 (DGC-75, follows T34/DGC-55).
 *
 * Unlike `../prompts.ts` (T34 — pure text generation, guide spoon-fed as the
 * system prompt, `--strict-mcp-config` with NO servers so the model never
 * touches the real MCP tools), these 10 scenarios drive `claude -p` against a
 * REAL diagram-copilot server: the model must discover `get_dsl_guide` /
 * `list_icons` itself and call `validate_dsl` / `set_diagram` / `get_diagram`
 * / `undo_diagram` for real. Grading reads back the actual applied state via
 * a direct MCP `get_diagram` call (see `mcp-client.ts`), not just "did the
 * text parse" — this is what "assert applied receipt / canvas state" means
 * for v2.
 *
 * Each scenario gets an isolated, freshly spawned server + temp workspace
 * (see `harness.ts`), so scenarios never see each other's state.
 */
import type { DiagramDoc } from "@diagram-copilot/core";
import type { ToolCallRecord } from "./harness.js";

/** A `.arch` file to write into the temp workspace BEFORE the server starts. */
export interface SeedDiagram {
  /** Diagram name (no `.arch` extension). Use `"demo"` to guarantee it is auto-active. */
  name: string;
  /** Raw arch-dsl source to seed the file with (may be intentionally invalid). */
  dsl: string;
}

/** Everything a scenario's `assert` needs to judge the outcome. */
export interface ScenarioContext {
  /** Tool calls the model made, in order, with their result/error. */
  toolCalls: ToolCallRecord[];
  /** Raw `get_diagram` text for `gradeDiagram` (or the active diagram), fenced code stripped. `null` if the diagram could not be read at all. */
  finalDsl: string | null;
  /** `parseDsl(finalDsl)` result — `null` when `finalDsl` is `null` or fails to parse. */
  finalDoc: DiagramDoc | null;
  /** Names of every diagram in the workspace after the run (from `list_diagrams` via the grading client). */
  finalDiagramNames: string[];
}

export interface ScenarioVerdict {
  pass: boolean;
  /** Short human-readable reason, always present (even on pass — e.g. "3 nodes, 1 group"). */
  notes: string;
}

export interface LiveScenario {
  id: string;
  title: string;
  /** One-line grouping label for the report (e.g. "create", "edit", "undo"). */
  category: string;
  /** `.arch` files to seed before the server starts. Omit for a blank workspace. */
  seed?: SeedDiagram[];
  /** Diagram name `get_diagram` grades after the run. Defaults to the active diagram. */
  gradeDiagram?: string;
  /** The user message handed to the model (English or Vietnamese, matching real usage). */
  prompt: string;
  /** Judge the outcome from the transcript + graded final state. */
  assert(ctx: ScenarioContext): ScenarioVerdict;
}

// ---------------------------------------------------------------------------
// Shared assertion helpers
// ---------------------------------------------------------------------------

/** Case/diacritic-insensitive-ish substring match against a node/group's id+label. */
function nameMatches(name: string, needle: string): boolean {
  return name.toLowerCase().includes(needle.toLowerCase());
}

function findNode(doc: DiagramDoc, needle: string) {
  return doc.nodes.find((n) => nameMatches(n.id, needle) || nameMatches(n.label, needle));
}

function findGroup(doc: DiagramDoc, needle: string) {
  return doc.groups.find((g) => nameMatches(g.id, needle) || nameMatches(g.label, needle));
}

function hasEdge(doc: DiagramDoc, fromNeedle: string, toNeedle: string): boolean {
  return doc.edges.some((e) => {
    const fromNode = doc.nodes.find((n) => n.id === e.from) ?? doc.groups.find((g) => g.id === e.from);
    const toNode = doc.nodes.find((n) => n.id === e.to) ?? doc.groups.find((g) => g.id === e.to);
    const fromLabel = fromNode ? "label" in fromNode ? fromNode.label : "" : "";
    const toLabel = toNode ? "label" in toNode ? toNode.label : "" : "";
    return (
      (nameMatches(e.from, fromNeedle) || nameMatches(fromLabel, fromNeedle)) &&
      (nameMatches(e.to, toNeedle) || nameMatches(toLabel, toNeedle))
    );
  });
}

/** First tool call matching `toolName` (short form, no `mcp__diagram-copilot__` prefix). */
function firstCall(toolCalls: ToolCallRecord[], toolName: string): ToolCallRecord | undefined {
  return toolCalls.find((c) => c.tool === toolName);
}

function indexOfFirstCall(toolCalls: ToolCallRecord[], toolName: string): number {
  return toolCalls.findIndex((c) => c.tool === toolName);
}

function describeDoc(doc: DiagramDoc | null): string {
  if (doc === null) return "no valid doc";
  return `${doc.nodes.length} node(s), ${doc.groups.length} group(s), ${doc.edges.length} edge(s)`;
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

const EXISTING_VPC_DIAGRAM = `direction right
Client [icon: browser]
VPC [color: gray] {
  API [icon: server]
  Database [icon: postgresql]
}
Client > API: HTTPS
API > Database: query
`;

const BASELINE_3TIER = `direction right
Client [icon: browser]
API [icon: server]
Database [icon: postgresql]
Client > API: HTTPS
API > Database: query
`;

/** Same broken document T34 used for its "repair" prompt (kept for continuity). */
const BROKEN_DIAGRAM = `direction downward
Người dùng
Người dùng > API Gateway
API Gateway [type: rest]
API Gateway > Auth, Orders
Orders > Database [icon = postgres]
`;

const BILLING_DIAGRAM = `direction right
Invoice [icon: server]
Database [icon: postgresql]
Invoice > Database: reads/writes
`;

export const LIVE_SCENARIOS: LiveScenario[] = [
  {
    id: "create-basic",
    title: "Create a diagram from scratch (EN)",
    category: "create",
    prompt:
      "Create a new architecture diagram for a simple web app: a Client, an " +
      "API, and a Database. Add labelled edges showing the request flow. " +
      "Save it with set_diagram when you're done.",
    assert(ctx) {
      if (ctx.finalDoc === null) {
        return { pass: false, notes: `diagram did not end up valid — ${ctx.finalDsl ? "parse failed" : "unreadable"}` };
      }
      const client = findNode(ctx.finalDoc, "client");
      const api = findNode(ctx.finalDoc, "api");
      const db = findNode(ctx.finalDoc, "database");
      const ok = client !== undefined && api !== undefined && db !== undefined && ctx.finalDoc.edges.length >= 2;
      return {
        pass: ok,
        notes: ok ? describeDoc(ctx.finalDoc) : `missing expected nodes/edges — ${describeDoc(ctx.finalDoc)}`,
      };
    },
  },

  {
    id: "nested-groups",
    title: "Two-tier nested groups (EN)",
    category: "create",
    prompt:
      "Design a news feed backend. Put the internal services inside a VPC " +
      "group, and INSIDE that VPC nest a second group called 'Data Layer' " +
      "that holds the database and a cache. Outside the VPC put the mobile " +
      "client and a CDN. Save the result with set_diagram.",
    assert(ctx) {
      if (ctx.finalDoc === null) return { pass: false, notes: "diagram did not end up valid" };
      const vpc = findGroup(ctx.finalDoc, "vpc");
      const dataLayer = ctx.finalDoc.groups.find((g) => g.parentId !== undefined && nameMatches(g.label, "data"));
      const ok = vpc !== undefined && dataLayer !== undefined && dataLayer.parentId === vpc.id;
      return {
        pass: ok,
        notes: ok
          ? `nested group confirmed — ${describeDoc(ctx.finalDoc)}`
          : `expected a "Data Layer" group nested inside "VPC" — ${describeDoc(ctx.finalDoc)}`,
      };
    },
  },

  {
    id: "edit-add-node-to-group",
    title: "Add a node into an existing group (EN, edit)",
    category: "edit",
    seed: [{ name: "demo", dsl: EXISTING_VPC_DIAGRAM }],
    prompt:
      "Read the current diagram. Inside the existing 'VPC' group, add a new " +
      "node called 'Cache' (a Redis cache) and connect API > Cache with the " +
      "label 'cache lookup'. Keep everything else in the diagram unchanged, " +
      "then save the full document with set_diagram.",
    assert(ctx) {
      if (ctx.finalDoc === null) return { pass: false, notes: "diagram did not end up valid" };
      const cache = findNode(ctx.finalDoc, "cache");
      const vpc = findGroup(ctx.finalDoc, "vpc");
      const stillHasOriginal =
        findNode(ctx.finalDoc, "client") !== undefined && findNode(ctx.finalDoc, "database") !== undefined;
      const ok =
        cache !== undefined && vpc !== undefined && cache.groupId === vpc.id && stillHasOriginal && hasEdge(ctx.finalDoc, "api", "cache");
      return {
        pass: ok,
        notes: ok
          ? `Cache added inside VPC, original nodes kept — ${describeDoc(ctx.finalDoc)}`
          : `Cache missing/not in VPC group, or original content lost — ${describeDoc(ctx.finalDoc)}`,
      };
    },
  },

  {
    id: "validate-before-set",
    title: "Validate-first workflow (EN, forced validate_dsl)",
    category: "workflow",
    prompt:
      "Draw a diagram for a chat system: Client, WebSocket Gateway, Message " +
      "Queue, Chat Service, Database, with labelled edges for the message " +
      "flow. IMPORTANT: you MUST call validate_dsl to check your draft DSL " +
      "BEFORE calling set_diagram — only call set_diagram once validate_dsl " +
      "reports it is valid.",
    assert(ctx) {
      const validateIdx = indexOfFirstCall(ctx.toolCalls, "validate_dsl");
      const setIdx = indexOfFirstCall(ctx.toolCalls, "set_diagram");
      const followedInstruction = validateIdx !== -1 && setIdx !== -1 && validateIdx < setIdx;
      if (ctx.finalDoc === null) {
        return { pass: false, notes: "diagram did not end up valid" };
      }
      const ok = followedInstruction && ctx.finalDoc.nodes.length >= 4;
      return {
        pass: ok,
        notes: followedInstruction
          ? `validate_dsl called before set_diagram — ${describeDoc(ctx.finalDoc)}`
          : `validate_dsl NOT called before the first set_diagram (validate@${validateIdx}, set@${setIdx})`,
      };
    },
  },

  {
    id: "vietnamese-diacritics",
    title: "Vietnamese names with đ/Đ (VI)",
    category: "unicode",
    prompt:
      "Vẽ sơ đồ kiến trúc cho hệ thống đặt hàng online. Dùng CHÍNH XÁC các " +
      "tên node tiếng Việt sau (giữ nguyên dấu): 'Người dùng', 'Cổng thanh " +
      "toán', 'Đơn hàng', 'Kho dữ liệu'. Nối các node theo luồng đặt hàng và " +
      "ghi nhãn cạnh bằng tiếng Việt, rồi lưu bằng set_diagram.",
    assert(ctx) {
      if (ctx.finalDoc === null) return { pass: false, notes: "diagram did not end up valid" };
      const hasDStroke = ctx.finalDoc.nodes.some((n) => /[đĐ]/.test(n.id) || /[đĐ]/.test(n.label));
      const hasOrder = findNode(ctx.finalDoc, "Đơn hàng") !== undefined || findNode(ctx.finalDoc, "don hang") !== undefined;
      const nodeCount = ctx.finalDoc.nodes.length;
      const ok = hasDStroke && nodeCount >= 3;
      return {
        pass: ok,
        notes: ok
          ? `Vietnamese đ/Đ preserved (order node: ${hasOrder}) — ${describeDoc(ctx.finalDoc)}`
          : `no node id/label contains đ/Đ — ${describeDoc(ctx.finalDoc)}`,
      };
    },
  },

  {
    id: "one-to-many-fanout",
    title: "One-to-many fan-out edge (EN)",
    category: "edges",
    prompt:
      "Draw a diagram where an Ingestion Service publishes jobs to a Queue, " +
      "and the Queue fans out to three workers: Worker A, Worker B, Worker " +
      "C. Use a single one-to-many edge from the Queue to the three workers " +
      "(see get_dsl_guide for the 'Source > A, B, C' syntax), then save it.",
    assert(ctx) {
      if (ctx.finalDoc === null) return { pass: false, notes: "diagram did not end up valid" };
      const queue = findNode(ctx.finalDoc, "queue");
      const workersHit = ["worker a", "worker b", "worker c"].filter((w) =>
        queue ? ctx.finalDoc!.edges.some((e) => e.from === queue.id && nameMatches(
          ctx.finalDoc!.nodes.find((n) => n.id === e.to)?.label ?? e.to,
          w,
        )) : false,
      );
      const ok = queue !== undefined && workersHit.length === 3;
      return {
        pass: ok,
        notes: ok
          ? `Queue fans out to all 3 workers — ${describeDoc(ctx.finalDoc)}`
          : `Queue -> workers fan-out incomplete (${workersHit.length}/3) — ${describeDoc(ctx.finalDoc)}`,
      };
    },
  },

  {
    id: "undo-after-mistake",
    title: "Undo after a wrong edit (EN, undo_diagram)",
    category: "undo",
    seed: [{ name: "demo", dsl: BASELINE_3TIER }],
    prompt:
      "The current diagram has Client, API and Database. First, REMOVE the " +
      "Database node entirely (rewrite the document without it) and save " +
      "with set_diagram. Then, on reflection, that removal was a MISTAKE — " +
      "undo it using undo_diagram so the diagram is back to having Client, " +
      "API and Database again. Finish once the Database node is restored.",
    assert(ctx) {
      const undoCalled = firstCall(ctx.toolCalls, "undo_diagram") !== undefined;
      const undoOk = firstCall(ctx.toolCalls, "undo_diagram")?.isError === false;
      if (ctx.finalDoc === null) return { pass: false, notes: "diagram did not end up valid" };
      const dbBack = findNode(ctx.finalDoc, "database") !== undefined;
      const ok = undoCalled && undoOk && dbBack;
      return {
        pass: ok,
        notes: ok
          ? `undo_diagram restored Database — ${describeDoc(ctx.finalDoc)}`
          : `undo_diagram called=${undoCalled} ok=${undoOk}, Database present=${dbBack}`,
      };
    },
  },

  {
    id: "repair-broken-existing",
    title: "Repair a broken existing diagram (mixed, self-correct)",
    category: "self-correct",
    seed: [{ name: "demo", dsl: BROKEN_DIAGRAM }],
    prompt:
      "The current diagram fails to parse. Read it, fix every syntax error " +
      "while keeping the same intent (a payment flow: Vietnamese user, " +
      "gateway, auth, orders, database), and save the corrected VALID DSL " +
      "with set_diagram.",
    assert(ctx) {
      if (ctx.finalDoc === null) {
        return { pass: false, notes: "diagram still does not parse after the model's attempt(s)" };
      }
      const ok = ctx.finalDoc.nodes.length >= 4 && ctx.finalDoc.edges.length >= 3;
      return {
        pass: ok,
        notes: ok ? `repaired and valid — ${describeDoc(ctx.finalDoc)}` : `too few nodes/edges after repair — ${describeDoc(ctx.finalDoc)}`,
      };
    },
  },

  {
    id: "icon-lookup",
    title: "Look up an icon before using it (EN, list_icons)",
    category: "workflow",
    prompt:
      "Create a diagram with a single 'Database' node. Before setting its " +
      "icon, call list_icons to find a real database icon id, then use that " +
      "id as the node's [icon: ...] attribute. Save with set_diagram.",
    assert(ctx) {
      const lookedUp = firstCall(ctx.toolCalls, "list_icons") !== undefined;
      if (ctx.finalDoc === null) return { pass: false, notes: "diagram did not end up valid" };
      const db = findNode(ctx.finalDoc, "database");
      const hasIcon = db?.icon !== undefined && db.icon.length > 0;
      const ok = lookedUp && hasIcon;
      return {
        pass: ok,
        notes: ok
          ? `list_icons called, Database icon="${db?.icon}"`
          : `list_icons called=${lookedUp}, Database icon="${db?.icon ?? "(none)"}"`,
      };
    },
  },

  {
    id: "multi-diagram-open",
    title: "List + open a non-active diagram, then edit it (EN)",
    category: "workspace",
    seed: [
      { name: "demo", dsl: BASELINE_3TIER },
      { name: "billing", dsl: BILLING_DIAGRAM },
    ],
    gradeDiagram: "billing",
    prompt:
      "List the diagrams in this workspace, open the one called 'billing' " +
      "(not the active/default one), and add a new node 'Invoice Service' " +
      "connected as Invoice Service > Database. Save with set_diagram, " +
      "targeting the 'billing' diagram.",
    assert(ctx) {
      const listed = firstCall(ctx.toolCalls, "list_diagrams") !== undefined;
      const opened = ctx.toolCalls.some(
        (c) => c.tool === "open_diagram" && typeof c.input?.["name"] === "string" && (c.input["name"] as string).toLowerCase() === "billing",
      );
      if (ctx.finalDoc === null) return { pass: false, notes: `diagram did not end up valid (listed=${listed}, opened=${opened})` };
      const invoiceService = findNode(ctx.finalDoc, "invoice service");
      const stillHasOriginal = findNode(ctx.finalDoc, "database") !== undefined;
      const ok = listed && invoiceService !== undefined && stillHasOriginal;
      return {
        pass: ok,
        notes: ok
          ? `billing diagram edited correctly (list_diagrams used=${listed}, open_diagram used=${opened}) — ${describeDoc(ctx.finalDoc)}`
          : `list_diagrams=${listed} open_diagram=${opened} — ${describeDoc(ctx.finalDoc)}`,
      };
    },
  },
];
