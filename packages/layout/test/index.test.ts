import { describe, expect, it } from "vitest";
import { validateDoc, type DiagramDoc, type Direction } from "@diagram-copilot/core";
import {
  layoutDiagram,
  measureNode,
  NODE_HEIGHT,
  SPACING_PRESETS,
  type PositionedGraph,
} from "../src/index.js";

/**
 * The spike's hard case: client/cdn at root, a VPC containing a public subnet
 * (alb) and a private subnet (api, worker, redis, postgres, queue), wired with
 * 8 edges including cross-tier ones.
 */
function fixtureDoc(direction: Direction): DiagramDoc {
  return {
    type: "architecture",
    direction,
    nodes: [
      { id: "client", label: "Client" },
      { id: "cdn", label: "CloudFront" },
      { id: "alb", label: "ALB", groupId: "public" },
      { id: "api", label: "API service", groupId: "private" },
      { id: "worker", label: "Worker", groupId: "private" },
      { id: "redis", label: "Redis", groupId: "private" },
      { id: "postgres", label: "Postgres", groupId: "private" },
      { id: "queue", label: "SQS", groupId: "private" },
    ],
    groups: [
      { id: "vpc", label: "VPC" },
      { id: "public", label: "Public subnet", parentId: "vpc" },
      { id: "private", label: "Private subnet", parentId: "vpc" },
    ],
    edges: [
      { id: "e1", from: "client", to: "cdn" },
      { id: "e2", from: "cdn", to: "alb" },
      { id: "e3", from: "alb", to: "api" },
      { id: "e4", from: "api", to: "redis", label: "cache" },
      { id: "e5", from: "api", to: "postgres", label: "query" },
      { id: "e6", from: "api", to: "queue" },
      { id: "e7", from: "queue", to: "worker" },
      { id: "e8", from: "worker", to: "postgres" },
    ],
  };
}

/** All laid-out boxes (nodes + groups) keyed by id. */
function boxesById(graph: PositionedGraph) {
  const map = new Map<
    string,
    { x: number; y: number; width: number; height: number; parentId?: string }
  >();
  for (const box of [...graph.groups, ...graph.nodes]) map.set(box.id, box);
  return map;
}

const EPS = 0.5;

describe("fixture doc is well-formed", () => {
  it("passes core validateDoc", () => {
    expect(validateDoc(fixtureDoc("right")).ok).toBe(true);
  });
});

describe("layoutDiagram — architecture fixture", () => {
  it("gives every node and group finite coordinates and a real size", async () => {
    const graph = await layoutDiagram(fixtureDoc("right"));

    expect(graph.nodes).toHaveLength(8);
    expect(graph.groups).toHaveLength(3);
    for (const box of [...graph.nodes, ...graph.groups]) {
      for (const v of [box.x, box.y, box.width, box.height]) {
        expect(Number.isFinite(v)).toBe(true);
      }
      expect(box.width).toBeGreaterThan(0);
      expect(box.height).toBeGreaterThan(0);
    }
    expect(Number.isFinite(graph.width)).toBe(true);
    expect(Number.isFinite(graph.height)).toBe(true);
    expect(graph.width).toBeGreaterThan(0);
    expect(graph.height).toBeGreaterThan(0);
  });

  it("keeps leaf nodes at the heuristic height", async () => {
    const graph = await layoutDiagram(fixtureDoc("right"));
    for (const node of graph.nodes) {
      expect(node.height).toBe(NODE_HEIGHT);
      expect(node.width).toBe(measureNode(labelOf(node.id)).width);
    }
  });

  it("contains every child fully inside its parent's box", async () => {
    const graph = await layoutDiagram(fixtureDoc("right"));
    const boxes = boxesById(graph);
    // x/y are parent-relative, so containment is a local check.
    for (const box of [...graph.nodes, ...graph.groups]) {
      if (box.parentId === undefined) continue;
      const parent = boxes.get(box.parentId);
      expect(parent).toBeDefined();
      expect(box.x).toBeGreaterThanOrEqual(-EPS);
      expect(box.y).toBeGreaterThanOrEqual(-EPS);
      expect(box.x + box.width).toBeLessThanOrEqual(parent!.width + EPS);
      expect(box.y + box.height).toBeLessThanOrEqual(parent!.height + EPS);
    }
  });

  it("nests groups parent-before-child in the groups array", async () => {
    const graph = await layoutDiagram(fixtureDoc("right"));
    const indexById = new Map(graph.groups.map((g, i) => [g.id, i] as const));
    for (const group of graph.groups) {
      if (group.parentId === undefined) continue;
      expect(indexById.get(group.parentId)!).toBeLessThan(indexById.get(group.id)!);
    }
    // vpc (root) precedes both subnets.
    expect(indexById.get("vpc")).toBe(0);
  });

  it("routes every edge with non-empty sections", async () => {
    const graph = await layoutDiagram(fixtureDoc("right"));
    expect(graph.edges).toHaveLength(8);
    for (const edge of graph.edges) {
      expect(edge.sections.length).toBeGreaterThan(0);
      for (const section of edge.sections) {
        for (const p of [section.startPoint, section.endPoint]) {
          expect(Number.isFinite(p.x)).toBe(true);
          expect(Number.isFinite(p.y)).toBe(true);
        }
      }
    }
    // Labels are carried through.
    expect(graph.edges.find((e) => e.id === "e4")?.label).toBe("cache");
  });

  it("flips the primary axis for direction 'down'", async () => {
    const right = boxesById(await layoutDiagram(fixtureDoc("right")));
    const down = boxesById(await layoutDiagram(fixtureDoc("down")));

    // client → cdn are consecutive root-level layers.
    const rSep = axisSeparation(right, "client", "cdn");
    const dSep = axisSeparation(down, "client", "cdn");
    expect(rSep.dx).toBeGreaterThan(rSep.dy); // RIGHT: mostly horizontal
    expect(dSep.dy).toBeGreaterThan(dSep.dx); // DOWN: mostly vertical
  });

  it("applies the requested spacing preset", async () => {
    // Airy padding is larger, so the VPC group ends up wider than compact.
    const compact = boxesById(await layoutDiagram(fixtureDoc("right"), { spacing: "compact" }));
    const airy = boxesById(await layoutDiagram(fixtureDoc("right"), { spacing: "airy" }));
    expect(SPACING_PRESETS.airy.nodeNode).toBeGreaterThan(SPACING_PRESETS.compact.nodeNode);
    expect(airy.get("vpc")!.width).toBeGreaterThan(compact.get("vpc")!.width);
  });
});

function axisSeparation(
  boxes: ReturnType<typeof boxesById>,
  a: string,
  b: string,
): { dx: number; dy: number } {
  const ba = boxes.get(a)!;
  const bb = boxes.get(b)!;
  return { dx: Math.abs(bb.x - ba.x), dy: Math.abs(bb.y - ba.y) };
}

function labelOf(id: string): string {
  const labels: Record<string, string> = {
    client: "Client",
    cdn: "CloudFront",
    alb: "ALB",
    api: "API service",
    worker: "Worker",
    redis: "Redis",
    postgres: "Postgres",
    queue: "SQS",
  };
  return labels[id]!;
}
