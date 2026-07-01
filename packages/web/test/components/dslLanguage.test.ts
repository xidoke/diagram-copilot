/**
 * Data-level smoke tests for the `arch-dsl` Monarch tokenizer + language
 * configuration. `dslLanguage.ts` imports `monaco-editor` with `import
 * type` only, so this file never touches the real (browser-only) Monaco
 * engine — it inspects the tokenizer's rule tuples directly (regexes are
 * plain data) rather than running text through Monaco's tokenizer.
 */
import { describe, expect, it } from "vitest";
import {
  ARCH_DSL_LANGUAGE_ID,
  archDslLanguageConfiguration,
  archDslMonarchLanguage,
  archDslThemeRules,
  registerArchDslLanguage,
} from "../../src/components/dslLanguage";

/** A tokenizer rule tuple is `[RegExp, action]`, possibly with a 3rd
 *  "matchOnlyAtStart"-style element in Monarch's fuller form; we only ever
 *  emit the 2-tuple form, so narrow to that. */
type Rule = readonly [RegExp, unknown];

function rulesOf(state: readonly unknown[]): Rule[] {
  return state.filter((r): r is Rule => Array.isArray(r) && r[0] instanceof RegExp);
}

/** Monarch always matches a rule's regex at the *current scan position* —
 *  never partway into the remaining string — so a plain unanchored
 *  `RegExp.test()` would misidentify the winning rule (e.g. it would find
 *  a bare `:` rule inside `"icon:"` even though the real engine tries
 *  `attr-key` first and it wins at position 0). This mirrors that by only
 *  accepting a match that starts at index 0 of `sample`. */
function matchesAtStart(re: RegExp, sample: string): boolean {
  const anchored = new RegExp(re.source, re.flags.replace("g", ""));
  const m = anchored.exec(sample);
  return m !== null && m.index === 0;
}

/** Finds the first rule in `state` whose regex matches `sample` starting at
 *  position 0 — i.e. the rule Monarch would actually pick there. */
function findRuleMatching(state: readonly unknown[], sample: string): Rule | undefined {
  return rulesOf(state).find(([re]) => matchesAtStart(re, sample));
}

describe("ARCH_DSL_LANGUAGE_ID", () => {
  it("is the stable language + marker-owner id", () => {
    expect(ARCH_DSL_LANGUAGE_ID).toBe("arch-dsl");
  });
});

describe("archDslLanguageConfiguration", () => {
  it("declares `//` as the line comment", () => {
    expect(archDslLanguageConfiguration.comments?.lineComment).toBe("//");
  });

  it("declares [] and {} as matching brackets", () => {
    expect(archDslLanguageConfiguration.brackets).toEqual(
      expect.arrayContaining([
        ["{", "}"],
        ["[", "]"],
      ]),
    );
  });

  it("auto-closes [] and {}", () => {
    const pairs = archDslLanguageConfiguration.autoClosingPairs ?? [];
    expect(pairs).toEqual(
      expect.arrayContaining([
        { open: "{", close: "}" },
        { open: "[", close: "]" },
      ]),
    );
  });
});

describe("archDslMonarchLanguage — root state", () => {
  const root = archDslMonarchLanguage.tokenizer["root"] as unknown[];

  it("has a rule that recognizes a full-line comment", () => {
    const rule = findRuleMatching(root, "// a comment");
    expect(rule).toBeDefined();
    expect(rule?.[1]).toBe("comment");
  });

  it("recognizes a trailing comment after content on the same regex", () => {
    // The comment rule is `//.*$`, so it matches anywhere `//` starts —
    // including mid-string, which is how a trailing `// comment` is found.
    const [regex] = findRuleMatching(root, "// trailing") ?? [];
    expect(regex?.test("Node Name // trailing comment")).toBe(true);
  });

  it("has a rule recognizing the `direction` keyword at line start", () => {
    const rule = findRuleMatching(root, "direction right");
    expect(rule).toBeDefined();
    // Action is a per-group array; the group holding "direction" is tagged
    // keyword and pushes the @direction state to color its value too.
    const action = rule?.[1] as unknown[];
    expect(Array.isArray(action)).toBe(true);
    const keywordGroup = action.find(
      (a) => typeof a === "object" && a !== null && (a as { token?: string }).token === "keyword",
    ) as { next?: string } | undefined;
    expect(keywordGroup?.next).toBe("@direction");
  });

  it("has a rule recognizing the edge operator `>`", () => {
    const rule = findRuleMatching(root, ">");
    expect(rule).toBeDefined();
    expect(rule?.[1]).toBe("operator");
  });

  it("has a rule that starts an edge label at `:`", () => {
    const rule = findRuleMatching(root, ":");
    expect(rule).toBeDefined();
    expect(rule?.[1]).toMatchObject({ next: "@label" });
  });

  it("has a rule that opens the attrs block at `[`", () => {
    const rule = findRuleMatching(root, "[");
    expect(rule).toBeDefined();
    expect(rule?.[1]).toMatchObject({ next: "@attrs" });
  });
});

