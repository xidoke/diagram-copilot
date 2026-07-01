/**
 * `POST /export` — saves a client-rasterized diagram image (PNG/SVG data URL
 * from `packages/web/src/render/export.ts`) to disk under `--export-dir`
 * (T29 / DGC-49).
 *
 * Kept as its own module so `http.ts` only gains a single route branch: all
 * body reading, validation, and filesystem logic lives here.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

/** Route path for the export endpoint. Kept here so `http.ts` and any future
 *  client code reference the same constant, mirroring `MCP_PATH` in `http.ts`. */
export const EXPORT_PATH = "/export";

/** Hard cap on the request body — a retina PNG data URL rarely exceeds a few
 *  MB, but very large diagrams can get big; ~20MB leaves headroom without
 *  letting a runaway/malicious body exhaust memory. */
export const MAX_EXPORT_BODY_BYTES = 20 * 1024 * 1024;

export type ExportFormat = "png" | "svg";

export interface ExportRequestBody {
  name: string;
  version: number;
  format: ExportFormat;
  dataUrl: string;
}

export interface SaveExportResult {
  ok: boolean;
  /** Absolute path written to disk. Only present when `ok`. */
  path?: string;
  /** Human-readable reason. Only present when `!ok`. */
  error?: string;
}

const DATA_URL_RE = /^data:[^,]*;base64,([\s\S]*)$/;

/**
 * Decode a base64 `data:` URL (e.g. `data:image/png;base64,AAAA...`) to raw
 * bytes. Returns `null` for anything else — the browser export pipeline
 * (`toPng`/`toSvg` from html-to-image) always produces base64 data URLs, so
 * a non-matching value is treated as a caller error rather than guessed at.
 */
export function decodeDataUrl(dataUrl: string): Buffer | null {
  const match = DATA_URL_RE.exec(dataUrl);
  if (!match) return null;
  try {
    return Buffer.from(match[1] ?? "", "base64");
  } catch {
    return null;
  }
}

/**
 * Validate a caller-supplied diagram name, rejecting anything that could
 * escape `exportDir` — path separators or `..` — same convention as
 * `validateDiagramName` in `workspace/watcher.ts`.
 */
function validateExportName(raw: string): { ok: true; name: string } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "Missing diagram name." };
  }
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("..")) {
    return {
      ok: false,
      error: `Invalid diagram name "${raw}" — names cannot contain path separators or "..".`,
    };
  }
  return { ok: true, name: trimmed };
}

/** Sanitize an already-traversal-checked name for use as a filename component
 *  (spaces, quotes, etc). Mirrors the web client's `sanitizeForFilename`
 *  (`render/export.ts`) so downloaded and saved filenames look the same. */
function sanitizeForFilename(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\s]+/g, "-");
  return cleaned || "diagram";
}

/**
 * Build `<exportDir>/<name>-v<version>.<format>`, resolving a collision by
 * appending `-2`, `-3`, ... before the extension rather than overwriting.
 */
export function resolveExportPath(
  exportDir: string,
  name: string,
  version: number,
  format: ExportFormat,
): string {
  const base = `${sanitizeForFilename(name)}-v${version}`;
  let candidate = path.join(exportDir, `${base}.${format}`);
  let suffix = 2;
  while (existsSync(candidate)) {
    candidate = path.join(exportDir, `${base}-${suffix}.${format}`);
    suffix += 1;
  }
  return candidate;
}

/**
 * Validate + decode `body`, write it under `exportDir` (created if missing —
 * "create the dir when needed" rather than eagerly at server startup), and
 * report the path written. Never throws; filesystem/validation failures come
 * back as `{ ok: false, error }`.
 */
