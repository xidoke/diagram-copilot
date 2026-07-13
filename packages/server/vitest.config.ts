import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Several suites (watcher, client-updates) spin REAL chokidar/FSEvents
    // watchers on temp dirs and assert on debounced fs events. With vitest's
    // default parallel file workers, concurrent watcher setup + CPU load
    // delays or outright drops macOS fs events, making those suites flaky
    // (events that never arrive within any reasonable timeout). Running test
    // files sequentially makes fs-event delivery deterministic; the whole
    // suite still finishes in seconds.
    fileParallelism: false,
    // Bind every test HTTP server to 127.0.0.1 instead of the default `::`
    // wildcard, so ephemeral-port servers can't be hijacked by a foreign
    // loopback listener that grabbed the same port. See the module docblock —
    // this is the DGC-102 /mcp 404 / empty-JSON deflake.
    setupFiles: ["./test/setup/loopback.ts"],
  },
});
