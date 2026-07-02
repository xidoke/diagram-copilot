/**
 * Template gallery (DGC-66 / F6): fixture discovery (`listTemplates` /
 * `deriveTemplateTitle` / `resolveFixturesDir`) plus the
 * `/api/templates` + `/api/templates/use` HTTP routes, driven against a real
 * `node:http` server (`/api/templates`) and a real `createWorkspaceWatcher`
 * over a temp workspace (`/api/templates/use`) — same shape
 * `http-open.test.ts` uses for `/api/open`.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseDsl } from "@diagram-copilot/core";
import { createServer, type ServerHandle } from "../src/server.js";
import {
  createTemplatesApiHandler,
  deriveTemplateTitle,
  listTemplates,
  readTemplateDsl,
  resolveFixturesDir,
  TEMPLATES_LIST_PATH,
  TEMPLATES_USE_PATH,
} from "../src/templates.js";
import { createWorkspaceWatcher, type WorkspaceWatcher } from "../src/workspace/watcher.js";

const openServers = new Set<ServerHandle>();
const openWatchers = new Set<WorkspaceWatcher>();
const tmpDirs = new Set<string>();

afterEach(async () => {
  await Promise.all([...openWatchers].map((watcher) => watcher.stop()));
  openWatchers.clear();
  await Promise.all([...openServers].map((server) => server.stop()));
  openServers.clear();
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs.clear();
});

function makeWorkspace(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "dgc-templates-"));
  tmpDirs.add(dir);
  return dir;
}

/** Start a real server with the templates API wired to a fresh temp workspace watcher. */
async function startWithWorkspace(): Promise<{ base: string; workspace: string; watcher: WorkspaceWatcher }> {
  const workspace = makeWorkspace();
  const watcher = createWorkspaceWatcher({ dir: workspace, broadcast: () => {} });
  openWatchers.add(watcher);
  await watcher.start();
  const server = createServer({ port: 0, templatesHandler: createTemplatesApiHandler(() => watcher) });
  openServers.add(server);
  const { url } = await server.start();
  return { base: url, workspace, watcher };
}

// --- fixture discovery -------------------------------------------------------

describe("resolveFixturesDir", () => {
  it("resolves to packages/core/fixtures — works running from src (tsx/vitest)", () => {
    const dir = resolveFixturesDir();
    expect(path.basename(dir)).toBe("fixtures");
    expect(path.basename(path.dirname(dir))).toBe("core");
    // Actually readable from this location — proves the relative walk lands
    // on the real directory, not just a plausible-looking path.
    expect(readFileSync(path.join(dir, "url-shortener.arch"), "utf8")).toContain("url-shortener.arch");
  });
});

describe("listTemplates", () => {
  it("lists exactly the 3 shipped fixtures with correct ids, titles, and node counts", () => {
    const templates = listTemplates();
    expect(templates).toEqual([
      { id: "news-feed", title: "News Feed", nodeCount: 12 },
      { id: "rate-limiter", title: "Rate Limiter", nodeCount: 5 },
      { id: "url-shortener", title: "URL Shortener", nodeCount: 7 },
    ]);
  });

  it("nodeCount matches parseDsl(doc).nodes.length for every fixture", () => {
    const fixturesDir = resolveFixturesDir();
    for (const template of listTemplates()) {
      const dsl = readFileSync(path.join(fixturesDir, `${template.id}.arch`), "utf8");
      const result = parseDsl(dsl);
      if (!result.ok) throw new Error(`fixture "${template.id}" failed to parse`);
      expect(template.nodeCount).toBe(result.doc.nodes.length);
    }
  });

  it("returns an empty list rather than throwing when the fixtures dir is missing", () => {
    expect(listTemplates(path.join(tmpdir(), "dgc-templates-does-not-exist"))).toEqual([]);
  });
});

describe("deriveTemplateTitle", () => {
  it("strips the shared '— golden fixture (DGC-N)' suffix and humanizes the slug", () => {
    expect(deriveTemplateTitle("news-feed", "// news-feed.arch — golden fixture (DGC-31)\n")).toBe("News Feed");
    expect(deriveTemplateTitle("rate-limiter", "// rate-limiter.arch — golden fixture (DGC-31)\n")).toBe(
      "Rate Limiter",
    );
    expect(deriveTemplateTitle("url-shortener", "// url-shortener.arch — golden fixture (DGC-31)\n")).toBe(
      "URL Shortener",
    );
  });

  it("uses a genuine descriptive first-line comment verbatim (humanized) when present", () => {
    expect(deriveTemplateTitle("chat", "// A simple chat app\ndirection right\n")).toBe("A Simple Chat App");
  });

  it("falls back to the humanized id when there is no leading comment", () => {
    expect(deriveTemplateTitle("blank-canvas", "direction right\n")).toBe("Blank Canvas");
  });
});

describe("readTemplateDsl", () => {
  it("returns the fixture's raw DSL for a known id", () => {
    const dsl = readTemplateDsl("rate-limiter");
    expect(dsl).toContain("Rate Limiter");
  });

  it("returns null for an unknown id", () => {
    expect(readTemplateDsl("does-not-exist")).toBeNull();
  });
});

