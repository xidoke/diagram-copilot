/**
 * Template gallery (DGC-66 / F6) — "New from template ▸" in the diagram
 * picker. Templates are exactly the golden fixtures already shipped inside
 * `@diagram-copilot/core` (`packages/core/fixtures/*.arch` — the same
 * system-design sketches `golden.test.ts` exercises for T11/DGC-31 plus the
 * ~60-node stress fixture from T-PERF/DGC-76), read straight off disk rather
 * than duplicated into the server package.
 *
 *   - `GET`  `/api/templates`      → `{ templates: TemplateSummary[] }`
 *   - `POST` `/api/templates/use` `{ id, name }` → creates `name` seeded with
 *     the `id` fixture's DSL and makes it active, then responds with the
 *     `{ ok, name, version, error? }` shape `POST /api/open` already uses.
 *
 * ## Fixture resolution (src vs. dist)
 *
 * `packages/core/fixtures/*.arch` live OUTSIDE `packages/core/src/` (core's
 * tsc `rootDir` — see `packages/core/tsconfig.json`), so they are never part
 * of `core`'s `dist/` output: its build step (`langium generate && tsc`)
 * only ever maps `src/` → `dist/` and never touches `fixtures/`. That means
 * the fixtures directory sits at a FIXED path relative to the monorepo
 * layout regardless of whether `core` has been built yet — no
 * `dist`-copy build step is needed (unlike, say, the web bundle).
 *
 * {@link resolveFixturesDir} finds it with a `fileURLToPath(import.meta.url)`
 * relative walk, the same technique `resolveStaticDir()` (`index.ts`) uses
 * for `packages/web/dist` and the same "works from both `src/` and `dist/`"
 * property `serverVersion()` (`index.ts`) gets from `createRequire(...).
 * require("../package.json")`: `packages/server/src/templates.ts` (tsx dev,
 * vitest) and the built `packages/server/dist/templates.js` both sit at the
 * same depth under `packages/server/`, so `../../core/fixtures` resolves to
 * the same real directory from either location. A `createRequire(...)
 * .resolve("@diagram-copilot/core")` approach was considered instead (mirror
 * `serverVersion()`'s `require` more literally) but rejected: `core`'s
 * `package.json` "exports" map only declares `"."` (`development` →
 * `src/index.ts`, default → `dist/index.js`), and CJS `require.resolve`
 * conditions don't include `development`, so it would always resolve to
 * `dist/index.js` — throwing when `core` hasn't been built yet, exactly the
 * `src`-mode case this needs to keep working.
 */
import { readFileSync, readdirSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ARCH_EXT, parseDsl } from "@diagram-copilot/core";
import type { WorkspaceOps } from "./workspace/watcher.js";

/** URL for the template listing (`GET`). */
export const TEMPLATES_LIST_PATH = "/api/templates";

/** URL for creating a diagram from a template (`POST`). */
export const TEMPLATES_USE_PATH = "/api/templates/use";

/** Prefix `http.ts` routes to this module's handler — covers both routes above. */
export const TEMPLATES_API_PREFIX = "/api/templates";

/** One template entry as reported to the picker. */
export interface TemplateSummary {
  /** Fixture file stem — also the `id` passed to `POST /api/templates/use`. */
  id: string;
  /** Human title, derived from the fixture's first-line comment or its filename. */
  title: string;
  /** Node count, from parsing the fixture DSL (`parseDsl(dsl).doc.nodes.length`). */
  nodeCount: number;
}

/**
 * Resolve `packages/core/fixtures` relative to this file's own location. See
 * the module docstring for why this is stable across `src/` (dev/test) and
 * `dist/` (built) without a build-time copy step.
 */
export function resolveFixturesDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../core/fixtures");
}

