/**
 * Technology/product logos baked in from `simple-icons` (package-level
 * license CC0-1.0; per-icon `license` overrides exist for a few marks —
 * e.g. Apache Kafka ships as Apache-2.0 — and are honored below).
 *
 * These identify a *specific* product/service in a diagram. The SVG
 * artwork is public domain, but the brand/name itself remains the
 * trademark of its respective owner — see ATTRIBUTION.md.
 */
import {
  siApachekafka,
  siDocker,
  siElasticsearch,
  siGithub,
  siGithubactions,
  siGrafana,
  siGraphql,
  siKubernetes,
  siMongodb,
  siMysql,
  siNginx,
  siNodedotjs,
  siPostgresql,
  siPrometheus,
  siRabbitmq,
  siReact,
  siRedis,
  siStripe,
  type SimpleIcon,
} from "simple-icons";

import type { IconMeta } from "./types.js";

export const DEFAULT_SIMPLE_ICONS_LICENSE = "CC0-1.0";

/**
 * simple-icons ships raw SVGs with no `fill` attribute, which defaults to
 * solid black. Inject `fill="currentColor"` on the root `<svg>` so this
 * set themes the same way the lucide set does.
 */
function withCurrentColor(svg: string): string {
  return svg.replace("<svg ", '<svg fill="currentColor" ');
}

function simpleIcon(id: string, icon: SimpleIcon): IconMeta {
  return {
    id,
    title: icon.title,
    source: "simple-icons",
    license: icon.license?.type ?? DEFAULT_SIMPLE_ICONS_LICENSE,
    svg: withCurrentColor(icon.svg),
  };
}

/** 18 product/technology logos covering a typical web/backend stack. */
export const SIMPLE_ICONS: readonly IconMeta[] = [
  simpleIcon("postgresql", siPostgresql),
  simpleIcon("mysql", siMysql),
  simpleIcon("mongodb", siMongodb),
  simpleIcon("redis", siRedis),
  simpleIcon("nginx", siNginx),
  simpleIcon("docker", siDocker),
  simpleIcon("kubernetes", siKubernetes),
  simpleIcon("rabbitmq", siRabbitmq),
  simpleIcon("apachekafka", siApachekafka),
  simpleIcon("react", siReact),
  simpleIcon("nodedotjs", siNodedotjs),
  simpleIcon("graphql", siGraphql),
  simpleIcon("elasticsearch", siElasticsearch),
  simpleIcon("prometheus", siPrometheus),
  simpleIcon("grafana", siGrafana),
  simpleIcon("github", siGithub),
  simpleIcon("githubactions", siGithubactions),
  simpleIcon("stripe", siStripe),
];
