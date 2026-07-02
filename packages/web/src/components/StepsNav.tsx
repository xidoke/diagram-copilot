/**
 * Steps navigation (DGC-12) — "walk diagram evolution like slides." The
 * spec-driven workflow (studydoc v0.5) authors an evolving diagram as a base
 * plus numbered snapshots (`news-feed`, `news-feed.step1`, `news-feed.step2`,
 * …). When the active diagram is anywhere in one of those chains, this shows
 * a small `‹ step 2/4 ›` bar (bottom-center, stacked just above
 * {@link StatusPill}) so a viewer can flip forward/back through the
 * evolution without reopening the Picker each time.
 *
 * Hidden entirely when the active diagram isn't part of a chain — a base
 * diagram with no `.stepN` children is just a diagram, not a "step 1/1".
 *
 * `buildStepChain` is the pure half — no DOM, no network — so it's
 * unit-testable on its own (matches the project's node-only vitest setup;
 * see StatusPill.tsx/Picker.tsx). It reuses `groupDiagrams` (Picker.tsx)
 * rather than re-deriving the `.stepN` grouping rules, so the two stay in
 * lockstep by construction.
 */
import { useCallback, useEffect, useState } from "react";
import type { WorkspaceMessage } from "@diagram-copilot/core";
import { groupDiagrams } from "./Picker.js";
import { isEditableTarget } from "./UndoButton.js";

/** An ordered evolution chain (`[base, step1, step2, …]`) and the active
 *  diagram's position within it. */
export interface StepChain {
  chain: string[];
  index: number;
}

/**
 * Build the step chain the `active` diagram belongs to, or `null` when it
 * isn't part of one (a standalone diagram with no `.stepN` siblings, or a
 * diagram not present in `diagrams` at all). The base diagram is always
 * position 0 (`step 1/N` in the UI), and `.stepN` children follow sorted
 * numerically (matching `groupDiagrams`, so `step10` sorts after `step9`).
 */
export function buildStepChain(diagrams: string[], active: string | null | undefined): StepChain | null {
  if (!active) return null;
  const group = groupDiagrams(diagrams).find((g) => g.root === active || g.steps.includes(active));
  if (!group || group.steps.length === 0) return null;
  const chain = [group.root, ...group.steps];
  const index = chain.indexOf(active);
  return index === -1 ? null : { chain, index };
}

/** Same relative endpoint Picker.tsx uses to activate/create a diagram —
 *  same-origin in production, proxied to :4747 in dev (see Picker.tsx). */
const API_OPEN_URL = "/api/open";

async function requestOpen(name: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(API_OPEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const parsed = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
    if (!parsed) return { ok: false, error: `Unexpected response (HTTP ${res.status}).` };
    return { ok: Boolean(parsed.ok), error: parsed.error };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface StepsNavProps {
  /** Current workspace listing (diagrams + active) — `null` until the first WS frame arrives. */
  workspace: WorkspaceMessage | null;
}

export function StepsNav({ workspace }: StepsNavProps) {
  const [busy, setBusy] = useState(false);
  const stepChain = buildStepChain(workspace?.diagrams ?? [], workspace?.active);
  const prevName = stepChain && stepChain.index > 0 ? stepChain.chain[stepChain.index - 1] : undefined;
  const nextName =
    stepChain && stepChain.index < stepChain.chain.length - 1 ? stepChain.chain[stepChain.index + 1] : undefined;

  const goTo = useCallback(
    (target: string | undefined) => {
      if (!target || busy) return;
      setBusy(true);
      void requestOpen(target)
        .catch((err) => console.warn("[steps-nav] open failed:", err))
        .finally(() => setBusy(false));
    },
    [busy],
  );

  // ← → step through the chain — ignored while focus is inside a text field
  // or the Monaco DSL editor, so arrow keys keep their native meaning there
  // (same guard UndoButton uses for ⌘Z).
  useEffect(() => {
    if (!prevName && !nextName) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;
      if (event.key === "ArrowLeft" && prevName) {
        event.preventDefault();
        goTo(prevName);
      } else if (event.key === "ArrowRight" && nextName) {
        event.preventDefault();
        goTo(nextName);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [prevName, nextName, goTo]);

  if (!stepChain) return null;

  return (
    <div className="steps-nav" role="navigation" aria-label="Diagram evolution steps">
      <button
        type="button"
        className="steps-nav__btn"
        aria-label="Previous step"
        disabled={!prevName || busy}
        onClick={() => goTo(prevName)}
      >
        ‹
      </button>
      <span className="steps-nav__label">
        step {stepChain.index + 1}/{stepChain.chain.length}
      </span>
      <button
        type="button"
        className="steps-nav__btn"
        aria-label="Next step"
        disabled={!nextName || busy}
        onClick={() => goTo(nextName)}
      >
        ›
      </button>
    </div>
  );
}