/** Title-case a `kebab-case`/`snake_case` slug, e.g. `"news-feed"` -> `"News Feed"`. */
function humanizeSlug(slug: string): string {
  return slug
    .split(/[-_\s]+/)
    .filter((word) => word.length > 0)
    .map((word) => (word.toLowerCase() === "url" ? "URL" : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(" ");
}

/**
 * Derive a display title for a fixture: prefer the descriptive text on its
 * first-line `// …` comment, stripping the ` — golden fixture (DGC-N)`
 * suffix all three current fixtures share (and, once stripped, a redundant
 * `<id>.arch` echo if that's all that's left) — falling back to the fixture
 * id itself when there is no usable comment. Either way the result is
 * humanized (`"news-feed"` -> `"News Feed"`, `"url-shortener"` -> `"URL
 * Shortener"`).
 */
export function deriveTemplateTitle(id: string, dsl: string): string {
  const firstLine = (dsl.split(/\r?\n/, 1)[0] ?? "").trim();
  const commentMatch = /^\/\/\s*(.+)$/.exec(firstLine);
  let candidate = commentMatch?.[1]?.trim() ?? "";
  const dashIndex = candidate.indexOf(" — ");
  if (dashIndex !== -1) candidate = candidate.slice(0, dashIndex).trim();
  if (candidate === `${id}${ARCH_EXT}`) candidate = "";
  return humanizeSlug(candidate.length > 0 ? candidate : id);
}

/** List every `.arch` fixture in `fixturesDir` as a {@link TemplateSummary}, sorted by id. */
export function listTemplates(fixturesDir: string = resolveFixturesDir()): TemplateSummary[] {
  let entries: string[];
  try {
    entries = readdirSync(fixturesDir);
  } catch {
    // Fixtures dir missing (shouldn't happen in a normal checkout) — an
    // empty gallery rather than a crash.
    return [];
  }
  return entries
    .filter((entry) => entry.endsWith(ARCH_EXT))
    .map((entry): TemplateSummary => {
      const id = entry.slice(0, -ARCH_EXT.length);
      const dsl = readFileSync(path.join(fixturesDir, entry), "utf8");
      const result = parseDsl(dsl);
      const nodeCount = result.ok ? result.doc.nodes.length : 0;
      return { id, title: deriveTemplateTitle(id, dsl), nodeCount };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Read one template's raw DSL by id. `null` when `id` isn't a known fixture. */
export function readTemplateDsl(id: string, fixturesDir: string = resolveFixturesDir()): string | null {
  try {
    return readFileSync(path.join(fixturesDir, `${id}${ARCH_EXT}`), "utf8");
  } catch {
    return null;
  }
}

// --- HTTP wiring -------------------------------------------------------------

/** The request-handler shape wired into `createRequestHandler` (`http.ts`). */
export type TemplatesApiHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

/** JSON shape sent back by the `use` route — mirrors `/api/open`'s `OpenResult`. */
interface UseResponseBody {
  ok: boolean;
  name: string;
  version: number;
  error?: string;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** Refuse bodies past this size before they're even parsed — `{id, name}` is a few bytes. */
const MAX_USE_BODY_BYTES = 16 * 1024;

/** Buffer and JSON-parse a request body, rejecting anything past {@link MAX_USE_BODY_BYTES}. */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_USE_BODY_BYTES) {
      throw new Error("Request body too large.");
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw.length === 0) return {};
  return JSON.parse(raw);
}

function sendUse(res: ServerResponse, status: number, body: UseResponseBody): void {
  sendJson(res, status, body);
}

/**
 * Build the combined `/api/templates` (`GET`, list) + `/api/templates/use`
 * (`POST`, create-from-template) handler, bound to `getWorkspace` — the same
 * mutable-watcher-ref pattern `createOpenHandler` (`http.ts`) uses, since the
 * watcher is only created once the server has secured its port. Listing
 * needs no workspace (it just reads the fixtures dir); only `use` reads
 * `getWorkspace()`, and responds `503` while it is still `null`.
 */
export function createTemplatesApiHandler(getWorkspace: () => WorkspaceOps | null): TemplatesApiHandler {
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === TEMPLATES_LIST_PATH) {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { allow: "GET", "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "Method Not Allowed" }));
        return;
      }
      sendJson(res, 200, { templates: listTemplates() });
      return;
    }

    if (url.pathname === TEMPLATES_USE_PATH) {
      if (req.method !== "POST") {
        res.writeHead(405, { allow: "POST", "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, name: "", version: 0, error: "Method Not Allowed" }));
        return;
      }

      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        sendUse(res, 400, { ok: false, name: "", version: 0, error: "Invalid JSON body." });
        return;
      }

      const rawId =
        body !== null && typeof body === "object" && "id" in body ? (body as { id: unknown }).id : undefined;
      const rawName =
        body !== null && typeof body === "object" && "name" in body
          ? (body as { name: unknown }).name
          : undefined;
      if (typeof rawId !== "string" || typeof rawName !== "string") {
        sendUse(res, 400, {
          ok: false,
          name: typeof rawName === "string" ? rawName : "",
          version: 0,
          error: '"id" and "name" must be strings.',
        });
        return;
      }

      const dsl = readTemplateDsl(rawId);
      if (dsl === null) {
        sendUse(res, 400, { ok: false, name: rawName, version: 0, error: `Unknown template "${rawId}".` });
        return;
      }

      const workspace = getWorkspace();
      if (!workspace) {
        sendUse(res, 503, {
          ok: false,
          name: rawName,
          version: 0,
          error: "Workspace is not ready yet — try again in a moment.",
        });
        return;
      }

      // Validates + normalizes `rawName` and refuses to clobber an existing
      // diagram — same choke point `open`/`snapshot_diagram` go through.
      const created = workspace.createDiagram(rawName, dsl);
      if (!created.ok) {
        sendUse(res, 400, { ok: false, name: created.name, version: 0, error: created.error });
        return;
      }
      // `createDiagram` activates the file it just wrote but its result type
      // carries no version; look the accepted version back up from `list()`.
      const listing = workspace.list().find((entry) => entry.name === created.name);
      sendUse(res, 200, { ok: true, name: created.name, version: listing?.version ?? 1 });
      return;
    }

    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "Not Found" }));
  };
}
