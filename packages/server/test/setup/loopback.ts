/**
 * Deflake the server suite: bind every test HTTP server to the IPv4 loopback
 * address (127.0.0.1) instead of the default wildcard.
 *
 * ## The bug this fixes (DGC-102)
 *
 * `createServer(...).start()` calls `httpServer.listen(port)` with no host, so
 * Node binds the *dual-stack IPv6 wildcard* `::` (all interfaces). Every test,
 * however, connects over the wire to `127.0.0.1` (see the `post`/`fetch`/`ws://`
 * helpers in each file). On macOS/Linux a specific `127.0.0.1:P` listener takes
 * precedence over a dual-stack `::` listener for IPv4 connections to that port.
 *
 * Ephemeral ports (`port: 0`) are drawn from a range (49152–65535) shared with
 * every other local process — VS Code helpers, Chrome, esbuild, and the *other*
 * vitest worker processes that `pnpm test` (`pnpm -r`) runs in parallel. When
 * the OS hands our wildcard server a port that one of those processes already
 * holds as a specific `127.0.0.1` listener, the client's `fetch(127.0.0.1:P)`
 * is answered by *that foreign process*, not our server — producing the
 * intermittent `404` (foreign "404 page not found" or empty body), `405→404`,
 * `200→404`, and "Unexpected end of JSON input" failures. It reproduces only
 * under the full parallel `pnpm test` (more concurrent processes = more foreign
 * loopback listeners = more collisions); a single file always passes.
 *
 * Binding to `127.0.0.1` closes the hole at the root: the OS ephemeral-port
 * allocator for a `127.0.0.1` bind only hands out ports that are free *on that
 * exact address*, so it can never collide with a foreign `127.0.0.1` listener —
 * and IPv4 connections land on our specific bind, never a foreign one. This is
 * exactly what `http-open`/`http-edit`/`http-lifecycle.test.ts` already do
 * manually (`listen(0, "127.0.0.1")`); this hook extends the same guarantee to
 * every `createServer`-based server without touching product code.
 *
 * Production is unaffected: the CLI binds the fixed port 4747, where a clash is
 * a loud `EADDRINUSE` at startup — never a silent hijack — and this hook only
 * runs inside the vitest process.
 */
import http from "node:http";

const LOOPBACK_HOST = "127.0.0.1";
const originalListen = http.Server.prototype.listen;

// Guard against double-patching if this setup file is evaluated more than once.
if (!(originalListen as { __dgcLoopbackPatched?: boolean }).__dgcLoopbackPatched) {
  function patchedListen(this: http.Server, ...args: unknown[]): http.Server {
    // Only rewrite the `listen(port[, callback])` form, where no host/options
    // was supplied. `listen(port, host, ...)`, `listen(options)`, and
    // `listen(path, ...)` all already pin an address (or a pipe) and are left
    // untouched — so tests that intentionally pass "127.0.0.1" are no-ops here.
    if (typeof args[0] === "number" && (args[1] === undefined || typeof args[1] === "function")) {
      args.splice(1, 0, LOOPBACK_HOST);
    }
    return originalListen.apply(this, args as Parameters<http.Server["listen"]>);
  }
  (patchedListen as { __dgcLoopbackPatched?: boolean }).__dgcLoopbackPatched = true;
  http.Server.prototype.listen = patchedListen as http.Server["listen"];
}
