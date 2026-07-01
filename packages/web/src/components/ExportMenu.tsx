/**
 * Floating export menu (DGC-48 / T28) — 📤 trigger button docked top-right,
 * 8px below the layout Toolbar (own floating chrome; Toolbar.tsx is owned by
 * another workstream and isn't touched here). Click opens a small menu:
 * PNG, PNG (transparent), SVG, Copy PNG.
 *
 * Pure presentational + the click wiring: the actual rasterization lives in
 * `render/export.ts`, this component just supplies the node bbox (via
 * `useReactFlow`, so sub-flow/group nodes resolve correctly) and the
 * `<diagramName>-v<version>` filename base.
 */
import { useEffect, useRef, useState } from "react";
import { useReactFlow } from "@xyflow/react";
import { buildExportFilename, copyPngToClipboard, exportPng, exportSvg } from "../render/export.js";

export interface ExportMenuProps {
  /** Active diagram name — used to build the downloaded filename. */
  name: string;
  /** Active diagram version — used to build the downloaded filename. */
  version: number;
}

interface MenuStatus {
  tone: "success" | "error";
  message: string;
}

/** How long a status message (copy result / export error) stays visible. */
const STATUS_TIMEOUT_MS = 2500;

export function ExportMenu({ name, version }: ExportMenuProps) {
  const { getNodes, getNodesBounds } = useReactFlow();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<MenuStatus | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on outside click / Escape — standard dropdown behavior.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as globalThis.Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // Auto-clear any status toast.
  useEffect(() => {
    if (!status) return;
    const id = window.setTimeout(() => setStatus(null), STATUS_TIMEOUT_MS);
    return () => window.clearTimeout(id);
  }, [status]);

  const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

  const handleDownload = async (label: string, action: () => Promise<void>) => {
    setOpen(false);
    try {
      await action();
    } catch (err) {
      setStatus({ tone: "error", message: `${label} export failed: ${errorMessage(err)}` });
    }
  };

  const handlePng = (transparent: boolean) =>
    handleDownload(transparent ? "PNG (transparent)" : "PNG", () =>
      exportPng(getNodesBounds(getNodes()), buildExportFilename(name, version, "png"), { transparent }),
    );

  const handleSvg = () =>
    handleDownload("SVG", () => exportSvg(getNodesBounds(getNodes()), buildExportFilename(name, version, "svg")));

  const handleCopy = async () => {
    setOpen(false);
    const result = await copyPngToClipboard(getNodesBounds(getNodes()));
    setStatus(
      result.ok
        ? { tone: "success", message: "PNG copied to clipboard" }
        : { tone: "error", message: result.error ?? "Copy to clipboard failed" },
    );
  };

  return (
    <div className="export-menu" ref={containerRef}>
      <button
        type="button"
        className="export-menu__trigger"
        title="Export diagram"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        📤
      </button>
      {open && (
        <div className="export-menu__panel" role="menu">
          <button type="button" role="menuitem" className="export-menu__item" onClick={() => handlePng(false)}>
            PNG
          </button>
          <button type="button" role="menuitem" className="export-menu__item" onClick={() => handlePng(true)}>
            PNG (transparent)
          </button>
          <button type="button" role="menuitem" className="export-menu__item" onClick={handleSvg}>
            SVG
          </button>
          <button type="button" role="menuitem" className="export-menu__item" onClick={handleCopy}>
            Copy PNG
          </button>
        </div>
      )}
      {status && (
        <div className={`export-menu__status export-menu__status--${status.tone}`} role="status">
          {status.message}
        </div>
      )}
    </div>
  );
}
