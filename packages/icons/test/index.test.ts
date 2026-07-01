import { describe, expect, it } from "vitest";

import { ALIASES, getIcon, hasIcon, listIcons } from "../src/index.js";

describe("registry", () => {
  it("has ~38 canonical icons", () => {
    const all = listIcons();
    expect(all.length).toBeGreaterThanOrEqual(35);
    expect(all.length).toBeLessThanOrEqual(45);
  });

  it("has no duplicate ids", () => {
    const ids = listIcons().map((icon) => icon.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every canonical icon has a non-empty svg containing <svg", () => {
    for (const icon of listIcons()) {
      expect(icon.svg).toBeTruthy();
      expect(icon.svg.length).toBeGreaterThan(0);
      expect(icon.svg).toMatch(/<svg/);
      expect(icon.id).toBe(icon.id.toLowerCase());
    }
  });

  it("includes both lucide and simple-icons sources", () => {
    const sources = new Set(listIcons().map((icon) => icon.source));
    expect(sources.has("lucide")).toBe(true);
    expect(sources.has("simple-icons")).toBe(true);
  });

  it("lucide icons are stroke-based and theme via currentColor", () => {
    const server = getIcon("server");
    expect(server.source).toBe("lucide");
    expect(server.license).toBe("ISC");
    expect(server.svg).toContain("currentColor");
  });

  it("simple-icons logos are filled with currentColor (not baked black)", () => {
    const postgres = getIcon("postgresql");
    expect(postgres.source).toBe("simple-icons");
    expect(postgres.svg).toContain('fill="currentColor"');
  });

  it("apachekafka keeps its icon-specific license override", () => {
    const kafka = getIcon("apachekafka");
    expect(kafka.license).toBe("Apache-2.0");
  });
});

describe("getIcon", () => {
  it("returns the exact registry entry for a canonical id", () => {
    const icon = getIcon("database");
    expect(icon.id).toBe("database");
    expect(icon.source).toBe("lucide");
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(getIcon("  Server  ").id).toBe("server");
    expect(getIcon("PostgreSQL").id).toBe("postgresql");
  });

  it("falls back to a generic box icon for an unknown id, without throwing", () => {
    expect(() => getIcon("totally-unknown-service-xyz")).not.toThrow();
    const fallback = getIcon("totally-unknown-service-xyz");
    expect(fallback.source).toBe("builtin");
    expect(fallback.id).toBe("totally-unknown-service-xyz");
    expect(fallback.svg).toMatch(/<svg/);
    expect(fallback.svg.length).toBeGreaterThan(0);
  });

  it("never returns undefined, even for an empty string id", () => {
    expect(getIcon("")).toBeDefined();
  });
});

describe("hasIcon", () => {
  it("is true for canonical ids and false for unknown ids", () => {
    expect(hasIcon("server")).toBe(true);
    expect(hasIcon("totally-bogus-icon-id")).toBe(false);
  });

  it("is true for known aliases", () => {
    expect(hasIcon("postgres")).toBe(true);
    expect(hasIcon("k8s")).toBe(true);
  });
});

describe("aliases", () => {
  const required = ["postgres", "k8s", "kafka", "node", "db", "lb", "client", "cdn", "queue"];

  it.each(required)("resolves required alias %s", (alias) => {
    expect(hasIcon(alias)).toBe(true);
  });

  it("resolves postgres -> postgresql", () => {
    expect(getIcon("postgres").id).toBe("postgresql");
  });

  it("resolves k8s -> kubernetes", () => {
    expect(getIcon("k8s").id).toBe("kubernetes");
  });

  it("resolves kafka -> apachekafka", () => {
    expect(getIcon("kafka").id).toBe("apachekafka");
  });

  it("resolves node -> nodedotjs", () => {
    expect(getIcon("node").id).toBe("nodedotjs");
  });

  it("resolves db -> database", () => {
    expect(getIcon("db").id).toBe("database");
  });

  it("every alias target exists in the registry", () => {
    for (const [alias, target] of Object.entries(ALIASES)) {
      expect(hasIcon(target), `alias "${alias}" -> "${target}" should resolve`).toBe(true);
    }
  });
});

describe("listIcons", () => {
  it("returns everything when called without a query", () => {
    expect(listIcons().length).toBe(listIcons(undefined).length);
  });

  it("finds postgresql by a partial, case-insensitive query", () => {
    const results = listIcons("post");
    expect(results.some((icon) => icon.id === "postgresql")).toBe(true);
  });

  it("matches by title as well as id", () => {
    const results = listIcons("Kubernetes");
    expect(results.some((icon) => icon.id === "kubernetes")).toBe(true);
  });

  it("returns an empty array for a query that matches nothing", () => {
    expect(listIcons("zzz-nonexistent-zzz")).toEqual([]);
  });
});
