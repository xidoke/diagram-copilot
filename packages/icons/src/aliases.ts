/**
 * Alternate/shorthand names mapped to a canonical registry id. Keys and
 * values are lowercase kebab-case. {@link getIcon}/{@link hasIcon} check
 * this table after an exact id match and before falling back.
 *
 * A few targets (`network` for load balancer, `monitor` for a generic
 * client, `cloud` for CDN, `list` for queue) are deliberate stand-ins —
 * there's no dedicated icon for those concepts in the ~38-icon set yet,
 * so we borrow the closest generic shape rather than leave them unresolved.
 */
export const ALIASES: Readonly<Record<string, string>> = Object.freeze({
  // simple-icons spelling/short-name variants
  postgres: "postgresql",
  pg: "postgresql",
  k8s: "kubernetes",
  kafka: "apachekafka",
  node: "nodedotjs",
  nodejs: "nodedotjs",
  git: "github",
  vcs: "github",
  ci: "githubactions",
  "ci-cd": "githubactions",
  cicd: "githubactions",
  mq: "rabbitmq",
  es: "elasticsearch",
  cache: "redis",
  payment: "stripe",
  payments: "stripe",
  frontend: "react",

  // generic-concept stand-ins (see doc comment above)
  db: "database",
  lb: "network",
  "load-balancer": "network",
  client: "monitor",
  desktop: "monitor",
  cdn: "cloud",
  queue: "list",
  auth: "lock",
  security: "shield",
  notification: "bell",
  notifications: "bell",
  mobile: "smartphone",
});
