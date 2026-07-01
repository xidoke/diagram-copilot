/**
 * WebSocket protocol between the diagram-copilot server and web clients.
 *
 * Architecture decision (frozen): the server is the ONLY place that parses
 * DSL — the web app never runs Langium. Every broadcast therefore carries
 * both the raw `dsl` (for the Monaco drawer) and the parsed `doc` (for the
 * canvas). Messages are JSON, discriminated by `kind`, and validated with
 * Zod on both ends via {@link parseServerMessage} / {@link parseClientMessage}.
 */
import { z } from "zod";
import {
  ModelErrorSchema,
  ParseErrorSchema,
  formatErrorPath,
  type ModelError,
  type ParseError,
} from "../errors.js";
import { DiagramDocSchema, type DiagramDoc } from "../model/index.js";

/**
 * Where a mutation originated. Used for echo-loop prevention: the server
 * tags every broadcast, and a client must not re-apply/rebroadcast a
 * change it originated itself.
 *
 * - `mcp` — Claude Code via an MCP tool (`set_diagram`, …)
 * - `drawer` — the Monaco DSL editor in the web app
 * - `canvas` — direct canvas manipulation (drag, …)
 * - `file` — external file change picked up by the workspace watcher (git checkout, …)
 */
export type Origin = "mcp" | "drawer" | "canvas" | "file";

/** Zod schema for {@link Origin}. */
export const OriginSchema = z.enum(["mcp", "drawer", "canvas", "file"]);

/** Origins a web client can produce (subset of {@link Origin}). */
export type ClientOrigin = Extract<Origin, "drawer" | "canvas">;

/** Zod schema for {@link ClientOrigin}. */
export const ClientOriginSchema = z.enum(["drawer", "canvas"]);

/** Diagram name: non-empty, no `.arch` extension (see `workspace.ts`). */
const DiagramNameSchema = z.string().min(1);

/** Server-side monotonic version of a diagram (0-based, increments per accepted change). */
const VersionSchema = z.number().int().nonnegative();

// ---------------------------------------------------------------------------
// Server → Client
// ---------------------------------------------------------------------------

/**
 * Full state of the active diagram after every VALID change.
 * Clients replace their state wholesale — no patching, no client-side parse.
 */
export interface DiagramMessage {
  kind: "diagram";
  /** Diagram name (workspace file stem, no extension). */
  name: string;
  /** Monotonic server version of this diagram. */
  version: number;
  /** Which side produced this change (echo-loop prevention). */
  origin: Origin;
  /** Raw DSL source — shown in the Monaco drawer. */
  dsl: string;
  /** Parsed + validated document — rendered on the canvas. */
  doc: DiagramDoc;
}

/** Zod schema for {@link DiagramMessage}. */
export const DiagramMessageSchema = z.object({
  kind: z.literal("diagram"),
  name: DiagramNameSchema,
  version: VersionSchema,
  origin: OriginSchema,
  dsl: z.string(),
  doc: DiagramDocSchema,
});

/**
 * Broadcast when a submitted DSL failed to parse or validate.
 * Clients keep rendering the last good {@link DiagramMessage} and surface
 * the errors (banner / Monaco markers). `version` stays at the last
 * accepted version — invalid input never bumps it.
 */
export interface DiagramErrorMessage {
  kind: "diagram-error";
  /** Diagram name the failed change targeted. */
  name: string;
  /** Version of the last ACCEPTED state (unchanged by the failure). */
  version: number;
  /** Which side submitted the invalid DSL. */
  origin: Origin;
  /** The offending DSL source, so the drawer can show it with markers. */
  dsl: string;
  /** Syntax errors from the Langium parser (with line/column). */
  parseErrors: ParseError[];
  /** Semantic errors from {@link validateDoc} (with document paths). */
  modelErrors: ModelError[];
}

/** Zod schema for {@link DiagramErrorMessage}. */
export const DiagramErrorMessageSchema = z.object({
  kind: z.literal("diagram-error"),
  name: DiagramNameSchema,
  version: VersionSchema,
  origin: OriginSchema,
  dsl: z.string(),
  parseErrors: z.array(ParseErrorSchema),
  modelErrors: z.array(ModelErrorSchema),
});

