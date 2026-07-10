/**
 * Opt-in external icon packs (DGC-99).
 *
 * A pack is a set of vendor glyphs (e.g. the official AWS Architecture
 * Icons) that is NOT committed to this repo — vendor terms typically allow
 * *using* the icons in architecture diagrams but not redistributing or
 * altering them, so the artwork is generated locally into
 * `packages/icons/packs/<ns>.icons.json` (gitignored) by a script such as
 * `pnpm icons:aws`, and registered at startup by each consumer (web: vite
 * glob in `iconPacks.ts`; server: `loadIconPacksFromDisk`).
 *
 * Resolution contract (see `getIcon` in index.ts):
 * - Namespaced ids (`aws:dynamodb`) resolve only through the pack with
 *   that namespace; without the pack they soft-fall back to the generic
 *   box exactly like any unknown id — installing a pack is never required.
 * - Bare names (`dynamodb`, `s3`) resolve through packs only AFTER the
 *   built-in registry and its aliases miss, so installing a pack can never
 *   change what an existing diagram renders.
 * - Pack SVG markup is kept verbatim (no `currentColor` rewrite): official
 *   vendor artwork must not be recolored/re-themed.
 */
import type { IconMeta } from "./types.js";

/** One glyph in a pack definition (pre-registration shape). */
export interface IconPackIconDef {
  /** Human-readable display name, e.g. `"Amazon DynamoDB"`. */
  title: string;
  /** Full `<svg>...</svg>` markup, verbatim vendor artwork. */
  svg: string;
}

/**
 * The JSON shape a pack generator script emits
 * (`packs/<namespace>.icons.json`) and consumers pass to
 * {@link registerIconPack}.
 */
export interface IconPackDef {
  /** Lowercase namespace, e.g. `"aws"` — becomes the `<ns>:` id prefix. */
  namespace: string;
  /** Display name for the pack, e.g. `"AWS Architecture Icons"`. */
  title: string;
  /** License/terms note applied to every icon in the pack. */
  license: string;
  /** Pack release identifier (e.g. the AWS asset-package date). */
  version?: string;
  /** Where the artwork was obtained from (official download page). */
  source?: string;
  /** Bare id → glyph, e.g. `"dynamodb"` → `{ title, svg }`. */
  icons: Record<string, IconPackIconDef>;
  /** Bare alias → bare id, e.g. `"s3"` → `"simple-storage-service"`. */
  aliases?: Record<string, string>;
}

/** Summary row returned by {@link registeredIconPacks}. */
export interface IconPackInfo {
  namespace: string;
  title: string;
  version?: string;
  /** Number of canonical icons (aliases not counted). */
  count: number;
}

interface RegisteredPack {
  info: IconPackInfo;
  /** Bare id → fully-built IconMeta (id already namespaced). */
  icons: Map<string, IconMeta>;
  /** Bare alias → bare id (validated to point at an existing icon). */
  aliases: Map<string, string>;
}

/** Registered packs by namespace, in registration order. */
const PACKS = new Map<string, RegisteredPack>();

const NAMESPACE_RE = /^[a-z][a-z0-9-]*$/;

/**
 * Registers (or replaces) an icon pack. Throws on a malformed definition —
 * packs are developer/script-generated input, so loud failure beats a
 * silently half-registered pack. Dangling aliases (target not in `icons`)
 * are skipped rather than fatal so a hand-edited pack degrades gracefully.
 */
