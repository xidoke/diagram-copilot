/**
 * Floating connection status pill (theme B: dark blueprint).
 *
 * `statusPillContent` is the pure half — icon/text/tone per
 * {@link ConnectionStatus} — kept separate from JSX so it's testable
 * without rendering (no DOM needed, matches the project's node-only
 * vitest setup).
 */
import type { ConnectionStatus } from "../connection/types.js";

export type StatusPillTone = ConnectionStatus;

export interface StatusPillContent {
  tone: StatusPillTone;
  icon: string;
  text: string;
}

/** Icon/text/tone for a given connection status. Pure — no DOM. */
export function statusPillContent(status: ConnectionStatus): StatusPillContent {
  switch (status) {
    case "connected":
      return { tone: "connected", icon: "●", text: "connected · live" };
    case "connecting":
      return { tone: "connecting", icon: "○", text: "connecting…" };
    case "disconnected":
      return { tone: "disconnected", icon: "◌", text: "disconnected · reconnecting" };
  }
}

export interface StatusPillProps {
  status: ConnectionStatus;
}

export function StatusPill({ status }: StatusPillProps) {
  const { tone, icon, text } = statusPillContent(status);
  return (
    <div className={`status-pill status-pill--${tone}`} role="status">
      <span className="status-pill__icon" aria-hidden="true">
        {icon}
      </span>
      <span className="status-pill__text">{text}</span>
    </div>
  );
}
