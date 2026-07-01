/**
 * arch-dsl — minimal eraser-style DSL parser (DGC-26).
 *
 * Grammar lives in `arch-dsl.langium`; `generated/` is produced by
 * `pnpm --filter @diagram-copilot/core generate` (langium-cli) and is
 * committed so downstream packages build without running codegen.
 */
export { parseDsl, type ParseDslResult } from "./parse.js";
