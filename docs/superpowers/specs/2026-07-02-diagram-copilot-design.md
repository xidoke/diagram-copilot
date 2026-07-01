# diagram-copilot — Design Spec (v1)

- **Ngày:** 2026-07-02
- **Trạng thái:** Draft v2 — đã qua deep-research (decision memo: `Research/diagram-copilot/output/decision-2026-07-02-stack-de-risk.md`) và persona pass (người dùng / dev / Đô) cùng ngày.
- **Một câu:** Công cụ vẽ sơ đồ **local-first** để **học & thực hành System Design**, ngôi sao là **sơ đồ cloud architecture đẹp**, với AI copilot = **Claude Code local của người dùng nối qua MCP**.

---

## 1. Tầm nhìn & bối cảnh

Người dùng là dev có kinh nghiệm, sống trong Claude Code, học System Design từ sách và research wiki trong vault Obsidian. Anh ấy *vốn đã* chat với Claude Code về kiến trúc — công cụ này làm cho **sơ đồ mọc ra như side-effect của cuộc chat đang có**, thay vì phải mở một app rời và làm việc riêng.

Điểm khác biệt: **app không nhúng AI**. Bộ não là Claude Code sẵn có của người dùng, nối vào qua **MCP (Streamable HTTP)**. App lo phần *render đẹp + workspace + đồng bộ live + export về vault*. Hệ quả: v1 nhỏ, không phát sinh chi phí AI riêng.

**Dòng chảy điển hình:** đang đọc chương "Design News Feed" → chat với Claude Code → sơ đồ baseline hiện ra trên canvas → "thêm cache layer" → sơ đồ cập nhật live → `snapshot` giữ lại bước → export PNG vào `Research/<topic>/output/` trong vault.

---

## 2. Mục tiêu & Non-goals

### Mục tiêu (v1)
- Render **sơ đồ cloud architecture** chất lượng cao (đẹp ngang eraser): auto-layout ELK, node có icon, group lồng nhau, đường nối orthogonal. **Đã de-risk bằng spike** (`spikes/reactflow-elk-layout`, GO, ~60ms).
- **DSL kiểu eraser** (tự định nghĩa, parse bằng Langium) làm nguồn sự thật — dễ đọc, hợp Git, AI viết chuẩn. Hỗ trợ **comment `//`** (ghi chú "tại sao") và **tên node tiếng Việt** (diacritics).
- **MCP server (Streamable HTTP, port cố định)** để Claude Code sinh/sửa sơ đồ; **canvas tự cập nhật live** qua WebSocket; **state sống qua restart** (yêu cầu cứng).
- **Workspace tối giản**: một thư mục file `.arch`; liệt kê/mở qua MCP tool + dropdown picker. Đủ cho "mở lại URL shortener tuần trước".
- **Snapshot tiến hóa tối giản**: tool `snapshot_diagram` copy file với hậu tố bước (`news-feed.step2.arch`) — phục vụ học SD theo bước (baseline → cache → shard).
- **Export là core, không phải polish**: PNG/SVG, kèm `exportDir` config trỏ vào vault Obsidian.
- Chỉnh tay: sửa DSL trong drawer (Monaco) + kéo-thả tinh chỉnh **tối thiểu** trên canvas.
- **Theme system**: dark "blueprint" (mặc định, đã validate trong spike) + light "clean" về sau.

### Non-goals (KHÔNG làm ở v1 — YAGNI)
- **Flowchart / sequence / ERD (Mermaid)** → **v1.1**. v1 chỉ có architecture — ngôi sao duy nhất, làm thật sâu. (Quyết định persona pass: không chung code path, thêm sau không tốn gì.)
- Collaboration real-time, cloud sync, đăng nhập/tài khoản.
- Docs/pages, whiteboard vẽ tay, UI so sánh snapshot side-by-side.
- Ô prompt AI **trong app** (Agent SDK) — MCP-first đã đủ; để tương lai.
- Đóng gói Tauri — v1 chạy `localhost`.

---

## 3. Trải nghiệm người dùng (UX)

**Bố cục — "Canvas toàn màn + thanh nổi" (Layout C đã chọn):**
- **Canvas** chiếm gần trọn cửa sổ — sơ đồ là ngôi sao.
- **Top toolbar** mỏng: **diagram picker** (dropdown liệt kê workspace, gồm cả snapshot steps), `direction`, theme toggle, **export PNG/SVG**.
- **Slide-over drawer** trái: editor DSL (Monaco), trượt ra khi cần, thu lại xem sơ đồ full.
- **Floating status pill** góc dưới: trạng thái Claude Code (`● connected · live` / `paused · reconnecting`).

