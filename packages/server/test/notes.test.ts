/**
 * Per-diagram notes (DGC-63): the `/api/notes/:name` HTTP API driven against a
 * real `node:http` server over a fresh temp workspace, plus a couple of direct
 * {@link createNotesStore} assertions for the paths the HTTP layer delegates to
 * (sanitize + 1 MB cap). Mirrors `layout-overrides.test.ts`.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type ServerHandle } from "../src/server.js";
import { createNotesApiHandler, createNotesStore, MAX_NOTES_BYTES, NOTES_EXT } from "../src/notes.js";

const openServers = new Set<ServerHandle>();
const tmpDirs = new Set<string>();

afterEach(async () => {
  await Promise.all([...openServers].map((server) => server.stop()));
  openServers.clear();
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs.clear();
});

function makeWorkspace(): string {
  const workspace = mkdtempSync(path.join(tmpdir(), "dgc-notes-"));
  tmpDirs.add(workspace);
  return workspace;
}

/** Start a real server whose `/api/notes` routes read/write a fresh temp workspace. */
async function startWithWorkspace(): Promise<{ base: string; workspace: string }> {
  const workspace = makeWorkspace();
  const server = createServer({ port: 0, notesHandler: createNotesApiHandler(workspace) });
  openServers.add(server);
  const { url } = await server.start();
  return { base: url, workspace };
}

describe("/api/notes/:name — round-trip", () => {
  it("GET returns empty markdown when no notes file exists yet", async () => {
    const { base } = await startWithWorkspace();
    const res = await fetch(`${base}/api/notes/news-feed`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "news-feed", markdown: "" });
  });

  it("PUT persists markdown to <name>.notes.md and GET reads it back", async () => {
    const { base, workspace } = await startWithWorkspace();
    const markdown = "# Trade-offs\n\n- Queue over direct call: decouples the spike.\n- Cache TTL 5m.\n";

    const put = await fetch(`${base}/api/notes/news-feed`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ markdown }),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ name: "news-feed", markdown });

    // Written to the expected `.notes.md` path in the workspace.
    const notesFile = path.join(workspace, `news-feed${NOTES_EXT}`);
    expect(existsSync(notesFile)).toBe(true);
    expect(readFileSync(notesFile, "utf8")).toBe(markdown);

    const get = await fetch(`${base}/api/notes/news-feed`);
    expect(await get.json()).toEqual({ name: "news-feed", markdown });
  });

  it("PUT accepts an empty string (clears the notes)", async () => {
    const { base, workspace } = await startWithWorkspace();
    const notesFile = path.join(workspace, `news-feed${NOTES_EXT}`);
    writeFileSync(notesFile, "old notes");

    const put = await fetch(`${base}/api/notes/news-feed`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ markdown: "" }),
    });
    expect(put.status).toBe(200);
    expect(readFileSync(notesFile, "utf8")).toBe("");
  });

  it("tolerates a trailing .arch on the name (same file as the bare stem)", async () => {
    const { base, workspace } = await startWithWorkspace();
    await fetch(`${base}/api/notes/${encodeURIComponent("news-feed.arch")}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ markdown: "hi" }),
    });
    expect(readFileSync(path.join(workspace, `news-feed${NOTES_EXT}`), "utf8")).toBe("hi");
    const get = await fetch(`${base}/api/notes/news-feed`);
    expect(await get.json()).toEqual({ name: "news-feed", markdown: "hi" });
  });
});

describe("/api/notes/:name — validation", () => {
  it("rejects a body without a string markdown field with 400", async () => {
    const { base } = await startWithWorkspace();
    const res = await fetch(`${base}/api/notes/news-feed`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ markdown: 42 }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.any(String) });
  });

  it("rejects malformed JSON with 400", async () => {
    const { base } = await startWithWorkspace();
    const res = await fetch(`${base}/api/notes/news-feed`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{ not json",
    });
    expect(res.status).toBe(400);
  });

  it("rejects markdown over the 1 MB cap with 400 and writes nothing", async () => {
    const { base, workspace } = await startWithWorkspace();
    const tooBig = "x".repeat(MAX_NOTES_BYTES + 1);
    const res = await fetch(`${base}/api/notes/news-feed`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ markdown: tooBig }),
    });
    expect(res.status).toBe(400);
    expect(existsSync(path.join(workspace, `news-feed${NOTES_EXT}`))).toBe(false);
  });

  it("rejects a path-traversal name with 400 and writes nothing outside the workspace", async () => {
    const { base, workspace } = await startWithWorkspace();
    const res = await fetch(`${base}/api/notes/${encodeURIComponent("../escape")}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ markdown: "leak" }),
    });
    expect(res.status).toBe(400);
    // The parent of the workspace must not have gained an escape notes file.
    expect(existsSync(path.join(path.dirname(workspace), `escape${NOTES_EXT}`))).toBe(false);
  });

  it("rejects an unknown verb (DELETE) with 405", async () => {
    const { base } = await startWithWorkspace();
    const res = await fetch(`${base}/api/notes/news-feed`, { method: "DELETE" });
    expect(res.status).toBe(405);
  });
});

describe("createNotesStore — direct", () => {
  it("round-trips a write then read", () => {
    const store = createNotesStore(makeWorkspace());
    expect(store.write("demo", "hello notes")).toEqual({ ok: true, name: "demo" });
    expect(store.read("demo")).toEqual({ ok: true, name: "demo", markdown: "hello notes" });
  });

  it("reads empty markdown for a diagram that has no notes", () => {
    const store = createNotesStore(makeWorkspace());
    expect(store.read("never-written")).toEqual({ ok: true, name: "never-written", markdown: "" });
  });

  it("refuses an empty name", () => {
    const store = createNotesStore(makeWorkspace());
    expect(store.read("   ").ok).toBe(false);
    expect(store.write("", "x").ok).toBe(false);
  });

  it("refuses a path-traversal name", () => {
    const store = createNotesStore(makeWorkspace());
    const result = store.write("../escape", "x");
    expect(result.ok).toBe(false);
  });

  it("enforces the 1 MB cap", () => {
    const workspace = makeWorkspace();
    const store = createNotesStore(workspace);
    const atLimit = store.write("demo", "y".repeat(MAX_NOTES_BYTES));
    expect(atLimit.ok).toBe(true);
    const overLimit = store.write("demo2", "y".repeat(MAX_NOTES_BYTES + 1));
    expect(overLimit.ok).toBe(false);
    expect(existsSync(path.join(workspace, `demo2${NOTES_EXT}`))).toBe(false);
  });
});