export function registerIconPack(def: IconPackDef): IconPackInfo {
  if (typeof def !== "object" || def === null) throw new Error("icon pack: definition must be an object");
  const { namespace, title, license, icons } = def;
  if (typeof namespace !== "string" || !NAMESPACE_RE.test(namespace)) {
    throw new Error(`icon pack: invalid namespace ${JSON.stringify(namespace)} (want lowercase [a-z][a-z0-9-]*)`);
  }
  if (typeof title !== "string" || title === "") throw new Error(`icon pack "${namespace}": missing title`);
  if (typeof license !== "string" || license === "") throw new Error(`icon pack "${namespace}": missing license`);
  if (typeof icons !== "object" || icons === null || Object.keys(icons).length === 0) {
    throw new Error(`icon pack "${namespace}": no icons`);
  }

  const builtIcons = new Map<string, IconMeta>();
  for (const [bareId, icon] of Object.entries(icons)) {
    const key = bareId.trim().toLowerCase();
    if (key === "" || key.includes(":")) throw new Error(`icon pack "${namespace}": invalid icon id "${bareId}"`);
    if (typeof icon?.svg !== "string" || !icon.svg.includes("<svg")) {
      throw new Error(`icon pack "${namespace}": icon "${bareId}" has no <svg> markup`);
    }
    builtIcons.set(key, {
      id: `${namespace}:${key}`,
      title: typeof icon.title === "string" && icon.title !== "" ? icon.title : key,
      source: "pack",
      pack: namespace,
      license,
      svg: icon.svg,
    });
  }

  const builtAliases = new Map<string, string>();
  for (const [alias, target] of Object.entries(def.aliases ?? {})) {
    const aliasKey = alias.trim().toLowerCase();
    const targetKey = typeof target === "string" ? target.trim().toLowerCase() : "";
    if (aliasKey === "" || aliasKey.includes(":")) continue;
    if (!builtIcons.has(targetKey)) continue; // dangling alias — skip, don't break the pack
    builtAliases.set(aliasKey, targetKey);
  }

  const info: IconPackInfo = {
    namespace,
    title,
    ...(typeof def.version === "string" && def.version !== "" ? { version: def.version } : {}),
    count: builtIcons.size,
  };
  PACKS.set(namespace, { info, icons: builtIcons, aliases: builtAliases });
  return info;
}

/** Removes a registered pack (mainly for tests). Returns whether it existed. */
export function unregisterIconPack(namespace: string): boolean {
  return PACKS.delete(namespace);
}

/** Summaries of every registered pack, in registration order. */
export function registeredIconPacks(): IconPackInfo[] {
  return [...PACKS.values()].map((pack) => pack.info);
}

/** Looks a bare id (or in-pack alias) up inside one pack. */
function lookupInPack(pack: RegisteredPack, bareKey: string): IconMeta | undefined {
  const direct = pack.icons.get(bareKey);
  if (direct !== undefined) return direct;
  const aliased = pack.aliases.get(bareKey);
  return aliased !== undefined ? pack.icons.get(aliased) : undefined;
}

/**
 * Resolves an already-normalized (lowercased/trimmed) key against the
 * registered packs. `ns:name` keys look only inside pack `ns`; bare keys
 * try each pack in registration order (callers check the built-in registry
 * first, so a pack can never shadow a built-in id). Returns `undefined`
 * when nothing matches — including a namespaced id whose pack isn't
 * installed, which then soft-falls back like any unknown id.
 */
export function resolvePackIcon(key: string): IconMeta | undefined {
  const sep = key.indexOf(":");
  if (sep !== -1) {
    const pack = PACKS.get(key.slice(0, sep));
    return pack === undefined ? undefined : lookupInPack(pack, key.slice(sep + 1));
  }
  for (const pack of PACKS.values()) {
    const hit = lookupInPack(pack, key);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** Every pack icon (canonical, namespaced ids), in registration order. */
export function listPackIcons(): IconMeta[] {
  return [...PACKS.values()].flatMap((pack) => [...pack.icons.values()]);
}

/**
 * Bare-name shortcuts contributed by packs, as `alias → namespaced id`
 * (e.g. `s3 → aws:simple-storage-service`, `dynamodb → aws:dynamodb`).
 * Includes each icon's own bare name as well as explicit pack aliases.
 * `exclude` (the built-in ids + aliases) filters out shortcuts that would
 * lie — a bare name the built-in registry already claims resolves there,
 * never to a pack.
 */
export function packAliases(exclude: ReadonlySet<string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pack of PACKS.values()) {
    for (const [bareId, meta] of pack.icons) {
      if (!exclude.has(bareId) && out[bareId] === undefined) out[bareId] = meta.id;
    }
    for (const [alias, target] of pack.aliases) {
      const meta = pack.icons.get(target);
      if (meta !== undefined && !exclude.has(alias) && out[alias] === undefined) out[alias] = meta.id;
    }
  }
  return out;
}