**Theme:** dark "blueprint" mặc định; light "clean" sau. Design tokens (CSS variables) tách theme khỏi logic render. **Lưu ý license:** tokens áp lên *khung node*, KHÔNG đổi màu glyph icon hãng.

---

## 4. Kiến trúc hệ thống

```
┌──────────────────────────────────────────────────────────────┐
│  Claude Code (terminal)   ── bộ não / copilot ──               │
│      │  MCP Streamable HTTP  (POST/GET /mcp, port cố định)      │
│      ▼                                                          │
│  ┌────────────────────────────────────────────────────────┐   │
│  │  diagram-copilot SERVER (Node + TypeScript)             │   │
│  │   • serve web app · MCP endpoint /mcp                   │   │
│  │   • diagram state (in-memory cache + version)           │   │
│  │   • persistence: workspace dir (*.arch) — server-owned  │   │
│  │   • WebSocket broadcast ──► canvas                       │   │
│  │   • export PNG/SVG → exportDir (vault)                  │   │
│  └────────────────────────────────────────────────────────┘   │
│      │  WebSocket (live state, version + origin tag)            │
│      ▼                                                          │
│  ┌────────────────────────────────────────────────────────┐   │
│  │  WEB APP (Vite + React + TS) — canvas @ localhost       │   │
│  │   • Architecture renderer: React Flow + ELK + icons ⭐  │   │
│  │   • DSL drawer (Monaco) · toolbar+picker · status pill  │   │
│  │   • Design tokens (theme dark → light sau)              │   │
│  └────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
```

**Nguyên tắc tách khối:** DSL core (Langium grammar + model + Zod — thuần) · Layout (elkjs — thuần) · Renderer (nhận model đã layout, không biết nguồn) · Server/MCP (state & I/O, không biết cách vẽ) · Web shell (lắp ráp). *(Renderer router đa loại sơ đồ quay lại ở v1.1 khi thêm Mermaid.)*

---

## 5. Mô hình dữ liệu & DSL

### DSL (lấy cảm hứng eraser, parse bằng **Langium**)
```
// News Feed — bước 2: thêm cache
direction right

Người dùng [icon: user]

VPC subnet {
  API [icon: aws-ec2, color: orange]
  Postgres [icon: aws-rds]
  Redis [icon: redis]   // cache-aside, TTL 60s
}

Người dùng > API
API > Redis: cache
API > Postgres: query
```
- **Node:** `Name [icon: <id>, color: <token>, label: <text>]` — **Name chấp nhận Unicode/diacritics tiếng Việt** (test case bắt buộc).
- **Group (lồng được):** `Name { ... }`. **Edge:** `A > B`, label `A > B: text`, one-to-many `A > B, C, D`. **Direction:** `direction down|up|left|right`.
- **Comment `//`** — cuối dòng hoặc cả dòng, giữ được ghi chú "tại sao" trong nguồn.
- **Parser: Langium** (all-TS, kèm LSP → autocomplete/validate trong Monaco về sau).

### Model nội bộ (sau parse, validate bằng Zod)
```ts
type DiagramDoc = { type: 'architecture'; direction: Direction; nodes: Node[]; groups: Group[]; edges: Edge[] }
// v1.1 mở rộng union: { type: 'flowchart' | 'sequence' | 'erd'; mermaid: string }

type Node  = { id: string; label: string; icon?: string; color?: string; groupId?: string }
type Group = { id: string; label: string; parentId?: string; icon?: string; color?: string }
type Edge  = { id: string; from: string; to: string; label?: string }
```

### Lưu trữ (server-owned — KHÔNG dùng File System Access API)
- **Workspace dir** (mặc định `~/diagram-copilot/workspace/`, override `--workspace`): mỗi sơ đồ một file `.arch` (DSL text — nguồn sự thật, hợp Git). Snapshot = file hậu tố `.stepN.arch`.
- **Layout overrides** (kéo tay) → sidecar `<name>.layout.json`.
- **Server đọc/ghi toàn bộ file**; browser không đụng filesystem → chạy mọi browser, MCP + canvas nhìn cùng nguồn.
- **Restart-safety (yêu cầu cứng):** file là nguồn bền; in-memory chỉ là cache có version. Server restart → state khôi phục từ file, canvas reconnect tự render lại. Có test.