export function saveExport(exportDir: string, body: ExportRequestBody): SaveExportResult {
  if (body.format !== "png" && body.format !== "svg") {
    return { ok: false, error: `Unsupported format "${String(body.format)}" (expected "png" or "svg").` };
  }
  if (typeof body.version !== "number" || !Number.isFinite(body.version)) {
    return { ok: false, error: "Missing/invalid diagram version." };
  }
  const validated = validateExportName(typeof body.name === "string" ? body.name : "");
  if (!validated.ok) {
    return { ok: false, error: validated.error };
  }
  const bytes = decodeDataUrl(typeof body.dataUrl === "string" ? body.dataUrl : "");
  if (!bytes) {
    return { ok: false, error: "dataUrl must be a base64-encoded data: URL." };
  }

  const root = path.resolve(exportDir);
  mkdirSync(root, { recursive: true });
  const filePath = resolveExportPath(root, validated.name, body.version, body.format);

  // Defense in depth: the name is already traversal-checked above, but
  // assert the final resolved path never escapes exportDir before touching
  // disk, mirroring `resolveWithin` in http.ts.
  const relative = path.relative(root, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return { ok: false, error: "Resolved export path escapes the export directory." };
  }

  writeFileSync(filePath, bytes);
  return { ok: true, path: filePath };
}

/** Parse+narrow an arbitrary JSON value into an {@link ExportRequestBody}. */
function parseExportRequestBody(value: unknown): { ok: true; body: ExportRequestBody } | { ok: false; error: string } {
  if (typeof value !== "object" || value === null) {
    return { ok: false, error: "Request body must be a JSON object." };
  }
  const { name, version, format, dataUrl } = value as Record<string, unknown>;
  if (typeof name !== "string") return { ok: false, error: '"name" must be a string.' };
  if (typeof version !== "number") return { ok: false, error: '"version" must be a number.' };
  if (format !== "png" && format !== "svg") return { ok: false, error: '"format" must be "png" or "svg".' };
  if (typeof dataUrl !== "string") return { ok: false, error: '"dataUrl" must be a string.' };
  return { ok: true, body: { name, version, format, dataUrl } };
}

type BodyReadResult = { ok: true; body: unknown } | { ok: false; status: number; error: string };

/**
 * Buffer the request body up to `maxBytes`, then JSON-parse it. Once the
 * running total crosses `maxBytes` the already-buffered chunks are dropped
 * (bounding memory), but the stream keeps draining to `end` rather than
 * being `destroy()`-ed mid-flight — killing the socket while the client is
 * still writing a large body turns into a client-side connection reset
 * instead of delivering the 413 response, which is the point of this cap.
 */
function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<BodyReadResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let oversize = false;
    let settled = false;

    const finish = (result: BodyReadResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        oversize = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (oversize) {
        finish({ ok: false, status: 413, error: `Request body exceeds ${maxBytes} bytes.` });
        return;
      }
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        const parsed: unknown = raw.length > 0 ? JSON.parse(raw) : undefined;
        finish({ ok: true, body: parsed });
      } catch {
        finish({ ok: false, status: 400, error: "Request body must be valid JSON." });
      }
    });
    req.on("error", () => finish({ ok: false, status: 400, error: "Failed to read request body." }));
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const raw = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(raw),
  });
  res.end(raw);
}

/**
 * `node:http` handler for `POST /export`. Reads the JSON body (bounded by
 * {@link MAX_EXPORT_BODY_BYTES}), validates it, and delegates to
 * {@link saveExport}. Always responds — never leaves the socket hanging.
 */
export async function handleExportRequest(
  req: IncomingMessage,
  res: ServerResponse,
  exportDir: string,
): Promise<void> {
  const bodyResult = await readJsonBody(req, MAX_EXPORT_BODY_BYTES);
  if (!bodyResult.ok) {
    sendJson(res, bodyResult.status, { ok: false, error: bodyResult.error });
    return;
  }
  const parsed = parseExportRequestBody(bodyResult.body);
  if (!parsed.ok) {
    sendJson(res, 400, { ok: false, error: parsed.error });
    return;
  }
  const result = saveExport(exportDir, parsed.body);
  sendJson(res, result.ok ? 200 : 400, result);
}
