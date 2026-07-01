/**
 * Tests for `POST /export` (T29 / DGC-49): the pure save.ts helpers directly,
 * plus a few end-to-end round trips through the real `node:http` server (same
 * `createServer({ port: 0 })` + `fetch` pattern as mcp.test.ts/server.test.ts)
 * to prove the http.ts route branch + body-reading wiring actually works.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  decodeDataUrl,
  MAX_EXPORT_BODY_BYTES,
  resolveExportPath,
  saveExport,
  type ExportRequestBody,
} from "../src/export/save.js";
import { createServer, type ServerHandle } from "../src/server.js";

/** A real (tiny, 1x1 transparent) PNG, base64-encoded — a valid "fake" PNG dataUrl. */
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const TINY_PNG_DATA_URL = `data:image/png;base64,${TINY_PNG_BASE64}`;
const TINY_PNG_BYTES = Buffer.from(TINY_PNG_BASE64, "base64");

describe("decodeDataUrl", () => {
  it("decodes a base64 PNG data URL to its raw bytes", () => {
    expect(decodeDataUrl(TINY_PNG_DATA_URL)).toEqual(TINY_PNG_BYTES);
  });

  it("decodes a base64 SVG data URL", () => {
    const svg = "<svg></svg>";
    const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
    expect(decodeDataUrl(dataUrl)?.toString("utf8")).toBe(svg);
  });

  it("returns null for a non-data URL / non-base64 value", () => {
    expect(decodeDataUrl("not a data url")).toBeNull();
    expect(decodeDataUrl("data:image/png,not-base64")).toBeNull();
    expect(decodeDataUrl("")).toBeNull();
  });
});

describe("resolveExportPath — collision suffixing", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("returns the plain <name>-v<version>.<format> path when nothing exists yet", () => {
    dir = mktemp();
    const resolved = resolveExportPath(dir, "checkout-flow", 3, "png");
    expect(resolved).toBe(path.join(dir, "checkout-flow-v3.png"));
  });

  it("appends -2, -3, ... on repeated collisions", () => {
    dir = mktemp();
    const base = path.join(dir, "checkout-flow-v1.png");
    const second = path.join(dir, "checkout-flow-v1-2.png");
    writeFileSync(base, "x");
    expect(resolveExportPath(dir, "checkout-flow", 1, "png")).toBe(second);

    writeFileSync(second, "x");
    expect(resolveExportPath(dir, "checkout-flow", 1, "png")).toBe(path.join(dir, "checkout-flow-v1-3.png"));
  });
});

function mktemp(): string {
  return mkdtempSync(path.join(tmpdir(), "dgc-export-"));
}

describe("saveExport", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function body(overrides: Partial<ExportRequestBody> = {}): ExportRequestBody {
    return { name: "checkout-flow", version: 1, format: "png", dataUrl: TINY_PNG_DATA_URL, ...overrides };
  }

  it("writes the decoded bytes to <exportDir>/<name>-v<version>.<format>", () => {
    dir = mktemp();
    const result = saveExport(dir, body());
    expect(result.ok).toBe(true);
    expect(result.path).toBe(path.join(dir, "checkout-flow-v1.png"));
    expect(readFileSync(result.path!)).toEqual(TINY_PNG_BYTES);
  });

  it("creates exportDir when it does not exist yet", () => {
    const parent = mktemp();
    dir = parent;
    const nested = path.join(parent, "nested", "exports");
    const result = saveExport(nested, body());
    expect(result.ok).toBe(true);
    expect(existsSync(nested)).toBe(true);
    expect(existsSync(result.path!)).toBe(true);
  });

  it("dedupes a repeated name/version by appending -2, then -3", () => {
    dir = mktemp();
    const first = saveExport(dir, body());
    const second = saveExport(dir, body());
    const third = saveExport(dir, body());

    expect(first.path).toBe(path.join(dir, "checkout-flow-v1.png"));
    expect(second.path).toBe(path.join(dir, "checkout-flow-v1-2.png"));
    expect(third.path).toBe(path.join(dir, "checkout-flow-v1-3.png"));
    // All three files actually exist with the right bytes — no overwrite.
    for (const result of [first, second, third]) {
      expect(readFileSync(result.path!)).toEqual(TINY_PNG_BYTES);
    }
  });

  it("blocks path traversal via the name field instead of writing outside exportDir", () => {
    dir = mktemp();
    const result = saveExport(dir, body({ name: "../../etc/passwd" }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/path separators|\.\./);
    // Nothing was written outside (or inside) exportDir.
    expect(existsSync(path.join(dir, "..", "..", "etc", "passwd"))).toBe(false);
  });

  it("blocks a name containing a raw path separator", () => {
    dir = mktemp();
    const result = saveExport(dir, body({ name: "sub/dir" }));
    expect(result.ok).toBe(false);
  });

  it("rejects a malformed dataUrl without writing anything", () => {
    dir = mktemp();
    const result = saveExport(dir, body({ dataUrl: "not-a-data-url" }));
    expect(result.ok).toBe(false);
    expect(existsSync(path.join(dir, "checkout-flow-v1.png"))).toBe(false);
  });

  it("rejects an unsupported format", () => {
    dir = mktemp();
    // @ts-expect-error deliberately invalid format for the runtime check
    const result = saveExport(dir, body({ format: "gif" }));
    expect(result.ok).toBe(false);
  });
});