---

## 6. Giao diện MCP (Claude Code làm copilot)

- **Transport: Streamable HTTP** — ⚠ KHÔNG dùng SSE (deprecated ở Claude Code + MCP spec 2025-11-25; SSE chỉ còn là kiểu stream *bên trong* Streamable HTTP).
- **Endpoint:** một path `/mcp` hỗ trợ **POST và GET**; trả `application/json` hoặc `text/event-stream`.
- **Port CỐ ĐỊNH: mặc định `4747`**, override `--port`. Lý do: `claude mcp add` ghi URL vào config bền vững — port ngẫu nhiên sẽ phá đăng ký sau mỗi restart.
- **Đăng ký (một lần):** `claude mcp add --transport http diagram-copilot http://localhost:4747/mcp` (`.mcp.json` nhận alias `type: streamable-http`).

### Bộ tool v1
| Tool | Input | Kết quả |
|---|---|---|
| `get_dsl_guide` | – | cú pháp DSL + ví dụ + quy ước — để mọi phiên Claude mới tự bootstrap, khỏi dạy lại |
| `list_icons` | `{ query? }` | icon ids hợp lệ |
| `get_diagram` | – | `{ name, dsl, version }` của sơ đồ đang mở |
| `set_diagram` | `{ dsl }` | thay toàn bộ; validate; lỗi trả **danh sách lỗi có dòng** để Claude tự sửa |
| `list_diagrams` | – | tên các `.arch` trong workspace (gồm snapshot steps) |
| `open_diagram` | `{ name }` | chuyển sơ đồ active (tạo mới nếu chưa có) |
| `snapshot_diagram` | `{ label? }` | copy file hiện tại → `.stepN.arch`, trả tên |
| `undo_diagram` | – | hoàn tác thay đổi gần nhất (ring buffer version server-side) — lưới an toàn khi `set_diagram` ghi đè |
| `get_snapshot` *(tùy chọn)* | – | PNG/SVG hiện tại — cho Claude tự "nhìn" kết quả để verify |

> Tool tinh (`add_node`, `patch_diagram`...) để tương lai. v1 ưu tiên thô-mà-chắc: Claude sinh lại toàn bộ DSL (file nhỏ, khó sai).

Mỗi lần tool ghi: **validate → cập nhật state (version++) → ghi file → WS broadcast (kèm origin tag) → canvas render**.

---

## 7. Luồng dữ liệu

**Từ Claude Code:** `set_diagram(dsl)` → Langium parse + Zod validate → state (version++, origin=`mcp`) → ghi file → WS broadcast → web: ELK layout (trừ node có override) → React Flow render.

**Từ người dùng:** sửa DSL trong Monaco *hoặc* kéo node → gửi lên server (origin=`drawer`/`canvas`) → validate → state + file → broadcast cho các view khác (không echo về nguồn).

**Chống echo-loop (hướng, chốt bằng spike P3):** server = single source of truth; version/seq đơn điệu; tag origin mọi mutation; client không rebroadcast thứ vừa nhận; persist file là side-effect, file-watch chỉ dành cho sửa ngoài (git checkout).

---

## 8. Xử lý lỗi

- **DSL sai từ MCP:** `set_diagram` trả lỗi có dòng/vị trí → Claude tự sửa; canvas giữ bản render tốt gần nhất + banner lỗi.
- **Icon không tồn tại:** fallback icon generic + cảnh báo mềm.
- **Port 4747 bận:** fail rõ ràng với hướng dẫn `--port` + lệnh `claude mcp add` tương ứng (không tự nhảy port — sẽ lệch đăng ký MCP).
- **Server tắt / mất kết nối:** canvas overlay "paused", WS auto-reconnect, pill đổi trạng thái.

---

## 9. Công nghệ (stack)

- **Web:** Vite · React · TypeScript · Tailwind (+ CSS variables tokens)
- **Architecture render:** React Flow (custom nodes/edges) · **elkjs** (`layered`, `hierarchyHandling=INCLUDE_CHILDREN`, orthogonal) — *engine mở; đã spike GO. Không dùng D2/TALA (TALA closed/paid/no-browser).*
- **DSL/parser:** **Langium** · **Editor:** Monaco · **Validate:** Zod
- **Server:** Node + TS · Hono/Express · `ws` · `@modelcontextprotocol/sdk` (**Streamable HTTP**)
- **Icons:** **bộ open (CC0/MIT) mặc định**; pack AWS/GCP/Azure chính hãng **opt-in** (đọc ToU riêng từng hãng; **không re-theme glyph** — AWS no-derivatives)
- **Export:** PNG/SVG từ canvas (html-to-image hoặc render SVG trực tiếp)
- **Test:** Vitest · Testing Library
- *(v1.1: Mermaid themed cho flowchart/sequence/ERD)*

