# Golden fixtures (DGC-31 / T11)

Real-ish `.arch` system-design sketches used two ways:

1. **`packages/core/test/golden.test.ts`** parses each one and asserts both
   a full-doc snapshot and explicit structural properties (node/group/edge
   counts, key `groupId`s), so the parser's whole pipeline — grammar,
   groups, attributes, one-to-many edges, Vietnamese names — gets a
   regression net in one place, with the snapshot never the sole source of
   truth.
2. **T17 (web integration)** loads the same files for visual QA of the
   renderer: node styling, group nesting/depth tint, icon resolution, and
   ELK layout on non-trivial diagrams.

## Fixtures

- **`url-shortener.arch`** — the textbook "design a URL shortener" sketch.
  A client behind a load balancer fans out to two API server instances
  (`Service tier` group) sharing a Redis cache and Postgres database plus
  an analytics queue (`Data tier` group). Exercises: one-to-many fan-out
  (`LB > API Server A, API Server B`), a flat two-group layout, and a
  five-icon spread (`monitor`, `network`, `server`, `redis`, `postgresql`,
  `list`).
- **`news-feed.arch`** — a deeper "design a news feed" sketch: a public
  edge (CDN + load balancer) in front of a `VPC` group that nests two
  child groups — `Feed service` (API gateway, auth, fan-out worker,
  notifications) and `Data stores` (Redis, Postgres, object storage,
  search index) — plus a Kafka queue shared by both. Exercises: two-level
  group nesting, a node (`Kafka Queue`) declared directly in the outer
  group alongside two subgroups, and the `apachekafka`/`hard-drive`/
  `elasticsearch` icons.
- **`rate-limiter.arch`** — the "design a rate limiter" sketch: a request
  enters at `Gateway`, is checked against a token-bucket counter in
  `Rules Cache` (Redis) by `Rate Limiter`, then forwarded to `API Backend`
  if a token remains. Two flat groups (`Edge`, `Backend`). Exercises: a
  Vietnamese node name (`Người dùng`, "user") as the client, and
  Vietnamese edge labels end to end.
- **`microservices.arch`** (T-PERF/DGC-76) — a ~60-node e-commerce
  microservices stress fixture, hand-written (not runtime-generated) to
  exercise `packages/layout`'s layout-time budget on a realistic large
  graph. A public edge (`Web Client`/`Mobile Client`/`Partner Client`)
  feeds a `Platform` group nesting 9 child groups — `Edge`, `API Tier`,
  four business domains (`Users Domain`, `Orders Domain`, `Payments
  Domain`, `Inventory Domain`), a shared `Data Tier`, `Messaging` (Kafka
  fan-out), and `Observability` — plus two third-level `…Data` groups
  (`Users Data`, `Orders Data`) nested inside their domain, for 12 groups
  total across 3 levels of nesting. 92 labeled edges (including a
  one-to-many fan-out and a 4-way fan-in) span 29 distinct icons across
  all 9 named color tokens. See `packages/layout/test/perf.test.ts` and
  `docs/PERF.md` for the layout-time measurements this fixture drives.

## Icons used

All icon ids below resolve in `@diagram-copilot/icons` (`packages/icons/src`)
either directly or through an alias — see `packages/icons/src/aliases.ts`.

| Fixture | Icon ids (attribute value written in the `.arch` file) |
| --- | --- |
| `url-shortener.arch` | `monitor`, `network`, `server`, `redis`, `postgresql`, `list` |
| `news-feed.arch` | `monitor`, `cloud`, `network`, `server`, `lock`, `cpu`, `bell`, `redis`, `postgresql`, `hard-drive`, `elasticsearch`, `apachekafka` |
| `rate-limiter.arch` | `monitor`, `shield`, `cpu`, `redis`, `server` |
| `microservices.arch` | `monitor`, `smartphone`, `globe`, `cloud`, `network`, `shield`, `server`, `lock`, `redis`, `graphql`, `cpu`, `webhook`, `layers`, `user`, `bell`, `postgresql`, `database`, `box`, `router`, `mysql`, `elasticsearch`, `hard-drive`, `apachekafka`, `mail`, `list`, `prometheus`, `grafana`, `githubactions`, `stripe` |

Note: `cpu` stands in for "rate limiter" (there is no dedicated
gauge/meter icon in the ~38-icon registry); `monitor` is the existing
generic-client stand-in also used by `examples/demo.arch`.
