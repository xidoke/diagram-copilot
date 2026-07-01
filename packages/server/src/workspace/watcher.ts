/**
 * Workspace directory watcher.
 *
 * Owns the filesystem side of the workspace: scans the workspace directory
 * for `.arch` files, tracks which one is "active", and re-parses + broadcasts
 * whenever the active diagram's content changes. Non-active files only ever
 * affect the diagram *list* (the workspace picker) — their content is never
 * read until they become active, matching the "server is the only DSL
 * parser, and only for what clients need right now" architecture decision.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync, type Dirent } from "node:fs";
import path from "node:path";
import { watch as watchDir, type FSWatcher } from "chokidar";
import {
  ARCH_EXT,
  diagramNameFromFile,
  isArchFile,
  parseDsl,
  type ServerMessage,
  type WorkspaceMessage,
} from "@diagram-copilot/core";

/** How long to wait after the last fs event on a given file before acting on it. */
const DEBOUNCE_MS = 150;

export interface WorkspaceWatcherOptions {
  /** Workspace directory to scan/watch. Created if missing. */
  dir: string;
  /** Send a message to every connected client (typically `ServerHandle.broadcast`). */
  broadcast: (message: ServerMessage) => void;
}

/** Snapshot of what the watcher currently knows about the workspace. */
export interface WorkspaceState {
  /** All diagram names found in the workspace (no `.arch` extension), sorted. */
  diagrams: string[];
  /** Name of the active diagram, or `null` if the workspace has no files yet. */
  active: string | null;
  /** Last ACCEPTED (successfully parsed) version per diagram name. */
  versions: Map<string, number>;
}

/** One diagram entry as reported to MCP tools / the picker. */
export interface DiagramListing {
  /** Diagram name (file stem, no `.arch`). */
  name: string;
  /** Last accepted version, or `0` if never parsed successfully. */
  version: number;
  /** Whether this is the currently active diagram. */
  active: boolean;
}

/** Outcome of {@link WorkspaceOps.open}. */
export interface OpenResult {
  /** `true` when the diagram is now active; `false` on a validation failure. */
  ok: boolean;
  /** `true` when a brand-new diagram file was created by this call. */
  created: boolean;
  /** Normalized diagram name (or the raw input when validation failed). */
  name: string;
  /** Version of the now-active diagram (`0` when never parsed / on failure). */
  version: number;
  /** Human-readable reason when `ok` is `false`. */
  error?: string;
}

/** Outcome of {@link WorkspaceWatcher.createDiagram}. */
export interface CreateDiagramResult {
  /** `true` when a new file was written. */
  ok: boolean;
  /** Normalized diagram name (or the raw input when validation failed). */
  name: string;
  /** Human-readable reason when `ok` is `false` (invalid name, already exists). */
  error?: string;
}

/**
 * Narrow, read/activate-only view of the workspace handed to MCP tools
 * (`list_diagrams`, `open_diagram`, and — reused by T20 — future workspace
 * tools). Deliberately excludes the watcher's lifecycle (`start`/`stop`) and
 * raw state so tool code cannot drive the filesystem watcher directly.
 */
export interface WorkspaceOps {
  /** All diagrams, sorted by name, with their version and active flag. */
  list(): DiagramListing[];
  /** Activate `name`, creating it from a template if it does not exist yet. */
  open(name: string): OpenResult;
}

export interface WorkspaceWatcher extends WorkspaceOps {
  /** Scan the workspace, parse+broadcast the active diagram, then start watching for changes. */
  start(): Promise<void>;
  /** Stop watching and release resources. Safe to call even if `start()` was never called. */
  stop(): Promise<void>;
  /** Current in-memory view of the workspace (diagrams, active, versions). */
  getState(): WorkspaceState;
  /**
   * Explicitly make `name` the active diagram (a "sticky" choice that wins over
   * the automatic demo/alphabetical pick until its file is deleted). Re-parses
   * and broadcasts the diagram plus a workspace update.
   */
  setActive(name: string): void;
  /**
   * Create a new diagram file (validated name, `.arch` appended) seeded with a
   * template (or `dsl` when given), then make it active. Refuses to overwrite
   * an existing file and rejects path-traversal names.
   */
  createDiagram(name: string, dsl?: string): CreateDiagramResult;
}

type FileEventKind = "add" | "change" | "unlink";

/**
 * Which `.arch` file is "active": the one whose content clients render by
 * default. `demo` wins if present (dev convenience); otherwise the first
 * name alphabetically. `null` when the workspace is empty.
 */
function computeActive(diagrams: ReadonlySet<string>): string | null {
  if (diagrams.size === 0) return null;
  if (diagrams.has("demo")) return "demo";
  return [...diagrams].sort()[0] ?? null;
}

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

