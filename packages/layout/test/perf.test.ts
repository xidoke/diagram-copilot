import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseDsl, type DiagramDoc } from "@diagram-copilot/core";
import { layoutDiagram } from "../src/index.js";

/**
 * Layout perf budget (T-PERF/DGC-76).
 *
 * `microservices.arch` (`packages/core/fixtures/microservices.arch`) is a
 * hand-written ~60-node / 12-nested-group / 92-labeled-edge system-design
 * sketch — NOT runtime-generated — used here to stress `layoutDiagram`
 * (elkjs `layered` algorithm) at roughly the size a real, actively-drawn
 * diagram is expected to reach. `news-feed.arch` (12 nodes) is kept
 * alongside it as a small-diagram baseline so a regression shows up as a
 * ratio, not just an absolute number.
 *
 * elkjs runs synchronously on the main thread here (`new ElkConstructor()`
 * with no `workerFactory` — see `packages/layout/src/layout.ts`); there is
 * no web worker in this pipeline yet. See `docs/PERF.md` for the measured
 * numbers, the budget rationale, and the recommended threshold for
 * introducing one.
 *
 * Each number is the median of 3 runs (cheap enough to not need more, and
 * median shaves off one-off JIT/GC outliers better than a mean would).
 * Timings are also `console.log`ged (not just asserted) so a CI run leaves
 * a record of the actual numbers, not just pass/fail.
 */

/** Read a core fixture's raw DSL text. */
function loadFixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../core/fixtures/${name}`, import.meta.url)), "utf8");
}

/** Parse a fixture and assert it parsed cleanly (a perf test on a broken fixture is meaningless). */
function parseFixture(name: string): DiagramDoc {
  const dsl = loadFixture(name);
  const result = parseDsl(dsl);
  if (!result.ok) {
    throw new Error(
      `fixture "${name}" failed to parse: ${JSON.stringify(
        { parseErrors: result.parseErrors, modelErrors: result.modelErrors },
        null,
        2,
      )}`,
    );
  }
  return result.doc;
}

/** Median of 3+ samples (odd length in practice here, so no averaging of the middle two). */
function median(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/** Median wall-clock ms of `runs` calls to `fn`. */
function medianMs(fn: () => void, runs = 3): number {
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    fn();
    samples.push(performance.now() - start);
  }
  return median(samples);
}

/** Median wall-clock ms of `runs` calls to an async `fn`. */
async function medianMsAsync(fn: () => Promise<unknown>, runs = 3): Promise<number> {
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    await fn();
    samples.push(performance.now() - start);
  }
  return median(samples);
}

/** ms budgets (see docs/PERF.md for the measured numbers behind these). */
const BUDGET_MS = {
  microservicesParse: 300,
  microservicesLayout: 1500,
  // news-feed is the small-diagram baseline — generous but still a real
  // regression guard (a small diagram taking >1s would itself be a bug).
  newsFeedParse: 100,
  newsFeedLayout: 500,
} as const;

describe("layout perf — microservices.arch stress fixture (T-PERF/DGC-76)", () => {
  it("parses within budget (median of 3 runs)", () => {
    const dsl = loadFixture("microservices.arch");
    const ms = medianMs(() => {
      const result = parseDsl(dsl);
      if (!result.ok) throw new Error("microservices.arch failed to parse");
    });
    console.log(`[perf] microservices.arch parseDsl: ${ms.toFixed(2)}ms (budget ${BUDGET_MS.microservicesParse}ms)`);
    expect(ms).toBeLessThan(BUDGET_MS.microservicesParse);
  });

  it("lays out within budget (median of 3 runs)", async () => {
    const doc = parseFixture("microservices.arch");
    expect(doc.nodes.length).toBe(60);
    expect(doc.groups.length).toBe(12);

    const ms = await medianMsAsync(() => layoutDiagram(doc));
    console.log(`[perf] microservices.arch layoutDiagram: ${ms.toFixed(2)}ms (budget ${BUDGET_MS.microservicesLayout}ms)`);
    expect(ms).toBeLessThan(BUDGET_MS.microservicesLayout);

    // Sanity: the run actually laid out the whole graph, not a truncated one.
    const graph = await layoutDiagram(doc);
    expect(graph.nodes).toHaveLength(60);
    expect(graph.groups).toHaveLength(12);
    expect(graph.edges).toHaveLength(92);
  });
});

describe("layout perf — news-feed.arch small-diagram baseline (T-PERF/DGC-76)", () => {
  it("parses within budget (median of 3 runs)", () => {
    const dsl = loadFixture("news-feed.arch");
    const ms = medianMs(() => {
      const result = parseDsl(dsl);
      if (!result.ok) throw new Error("news-feed.arch failed to parse");
    });
    console.log(`[perf] news-feed.arch parseDsl: ${ms.toFixed(2)}ms (budget ${BUDGET_MS.newsFeedParse}ms)`);
    expect(ms).toBeLessThan(BUDGET_MS.newsFeedParse);
  });

  it("lays out within budget (median of 3 runs)", async () => {
    const doc = parseFixture("news-feed.arch");
    expect(doc.nodes.length).toBe(12);

    const ms = await medianMsAsync(() => layoutDiagram(doc));
    console.log(`[perf] news-feed.arch layoutDiagram: ${ms.toFixed(2)}ms (budget ${BUDGET_MS.newsFeedLayout}ms)`);
    expect(ms).toBeLessThan(BUDGET_MS.newsFeedLayout);
  });
});