// --- GET /api/templates ------------------------------------------------------

describe("GET /api/templates", () => {
  it("returns the 3 fixtures over real HTTP, workspace not required", async () => {
    const server = createServer({ port: 0, templatesHandler: createTemplatesApiHandler(() => null) });
    openServers.add(server);
    const { url } = await server.start();

    const res = await fetch(`${url}${TEMPLATES_LIST_PATH}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { templates: unknown };
    expect(body.templates).toEqual(listTemplates());
  });

  it("rejects a non-GET/HEAD verb with 405", async () => {
    const { base } = await startWithWorkspace();
    const res = await fetch(`${base}${TEMPLATES_LIST_PATH}`, { method: "DELETE" });
    expect(res.status).toBe(405);
  });
});

// --- POST /api/templates/use -------------------------------------------------

function postUse(base: string, body: unknown): Promise<{ status: number; json: unknown }> {
  return fetch(`${base}${TEMPLATES_USE_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, json: await res.json() }));
}

describe("POST /api/templates/use", () => {
  it("creates a diagram whose on-disk content is exactly the fixture DSL, and activates it", async () => {
    const { base, workspace, watcher } = await startWithWorkspace();

    const { status, json } = await postUse(base, { id: "url-shortener", name: "my-shortener" });

    expect(status).toBe(200);
    expect(json).toMatchObject({ ok: true, name: "my-shortener", version: 1 });

    const fixtureDsl = readTemplateDsl("url-shortener");
    const onDisk = readFileSync(path.join(workspace, "my-shortener.arch"), "utf8");
    expect(onDisk).toBe(fixtureDsl);
    expect(watcher.getState().active).toBe("my-shortener");
  });

  it("defaults to the template id as the diagram name when name === id", async () => {
    const { base, workspace } = await startWithWorkspace();

    const { status } = await postUse(base, { id: "rate-limiter", name: "rate-limiter" });

    expect(status).toBe(200);
    expect(readFileSync(path.join(workspace, "rate-limiter.arch"), "utf8")).toBe(
      readTemplateDsl("rate-limiter"),
    );
  });

  it("blocks a name that already exists (name collision)", async () => {
    const { base } = await startWithWorkspace();
    await postUse(base, { id: "news-feed", name: "taken" });

    const { status, json } = await postUse(base, { id: "rate-limiter", name: "taken" });

    expect(status).toBe(400);
    expect(json).toMatchObject({ ok: false });
    expect((json as { error?: string }).error).toMatch(/already exists/);
  });

  it("rejects an unknown template id with 400", async () => {
    const { base } = await startWithWorkspace();

    const { status, json } = await postUse(base, { id: "does-not-exist", name: "whatever" });

    expect(status).toBe(400);
    expect(json).toMatchObject({ ok: false, error: expect.stringContaining("does-not-exist") });
  });

  it.each([
    ["path separator", "../escape"],
    ["empty after trim", "   "],
    ["dot-dot", ".."],
  ])("rejects an invalid diagram name (%s) with ok:false", async (_label, name) => {
    const { base } = await startWithWorkspace();

    const { status, json } = await postUse(base, { id: "news-feed", name });

    expect(status).toBe(400);
    expect(json).toMatchObject({ ok: false });
  });

  it("rejects a missing/non-string id or name with 400", async () => {
    const { base } = await startWithWorkspace();

    expect((await postUse(base, { name: "x" })).status).toBe(400);
    expect((await postUse(base, { id: "news-feed" })).status).toBe(400);
  });

  it("rejects malformed JSON with 400", async () => {
    const { base } = await startWithWorkspace();
    const { status, json } = await postUse(base, "not json");
    expect(status).toBe(400);
    expect(json).toMatchObject({ ok: false });
  });

  it("rejects a non-POST method with 405", async () => {
    const { base } = await startWithWorkspace();
    const res = await fetch(`${base}${TEMPLATES_USE_PATH}`, { method: "GET" });
    expect(res.status).toBe(405);
  });

  it("responds 503 when the workspace watcher has not started yet", async () => {
    const server = createServer({ port: 0, templatesHandler: createTemplatesApiHandler(() => null) });
    openServers.add(server);
    const { url } = await server.start();

    const { status, json } = await postUse(url, { id: "news-feed", name: "demo" });

    expect(status).toBe(503);
    expect(json).toMatchObject({ ok: false, name: "demo" });
  });

  it("does not interfere with the /api/open route when both handlers are wired", async () => {
    const workspace = makeWorkspace();
    const watcher = createWorkspaceWatcher({ dir: workspace, broadcast: () => {} });
    openWatchers.add(watcher);
    await watcher.start();
    const server = createServer({
      port: 0,
      templatesHandler: createTemplatesApiHandler(() => watcher),
      openHandler: async (req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, created: false, name: "n", version: 1 }));
      },
    });
    openServers.add(server);
    const { url } = await server.start();

    const useRes = await postUse(url, { id: "news-feed", name: "from-template" });
    expect(useRes.status).toBe(200);

    const openRes = await fetch(`${url}/api/open`, { method: "POST", body: "{}" });
    expect(openRes.status).toBe(200);
  });
});