/**
 * Workspace listing: all diagram names (including snapshot steps like
 * `news-feed.step2`) plus the currently active one. Sent on connect and
 * whenever the workspace or active diagram changes. Feeds the picker.
 */
export interface WorkspaceMessage {
  kind: "workspace";
  /** All diagram names in the workspace (no `.arch` extension). */
  diagrams: string[];
  /** Name of the currently active diagram. */
  active: string;
}

/** Zod schema for {@link WorkspaceMessage}. */
export const WorkspaceMessageSchema = z.object({
  kind: z.literal("workspace"),
  diagrams: z.array(DiagramNameSchema),
  active: DiagramNameSchema,
});

/**
 * Ask connected web clients to render a PNG snapshot of a diagram
 * (added by T24 / DGC-44). The server cannot rasterize headlessly, so the
 * `get_snapshot` MCP tool broadcasts this request and an open canvas that is
 * currently rendering `name` answers with a {@link SnapshotResponseMessage}
 * carrying the same correlation `id`. Clients showing a different diagram
 * stay silent (the first matching response wins server-side).
 */
export interface SnapshotRequestMessage {
  kind: "snapshot-request";
  /** Correlation id — echoed back verbatim in the response. */
  id: string;
  /** Diagram name to capture (workspace file stem, no extension). */
  name: string;
}

/** Zod schema for {@link SnapshotRequestMessage} (added by T24). */
export const SnapshotRequestMessageSchema = z.object({
  kind: z.literal("snapshot-request"),
  id: z.string().min(1),
  name: DiagramNameSchema,
});

/** Any message the server sends to clients, discriminated by `kind`. */
export type ServerMessage =
  | DiagramMessage
  | DiagramErrorMessage
  | WorkspaceMessage
  | SnapshotRequestMessage;

/** Zod schema for {@link ServerMessage}. */
export const ServerMessageSchema = z.discriminatedUnion("kind", [
  DiagramMessageSchema,
  DiagramErrorMessageSchema,
  WorkspaceMessageSchema,
  SnapshotRequestMessageSchema,
]);

// ---------------------------------------------------------------------------
// Client → Server (defined for v0.4; unused in v0.1)
// ---------------------------------------------------------------------------

/**
 * A client-initiated DSL replacement (drawer edit or canvas gesture
 * serialized back to DSL). The server validates, bumps the version, and
 * broadcasts to the OTHER clients (no echo to the originator).
 * `baseVersion` is the version the client edited on top of, so the server
 * can detect and reject stale writes.
 */
export interface UpdateMessage {
  kind: "update";
  /** Target diagram name. */
  name: string;
  /** Full replacement DSL source. */
  dsl: string;
  /** Which client surface produced the edit. */
  origin: ClientOrigin;
  /** Server version this edit was based on (stale-write detection). */
  baseVersion: number;
}

/** Zod schema for {@link UpdateMessage}. */
export const UpdateMessageSchema = z.object({
  kind: z.literal("update"),
  name: DiagramNameSchema,
  dsl: z.string(),
  origin: ClientOriginSchema,
  baseVersion: VersionSchema,
});

/**
 * A client's answer to a {@link SnapshotRequestMessage} (added by T24 /
 * DGC-44). Sent ONLY by a client whose canvas is currently rendering the
 * requested diagram: `ok: true` carries the rendered PNG as a
 * `data:image/png;base64,…` data URL; `ok: false` carries a human-readable
 * `error` (capture failed, canvas not ready, …).
 */
export interface SnapshotResponseMessage {
  kind: "snapshot-response";
  /** Correlation id copied from the request. */
  id: string;
  /** Diagram name that was captured (copied from the request). */
  name: string;
  /** Whether the capture succeeded. */
  ok: boolean;
  /** PNG data URL (`data:image/png;base64,…`) — present when `ok` is true. */
  dataUrl?: string;
  /** Failure reason — present when `ok` is false. */
  error?: string;
}

/** Zod schema for {@link SnapshotResponseMessage} (added by T24). */
export const SnapshotResponseMessageSchema = z.object({
  kind: z.literal("snapshot-response"),
  id: z.string().min(1),
  name: DiagramNameSchema,
  ok: z.boolean(),
  dataUrl: z.string().optional(),
  error: z.string().optional(),
});