/**
 * Validate + normalize a caller-supplied diagram name into a bare file stem.
 *
 * Accepts an optional trailing `.arch` (stripped), rejects empty names and
 * anything that could escape the workspace directory — path separators or
 * `..`. The name is used verbatim to build a path under the workspace root, so
 * this is the single choke point that keeps `createDiagram`/`open` from writing
 * outside it.
 */
function validateDiagramName(raw: string): { ok: true; name: string } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "Diagram name must not be empty." };
  }
  const name = trimmed.endsWith(ARCH_EXT) ? trimmed.slice(0, -ARCH_EXT.length) : trimmed;
  if (name.length === 0) {
    return { ok: false, error: "Diagram name must not be empty." };
  }
  if (name.includes("/") || name.includes("\\") || name.includes("..")) {
    return {
      ok: false,
      error: `Invalid diagram name "${raw}" — names cannot contain path separators or "..".`,
    };
  }
  return { ok: true, name };
}

/** Seed contents for a freshly created diagram (a valid, empty-canvas doc). */
function diagramTemplate(name: string): string {
  return `// ${name}\ndirection right\n`;
}

/** Non-recursive scan of `dir` for `.arch` files. Missing dir reads as empty. */
function scanArchFileNames(dir: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && isArchFile(entry.name))
    .map((entry) => diagramNameFromFile(entry.name));
}

export function createWorkspaceWatcher(options: WorkspaceWatcherOptions): WorkspaceWatcher {
  const root = path.resolve(options.dir);
  const { broadcast } = options;

  const diagrams = new Set<string>();
  const versions = new Map<string, number>();
  let active: string | null = null;
  // An explicit `setActive`/`open` choice that overrides the automatic
  // demo/alphabetical pick. Cleared automatically once its file disappears, so
  // deleting the active diagram falls back to auto-selection (see resolveActive).
  let stickyActive: string | null = null;

  let watcher: FSWatcher | undefined;
  const debounceTimers = new Map<string, NodeJS.Timeout>();

  /**
   * Which diagram should be active right now: the sticky choice if it still
   * exists, otherwise the automatic pick. A vanished sticky choice is cleared
   * here so it never resurrects if a file with that name reappears later.
   */
  function resolveActive(): string | null {
    if (stickyActive !== null) {
      if (diagrams.has(stickyActive)) return stickyActive;
      stickyActive = null;
    }
    return computeActive(diagrams);
  }

  function broadcastWorkspace(): void {
    const message: WorkspaceMessage = {
      kind: "workspace",
      diagrams: [...diagrams].sort(),
      active: active ?? "untitled",
    };
    broadcast(message);
  }

  /** Read, parse, and broadcast the diagram/diagram-error for `name` (must currently be active). */
  function parseAndBroadcastActive(name: string): void {
    const filePath = path.join(root, `${name}${ARCH_EXT}`);
    let dsl: string;
    try {
      dsl = readFileSync(filePath, "utf8");
    } catch {
      // File vanished between the triggering event and this read (e.g. a
      // fast create-then-delete). The next event for this path will settle
      // things; nothing useful to broadcast right now.
      return;
    }

    const result = parseDsl(dsl);
    if (result.ok) {
      const nextVersion = (versions.get(name) ?? 0) + 1;
      versions.set(name, nextVersion);
      const message: ServerMessage = {
        kind: "diagram",
        name,
        version: nextVersion,
        origin: "file",
        dsl,
        doc: result.doc,
      };
      broadcast(message);
    } else {
      const currentVersion = versions.get(name) ?? 0;
      const message: ServerMessage = {
        kind: "diagram-error",
        name,
        version: currentVersion,
        origin: "file",
        dsl,
        parseErrors: result.parseErrors,
        modelErrors: result.modelErrors,
      };
      broadcast(message);
    }
  }

  /** Apply one debounced fs event: update workspace/active state, broadcast as needed. */
  function handleFileEvent(name: string, kind: FileEventKind): void {
    const prevDiagrams = new Set(diagrams);
    const prevActive = active;

    if (kind === "unlink") {
      diagrams.delete(name);
    } else {
      diagrams.add(name);
    }

    const newActive = resolveActive();
    const diagramsChanged = !setsEqual(prevDiagrams, diagrams);
    const activeChanged = newActive !== prevActive;
    active = newActive;

    if (diagramsChanged || activeChanged) {
      broadcastWorkspace();
    }

    // Parse+broadcast the active diagram when: it just became active (fresh
    // content the client hasn't seen), or its own content just changed.
    const shouldParseActive =
      newActive !== null && (activeChanged || (kind !== "unlink" && name === newActive));
    if (shouldParseActive) {
      parseAndBroadcastActive(newActive);
    }
  }

  function scheduleFileEvent(filePath: string, kind: FileEventKind): void {
    if (!isArchFile(filePath)) return;
    const name = diagramNameFromFile(filePath);

    const existing = debounceTimers.get(name);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      debounceTimers.delete(name);
      handleFileEvent(name, kind);
    }, DEBOUNCE_MS);
    debounceTimers.set(name, timer);
  }

  /**
   * Make `name` the sticky-active diagram and push fresh state to clients: a
   * workspace update plus the diagram (or diagram-error) frame for its content.
   * Broadcasts unconditionally — an explicit activation is a user action worth
   * echoing even if `name` was already active (the canvas re-syncs).
   */
  function setActive(name: string): void {
    stickyActive = name;
    active = resolveActive();
    broadcastWorkspace();
    if (active !== null) parseAndBroadcastActive(active);
  }

  function createDiagram(name: string, dsl?: string): CreateDiagramResult {
    const validated = validateDiagramName(name);
    if (!validated.ok) return { ok: false, name, error: validated.error };
    const stem = validated.name;
    const filePath = path.join(root, `${stem}${ARCH_EXT}`);
    try {
      // `wx`: create-exclusive — fail rather than clobber an existing diagram.
      writeFileSync(filePath, dsl ?? diagramTemplate(stem), { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        return { ok: false, name: stem, error: `Diagram "${stem}" already exists.` };
      }
      throw error;
    }
    // Reflect the new file immediately rather than waiting for the debounced fs
    // watcher, so a subsequent read/list observes it synchronously. The later
    // watcher "add" event is then a no-op (already present, already active).
    diagrams.add(stem);
    setActive(stem);
    return { ok: true, name: stem };
  }

  function list(): DiagramListing[] {
    return [...diagrams].sort().map((name) => ({
      name,
      version: versions.get(name) ?? 0,
      active: name === active,
    }));
  }

  function open(name: string): OpenResult {
    const validated = validateDiagramName(name);
    if (!validated.ok) {
      return { ok: false, created: false, name, version: 0, error: validated.error };
    }
    const stem = validated.name;
    if (diagrams.has(stem)) {
      setActive(stem);
      return { ok: true, created: false, name: stem, version: versions.get(stem) ?? 0 };
    }
    const result = createDiagram(stem);
    if (!result.ok) {
      return { ok: false, created: false, name: result.name, version: 0, error: result.error };
    }
    return { ok: true, created: true, name: result.name, version: versions.get(result.name) ?? 0 };
  }

  return {
    async start() {
      mkdirSync(root, { recursive: true });

      for (const name of scanArchFileNames(root)) diagrams.add(name);
      active = resolveActive();
      broadcastWorkspace();
      if (active !== null) parseAndBroadcastActive(active);

      watcher = watchDir(root, {
        depth: 0,
        ignoreInitial: true,
        persistent: true,
      });
      watcher.on("add", (filePath) => scheduleFileEvent(filePath, "add"));
      watcher.on("change", (filePath) => scheduleFileEvent(filePath, "change"));
      watcher.on("unlink", (filePath) => scheduleFileEvent(filePath, "unlink"));

      await new Promise<void>((resolve, reject) => {
        watcher?.once("ready", resolve);
        watcher?.once("error", reject);
      });
    },

    async stop() {
      for (const timer of debounceTimers.values()) clearTimeout(timer);
      debounceTimers.clear();
      if (watcher) {
        await watcher.close();
        watcher = undefined;
      }
    },

    getState() {
      return {
        diagrams: [...diagrams].sort(),
        active,
        versions: new Map(versions),
      };
    },

    setActive,
    createDiagram,
    list,
    open,
  };
}

