# diagram-copilot — Product Roadmap

- **Ngày lập:** 2026-07-02 · **PM/PO:** Đô (product owner) + Claude (đồng PM & builder)
- **Nguồn:** Spec v2 (`docs/superpowers/specs/2026-07-02-diagram-copilot-design.md`) + research vault (`Research/diagram-copilot/`)
- **Đơn vị lập lịch:** 1 **phiên vibe** = một buổi làm việc tập trung với Claude Code (~2–4h), kết thúc bằng **demo nhìn thấy được + commit + note vault**.

---

## 1. Tầm nhìn (nghĩ lớn)

> **"System Design Studio, local-first, AI-native."**
> Nơi một kỹ sư mở một cửa sổ, trò chuyện với Claude Code, và *thiết kế hệ thống hiện ra, tiến hóa, bị phản biện, được mô phỏng và xuất bản* — tất cả trên máy của mình, bằng subscription AI mình đã có.

Không phải "một tool vẽ sơ đồ nữa". Vẽ đẹp chỉ là **v1**. Đích cuối là **studio**: vẽ (v1) → nghĩ & học (v2: coach, what-if, diff, C4) → chia sẻ & mở rộng (v3).

**North Star metric:** *số sơ đồ được export vào vault/tài liệu mỗi tuần* — tool chỉ thắng khi nó nằm trong dòng chảy học & làm việc thật, không phải khi nó có nhiều tính năng.

**Wow cuối roadmap (câu chuyện demo v2.0):** *"Tôi nói với Claude Code: 'thiết kế news feed 10M DAU'. Sơ đồ đẹp như eraser hiện ra. Tôi hỏi 'nếu Redis chết thì sao?' — đường traffic đổi màu chạy lại trên canvas. Tôi bấm snapshot, bấm next — sơ đồ tiến hóa qua 4 bước như một bài giảng. Claude chấm điểm thiết kế của tôi, chỉ ra single point of failure. Tôi export cả chuỗi vào Obsidian. Tất cả local, không tốn thêm xu API nào."*

## 2. Nguyên tắc sản phẩm

1. **Hero-first:** mọi release phải làm architecture diagram *đẹp hơn hoặc hữu dụng hơn*. Không nuôi tính năng phụ khi ngôi sao chưa sáng.
2. **Side-effect of conversation:** trải nghiệm gốc là *đang chat thì sơ đồ mọc ra* — mọi feature phải trơn tru từ MCP trước, UI sau.
3. **Ship mỗi phiên:** không phiên vibe nào kết thúc mà không có thứ chạy được để nhìn.
4. **File là sự thật:** DSL text trên đĩa, hợp Git, sống qua restart, không lock-in.
5. **YAGNI có kỷ luật, vision có tham vọng:** cắt không thương tiếc trong release, nghĩ lớn giữa các release.

---

## 3. Module map (kiến trúc sản phẩm — 8 module lớn lên độc lập)

| Mã | Module | Nhiệm vụ | Trưởng thành qua |
|---|---|---|---|
| **M1** | **DSL Core** | Grammar Langium, model, validate, lỗi có dòng, comment, tiếng Việt | v0.2 → C4/what-if syntax (v2) |
| **M2** | **Render Engine** | React Flow + ELK, node/edge/group đẹp, theme tokens, icon packs | v0.2 → ELK bend-points, overlays (v2) |
| **M3** | **MCP Copilot** | Server Streamable HTTP :4747, bộ tool, DSL guide, snapshot cho AI "nhìn" | v0.3 → review/coach tools (v2) |
| **M4** | **Workspace & Persistence** | Dir `.arch`, open/list, restart-safe, layout sidecar, version/origin sync | v0.4 → diff, history (v2) |
| **M5** | **Export & Vault** | PNG/SVG, exportDir → Obsidian, clipboard | v0.4 → chuỗi snapshot, Marp/slide (v2) |
| **M6** | **Learning Tools** | Snapshot steps, ghi chú "tại sao", present/walkthrough, coach, what-if | v0.5 → linh hồn của v2 |
| **M7** | **App Shell & UX** | Layout C, drawer Monaco, picker, status pill, theme light | v0.4 → polish liên tục |
| **M8** | **Distribution & Quality** | npx install, docs, tests, CI, error UX, license hygiene, README+GIF | v1.0 — cửa ải "prod-grade" |

