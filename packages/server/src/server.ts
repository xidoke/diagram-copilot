/**
 * The diagram-copilot realtime server: a plain `node:http` server that
 * serves the web bundle and hosts a WebSocket hub at {@link WS_PATH}.
 *
 * I/O (argument parsing, process exit, filesystem watching) lives in the CLI
 * entry (`index.ts`) and later tasks. This module is pure wiring around a
 * client set so it can be started on an ephemeral port and driven from tests.
 */
import http from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import {
  parseClientMessage,
  serializeMessage,
  type ServerMessage,
  type WorkspaceMessage,
} from "@diagram-copilot/core";
import { createRequestHandler } from "./http.js";
import type { McpRequestHandler } from "./mcp/handler.js";

/** WebSocket upgrade path. Everything else on the port is HTTP. */
export const WS_PATH = "/ws";

/**
 * Greeting frame sent to every client on connect when no {@link
 * CreateServerOptions.getWelcome} is supplied. `active` must be non-empty
 * per the frozen protocol schema, so we use the `"untitled"` placeholder —
 * the same convention the workspace watcher (T4) uses for an empty workspace.
 */
export const WELCOME_WORKSPACE: WorkspaceMessage = {
  kind: "workspace",
  diagrams: [],
  active: "untitled",
};

export interface CreateServerOptions {
  /** TCP port to bind. Use `0` to let the OS pick an ephemeral port (tests). */
  port: number;
  /** Absolute path to the built web bundle. Omitted/missing → fallback page. */
  staticDir?: string;
  /**
   * Produce the greeting frames sent to a newly connected client, in order
   * (typically a `workspace` message followed by a `diagram`/`diagram-error`
   * for the active diagram). Called fresh on every connection so it always
   * reflects current state. Defaults to `[WELCOME_WORKSPACE]` — callers
   * without a workspace watcher (e.g. most tests) keep the old behavior.
   */
  getWelcome?: () => ServerMessage[];
  /**
   * Handler for the MCP Streamable HTTP endpoint (`/mcp`), built with
   * `createMcpHandler` from `mcp/handler.ts`. Omitted → the route falls
   * through to the static pipeline (servers without MCP, e.g. most tests).
   */
  mcpHandler?: McpRequestHandler;
}

export interface BroadcastOptions {
  /**
   * A connected socket to skip — typically the client that originated the
   * change, so it does not receive an echo of its own edit (the protocol's
   * echo-loop prevention, applied at the hub for socket-level precision).
   */
  excludeOrigin?: WebSocket;
}

/** Result of a successful {@link ServerHandle.start}. */
export interface ServerAddress {
  port: number;
  url: string;
}

/** In-process handle returned by {@link createServer}, consumed by later tasks. */
export interface ServerHandle {
  /** Bind and begin listening. Rejects with an `EADDRINUSE` error if the port is taken. */
  start(): Promise<ServerAddress>;
  /** Close all sockets and stop listening. */
  stop(): Promise<void>;
  /** Serialize (throws if invalid) and send a message to every connected client. */
  broadcast(message: ServerMessage, options?: BroadcastOptions): void;
  /** The live set of connected sockets. */
  readonly clients: Set<WebSocket>;
  /** The actually-bound port (resolves ephemeral `0` after {@link start}). */
  readonly port: number;
}

/**
 * Create a diagram-copilot server. The returned handle is inert until
 * {@link ServerHandle.start} is called.
 */
export function createServer(options: CreateServerOptions): ServerHandle {
  const httpServer = http.createServer(
    createRequestHandler(options.staticDir, options.mcpHandler),
  );
  const clients = new Set<WebSocket>();

  // `noServer` (rather than `{ server }`) keeps `ws` from attaching its own
  // `error`/`listening` handlers to the http server — those re-emit on the
  // WebSocketServer and would turn a bind failure into an uncaught exception,
  // defeating the EADDRINUSE handling in `start()`. We route upgrades here so
  // only `/ws` is accepted.
  const wss = new WebSocketServer({ noServer: true });
  wss.on("error", (error) => console.error("[server] websocket server error:", error));

  httpServer.on("upgrade", (request, socket, head) => {
    const { pathname } = new URL(request.url ?? "/", "http://localhost");
    if (pathname !== WS_PATH) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  wss.on("connection", (socket) => {
    clients.add(socket);

    // Greet the newcomer with current state — the workspace listing and
    // (if `getWelcome` is wired to a watcher) the active diagram.
    const welcomeMessages = options.getWelcome ? options.getWelcome() : [WELCOME_WORKSPACE];
    for (const message of welcomeMessages) {
      try {
        socket.send(serializeMessage(message));
      } catch (error) {
        console.error("[server] failed to send welcome frame:", error);
      }
    }

    socket.on("message", (data) => {
      const raw = Array.isArray(data)
        ? Buffer.concat(data).toString("utf8")
        : data.toString();
      const result = parseClientMessage(raw);
      if (!result.ok) {
        console.warn(`[server] ignoring invalid client message: ${result.error}`);
        return;
      }
      // v0.1 accepts the frame but does not yet apply updates (no workspace
      // write path). Later tasks validate + rebroadcast here.
      console.log(`[server] received ${result.message.kind} message (unhandled in v0.1)`);
    });

    const forget = () => clients.delete(socket);
    socket.on("close", forget);
    socket.on("error", forget);
  });

  function broadcast(message: ServerMessage, opts?: BroadcastOptions): void {
    const frame = serializeMessage(message);
    for (const socket of clients) {
      if (opts?.excludeOrigin && socket === opts.excludeOrigin) continue;
      if (socket.readyState === WebSocket.OPEN) socket.send(frame);
    }
  }

  function currentPort(): number {
    const address = httpServer.address();
    return address && typeof address === "object" ? address.port : options.port;
  }

  return {
    start() {
      return new Promise<ServerAddress>((resolve, reject) => {
        const onError = (error: Error) => {
          httpServer.removeListener("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          httpServer.removeListener("error", onError);
          const port = currentPort();
          resolve({ port, url: `http://127.0.0.1:${port}` });
        };
        httpServer.once("error", onError);
        httpServer.once("listening", onListening);
        httpServer.listen(options.port);
      });
    },
    stop() {
      return new Promise<void>((resolve) => {
        for (const socket of clients) socket.terminate();
        clients.clear();
        wss.close(() => {
          httpServer.close(() => resolve());
          // Drop idle keep-alive HTTP sockets so shutdown (and Ctrl-C) is
          // immediate rather than waiting out the client's keep-alive timeout.
          httpServer.closeAllConnections();
        });
      });
    },
    broadcast,
    get clients() {
      return clients;
    },
    get port() {
      return currentPort();
    },
  };
}
