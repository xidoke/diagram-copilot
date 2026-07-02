import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseDsl } from "../src/index.js";
import type { DiagramDoc } from "../src/index.js";

/**
 * Golden fixture + snapshot test suite (T11 / DGC-31).
 *
 * `packages/core/fixtures/*.arch` are three real-ish system-design sketches
 * (url shortener, news feed, rate limiter) used both here — as a regression
 * net over the whole parser pipeline in one shot — and by T17 for visual QA
 * in the web renderer. See `fixtures/README.md` for what each one covers.
 *
 * Every fixture gets a `toMatchSnapshot()` (catches *any* unintended change
 * to the mapped doc) plus explicit structural assertions on node/group/edge
 * counts and a few load-bearing ids, so a stale/regenerated snapshot is
 * never the only thing standing between us and a silent regression.
 */

/** Read a fixture file's raw DSL text. */
function loadFixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), "utf8");
}

/** Parse a fixture and assert it parsed cleanly. */
function parseFixture(name: string): DiagramDoc {
  const result = parseDsl(loadFixture(name));
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

describe("golden fixtures — snapshot + structural assertions", () => {
  it("url-shortener.arch: client + service tier + data tier", () => {
    const doc = parseFixture("url-shortener.arch");
    expect(doc).toMatchSnapshot();

    expect(doc.nodes).toHaveLength(7);
    expect(doc.groups).toHaveLength(2);
    expect(doc.edges).toHaveLength(9);

    expect(doc.groups.map((g) => g.id)).toEqual(["Service tier", "Data tier"]);
    // The two API server instances (the "x2" fan-out target) both live in
    // the service tier and both reach cache, database, and analytics queue.
    expect(
      doc.nodes.filter((n) => n.groupId === "Service tier").map((n) => n.id),
    ).toEqual(["LB", "API Server A", "API Server B"]);
    expect(
      doc.nodes.filter((n) => n.groupId === "Data tier").map((n) => n.id),
    ).toEqual(["Cache Redis", "Postgres", "Analytics Queue"]);
    // LB > API Server A, API Server B is a one-to-many fan-out.
    expect(doc.edges.filter((e) => e.from === "LB")).toEqual([
      { id: "e2", from: "LB", to: "API Server A", label: "round robin" },
      { id: "e3", from: "LB", to: "API Server B", label: "round robin" },
    ]);
  });

  it("news-feed.arch: nested VPC with Feed service + Data stores, Kafka fan-out", () => {
    const doc = parseFixture("news-feed.arch");
    expect(doc).toMatchSnapshot();

    expect(doc.nodes).toHaveLength(12);
    expect(doc.groups).toHaveLength(3);
    expect(doc.edges).toHaveLength(11);

    // Two-level nesting: Feed service and Data stores both parent to VPC.
    const groupsById = Object.fromEntries(doc.groups.map((g) => [g.id, g]));
    expect(groupsById["VPC"]?.parentId).toBeUndefined();
    expect(groupsById["Feed service"]?.parentId).toBe("VPC");
    expect(groupsById["Data stores"]?.parentId).toBe("VPC");

    // Kafka Queue sits directly in VPC (shared infra), not in either subtier.
    const kafka = doc.nodes.find((n) => n.id === "Kafka Queue");
    expect(kafka).toMatchObject({ icon: "apachekafka", groupId: "VPC" });

    expect(
      doc.nodes.filter((n) => n.groupId === "Feed service").map((n) => n.id),
    ).toEqual(["API Gateway", "Auth Service", "Fanout Worker", "Notification Service"]);
    expect(
      doc.nodes.filter((n) => n.groupId === "Data stores").map((n) => n.id),
    ).toEqual(["Redis Cache", "Postgres", "Object Storage", "Search Index"]);

    // The fan-out-on-write path: Fanout Worker enqueues onto Kafka, which the
    // Notification Service consumes.
    expect(doc.edges).toContainEqual({
      id: "e10",
      from: "Fanout Worker",
      to: "Kafka Queue",
      label: "enqueue fanout job",
    });
    expect(doc.edges).toContainEqual({
      id: "e11",
      from: "Kafka Queue",
      to: "Notification Service",
      label: "consume fanout job",
    });
  });

  it("rate-limiter.arch: Vietnamese client, Edge + Backend groups", () => {
    const doc = parseFixture("rate-limiter.arch");
    expect(doc).toMatchSnapshot();

    expect(doc.nodes).toHaveLength(5);
    expect(doc.groups).toHaveLength(2);
    expect(doc.edges).toHaveLength(4);

    expect(doc.groups.map((g) => g.id)).toEqual(["Edge", "Backend"]);
    // "Người dùng" (Vietnamese for "user") is the client, ungrouped.
    const client = doc.nodes.find((n) => n.id === "Người dùng");
    expect(client).toEqual({ id: "Người dùng", label: "Người dùng", icon: "monitor" });

    expect(
      doc.nodes.filter((n) => n.groupId === "Edge").map((n) => n.id),
    ).toEqual(["Gateway", "Rate Limiter", "Rules Cache"]);
    expect(
      doc.nodes.filter((n) => n.groupId === "Backend").map((n) => n.id),
    ).toEqual(["API Backend"]);

    // The whole request chain is a straight line through the rate limiter.
    expect(doc.edges.map((e) => `${e.from}>${e.to}`)).toEqual([
      "Người dùng>Gateway",
      "Gateway>Rate Limiter",
      "Rate Limiter>Rules Cache",
      "Rate Limiter>API Backend",
    ]);
  });

  it("microservices.arch: ~60-node stress fixture, 12 nested groups, e-commerce domains (T-PERF/DGC-76)", () => {
    const doc = parseFixture("microservices.arch");
    expect(doc).toMatchSnapshot();

    expect(doc.nodes).toHaveLength(60);
    expect(doc.groups).toHaveLength(12);
    expect(doc.edges).toHaveLength(92);
    // Every edge carries a label — used by the layout perf test to exercise
    // ELK's edge-label reservation on a realistic, fully-labeled graph.
    expect(doc.edges.every((e) => e.label !== undefined)).toBe(true);

    // Platform wraps 9 direct child groups; two domains (Users, Orders) each
    // nest a third-level "…Data" group — the 12 total (3-level-deep) groups.
    expect(doc.groups.map((g) => g.id)).toEqual([
      "Platform",
      "Edge",
      "API Tier",
      "Users Domain",
      "Users Data",
      "Orders Domain",
      "Orders Data",
      "Payments Domain",
      "Inventory Domain",
      "Data Tier",
      "Messaging",
      "Observability",
    ]);
    const groupsById = Object.fromEntries(doc.groups.map((g) => [g.id, g]));
    expect(groupsById["Platform"]?.parentId).toBeUndefined();
    expect(groupsById["Users Data"]?.parentId).toBe("Users Domain");
    expect(groupsById["Orders Data"]?.parentId).toBe("Orders Domain");
    for (const id of ["Edge", "API Tier", "Users Domain", "Orders Domain", "Payments Domain", "Inventory Domain", "Data Tier", "Messaging", "Observability"]) {
      expect(groupsById[id]?.parentId).toBe("Platform");
    }

    // Clients sit outside Platform (the public edge), same pattern as
    // news-feed.arch's Client/CDN split.
    expect(doc.nodes.filter((n) => n.groupId === undefined).map((n) => n.id)).toEqual([
      "Web Client",
      "Mobile Client",
      "Partner Client",
    ]);

    // A one-to-many fan-out (API Gateway routes to both API flavors) and a
    // 4-way fan-in (Prometheus scraping every domain service) both parse to
    // one edge per target, sharing the statement's single label.
    const withoutId = (edges: typeof doc.edges) => edges.map(({ from, to, label }) => ({ from, to, label }));
    expect(withoutId(doc.edges.filter((e) => e.from === "API Gateway" && e.label === "route request"))).toEqual([
      { from: "API Gateway", to: "Public API", label: "route request" },
      { from: "API Gateway", to: "Internal API", label: "route request" },
    ]);
    expect(withoutId(doc.edges.filter((e) => e.from === "Prometheus"))).toEqual([
      { from: "Prometheus", to: "Users Service", label: "scrape metrics" },
      { from: "Prometheus", to: "Orders Service", label: "scrape metrics" },
      { from: "Prometheus", to: "Payments Service", label: "scrape metrics" },
      { from: "Prometheus", to: "Inventory Service", label: "scrape metrics" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Additional edge cases not already covered by test/dsl.test.ts or
// test/dsl-ext.test.ts (checked by grep before adding — see DGC-31 notes):
//
//  - "DSL with only a comment" and "a file of only blank/whitespace lines"
//    are already covered (dsl-ext.test.ts "ignores a comment-only document";
//    dsl.test.ts "returns a valid empty doc for whitespace-only input", whose
//    input is itself blank lines), so they are intentionally NOT repeated
//    here.
//  - A 100+ character node name, an empty group carrying attributes, and an
//    edge label that mixes a literal `:` with a trailing `//` comment are
//    new combinations, added below.
// ---------------------------------------------------------------------------
describe("parseDsl — additional edge cases (DGC-31)", () => {
  it("parses a node name over 100 characters intact", () => {
    const longName = Array.from({ length: 12 }, (_, i) => `Segment${i}`).join(" ");
    expect(longName.length).toBeGreaterThan(100);
    const result = parseDsl(`${longName}\n`);
    if (!result.ok) throw new Error(JSON.stringify(result));
    expect(result.doc.nodes).toEqual([{ id: longName, label: longName }]);
  });

  it("parses an empty group that still carries icon/color/label attributes", () => {
    const result = parseDsl(
      ["Empty Zone [icon: cloud, color: gray, label: Reserved for later] {", "}"].join("\n"),
    );
    if (!result.ok) throw new Error(JSON.stringify(result));
    expect(result.doc.groups).toEqual([
      { id: "Empty Zone", label: "Reserved for later", icon: "cloud", color: "gray" },
    ]);
    expect(result.doc.nodes).toEqual([]);
  });

  it("keeps a literal colon in an edge label while still stripping a trailing // comment", () => {
    const result = parseDsl("A > B: ratio 2:1 // tune later\n");
    if (!result.ok) throw new Error(JSON.stringify(result));
    expect(result.doc.edges).toEqual([{ id: "e1", from: "A", to: "B", label: "ratio 2:1" }]);
  });
});