/**
 * Build the welcome frames for a newly connected client from the watcher's
 * current state: the workspace listing, plus a fresh `diagram`/`diagram-error`
 * for the active diagram (if any). Re-reads the active file from disk rather
 * than caching its last message, so the greeting always reflects what is on
 * disk right now even if it changed since the watcher last parsed it.
 */
export function buildWelcomeMessages(dir: string, state: WorkspaceState): ServerMessage[] {
  const root = path.resolve(dir);
  const workspaceMessage: WorkspaceMessage = {
    kind: "workspace",
    diagrams: state.diagrams,
    active: state.active ?? "untitled",
  };
  if (state.active === null) {
    return [workspaceMessage];
  }

  const filePath = path.join(root, `${state.active}${ARCH_EXT}`);
  let dsl: string;
  try {
    dsl = readFileSync(filePath, "utf8");
  } catch {
    return [workspaceMessage];
  }

  const result = parseDsl(dsl);
  const cachedVersion = state.versions.get(state.active) ?? 0;
  if (result.ok) {
    const version = cachedVersion === 0 ? 1 : cachedVersion;
    return [
      workspaceMessage,
      { kind: "diagram", name: state.active, version, origin: "file", dsl, doc: result.doc },
    ];
  }
  return [
    workspaceMessage,
    {
      kind: "diagram-error",
      name: state.active,
      version: cachedVersion,
      origin: "file",
      dsl,
      parseErrors: result.parseErrors,
      modelErrors: result.modelErrors,
    },
  ];
}
