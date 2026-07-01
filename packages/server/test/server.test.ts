import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { parseServerMessage, type ServerMessage } from "@diagram-copilot/core";
import { createServer, WELCOME_WORKSPACE, WS_PATH, type ServerHandle } from "../src/server.js";

/** Track servers/sockets so every test tears down cleanly. */
const openServers = new Set<ServerHandle>();
const openSockets = new Set<WebSocket>();

afterEach(async () => {
  for (const socket of openSockets) socket.close();
  openSockets.clear();
  await Promise.all([...openServers].map((server) => server.stop()));
  openServers.clear();
});

async function startServer(staticDir?: string): Promise<{ server: ServerHandle; port: number }> {
  const server = createServer({ port: 0, staticDir });
  openServers.add(server);
  const { port } = await server.start();
  return { server, port };
}

function connect(port: number): WebSocket {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`);
  openSockets.add(socket);
  return socket;
}

/** Resolve with the next parsed server frame received on `socket`. */
function nextMessage(socket: WebSocket): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    socket.once("message", (data) => {
      const result = parseServerMessage(data.toString());
      if (result.ok) resolve(result.message);
      else reject(new Error(result.error));
    });
    socket.once("error", reject);
  });
}

/** A connected socket that has already consumed its welcome frame. */
async function connectReady(port: number): Promise<WebSocket> {
  const socket = connect(port);
  await nextMessage(socket); // welcome
  return socket;
}

describe("createServer — websocket hub", () => {
  it("greets a newly connected client with the workspace welcome frame", async () => {
    const { port } = await startServer();
    const socket = connect(port);

    const message = await nextMessage(socket);
    expect(message).toEqual(WELCOME_WORKSPACE);
    expect(message.kind).toBe("workspace");
  });

  it("broadcasts a message to every connected client", async () => {
    const { server, port } = await startServer();
    const sockets = await Promise.all([connectReady(port), connectReady(port), connectReady(port)]);

    const pending = sockets.map((socket) => nextMessage(socket));
    const broadcasted: ServerMessage = { kind: "workspace", diagrams: ["news-feed"], active: "news-feed" };
    server.broadcast(broadcasted);

    const received = await Promise.all(pending);
    expect(received).toEqual([broadcasted, broadcasted, broadcasted]);
  });

  it("skips the excluded origin socket when broadcasting", async () => {
    const { server, port } = await startServer();
    const sockets = await Promise.all([connectReady(port), connectReady(port), connectReady(port)]);
    expect(server.clients.size).toBe(3);

    // Exclude one server-side socket; the rest must still receive the frame.
    const [excluded] = [...server.clients];
    let receivedCount = 0;
    for (const socket of sockets) socket.on("message", () => (receivedCount += 1));

    server.broadcast({ kind: "workspace", diagrams: ["a"], active: "a" }, { excludeOrigin: excluded });

    await new Promise((r) => setTimeout(r, 100));
    expect(receivedCount).toBe(2);
  });

  it("ignores an invalid client frame without crashing", async () => {
    const { server, port } = await startServer();
    const socket = await connectReady(port);

    socket.send("not json at all");
    socket.send(JSON.stringify({ kind: "bogus" }));

    // The hub is still healthy: a follow-up broadcast is delivered.
    const next = nextMessage(socket);
    server.broadcast({ kind: "workspace", diagrams: ["x"], active: "x" });
    await expect(next).resolves.toMatchObject({ kind: "workspace", active: "x" });
  });
});

describe("createServer — lifecycle", () => {
  it("rejects start() with EADDRINUSE when the port is taken", async () => {
    const { port } = await startServer();

    const second = createServer({ port });
    openServers.add(second);
    await expect(second.start()).rejects.toMatchObject({ code: "EADDRINUSE" });
  });
});

describe("createServer — http static", () => {
  it("serves the fallback page with 200 when no bundle exists", async () => {
    const { port } = await startServer();

    const response = await fetch(`http://127.0.0.1:${port}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("chưa build");
  });

  it("serves index.html from the static dir with 200", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dgc-static-"));
    try {
      writeFileSync(path.join(dir, "index.html"), "<h1>built app</h1>");
      const { port } = await startServer(dir);

      const response = await fetch(`http://127.0.0.1:${port}/`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("built app");

      // Unknown route falls back to the SPA shell.
      const spa = await fetch(`http://127.0.0.1:${port}/some/client/route`);
      expect(spa.status).toBe(200);
      expect(await spa.text()).toContain("built app");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
