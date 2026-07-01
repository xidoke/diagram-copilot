/**
 * Onboarding empty state (theme B: dark blueprint) — a translucent panel
 * centered over the canvas the first time the workspace is confirmed to
 * have zero diagrams. Walks a first-time user through three ways to get a
 * diagram on screen: connect Claude Code via MCP, ask Claude Code to draw
 * one, or open the DSL drawer (⌘E) and write it by hand. A fourth shortcut
 * — "Tạo sơ đồ mẫu" — sends a tiny demo diagram so the canvas isn't empty
 * forever even without an MCP session.
 *
 * `shouldShowEmptyState` is the pure gate — kept separate from JSX so it's
 * testable without rendering (matches the project's node-only vitest setup;
 * see StatusPill.tsx).
 */
import { useEffect, useState } from "react";
import type { ClientMessage, DiagramMessage, WorkspaceMessage } from "@diagram-copilot/core";

/** Command shown in step ① — copy/pasted into a shell to register the MCP server. */
export const MCP_ADD_COMMAND = "claude mcp add --transport http diagram-copilot http://localhost:4747/mcp";

/**
 * Small demo diagram (4 nodes, icon + color on each, one group) sent by the
 * "Tạo sơ đồ mẫu" button. Deliberately tiny and self-contained so it parses
 * with today's DSL grammar even before server-side seeding (T21) lands —
 * the button always sends *something* useful; if the server doesn't yet
 * accept an `update` for a brand-new name, this degrades to a no-op (the
 * existing diagram-error banner would surface a rejection) rather than a
 * crash.
 */
export const DEMO_DSL = `direction right

Client [icon: monitor, color: blue]

Services {
  API [icon: server, color: green]
  Cache [icon: redis, color: red]
}

Database [icon: database, color: orange]

Client > API: request
API > Cache: check cache
API > Database: query
`;

/** Diagram name the demo is sent under. */
const DEMO_DIAGRAM_NAME = "demo";

/** How long the "đã chép" copy confirmation stays visible. */
const COPY_CONFIRM_MS = 2000;

/**
 * Gate for the empty-state overlay. Shown only once the server has
 * confirmed the workspace is genuinely empty:
 * - `workspace` is `null` until the first `workspace` message arrives, so
 *   this stays `false` while still connecting ("no data yet" is not the
 *   same as "workspace is empty").
 * - A non-null `lastDiagram` means a diagram is already rendered; treated
 *   as authoritative over a possibly-stale `workspace.diagrams` so the
 *   overlay never flashes on top of live content.
 */
export function shouldShowEmptyState(
  workspace: WorkspaceMessage | null,
  lastDiagram: DiagramMessage | null,
): boolean {
  if (!workspace) return false;
  if (lastDiagram) return false;
  return workspace.diagrams.length === 0;
}

export interface EmptyStateProps {
  /** Current workspace listing — only rendered once it's confirmed empty. */
  workspace: WorkspaceMessage;
  /** Outbound sink (from `useDiagramConnection`) — used by the demo button. */
  send: (message: ClientMessage) => void;
}

export function EmptyState({ send }: EmptyStateProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), COPY_CONFIRM_MS);
    return () => window.clearTimeout(id);
  }, [copied]);

  const handleCopy = () => {
    navigator.clipboard?.writeText(MCP_ADD_COMMAND).then(
      () => setCopied(true),
      () => {
        /* clipboard denied/unavailable — silently ignore, command is still selectable text */
      },
    );
  };

  const handleDemo = () => {
    send({
      kind: "update",
      name: DEMO_DIAGRAM_NAME,
      dsl: DEMO_DSL,
      origin: "drawer",
      baseVersion: 0,
    });
  };

  return (
    <div className="empty-state">
      <div className="empty-state__panel">
        <div className="empty-state__title">Chưa có sơ đồ nào</div>
        <div className="empty-state__subtitle">Bắt đầu bằng một trong ba cách sau:</div>

        <ol className="empty-state__steps">
          <li className="empty-state__step">
            <span className="empty-state__step-num">1</span>
            <div className="empty-state__step-body">
              <div>Kết nối Claude Code:</div>
              <div className="empty-state__code-row">
                <code className="empty-state__code">{MCP_ADD_COMMAND}</code>
                <button
                  type="button"
                  className="empty-state__copy-btn"
                  onClick={handleCopy}
                  title="Copy command"
                >
                  {copied ? "đã chép" : "chép"}
                </button>
              </div>
            </div>
          </li>
          <li className="empty-state__step">
            <span className="empty-state__step-num">2</span>
            <div className="empty-state__step-body">
              Trong phiên Claude Code: “hãy vẽ hệ thống …” — tool <code>set_diagram</code> sẽ vẽ lên đây.
            </div>
          </li>
          <li className="empty-state__step">
            <span className="empty-state__step-num">3</span>
            <div className="empty-state__step-body">
              Hoặc tự tay: nhấn <kbd className="empty-state__kbd">⌘E</kbd> để mở editor.
            </div>
          </li>
        </ol>

        <button type="button" className="empty-state__demo-btn" onClick={handleDemo}>
          Tạo sơ đồ mẫu
        </button>
      </div>
    </div>
  );
}
