/**
 * Inbound client `update` frames → workspace writes (T21).
 *
 * This is the write path for the web clients (drawer/canvas): the hub
 * (`server.ts`) parses the frame, this module decides what happens. The
 * invariants it enforces, per the frozen sync contract:
 *
 * - **No echo loop.** An accepted update broadcasts to every client EXCEPT
 *   the originator (`excludeSocket` → `broadcast({ excludeOrigin })`); the
 *   originator already has its own content and manages its local echo state
 *   (T26). The watcher's content-map separately suppresses the chokidar echo
 *   of the write, so the file event never re-broadcasts or double-bumps.
 * - **Private failures.** A syntax error or unknown-diagram error goes to the
 *   sender ONLY — one client's half-typed DSL is not another client's
 *   problem, and it must never disturb the shared version/file.
 * - **Server wins on conflict (v0.4 trade-off).** `baseVersion` must equal
 *   the current accepted version. A mismatch (stale edit racing another
 *   writer — or a client from before a server restart claiming a future
 *   version) is NOT blind-overwritten and NOT merged: the sender alone gets a
 *   fresh `diagram` frame of current server state (origin `file`, the same
 *   "re-read from disk" convention `buildWelcomeMessages` uses) and is
 *   expected to re-apply its edit on top. Simple and lossy-for-the-loser;
 *   real merging (OT/CRDT) is out of scope for v0.4.
 *
 * Concurrency note: everything here is synchronous on the event loop — no
 * awaits between the version check and the write — so two clients' updates
 * serialize; the second sees the first's bumped version and takes the
 * conflict path. The chokidar pipeline is debounced onto later macrotasks and
 * cannot interleave mid-handler.
 */
import { WebSocket } from "ws";
import {
  parseDsl,
  serializeMessage,
  type ServerMessage,
  type UpdateMessage,
} from "@diagram-copilot/core";
import type { WorkspaceOps } from "./workspace/watcher.js";

/** Send a frame to one specific client (never broadcast). Logs, never throws. */
function sendTo(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  try {
    socket.send(serializeMessage(message));
  } catch (error) {
    console.error("[server] failed to send frame to originating client:", error);
  }
}

/**
 * Build the `onClientUpdate` handler for `createServer` from a workspace
 * accessor. The accessor is a thunk for the same mutable-watcher-ref reason
 * as `getWelcome` in the CLI entry: the watcher only exists after the port
 * is secured. A `null` workspace (startup gap) drops the frame with a log —
 * clients reconnect-sync anyway, and there is no state to corrupt.
 */
export function createClientUpdateHandler(
  getWorkspace: () => WorkspaceOps | null,
): (message: UpdateMessage, sender: WebSocket) => void {
  return function handleClientUpdate(message: UpdateMessage, sender: WebSocket): void {
    const workspace = getWorkspace();
    if (!workspace) {
      console.warn(
        `[server] dropping client update for "${message.name}" — workspace not ready yet`,
      );
      return;
    }

    // 1. The target must already exist — client updates edit diagrams they
    // were shown; creation flows through open/create. Unknown or invalid
    // names fail privately to the sender.
    const current = workspace.read(message.name);
    if (!current.ok || current.dsl === undefined) {
      sendTo(sender, {
        kind: "diagram-error",
        name: message.name,
        version: current.version,
        origin: message.origin,
        dsl: message.dsl,
        parseErrors: [],
        modelErrors: [
          { path: "", message: current.error ?? `Diagram "${message.name}" does not exist.` },
        ],
      });
      return;
    }

    // 2. Validate the DSL before anything touches disk or versions.
    const parsed = parseDsl(message.dsl);
    if (!parsed.ok) {
      sendTo(sender, {
        kind: "diagram-error",
        name: message.name,
        version: current.version,
        origin: message.origin,
        dsl: message.dsl,
        parseErrors: parsed.parseErrors,
        modelErrors: parsed.modelErrors,
      });
      return;
    }

    // 3. Stale-write detection: the edit must be based on the current
    // accepted version. Otherwise re-sync the sender with server state
    // (server wins — see module doc) and touch nothing.
    if (message.baseVersion !== current.version) {
      const onDisk = parseDsl(current.dsl);
      if (onDisk.ok) {
        sendTo(sender, {
          kind: "diagram",
          name: message.name,
          version: current.version,
          origin: "file",
          dsl: current.dsl,
          doc: onDisk.doc,
        });
      } else {
        // Disk currently holds invalid content (external edit mid-flight):
        // the honest re-sync is that error state at the last accepted version.
        sendTo(sender, {
          kind: "diagram-error",
          name: message.name,
          version: current.version,
          origin: "file",
          dsl: current.dsl,
          parseErrors: onDisk.parseErrors,
          modelErrors: onDisk.modelErrors,
        });
      }
      return;
    }

    // 4. Apply: write + version++ + broadcast tagged with the client's origin
    // to everyone EXCEPT the sender.
    const result = workspace.update(message.name, message.dsl, {
      origin: message.origin,
      excludeSocket: sender,
    });
    if (!result.ok) {
      // Unreachable given checks 1-2 (update re-validates name + DSL), but
      // never fail silently toward the client that asked.
      sendTo(sender, {
        kind: "diagram-error",
        name: message.name,
        version: result.version,
        origin: message.origin,
        dsl: message.dsl,
        parseErrors: [],
        modelErrors: [{ path: "", message: result.error ?? "Update failed." }],
      });
    }
  };
}
