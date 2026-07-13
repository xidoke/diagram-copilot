/**
 * Guards the DGC-102 deflake invariant: the `test/setup/loopback.ts` setup hook
 * must make every default `http.Server.listen(port)` bind the IPv4 loopback
 * address, so ephemeral-port test servers can't be hijacked by a foreign
 * `127.0.0.1` listener that grabbed the same port. If this regresses, the whole
 * `/mcp` family goes intermittently 404/empty under the full parallel suite.
 */
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type ServerHandle } from "../../src/server.js";

const openServers = new Set<ServerHandle>();
const openRaw = new Set<http.Server>();

afterEach(async () => {
  await Promise.all([...openServers].map((s) => s.stop()));
  openServers.clear();
  await Promise.all([...openRaw].map((s) => new Promise<void>((r) => s.close(() => r()))));
  openRaw.clear();
});

describe("loopback bind (DGC-102)", () => {
  it("a bare http.Server.listen(port) binds 127.0.0.1, not the :: wildcard", async () => {
    const server = http.createServer();
    openRaw.add(server);
    await new Promise<void>((resolve) => server.listen(0, resolve));

    const address = server.address();
    expect(address).not.toBeNull();
    // The setup hook rewrites the host-less form to 127.0.0.1 (IPv4). Without
    // it, Node would report `::` / IPv6 here.
    expect(typeof address === "object" && address?.address).toBe("127.0.0.1");
  });

  it("a createServer() handle also lands on the IPv4 loopback", async () => {
    const server = createServer({ port: 0 });
    openServers.add(server);
    const { port } = await server.start();
    expect(port).toBeGreaterThan(0);

    // Reachable on 127.0.0.1 (the address every test's fetch/ws helper uses).
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    await res.text();
  });

  it("leaves an explicit host untouched (listen(0, host) still honored)", async () => {
    const server = http.createServer();
    openRaw.add(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    expect(typeof address === "object" && address?.address).toBe("127.0.0.1");
  });
});
