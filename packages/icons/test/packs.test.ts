import { afterEach, describe, expect, it } from "vitest";

import {
  getIcon,
  hasIcon,
  listAliases,
  listIcons,
  registerIconPack,
  registeredIconPacks,
  unregisterIconPack,
  type IconPackDef,
} from "../src/index.js";

/** A miniature stand-in for the generated AWS pack (same JSON shape). */
function samplePack(overrides: Partial<IconPackDef> = {}): IconPackDef {
  return {
    namespace: "aws",
    title: "AWS Architecture Icons",
    version: "04302026",
    source: "https://aws.amazon.com/architecture/icons/",
    license: "AWS Architecture Icons terms",
    icons: {
      "simple-storage-service": { title: "Amazon Simple Storage Service", svg: '<svg viewBox="0 0 64 64"><rect fill="#7AA116"/></svg>' },
      dynamodb: { title: "Amazon DynamoDB", svg: '<svg viewBox="0 0 64 64"><rect fill="#C925D1"/></svg>' },
      lambda: { title: "AWS Lambda", svg: '<svg viewBox="0 0 64 64"><rect fill="#ED7100"/></svg>' },
      // Bare name that collides with a built-in lucide id on purpose.
      user: { title: "User", svg: '<svg viewBox="0 0 64 64"><rect/></svg>' },
    },
    aliases: {
      s3: "simple-storage-service",
      dynamo: "dynamodb",
      dangling: "not-a-real-target",
    },
    ...overrides,
  };
}

afterEach(() => {
  unregisterIconPack("aws");
  unregisterIconPack("other");
});

describe("without any pack installed (fallback như cũ)", () => {
  it("aws:* ids soft-fall back to the generic box, never throw", () => {
    const icon = getIcon("aws:s3");
    expect(icon.source).toBe("builtin");
    expect(icon.id).toBe("aws:s3");
    expect(icon.svg).toMatch(/<svg/);
    expect(hasIcon("aws:s3")).toBe(false);
  });

  it("bare pack-only names fall back too", () => {
    expect(getIcon("dynamodb").source).toBe("builtin");
  });
});

describe("registerIconPack", () => {
  it("resolves namespaced ids (aws:dynamodb, aws:lambda)", () => {
    registerIconPack(samplePack());
    const icon = getIcon("aws:dynamodb");
    expect(icon.id).toBe("aws:dynamodb");
    expect(icon.title).toBe("Amazon DynamoDB");
    expect(icon.source).toBe("pack");
    expect(icon.pack).toBe("aws");
    expect(icon.license).toContain("AWS");
    expect(hasIcon("aws:lambda")).toBe(true);
  });

  it("resolves in-pack aliases behind the namespace (aws:s3)", () => {
    registerIconPack(samplePack());
    expect(getIcon("aws:s3").id).toBe("aws:simple-storage-service");
    expect(getIcon("AWS:S3").id).toBe("aws:simple-storage-service"); // case-insensitive
  });

  it("resolves bare names once the pack is present (s3, lambda, dynamodb → aws:*)", () => {
    registerIconPack(samplePack());
    expect(getIcon("s3").id).toBe("aws:simple-storage-service");
    expect(getIcon("lambda").id).toBe("aws:lambda");
    expect(getIcon("dynamo").id).toBe("aws:dynamodb");
  });

  it("never shadows a built-in id or alias with a bare pack name", () => {
    registerIconPack(samplePack());
    // `user` exists in the built-in lucide set — the pack's `user` must not win.
    expect(getIcon("user").source).toBe("lucide");
    // `cache` is a built-in alias (→ redis) — stays built-in.
    expect(getIcon("cache").id).toBe("redis");
    // The pack copy stays reachable through its namespace.
    expect(getIcon("aws:user").source).toBe("pack");
  });

  it("keeps pack svg verbatim (no currentColor rewrite of vendor artwork)", () => {
    registerIconPack(samplePack());
    expect(getIcon("aws:lambda").svg).toContain('fill="#ED7100"');
    expect(getIcon("aws:lambda").svg).not.toContain("currentColor");
  });

  it("skips dangling aliases instead of failing the whole pack", () => {
    registerIconPack(samplePack());
    expect(getIcon("aws:dangling").source).toBe("builtin");
  });

  it("throws on malformed definitions", () => {
    expect(() => registerIconPack(samplePack({ namespace: "AWS!" }))).toThrow(/namespace/);
    expect(() => registerIconPack(samplePack({ icons: {} }))).toThrow(/no icons/);
    expect(() =>
      registerIconPack(samplePack({ icons: { bad: { title: "Bad", svg: "not svg" } } })),
    ).toThrow(/<svg>/);
  });

  it("re-registering a namespace replaces the pack; unregister restores fallback", () => {
    registerIconPack(samplePack());
    registerIconPack(samplePack({ icons: { lambda: { title: "AWS Lambda", svg: "<svg/>" } }, aliases: {} }));
    expect(hasIcon("aws:lambda")).toBe(true);
    expect(hasIcon("aws:dynamodb")).toBe(false);
    unregisterIconPack("aws");
    expect(hasIcon("aws:lambda")).toBe(false);
  });
});

describe("listIcons / listAliases / registeredIconPacks with a pack", () => {
  it("listIcons includes pack icons and still filters by substring", () => {
    registerIconPack(samplePack());
    const all = listIcons();
    expect(all.some((icon) => icon.id === "aws:dynamodb")).toBe(true);
    const filtered = listIcons("dynamo");
    expect(filtered.map((icon) => icon.id)).toContain("aws:dynamodb");
    expect(filtered.every((icon) => icon.id.includes("dynamo") || icon.title.toLowerCase().includes("dynamo"))).toBe(true);
  });

  it("listAliases merges built-in aliases with pack shortcuts, minus collisions", () => {
    registerIconPack(samplePack());
    const aliases = listAliases();
    expect(aliases["postgres"]).toBe("postgresql"); // built-in survives
    expect(aliases["s3"]).toBe("aws:simple-storage-service");
    expect(aliases["lambda"]).toBe("aws:lambda"); // bare canonical name of a pack icon
    expect(aliases["user"]).toBeUndefined(); // collides with built-in id → omitted
  });

  it("registeredIconPacks reports namespace/title/version/count", () => {
    registerIconPack(samplePack());
    expect(registeredIconPacks()).toEqual([
      { namespace: "aws", title: "AWS Architecture Icons", version: "04302026", count: 4 },
    ]);
  });
});
