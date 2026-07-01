# Icon attribution

`@diagram-copilot/icons` ships **no hand-drawn artwork** and **no official
AWS / GCP / Azure icons**. Every icon is baked at build time from one of
two open npm packages, chosen specifically because their licenses are
unambiguous for embedding and redistributing in this project:

| Package | Version | License | What it provides |
|---|---|---|---|
| [`lucide-static`](https://lucide.dev) | `^1.22.0` | [ISC](https://github.com/lucide-icons/lucide/blob/main/LICENSE) | 20 generic infra/UX icons (server, database, cloud, ...) |
| [`simple-icons`](https://simpleicons.org) | `^16.24.1` | [CC0-1.0](https://github.com/simple-icons/simple-icons/blob/develop/LICENSE.md) | 18 technology/product logos (PostgreSQL, Docker, ...) |

A generic `box` icon (from `lucide-static`) also doubles as the built-in
**fallback** artwork returned by `getIcon()` for any id that isn't
recognized — see `src/registry.ts`.

## Trademark note (simple-icons logos)

`simple-icons` artwork is released under CC0-1.0 (public domain) by the
simple-icons project. **The underlying brand/mark itself is not** — each
logo still identifies a trademark owned by the respective company (e.g.
the PostgreSQL elephant is a mark of the PostgreSQL Global Development
Group). Using these logos here is for **service identification inside
generated diagrams** (i.e. "this box is a PostgreSQL database"), not an
endorsement by or affiliation with the trademark owner. Do not use these
marks in ways that could imply sponsorship, certification, or official
partnership.

## Per-icon table

Canonical `id` → source package → license. All source-package licenses
apply to the SVG artwork as vendored; `apachekafka` carries a per-icon
license override in `simple-icons` (Apache-2.0) distinct from the
package's default CC0-1.0.

### lucide-static (ISC) — 20 icons

| id | title |
|---|---|
| `server` | Server |
| `database` | Database |
| `globe` | Globe |
| `cloud` | Cloud |
| `network` | Network |
| `router` | Router |
| `hard-drive` | Hard Drive |
| `layers` | Layers |
| `box` | Box *(also the fallback artwork)* |
| `cpu` | CPU |
| `shield` | Shield |
| `lock` | Lock |
| `user` | User |
| `users` | Users |
| `mail` | Mail |
| `smartphone` | Smartphone |
| `monitor` | Monitor |
| `bell` | Bell |
| `webhook` | Webhook |
| `list` | List |

### simple-icons (CC0-1.0 unless noted) — 18 icons

| id | title | license |
|---|---|---|
| `postgresql` | PostgreSQL | CC0-1.0 |
| `mysql` | MySQL | CC0-1.0 |
| `mongodb` | MongoDB | CC0-1.0 |
| `redis` | Redis | CC0-1.0 |
| `nginx` | NGINX | CC0-1.0 |
| `docker` | Docker | CC0-1.0 |
| `kubernetes` | Kubernetes | CC0-1.0 |
| `rabbitmq` | RabbitMQ | CC0-1.0 |
| `apachekafka` | Apache Kafka | **Apache-2.0** (icon-specific override) |
| `react` | React | CC0-1.0 |
| `nodedotjs` | Node.js | CC0-1.0 |
| `graphql` | GraphQL | CC0-1.0 |
| `elasticsearch` | Elasticsearch | CC0-1.0 |
| `prometheus` | Prometheus | CC0-1.0 |
| `grafana` | Grafana | CC0-1.0 |
| `github` | GitHub | CC0-1.0 |
| `githubactions` | GitHub Actions | CC0-1.0 |
| `stripe` | Stripe | CC0-1.0 |

### builtin — fallback

| id | title | license | notes |
|---|---|---|---|
| *(any unrecognized input)* | *(same as input)* | ISC | Renders the lucide `box` artwork, `source: "builtin"`. Returned by `getIcon()` instead of throwing/undefined. |

## Aliases

`src/aliases.ts` maps common alternate spellings (e.g. `postgres`, `k8s`,
`kafka`, `node`, `db`) and a few generic-concept stand-ins (e.g. `lb` →
`network`, `client` → `monitor`, `cdn` → `cloud`, `queue` → `list`) to one
of the canonical ids above. Aliases do not add new artwork or licenses —
they only resolve to an existing entry in the tables above.
