/**
 * Diagram model — the language-neutral document produced by parsing DSL
 * text. This is the single shape shared by parser (Langium), layout (ELK),
 * renderer (React Flow), server state, and the WS protocol.
 */

/** Primary flow direction of the diagram (`direction` statement in DSL). */
export type Direction = "right" | "left" | "up" | "down";

/**
 * A leaf node in an architecture diagram (a service, database, actor…).
 *
 * `id` shares one namespace with {@link DiagramGroup} ids: edges may target
 * either, so an id must be unique across nodes *and* groups.
 */
export interface DiagramNode {
  /** Unique id within the document (shared namespace with group ids). */
  id: string;
  /** Display text. May contain Unicode / Vietnamese diacritics. */
  label: string;
  /** Icon id from the icon registry (e.g. `"aws-ec2"`). Unknown ids fall back to a generic icon. */
  icon?: string;
  /** Color token (theme token name, e.g. `"orange"`), not a raw CSS color. */
  color?: string;
  /** Id of the {@link DiagramGroup} that directly contains this node. */
  groupId?: string;
}

/**
 * A container that visually groups nodes (e.g. a VPC or subnet).
 * Groups nest via `parentId`; nesting must be acyclic.
 */
export interface DiagramGroup {
  /** Unique id within the document (shared namespace with node ids). */
  id: string;
  /** Display text. May contain Unicode / Vietnamese diacritics. */
  label: string;
  /** Id of the parent group, for nested groups. Must not form a cycle. */
  parentId?: string;
  /** Icon id from the icon registry. */
  icon?: string;
  /** Color token (theme token name). */
  color?: string;
}

/** A directed edge between two nodes and/or groups. */
export interface DiagramEdge {
  /** Unique id among the document's edges. */
  id: string;
  /** Id of the source node or group. */
  from: string;
  /** Id of the target node or group. */
  to: string;
  /** Optional edge label (`A > B: text` in DSL). */
  label?: string;
}

/**
 * An architecture diagram document — the only document type in v1.
 * Nodes, groups, and edges are flat lists; containment is expressed via
 * `groupId` / `parentId` references rather than tree nesting.
 */
export interface ArchitectureDoc {
  /** Discriminator for the {@link DiagramDoc} union. */
  type: "architecture";
  /** Primary layout direction. */
  direction: Direction;
  /** All leaf nodes. */
  nodes: DiagramNode[];
  /** All groups (containers), flat with `parentId` references. */
  groups: DiagramGroup[];
  /** All edges. */
  edges: DiagramEdge[];
}

/**
 * Any diagram document, discriminated by `type`.
 *
 * v1 has a single member; v1.1 extends this union with Mermaid-backed
 * types, e.g. `{ type: 'flowchart' | 'sequence' | 'erd'; mermaid: string }`.
 * Downstream code MUST switch on `doc.type` rather than assume architecture.
 */
export type DiagramDoc = ArchitectureDoc;