---

## 4. Release train — tổng quan

| Version | Tên | Wow demo | Phiên (ước) |
|---|---|---|---|
| ✅ v0.0 | Spike | Nested VPC render đẹp trong 60ms | done |
| **v0.1** | Walking Skeleton | File `.arch` → sơ đồ trên canvas, sửa file → tự render lại | 2 |
| **v0.2** | Beautiful Core | Sơ đồ "đẹp ngang eraser" từ DSL đầy đủ, icon, theme dark | 3 |
| **v0.3** | The Copilot Loop ⭐ | **Chat trong Claude Code → canvas cập nhật live** (khoảnh khắc sản phẩm "ra đời") | 3 |
| **v0.4** | Daily Driver | Workspace picker, drawer Monaco, export vào vault — dùng học SD thật hằng ngày | 3 |
| **v0.5** | Learning Pack (v1.0-rc) | Snapshot steps news-feed 1→3, polish routing/label | 2 |
| **v1.0** | **Prod-grade** 🚀 | `npx diagram-copilot` + README GIF — người khác cài được trong 2 phút | 2–3 |
| **v1.2** | Visual Editing | Thao tác 2 chiều ngang app cùng loại — đang đóng (còn DGC-20 bay, T-VE4/T-VE5 Todo, T-VE6 chờ Đô) | 1 |
| **v1.3** | Copilot Hardening | Agent-first cho persona P1 (Chợ Phiên): rolling release, scope lấp từ dogfood intake — không dispatch khi chưa có tín hiệu (PO-PLAYBOOK §1) | rolling |
| **v2.0** | **SD Studio** | 3 phase theo module: **A** diff-visual + collapse (M4+M6, M2) → **B** C4 zoom (M1+M2) → **C** coach + what-if (M3+M6) | 8–12 |
| v1.1 | More Canvases (PARKED) | Mermaid themed — chỉ mở khi tín hiệu nhu cầu thật xuất hiện | 2–3 |
| v3.x | Moonshots | Publish web, template gallery, Tauri, embedded Agent SDK, plugin icons | — |

**Tổng đến v1.0: ~15–16 phiên vibe.** Nhịp đề xuất 3 phiên/tuần → **v1.0 trong ~5 tuần**; nhịp 2 phiên/tuần → ~8 tuần.

---

## 5. Chi tiết từng release

### v0.1 — Walking Skeleton (2 phiên) — *"xương sống chạy trước, đẹp sau"*
Mục tiêu: mọi tầng nói chuyện được với nhau, mỏng nhất có thể.
- **Phiên 1 (M7+M4):** scaffold monorepo (server + web), server serve web app, WS nối 2 chiều, status pill, workspace dir đọc file `.arch` (raw text), port 4747.
- **Phiên 2 (M1+M2):** Langium grammar tối thiểu (node/edge/direction) → model → ELK → React Flow render (tái dùng spike). File thay đổi (chokidar) → broadcast → canvas render lại.
- **Demo:** sửa `demo.arch` bằng vim → sơ đồ tự vẽ lại. **Đây đã là diagram-as-code tool chạy được.**