describe("archDslMonarchLanguage — direction state", () => {
  const direction = archDslMonarchLanguage.tokenizer["direction"] as unknown[];

  it.each(["right", "left", "up", "down"])("colors '%s' as a keyword", (value) => {
    const rule = findRuleMatching(direction, value);
    expect(rule).toBeDefined();
    expect(rule?.[1]).toBe("keyword");
  });

  it("does not treat an arbitrary word as a direction keyword", () => {
    const rules = rulesOf(direction);
    // The keyword rule must not match a value outside right/left/up/down —
    // otherwise any node name would get colored as a keyword after `direction`.
    const keywordRule = rules.find(([, action]) => action === "keyword");
    expect(keywordRule?.[0].test("sideways")).toBe(false);
  });
});

describe("archDslMonarchLanguage — label state", () => {
  const label = archDslMonarchLanguage.tokenizer["label"] as unknown[];

  it("has a rule that colors label text", () => {
    const rule = findRuleMatching(label, "shared label to end of line");
    expect(rule).toBeDefined();
    expect(rule?.[1]).toBe("label");
  });

  it("still colors an embedded `//` inside a label as a comment", () => {
    const rule = findRuleMatching(label, "// trailing comment");
    expect(rule).toBeDefined();
    expect(rule?.[1]).toBe("comment");
  });
});

describe("archDslMonarchLanguage — attrs state", () => {
  const attrs = archDslMonarchLanguage.tokenizer["attrs"] as unknown[];

  it("has a rule that colors an attribute key distinctly from its value", () => {
    const rule = findRuleMatching(attrs, "icon:");
    expect(rule).toBeDefined();
    expect(rule?.[1]).toBe("attr-key");
  });

  it("closes the block and pops out of state at `]`", () => {
    const rule = findRuleMatching(attrs, "]");
    expect(rule).toBeDefined();
    expect(rule?.[1]).toMatchObject({ next: "@pop" });
  });
});

describe("archDslThemeRules", () => {
  const byToken = Object.fromEntries(archDslThemeRules.map((r) => [r.token, r.foreground]));

  it("colors every custom token used by the tokenizer, postfixed to the language", () => {
    for (const name of ["comment", "keyword", "attr-key", "label", "operator"]) {
      expect(byToken[`${name}.arch-dsl`]).toMatch(/^[0-9a-f]{6}$/i);
    }
  });

  it("reuses the editor accent color for the operator token", () => {
    expect(byToken["operator.arch-dsl"]).toBe("4aa3ff");
  });
});

describe("registerArchDslLanguage", () => {
  function makeMonacoStub() {
    const registered: { id: string }[] = [];
    const calls = { register: 0, tokens: 0, config: 0 };
    return {
      registered,
      calls,
      languages: {
        getLanguages: () => registered,
        register: (lang: { id: string }) => {
          registered.push(lang);
          calls.register++;
        },
        setMonarchTokensProvider: () => {
          calls.tokens++;
        },
        setLanguageConfiguration: () => {
          calls.config++;
        },
      },
    };
  }

  it("registers the language, tokenizer, and configuration once", () => {
    const stub = makeMonacoStub();
    registerArchDslLanguage(stub as never);
    expect(stub.calls).toEqual({ register: 1, tokens: 1, config: 1 });
    expect(stub.registered.map((l) => l.id)).toEqual([ARCH_DSL_LANGUAGE_ID]);
  });

  it("is idempotent — skips re-registering if already present", () => {
    const stub = makeMonacoStub();
    registerArchDslLanguage(stub as never);
    registerArchDslLanguage(stub as never);
    expect(stub.calls).toEqual({ register: 1, tokens: 1, config: 1 });
  });
});
