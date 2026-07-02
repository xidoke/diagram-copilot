# arch-dsl LIVE eval (v2) — v2-haiku

- date: 2026-07-02T01:33:12.089Z
- model: `haiku` (real MCP tool calls against a live server on port 4950)
- scenarios: 10
- **pass rate: 10/10 (100%)**
- first-try rate (first set_diagram call succeeded, no self-correction): 10/10
- total cost: $0.3178

| # | scenario | category | pass | first-try | tools used | notes |
|---|----------|----------|------|-----------|------------|-------|
| 1 | Create a diagram from scratch (EN) | create | PASS | yes | get_dsl_guide, list_icons, set_diagram | 3 node(s), 0 group(s), 4 edge(s) |
| 2 | Two-tier nested groups (EN) | create | PASS | yes | get_dsl_guide, set_diagram | nested group confirmed — 7 node(s), 2 group(s), 8 edge(s) |
| 3 | Add a node into an existing group (EN, edit) | edit | PASS | yes | get_diagram, set_diagram | Cache added inside VPC, original nodes kept — 4 node(s), 1 group(s), 3 edge(s) |
| 4 | Validate-first workflow (EN, forced validate_dsl) | workflow | PASS | yes | get_dsl_guide, validate_dsl, set_diagram | validate_dsl called before set_diagram — 5 node(s), 0 group(s), 6 edge(s) |
| 5 | Vietnamese names with đ/Đ (VI) | unicode | PASS | yes | validate_dsl, set_diagram | Vietnamese đ/Đ preserved (order node: true) — 9 node(s), 1 group(s), 5 edge(s) |
| 6 | One-to-many fan-out edge (EN) | edges | PASS | yes | get_dsl_guide, set_diagram | Queue fans out to all 3 workers — 5 node(s), 0 group(s), 4 edge(s) |
| 7 | Undo after a wrong edit (EN, undo_diagram) | undo | PASS | yes | get_diagram, set_diagram, undo_diagram | undo_diagram restored Database — 3 node(s), 0 group(s), 2 edge(s) |
| 8 | Repair a broken existing diagram (mixed, self-correct) | self-correct | PASS | yes | get_diagram, validate_dsl, set_diagram | repaired and valid — 5 node(s), 0 group(s), 4 edge(s) |
| 9 | Look up an icon before using it (EN, list_icons) | workflow | PASS | yes | list_icons, set_diagram | list_icons called, Database icon="database" |
| 10 | List + open a non-active diagram, then edit it (EN) | workspace | PASS | yes | list_diagrams, get_diagram, set_diagram | billing diagram edited correctly (list_diagrams used=true, open_diagram used=false) — 3 node(s), 0 group(s), 2 edge(s) |

## Details

### 1. Create a diagram from scratch (EN) (`create-basic`) — PASS

- category: create
- first-try: yes
- tools used: get_dsl_guide, list_icons, set_diagram
- notes: 3 node(s), 0 group(s), 4 edge(s)
- cost: $0.0293

prompt:

```
Create a new architecture diagram for a simple web app: a Client, an API, and a Database. Add labelled edges showing the request flow. Save it with set_diagram when you're done.
```

### 2. Two-tier nested groups (EN) (`nested-groups`) — PASS

- category: create
- first-try: yes
- tools used: get_dsl_guide, set_diagram
- notes: nested group confirmed — 7 node(s), 2 group(s), 8 edge(s)
- cost: $0.0272

prompt:

```
Design a news feed backend. Put the internal services inside a VPC group, and INSIDE that VPC nest a second group called 'Data Layer' that holds the database and a cache. Outside the VPC put the mobile client and a CDN. Save the result with set_diagram.
```

### 3. Add a node into an existing group (EN, edit) (`edit-add-node-to-group`) — PASS

- category: edit
- first-try: yes
- tools used: get_diagram, set_diagram
- notes: Cache added inside VPC, original nodes kept — 4 node(s), 1 group(s), 3 edge(s)
- cost: $0.0237

prompt:

```
Read the current diagram. Inside the existing 'VPC' group, add a new node called 'Cache' (a Redis cache) and connect API > Cache with the label 'cache lookup'. Keep everything else in the diagram unchanged, then save the full document with set_diagram.
```

