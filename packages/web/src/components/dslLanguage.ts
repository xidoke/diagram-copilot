/**
 * Monaco language definition for `arch-dsl` (T27, DGC-47) — syntax
 * highlighting for the DSL parsed by `@diagram-copilot/core`
 * (`packages/core/src/dsl/arch-dsl.langium`).
 *
 * This module is deliberately Monaco-*type*-only: it imports `monaco-editor`
 * with `import type`, which TypeScript erases at compile time, so the file
 * has zero runtime dependency on the (browser-only) `monaco-editor` package.
 * That keeps it safe to import from plain Node vitest specs — the Monarch
 * tokenizer and language configuration below are just data, and are
 * asserted on directly rather than run through a real Monaco instance (see
 * `test/components/dslLanguage.test.ts`).
 *
 * The tokenizer is a best-effort *approximation* of the Langium grammar, not
 * a reimplementation of it — Monarch is a regex-per-state lexer with no
 * lookahead across the full grammar, so a few corners are intentionally
 * simplified (documented inline). Good enough for editor coloring; the
 * server remains the only real parser (see protocol/index.ts).
 */
import type { Monaco } from "@monaco-editor/react";
import type { editor, languages } from "monaco-editor";

/** Language id registered with Monaco; also the marker owner used for
 *  diagnostics (see `drawerMarkers.ts`) so they can be cleared selectively. */
export const ARCH_DSL_LANGUAGE_ID = "arch-dsl";

/** Recognized `direction` values — highlighted as keywords only when they
 *  appear as the value of a `direction` line (grammar note: they are NOT
 *  reserved words elsewhere, so a node named "up" stays plain text). */
const DIRECTION_VALUES = ["right", "left", "up", "down"];

/**
 * `monaco.languages.LanguageConfiguration` for `arch-dsl` — comment token,
 * bracket matching, and auto-closing pairs for `[]` / `{}`.
 */
export const archDslLanguageConfiguration: languages.LanguageConfiguration = {
  comments: {
    lineComment: "//",
  },
  brackets: [
    ["{", "}"],
    ["[", "]"],
  ],
  autoClosingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
  ],
  surroundingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
  ],
};

/**
 * Monarch tokenizer for `arch-dsl`. Token names map to theme rules added in
 * `Drawer.tsx`'s `defineTheme` call: `comment`, `keyword`, `attr-key`,
 * `label`, `operator`. Everything else (node/group names, attribute values)
 * uses the default token so it inherits the editor's plain foreground.
 */
export const archDslMonarchLanguage: languages.IMonarchLanguage = {
  defaultToken: "",
  tokenPostfix: ".arch-dsl",

  tokenizer: {
    root: [
      // Full-line or trailing comment — `//` to end of line. Checked first
      // so it always wins at a token boundary (after whitespace, `>`, line
      // start, …), matching the grammar's hidden SL_COMMENT terminal.
      [/\/\/.*$/, "comment"],

      // `direction` keyword at the start of a line; its value (if one of
      // the four recognized words) is colored in the dedicated state below
      // so plain node names elsewhere are never mis-colored as keywords.
      [/^(\s*)(direction)\b/, ["", { token: "keyword", next: "@direction" }]],

      // Fan-out / edge operator.
      [/>/, "operator"],

      // `:` starts an edge label that runs to end of line (grammar's
      // greedy EDGE_LABEL terminal) — switch state to color it distinctly.
      [/:/, { token: "operator", next: "@label" }],

      // Attribute block — `[key: value, …]`.
      [/\[/, { token: "delimiter.bracket", next: "@attrs" }],

      // Group braces. Content inside `{ … }` is just more statements, so no
      // nested state is needed — the grammar is uniformly recursive here.
      [/[{}]/, "@brackets"],

      // Fan-out target separator.
      [/,/, "delimiter"],

      [/[ \t]+/, ""],

      // Node / group name words (mirrors the grammar's WORD terminal:
      // anything but whitespace and the structural chars `>:{}[],`).
      [/[^\s>:{}[\],]+/, ""],
    ],

    // Entered right after a leading `direction` keyword; colors a
    // recognized value as `keyword` too, then always pops back to `root`
    // so a trailing comment on the same line still highlights normally.
    direction: [
      [/[ \t]+/, ""],
      [new RegExp(`(${DIRECTION_VALUES.join("|")})\\b`), "keyword", "@pop"],
      [/[^\s]+/, "", "@pop"],
      [/$/, "", "@pop"],
    ],

    // Entered right after `:` in an edge statement. The label runs to end
    // of line; a `//` inside it is still colored as a comment (matching
    // parse.ts's "comment wins over label content" AST-mapping behavior),
    // even though lexically it's part of the same EDGE_LABEL terminal.
    label: [
      [/\/\/.*$/, "comment", "@pop"],
      [/[^\n\r]*?(?=\/\/)/, "label"],
      [/[^\n\r]+/, "label", "@pop"],
      [/$/, "", "@pop"],
    ],

    // Entered right after `[` in an attribute block — `key: value, …`
    // until the matching `]` (never spans a newline, per the grammar's
    // opaque ATTRS terminal).
    attrs: [
      [/\]/, { token: "delimiter.bracket", next: "@pop" }],
      [/[ \t]+/, ""],
      [/,/, "delimiter"],
      [/:/, "delimiter"],
      [/[^\s:,\]]+(?=\s*:)/, "attr-key"],
      [/[^,\]]+/, ""],
    ],
  },
};