### v0.2 — Beautiful Core (3 phiên) — *"ngôi sao phải sáng trước khi có copilot"*
- **Phiên 3 (M1):** grammar đầy đủ: group lồng, thuộc tính `[icon, color, label]`, one-to-many, comment `//`, **tên tiếng Việt**, lỗi kèm dòng + test suite core.
- **Phiên 4 (M2):** node design theme B hoàn chỉnh (spike → component thật), group styling, bộ icon open khởi đầu (~40 icon phổ dụng: compute/db/cache/queue/lb/client...), icon fallback.
- **Phiên 5 (M2):** chất lượng layout: edge render theo **ELK bend-points** (bỏ smoothstep), label placement, spacing presets, fitView flow.
- **Demo:** 3 sơ đồ mẫu (URL shortener, news feed, rate limiter) render đẹp, chụp đặt cạnh eraser để so.

### v0.3 — The Copilot Loop ⭐ (3 phiên) — *"khoảnh khắc sản phẩm ra đời"*
- **Phiên 6 (M3):** MCP server Streamable HTTP `/mcp` (SDK TS), tools `get_dsl_guide`, `list_icons`, `get_diagram`, `set_diagram` (validate → lỗi có dòng cho Claude tự sửa), đăng ký `claude mcp add`.
- **Phiên 7 (M3+M4):** tools `list_diagrams`, `open_diagram`; sync version+origin (chống echo); **restart-safety test** (kill → start → state nguyên).
- **Phiên 8 (M3):** `get_snapshot` (PNG cho Claude "nhìn" và tự verify); tinh chỉnh DSL guide qua dùng thật; hardening error path.
- **Demo:** phiên Claude Code thật: *"thiết kế hệ thống đặt vé, 5k rps"* → canvas hiện sơ đồ → *"thêm queue chống oversell"* → cập nhật live.

### v0.4 — Daily Driver (3 phiên) — *"từ demo sang công cụ hằng ngày"*
- **Phiên 9 (M7):** drawer Monaco (syntax highlight cơ bản từ Langium), toolbar + diagram picker, direction switch.
- **Phiên 10 (M5):** export PNG/SVG (nền trong suốt/đặc), copy clipboard, `exportDir` config → ghi thẳng vào `Research/<topic>/output/` của vault.
- **Phiên 11 (M2+M4):** kéo-thả tối thiểu + layout overrides sidecar + nút "reset layout"; autosave; **undo/redo** (server giữ ring buffer version — hoàn tác được cả thay đổi do AI ghi đè, có nút UI + MCP tool `undo_diagram`).
- **Demo:** học 1 topic SD thật end-to-end, sơ đồ nằm trong note Obsidian. **Từ đây anh là daily user — feedback thật bắt đầu chảy về roadmap.**

### v0.5 — Learning Pack = v1.0-rc (2 phiên)
- **Phiên 12 (M6):** `snapshot_diagram` (`.stepN.arch` + label), steps trong picker, điều hướng step trước/sau.
- **Phiên 13 (M2+M7):** polish pass từ 1 tuần dùng thật (top 5 khó chịu), perf check sơ đồ ~50 node.
- **Demo:** news feed tiến hóa 3 bước, bấm qua lại như lật slide.

### v1.0 — Prod-grade 🚀 (2–3 phiên) — cửa ải M8, Definition of Done:
- [ ] Cài & chạy: `npx diagram-copilot` (hoặc `bunx`) → server up, in sẵn lệnh `claude mcp add` để copy.
- [ ] README có **GIF demo live-edit từ Claude Code** + quickstart 5 phút + tài liệu DSL đầy đủ.
- [ ] Test: core (parse/validate/layout-mapping) + MCP handlers + restart-safety xanh trên CI (GitHub Actions).
- [ ] Error UX tử tế: DSL sai không bao giờ làm trắng canvas; port bận nói rõ cách sửa; mất kết nối tự hồi.
- [ ] License hygiene: icon open có attribution file; pack hãng tách riêng opt-in kèm ghi chú ToU.
- [ ] Versioning + CHANGELOG; tag release; issue template.
- **Wow:** một dev lạ cài được và ra sơ đồ đầu tiên trong <5 phút — *"mọi người phải goal"* nghĩa là thế này.

