/**
 * Right-click context menu for a node or group (DGC-20 v1.2 visual editing).
 *
 * Opened by `App`'s `onNodeContextMenu` at the pointer, it offers the surgical
 * edits that have no drag gesture: change icon, change color, delete. Every
 * action is translated by the caller into a `POST /api/edit` op (the canvas
 * then refreshes off the WS broadcast — no optimistic UI, same path as the rest
 * of visual editing); this component only decides WHICH op and gathers its
 * value.
 *
 *   • Đổi icon  → a searchable icon grid (reuses `buildIconEntries`/`filterIcons`
 *                 from IconPalette) → `set_attr {key:"icon"}`; "Bỏ icon" sends null.
 *   • Đổi màu   → the nine DSL color swatches (COLOR_TOKENS) → `set_attr
 *                 {key:"color"}`; "Bỏ màu" sends null.
 *   • Xóa       → a node deletes straight away; a GROUP routes through an inline
 *                 confirm step first, because `remove` cascades every member —
 *                 this is the one explicit path to delete a group from the canvas
 *                 (Delete key deliberately skips groups, DGC-19).
 *
 * Portaled to <body> (like IconPalette) so it escapes the canvas stacking
 * context, positioned `fixed` at the click's viewport coords and clamped to
 * stay on-screen. Closes on Escape or an outside click.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { buildIconEntries, filterIcons } from "./IconPalette.js";
import { COLOR_TOKENS, resolveColor } from "../render/colors.js";
import { ARCH_GROUP_TYPE } from "../render/toFlow.js";
import "./contextMenu.css";

/** The subset of a right-clicked React Flow node the menu needs. */
export interface ContextMenuTarget {
  id: string;
  /** React Flow node type — `ARCH_GROUP_TYPE` gates the delete-confirm step. */
  type?: string;
  /** Current attrs, to mark the active icon/color in the pickers. */
  data?: { icon?: unknown; color?: unknown };
}

export interface ContextMenuProps {
  target: ContextMenuTarget;
  /** Viewport coords of the click (fixed-positioned, then clamped on-screen). */
  x: number;
  y: number;
  onClose: () => void;
  /** Change or remove an attribute (`value: null` removes it). */
  onSetAttr: (id: string, key: "icon" | "color", value: string | null) => void;
  /** Delete the target (a group takes its members with it — already confirmed). */
  onDelete: (target: ContextMenuTarget) => void;
}

/** Estimated menu size, used only to clamp the anchor so it never runs off-screen. */
const MENU_W = 240;
const MENU_H = 340;
const EDGE_PAD = 8;

type View = "root" | "icon" | "color" | "confirm";