/** Any message a client sends to the server, discriminated by `kind`. */
export type ClientMessage = UpdateMessage | SnapshotResponseMessage;

/** Zod schema for {@link ClientMessage}. */
export const ClientMessageSchema = z.discriminatedUnion("kind", [
  UpdateMessageSchema,
  SnapshotResponseMessageSchema,
]);

/** Any protocol message, either direction. */
export type ProtocolMessage = ServerMessage | ClientMessage;

// ---------------------------------------------------------------------------
// Codec
// ---------------------------------------------------------------------------

/** Result of parsing a raw WS frame: a typed message, or a diagnostic string. */
export type ParseMessageResult<M> =
  | { ok: true; message: M }
  | { ok: false; error: string };

function parseWith<M>(
  raw: string,
  schema: z.ZodType<M, z.ZodTypeDef, unknown>,
): ParseMessageResult<M> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (cause) {
    return { ok: false, error: `Invalid JSON: ${(cause as Error).message}` };
  }
  const parsed = schema.safeParse(json);
  if (parsed.success) {
    return { ok: true, message: parsed.data };
  }
  return { ok: false, error: formatZodError(parsed.error) };
}

/**
 * Parse and validate a raw WS frame received BY a client FROM the server.
 * Never throws; malformed JSON or schema violations return `ok: false`.
 */
export function parseServerMessage(raw: string): ParseMessageResult<ServerMessage> {
  return parseWith(raw, ServerMessageSchema);
}

/**
 * Parse and validate a raw WS frame received BY the server FROM a client.
 * Never throws; malformed JSON or schema violations return `ok: false`.
 */
export function parseClientMessage(raw: string): ParseMessageResult<ClientMessage> {
  return parseWith(raw, ClientMessageSchema);
}

/**
 * Serialize a protocol message to a JSON WS frame.
 * Validates with Zod first and THROWS on an invalid message — an invalid
 * outbound message is a programming error, not a runtime condition.
 */
export function serializeMessage(message: ProtocolMessage): string {
  // Client→server kinds: `update`, plus `snapshot-response` (added by T24).
  const isClientMessage = message.kind === "update" || message.kind === "snapshot-response";
  const schema = isClientMessage ? ClientMessageSchema : ServerMessageSchema;
  const parsed = schema.safeParse(message);
  if (!parsed.success) {
    throw new Error(`Cannot serialize invalid protocol message: ${formatZodError(parsed.error)}`);
  }
  return JSON.stringify(parsed.data);
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = formatErrorPath(issue.path);
      return path === "" ? issue.message : `${path}: ${issue.message}`;
    })
    .join("; ");
}

// --- Compile-time drift guards: schema output must equal the hand-written
// --- message types. A failure here is a broken contract.
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
type _OriginInSync = Assert<MutuallyAssignable<z.infer<typeof OriginSchema>, Origin>>;
type _DiagramInSync = Assert<MutuallyAssignable<z.infer<typeof DiagramMessageSchema>, DiagramMessage>>;
type _DiagramErrorInSync = Assert<
  MutuallyAssignable<z.infer<typeof DiagramErrorMessageSchema>, DiagramErrorMessage>
>;
type _WorkspaceInSync = Assert<
  MutuallyAssignable<z.infer<typeof WorkspaceMessageSchema>, WorkspaceMessage>
>;
type _UpdateInSync = Assert<MutuallyAssignable<z.infer<typeof UpdateMessageSchema>, UpdateMessage>>;
// Snapshot messages (added by T24): note z.infer emits `prop?: T | undefined`
// for `.optional()`, which is mutually assignable with `prop?: T` under the
// default tsconfig (no exactOptionalPropertyTypes), same as the types above.
type _SnapshotRequestInSync = Assert<
  MutuallyAssignable<z.infer<typeof SnapshotRequestMessageSchema>, SnapshotRequestMessage>
>;
type _SnapshotResponseInSync = Assert<
  MutuallyAssignable<z.infer<typeof SnapshotResponseMessageSchema>, SnapshotResponseMessage>
>;