### v1.2 — Visual Editing (đang đóng, PO update 2026-07-10) — *"ngang mặt bằng thao tác của app cùng loại"*
Sync **hai chiều canvas → DSL**, nguyên tắc: DSL vẫn là nguồn sự thật duy nhất.
- ✅ DSL printer + minimal-diff primitives (DGC-17) · delete + rename (T-VE1) · diff overlay (T-VE2) · icon palette (T-IPAL, T-VE3) · palette drop + edge draw (DGC-18) · drag vào/ra group + resize (DGC-19).
- 🔶 Còn: DGC-20 (context menu, Cmd+D, multi-select — bay) · T-VE4 (edge label edit) · T-VE5 (drop-point position) · T-VE6 (resize bền qua reload — chờ Đô duyệt contract).
- ✂️ Đã cắt: align/distribute (mâu thuẫn ELK — PO decision, xem DGC-20).

### v1.3 — Copilot Hardening (rolling, chạy song song mọi release) — *"agent là user hạng nhất"*
Persona P1 (agent session qua MCP — Chợ Phiên) là user thật hằng ngày. Release này KHÔNG có scope cố định: item sinh từ dogfood intake, ưu tiên trên task thường (CLAUDE.md), làm ngay khi có repro. Đã ship theo dòng này: export roots env var (DGC-81), headless export (DGC-82), zombie-client retry (DGC-84). Ứng viên chờ tín hiệu: theme param cho export PNG (headless đang luôn dark), Linux `--no-sandbox`, F8 edge styles/note attr, deterministic export path nâng cao.

### v2.0 — SD Studio (8–12 phiên, 3 phase theo module — PO chốt 2026-07-10)
Linh hồn giai đoạn 2 — biến tool vẽ thành **môi trường tư duy**. Xếp phase theo độ chín của module nền:
- **Phase A — "nhìn thấy tiến hóa" (M4+M6, M2):** snapshot diff visual — so 2 step cạnh nhau trên canvas, highlight thêm/bớt (nền: `diff_diagram` + T-VE2 đã ship) · F7 group collapse/expand (M2, tiền đề C4). Nền sẵn nhiều nhất → làm trước.
- **Phase B — "lặn xuống chi tiết" (M1+M2):** C4 zoom — context → container → component, double-click group để lặn; cần grammar additive (M1) + collapse từ Phase A.
- **Phase C — "bị phản biện" (M3+M6):** tool `review_architecture` — Claude chấm thiết kế: SPOF, bottleneck, trade-off; findings pin lên node · what-if overlays — annotate QPS/latency, "kill node này" → traffic re-route đổi màu. Khó nhất, giá trị wow nhất — làm khi A+B đã cho khung overlay/annotation.
- *(ứng viên thêm, chọn theo tín hiệu: cost lens; template gallery; import Mermaid/eraser/draw.io; keyboard shortcuts + command palette)*

### v1.1 — More Canvases (PARKED — không có ngày)
Renderer router: flowchart/sequence/ERD qua Mermaid themed theo tokens; theme light A đã ship trước (T-THEME). Chỉ mở khi có tín hiệu nhu cầu thật (PO-PLAYBOOK §1.4); icon pack hãng opt-in sau verify ToU.

### v3.x — Moonshots (giấc mơ có địa chỉ, không có deadline)
Publish sơ đồ thành web page tĩnh share được · template/community gallery · Tauri desktop app · embedded Agent SDK (người không dùng Claude Code vẫn xài được) · plugin system cho icon/theme · realtime collab.

---

## 6. Nghi thức mỗi phiên vibe (để roadmap tự vận hành)

1. **Mở phiên:** đọc lại note phiên trước + chọn mục tiêu phiên từ roadmap (1 dòng).
2. **Làm:** plan nhỏ → implement (TDD cho core) → demo chạy được.
3. **Đóng phiên (bắt buộc):** commit + cập nhật ô trạng thái roadmap + 3 dòng note vào `Research/diagram-copilot/output/log.md` (làm gì, học gì, phiên sau làm gì).
4. **Cửa thoát rủi ro:** Langium kẹt >1 phiên → Chevrotain. ELK đẹp không tới sau v0.2 → 1 phiên spike D2-WASM so sánh rồi quyết.