### 4. Validate-first workflow (EN, forced validate_dsl) (`validate-before-set`) — PASS

- category: workflow
- first-try: yes
- tools used: get_dsl_guide, validate_dsl, set_diagram
- notes: validate_dsl called before set_diagram — 5 node(s), 0 group(s), 6 edge(s)
- cost: $0.0312

prompt:

```
Draw a diagram for a chat system: Client, WebSocket Gateway, Message Queue, Chat Service, Database, with labelled edges for the message flow. IMPORTANT: you MUST call validate_dsl to check your draft DSL BEFORE calling set_diagram — only call set_diagram once validate_dsl reports it is valid.
```

### 5. Vietnamese names with đ/Đ (VI) (`vietnamese-diacritics`) — PASS

- category: unicode
- first-try: yes
- tools used: validate_dsl, set_diagram
- notes: Vietnamese đ/Đ preserved (order node: true) — 9 node(s), 1 group(s), 5 edge(s)
- cost: $0.0684

prompt:

```
Vẽ sơ đồ kiến trúc cho hệ thống đặt hàng online. Dùng CHÍNH XÁC các tên node tiếng Việt sau (giữ nguyên dấu): 'Người dùng', 'Cổng thanh toán', 'Đơn hàng', 'Kho dữ liệu'. Nối các node theo luồng đặt hàng và ghi nhãn cạnh bằng tiếng Việt, rồi lưu bằng set_diagram.
```

### 6. One-to-many fan-out edge (EN) (`one-to-many-fanout`) — PASS

- category: edges
- first-try: yes
- tools used: get_dsl_guide, set_diagram
- notes: Queue fans out to all 3 workers — 5 node(s), 0 group(s), 4 edge(s)
- cost: $0.0246

prompt:

```
Draw a diagram where an Ingestion Service publishes jobs to a Queue, and the Queue fans out to three workers: Worker A, Worker B, Worker C. Use a single one-to-many edge from the Queue to the three workers (see get_dsl_guide for the 'Source > A, B, C' syntax), then save it.
```

### 7. Undo after a wrong edit (EN, undo_diagram) (`undo-after-mistake`) — PASS

- category: undo
- first-try: yes
- tools used: get_diagram, set_diagram, undo_diagram
- notes: undo_diagram restored Database — 3 node(s), 0 group(s), 2 edge(s)
- cost: $0.0277

prompt:

```
The current diagram has Client, API and Database. First, REMOVE the Database node entirely (rewrite the document without it) and save with set_diagram. Then, on reflection, that removal was a MISTAKE — undo it using undo_diagram so the diagram is back to having Client, API and Database again. Finish once the Database node is restored.
```

### 8. Repair a broken existing diagram (mixed, self-correct) (`repair-broken-existing`) — PASS

- category: self-correct
- first-try: yes
- tools used: get_diagram, validate_dsl, set_diagram
- notes: repaired and valid — 5 node(s), 0 group(s), 4 edge(s)
- cost: $0.0387

prompt:

```
The current diagram fails to parse. Read it, fix every syntax error while keeping the same intent (a payment flow: Vietnamese user, gateway, auth, orders, database), and save the corrected VALID DSL with set_diagram.
```

### 9. Look up an icon before using it (EN, list_icons) (`icon-lookup`) — PASS

- category: workflow
- first-try: yes
- tools used: list_icons, set_diagram
- notes: list_icons called, Database icon="database"
- cost: $0.0219

prompt:

```
Create a diagram with a single 'Database' node. Before setting its icon, call list_icons to find a real database icon id, then use that id as the node's [icon: ...] attribute. Save with set_diagram.
```

### 10. List + open a non-active diagram, then edit it (EN) (`multi-diagram-open`) — PASS

- category: workspace
- first-try: yes
- tools used: list_diagrams, get_diagram, set_diagram
- notes: billing diagram edited correctly (list_diagrams used=true, open_diagram used=false) — 3 node(s), 0 group(s), 2 edge(s)
- cost: $0.0251

prompt:

```
List the diagrams in this workspace, open the one called 'billing' (not the active/default one), and add a new node 'Invoice Service' connected as Invoice Service > Database. Save with set_diagram, targeting the 'billing' diagram.
```