/**
 * Extra `monaco.editor.ITokenThemeRule`s for the `dgc-dark` theme, spread
 * into `defineTheme`'s `rules` array in `Drawer.tsx`. Kept here so the
 * language's tokenizer and its colors stay next to each other.
 */
export const archDslThemeRules: editor.ITokenThemeRule[] = [
  { token: "comment.arch-dsl", foreground: "5c7599" }, // calm blue-gray
  { token: "keyword.arch-dsl", foreground: "b39ddb" }, // light purple
  { token: "attr-key.arch-dsl", foreground: "ffb37a" }, // light orange
  { token: "label.arch-dsl", foreground: "f0dd8a" }, // light yellow
  { token: "operator.arch-dsl", foreground: "4aa3ff" }, // --accent
];

/**
 * Same token set as {@link archDslThemeRules}, retuned for the `dgc-light`
 * theme (DGC-70) — the dark set's pastel foregrounds (tuned for a near-black
 * editor background) fall below readable contrast on white, so light gets
 * its own deeper/more saturated hues rather than reusing the dark array.
 */
export const archDslThemeRulesLight: editor.ITokenThemeRule[] = [
  { token: "comment.arch-dsl", foreground: "6b7690" }, // --text-dim (light)
  { token: "keyword.arch-dsl", foreground: "7c4dc4" }, // deep purple
  { token: "attr-key.arch-dsl", foreground: "c96a1f" }, // deep orange
  { token: "label.arch-dsl", foreground: "9a7a15" }, // deep gold
  { token: "operator.arch-dsl", foreground: "4a7dd6" }, // --accent (light)
];

/**
 * Registers `arch-dsl` with a Monaco instance: the language id, its
 * tokenizer, and its language configuration. Idempotent — safe to call from
 * `beforeMount` on every editor mount (registering twice is a Monaco no-op
 * for the id, but re-registering the tokenizer/config would just replace
 * them redundantly, so we guard on the language already existing).
 */
export function registerArchDslLanguage(monacoInstance: Monaco): void {
  const alreadyRegistered = monacoInstance.languages
    .getLanguages()
    .some((lang) => lang.id === ARCH_DSL_LANGUAGE_ID);
  if (alreadyRegistered) return;

  monacoInstance.languages.register({ id: ARCH_DSL_LANGUAGE_ID });
  monacoInstance.languages.setMonarchTokensProvider(ARCH_DSL_LANGUAGE_ID, archDslMonarchLanguage);
  monacoInstance.languages.setLanguageConfiguration(
    ARCH_DSL_LANGUAGE_ID,
    archDslLanguageConfiguration,
  );
}