## 7. Trạng thái (cập nhật mỗi phiên)

| Release | Trạng thái | Ghi chú |
|---|---|---|
| v0.0 Spike | ✅ 2026-07-02 | GO — React Flow+ELK |
| v0.1 Walking Skeleton | ✅ 2026-07-02 | tag `v0.1` — T1→T8, 149 test, demo live re-render (docs/demos/). Langium OK không cần escape hatch. Vibe song song: 5 worker/wave chạy tốt |
| v0.2 Beautiful Core | ✅ 2026-07-02 | T9-T16 + T-FIX: groups+attrs, icons, ELK bend-point edges (dist=0.0px verify). **Chờ T17 visual QA — mắt Đô** |
| v0.3 Copilot Loop | ✅ 2026-07-02 | tag `v0.3` — 11 MCP tools, claude -p headless THẬT drive canvas (docs/demos/t25-claude-drove-canvas.png). Guide eval 5/6 first-try |
| v0.4 Daily Driver | ✅ 2026-07-02 | tag `v0.4` — T32 dogfood Đô duyệt. Drawer, picker, export, drag (edges bám live), undo/redo, group drag |
| v0.5 Learning Pack | ✅ 2026-07-02 | tag `v0.5` — steps nav, present mode ▶, notes ⌘I, diff_diagram, templates, perf 60-node=190ms |
| v1.0 Prod-grade | ✅ 2026-07-02 | tag `v1.0` 🚀 — CI xanh, node dist standalone, README GIF, DSL.md, MIT (Đô duyệt), eval 10/10 first-try. npm publish = quyết định riêng của Đô |
| v1.2 Visual Editing | ✅ 2026-07-10 | DGC-17/T-VE1/2/3/T-IPAL + DGC-18/19/20/85/86/87 merged (~1490 test). Đô duyệt contract DGC-87 + gật đóng release; UX issue phát hiện sau chảy vào v1.3 intake |
| v2.0 SD Studio | 🔶 Phase A mở 2026-07-10 | DGC-88 compare mode (bay, Fable). Kế: F7 collapse |
| v1.3 Copilot Hardening | 🔄 rolling | DGC-81/82/84 shipped 2026-07-10 (dogfood Chợ Phiên). Intake luôn mở |
| v1.1 More Canvases | ⏸ parked | Chờ tín hiệu nhu cầu thật |

## 8. Horizon hiện tại (PO update 2026-07-10, phiên tự hành — vai PO chính thức theo docs/PO-PLAYBOOK.md)
- **Hôm nay đã merge 6 task:** DGC-81 (export roots env var) · DGC-82 (headless PNG export, byte-identical) · DGC-18 (palette drop + edge draw) · DGC-83 (deflake watcher) · DGC-84 (zombie-client retry) · DGC-19 (drag vào/ra group + resize). Groom 11 item stale. PO-PLAYBOOK.md ra đời — Đô giao vai PO cho Claude, Đô là user.
- **Phiên kết thúc với 8 task merged** (4 wave): thêm DGC-20 (context menu/Cmd+D/marquee) + DGC-85/86 (edge label inline + drop-point) sau đợt đầu. v1.2 code-complete.
- **Chờ Đô:** DGC-87 (2 dòng optional vào LayoutPositionSchema — resize bền qua reload) · 5 checkpoint UX bằng chuột thật: kéo handle tạo edge, Alt-drag nhập label, drag vào/ra group, Shift+drag marquee, double-click edge sửa label.
- **Kế tiếp theo playbook:** Đô gật checkpoints → tuyên bố v1.2 xong → mở v2.0 Phase A (DGC-88 diff visual + F7 collapse) song song v1.3 intake. Mermaid (v1.1) tiếp tục parked.