---

## 10. Cấu trúc thư mục đề xuất

```
diagram-copilot/
├─ package.json
├─ src/
│  ├─ core/            # Langium grammar, model, Zod, DSL↔model   (thuần, test kỹ)
│  ├─ layout/          # elkjs mapping: model → positioned graph   (thuần)
│  ├─ render/
│  │  └─ architecture/ # React Flow nodes/edges/groups, icon map
│  ├─ web/             # shell, canvas, drawer, toolbar+picker, tokens
│  └─ server/          # serve + WS + MCP + persistence + export
├─ icons/              # SVG packs (open mặc định, provider opt-in)
├─ spikes/             # reactflow-elk-layout (giữ làm tham chiếu)
└─ docs/superpowers/specs/…
```

---

## 11. Chiến lược test

- **Unit (core/layout):** DSL → model đúng (gồm **tên tiếng Việt**, comment `//`); validate bắt lỗi kèm dòng; model → ELK input; model → React Flow nodes/edges.
- **Component:** architecture renderer dựng đúng node/group/edge từ fixture.
- **Server/MCP:** tool handlers với input cố định (không gọi LLM thật) — `set_diagram` → state + broadcast + persist; **restart-safety:** kill server → start → state khôi phục từ file, version nhất quán.
- **Live-sync:** mutation từ origin X không echo về X.

---

## 12. Lộ trình (phased build) — mỗi phase kết thúc bằng demo nhìn thấy được

- **✅ P-spike (XONG 2026-07-02):** React Flow + ELK nested + cross-tier edges → GO (~60ms, theme B đẹp). Còn nợ tinh chỉnh: edge từ ELK bend-points, label placement.
- **P0 — Scaffold:** monorepo Vite+React+TS + server; WS nối web↔server; tokens + theme dark. *Demo: trang trống có pill "connected".*
- **P1 — DSL core:** Langium grammar (node/group/edge/direction/comment/tiếng Việt) + model + Zod + test. *Demo: parse fixture → JSON model.*
- **P2 — Architecture renderer:** React Flow + ELK từ model + node design theme B + bộ icon open khởi đầu. *Demo: file .arch tĩnh → sơ đồ đẹp.*
- **P3 — MCP live loop:** MCP server (đủ bộ tool §6) + đăng ký Claude Code + restart-safety. *Demo end-to-end: chat trong Claude Code → canvas cập nhật live.*
- **P4 — Dùng thật:** drawer Monaco + kéo-thả tối thiểu + layout overrides + **undo/redo** (ring buffer version phía server — hoàn tác được cả khi AI ghi đè) + **workspace picker** + **export PNG/SVG + exportDir vault**. *Demo: học 1 topic SD thật, export vào vault.*
- **P5 — Snapshot + polish:** `snapshot_diagram` + hiện steps trong picker; edge routing từ ELK sections; label placement; spacing presets. *Demo: news-feed step1→3.*
- **v1.1+:** Mermaid (flowchart/sequence/ERD) · theme light A · so sánh snapshot side-by-side · Agent SDK prompt box · tool MCP tinh · Tauri · thêm icon packs.

---

## 13. Rủi ro & câu hỏi mở

- **Thẩm mỹ layout (rủi ro #1, đã giảm):** spike GO nhưng "hỗ trợ ≠ đẹp mặc định" — bug mở ELK routing chéo tầng (#700/#766/#515); nợ kỹ thuật: render edge theo ELK bend-points thay vì smoothstep. Theo dõi ở P2/P5.
- **License icon:** open set mặc định đã né phần lớn; trước khi bật pack hãng: đọc ToU riêng (AWS Architecture Icons ToU, Azure, **GCP chưa verify**), không re-theme glyph.
- **Echo-loop live-sync (chưa verify):** hướng đã có (§7), chốt bằng spike trong P3.
- **Langium learning curve:** lần đầu dùng — nếu P1 kẹt >1 buổi, fallback Chevrotain (grammar nhỏ, chuyển được).
- **MCP đăng ký:** xác nhận `claude mcp add --transport http` với server local mượt ngay ở P3 (sớm, không để cuối).