export function ContextMenu({ target, x, y, onClose, onSetAttr, onDelete }: ContextMenuProps) {
  const [view, setView] = useState<View>("root");
  const [query, setQuery] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);
  const iconEntries = useMemo(() => buildIconEntries(), []);
  const filteredIcons = useMemo(() => filterIcons(iconEntries, query), [iconEntries, query]);

  const isGroup = target.type === ARCH_GROUP_TYPE;
  const currentIcon = typeof target.data?.icon === "string" ? target.data.icon : undefined;
  const currentColor = typeof target.data?.color === "string" ? target.data.color : undefined;

  // Clamp the anchor into the viewport so a click near the right/bottom edge
  // doesn't push the panel off-screen.
  const left = Math.max(EDGE_PAD, Math.min(x, window.innerWidth - MENU_W - EDGE_PAD));
  const top = Math.max(EDGE_PAD, Math.min(y, window.innerHeight - MENU_H - EDGE_PAD));

  // Close on Escape / outside click. Mousedown (not click) so it beats React
  // Flow's own pane handlers, matching ExportMenu/IconPalette.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    const onPointerDown = (e: MouseEvent) => {
      if (!panelRef.current?.contains(e.target as globalThis.Node)) onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [onClose]);

  const setIcon = (value: string | null) => {
    onSetAttr(target.id, "icon", value);
    onClose();
  };
  const setColor = (value: string | null) => {
    onSetAttr(target.id, "color", value);
    onClose();
  };

  return createPortal(
    <div
      ref={panelRef}
      className="ctx-menu"
      role="menu"
      aria-label={`Tùy chọn cho "${target.id}"`}
      style={{ left, top }}
      // A right-click inside the menu shouldn't spawn the browser menu.
      onContextMenu={(e) => e.preventDefault()}
    >
      {view === "root" && (
        <>
          <div className="ctx-menu__title" title={target.id}>
            {isGroup ? "Nhóm" : "Node"}: {target.id}
          </div>
          <button type="button" role="menuitem" className="ctx-menu__item" onClick={() => setView("icon")}>
            <span>Đổi icon</span>
            <span className="ctx-menu__chevron" aria-hidden="true">
              ›
            </span>
          </button>
          <button type="button" role="menuitem" className="ctx-menu__item" onClick={() => setView("color")}>
            <span>Đổi màu</span>
            <span className="ctx-menu__chevron" aria-hidden="true">
              ›
            </span>
          </button>
          <div className="ctx-menu__sep" role="separator" />
          <button
            type="button"
            role="menuitem"
            className="ctx-menu__item ctx-menu__item--danger"
            onClick={() => (isGroup ? setView("confirm") : (onDelete(target), onClose()))}
          >
            {isGroup ? "Xóa nhóm…" : "Xóa"}
          </button>
        </>
      )}

      {view === "icon" && (
        <div className="ctx-menu__picker">
          <div className="ctx-menu__pickhead">
            <button
              type="button"
              className="ctx-menu__back"
              onClick={() => {
                setView("root");
                setQuery("");
              }}
              aria-label="Quay lại"
            >
              ‹
            </button>
            <input
              type="text"
              className="ctx-menu__search"
              placeholder="Tìm icon…"
              value={query}
              autoFocus
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Tìm icon theo tên hoặc alias"
            />
          </div>
          <button type="button" className="ctx-menu__clear" onClick={() => setIcon(null)}>
            ✕ Bỏ icon
          </button>
          {filteredIcons.length === 0 ? (
            <p className="ctx-menu__empty">Không có icon khớp.</p>
          ) : (
            <div className="ctx-menu__icongrid">
              {filteredIcons.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className={`ctx-menu__iconcell${entry.id === currentIcon ? " is-active" : ""}`}
                  title={entry.title}
                  onClick={() => setIcon(entry.id)}
                >
                  <span
                    className="ctx-menu__glyph"
                    // Trusted, baked markup from @diagram-copilot/icons (see ArchNode).
                    dangerouslySetInnerHTML={{ __html: entry.svg }}
                  />
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {view === "color" && (
        <div className="ctx-menu__picker">
          <div className="ctx-menu__pickhead">
            <button
              type="button"
              className="ctx-menu__back"
              onClick={() => setView("root")}
              aria-label="Quay lại"
            >
              ‹
            </button>
            <span className="ctx-menu__picktitle">Đổi màu</span>
          </div>
          <div className="ctx-menu__swatches">
            {COLOR_TOKENS.map((token) => (
              <button
                key={token}
                type="button"
                className={`ctx-menu__swatch${token === currentColor ? " is-active" : ""}`}
                title={token}
                aria-label={token}
                style={{ background: resolveColor(token) }}
                onClick={() => setColor(token)}
              />
            ))}
          </div>
          <button type="button" className="ctx-menu__clear" onClick={() => setColor(null)}>
            ✕ Bỏ màu
          </button>
        </div>
      )}

      {view === "confirm" && (
        <div className="ctx-menu__confirm">
          <p className="ctx-menu__confirmtext">
            Xóa nhóm <b>{target.id}</b> và toàn bộ thành viên bên trong?
          </p>
          <div className="ctx-menu__confirmrow">
            <button type="button" className="ctx-menu__btn" onClick={() => setView("root")}>
              Hủy
            </button>
            <button
              type="button"
              className="ctx-menu__btn ctx-menu__btn--danger"
              onClick={() => {
                onDelete(target);
                onClose();
              }}
            >
              Xóa nhóm
            </button>
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}