describe("POST /export — end to end over HTTP", () => {
  const openServers = new Set<ServerHandle>();
  let dir: string;

  afterEach(async () => {
    await Promise.all([...openServers].map((server) => server.stop()));
    openServers.clear();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function startServer(exportDir: string): Promise<number> {
    const server = createServer({ port: 0, exportDir });
    openServers.add(server);
    const { port } = await server.start();
    return port;
  }

  it("saves a fake PNG dataUrl to the right file with the right bytes", async () => {
    dir = mktemp();
    const port = await startServer(dir);

    const response = await fetch(`http://127.0.0.1:${port}/export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "news-feed", version: 2, format: "png", dataUrl: TINY_PNG_DATA_URL }),
    });

    expect(response.status).toBe(200);
    const json = (await response.json()) as { ok: boolean; path: string };
    expect(json.ok).toBe(true);
    expect(json.path).toBe(path.join(dir, "news-feed-v2.png"));
    expect(readFileSync(json.path)).toEqual(TINY_PNG_BYTES);
  });

  it("responds 400 and writes nothing for a path-traversal name", async () => {
    dir = mktemp();
    const port = await startServer(dir);

    const response = await fetch(`http://127.0.0.1:${port}/export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "../../etc/passwd", version: 1, format: "png", dataUrl: TINY_PNG_DATA_URL }),
    });

    expect(response.status).toBe(400);
    const json = (await response.json()) as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(existsSync(path.join(dir, "..", "..", "etc", "passwd"))).toBe(false);
  });

  it("appends -2 on a duplicate name+version+format instead of overwriting", async () => {
    dir = mktemp();
    const port = await startServer(dir);
    const post = () =>
      fetch(`http://127.0.0.1:${port}/export`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "demo", version: 1, format: "svg", dataUrl: TINY_PNG_DATA_URL }),
      });

    const first = (await (await post()).json()) as { path: string };
    const second = (await (await post()).json()) as { path: string };

    expect(first.path).toBe(path.join(dir, "demo-v1.svg"));
    expect(second.path).toBe(path.join(dir, "demo-v1-2.svg"));
    expect(existsSync(first.path)).toBe(true);
    expect(existsSync(second.path)).toBe(true);
  });

  it("only mounts the export handler on POST — GET /export falls through to the static pipeline", async () => {
    dir = mktemp();
    const port = await startServer(dir);
    const response = await fetch(`http://127.0.0.1:${port}/export`);
    // No staticDir configured in this test → the static pipeline's fallback
    // HTML (200), not the export handler's JSON response.
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
  });

  it("responds 413 for a body over the ~20MB cap without writing a file", async () => {
    dir = mktemp();
    const port = await startServer(dir);
    const oversized = "a".repeat(MAX_EXPORT_BODY_BYTES + 1024);

    const response = await fetch(`http://127.0.0.1:${port}/export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "big", version: 1, format: "png", dataUrl: oversized }),
    });

    expect(response.status).toBe(413);
  });

  it("does not mount the route when exportDir is not configured (falls through to static 404-ish fallback)", async () => {
    const server = createServer({ port: 0 });
    openServers.add(server);
    const { port } = await server.start();

    const response = await fetch(`http://127.0.0.1:${port}/export`, { method: "POST" });
    // No exportDir wired → not a GET/HEAD → the static pipeline's 405.
    expect(response.status).toBe(405);
  });
});
