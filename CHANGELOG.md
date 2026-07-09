# Changelog

Format theo [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning theo [Semantic Versioning](https://semver.org/) khi package public đầu tiên được publish (hiện tại các package trong monorepo là private, `0.0.0`, chưa publish npm — số version dưới đây theo **release train sản phẩm** trong `docs/ROADMAP.md`, khớp git tag `v0.1`/`v0.3`).

## [Unreleased]

### Added
- Visual editing v1.2: context menu right-click (đổi icon/màu, xóa — group xóa có confirm), Cmd+D duplicate, multi-select Shift+drag marquee + Shift-click (DGC-20).
- Visual editing v1.2: kéo node vào/ra group đổi nesting DSL thật (`move_to_group`, không nest vào subtree của chính nó); resize group bằng NodeResizer lưu layout override (bền trong session — bền qua reload chờ DGC-87); headless fallback tự retry khi client kết nối nhưng câm (zombie tab) (DGC-19, DGC-84).
- Headless PNG export: `get_snapshot`/`export_diagram` tự fallback sang hidden system-Chrome canvas (puppeteer-core, lazy) khi không có web client — PNG byte-identical với canvas mở; browser reuse + idle reap 60s; Chrome discovery qua `DIAGRAM_COPILOT_CHROME`/paths phổ biến (DGC-82, dogfood Chợ Phiên).
- Visual editing v1.2: kéo icon từ palette thả vào canvas → node mới (nest đúng group, tên de-dup); kéo handle node→node → edge mới, giữ Alt để nhập nhãn (DGC-18).
- Env var `DIAGRAM_COPILOT_EXPORT_ROOTS` khai báo thêm export root (ngăn bằng `:`, hỗ trợ `~`, cộng thêm vào whitelist — không thay thế cờ/vault); README document `--export-root` + env var (DGC-81, dogfood Chợ Phiên).
- Docs pack: README quickstart 5 phút (song ngữ), tài liệu DSL đầy đủ (`docs/DSL.md`), CHANGELOG, MIT license (DGC-14).

### Fixed
- Packaging: conditional `exports` trong `packages/server/package.json` sao cho `dist/` build đã build chạy standalone dưới `node` thuần, không cần workspace linking (DGC-59/T38).
- Test: assertion export-traversal phụ thuộc môi trường — phát hiện bởi lần chạy CI thật đầu tiên.

### Docs
- Cập nhật trạng thái roadmap: v0.2 Beautiful Core và v0.3 Copilot Loop đánh dấu hoàn thành.

## [v1.0] - 2026-07-02

Prod-grade 🚀 — cửa ải M8 hoàn thành, cả 4 gate được Đô duyệt (T17 visual QA, T32 dogfood, MIT license, README GIF).

### Added
- **21 MCP tools** — mới trong đợt này: `validate_dsl`, `export_diagram` (ghi PNG vào vault, whitelist `--export-root`), `get_notes`/`set_notes`, `rename_diagram`/`delete_diagram`/`list_trash`/`restore_diagram`, `edit_diagram` (surgical ops giữ nguyên comment/format), `diff_diagram`.
- Web: notes panel (⌘I), steps navigation, present mode ▶ (⌘⇧P), MiniMap, tìm node ⌘F (bỏ dấu được), light theme ☀, icon palette 🎨, templates gallery, rename/trash trong picker, kéo group bằng title band.
- Core: DSL printer + minimal-diff edit primitives (nền v1.2 visual editing) và `diffDocs`.
- Fixture `microservices.arch` 60 node + benchmark layout (~190ms, budget 1500ms) — `docs/PERF.md`.
- Eval harness v2 live-MCP: **10/10 scenario first-try** với haiku — `docs/EVAL.md`.
- CI GitHub Actions (badge trên README), LICENSE MIT, `docs/DSL.md`, README GIF demo.

### Fixed
- Export PNG mất edges/marker (html-to-image clone svg thô) — inline style + marker defs khi capture.
- Edge đứng yên khi kéo node/group — anchor-based dirty detect, path động bám handle từng frame.
- Node con đè lên viền/title group khi kéo — clamp chừa title band 32px.
- Label edge đè node — label thành first-class citizen trong ELK layout.
- CORS chặn API dev-mode — vite proxy + relative URLs.
- Bundle production nối WS cứng về :4747 — giờ nối same-origin (server standalone port tùy chỉnh hết rò dữ liệu chéo instance).
- Test path-traversal phụ thuộc môi trường (CI Ubuntu bắt được ngay lần chạy đầu).

## [v0.3] — 2026-07-02 — "The Copilot Loop" ⭐

Gộp cả hai mốc **v0.2 Beautiful Core** và **v0.3 The Copilot Loop** của roadmap (không có tag `v0.2` riêng — xem `docs/ROADMAP.md` mục 7 "Trạng thái"). Đây là khoảnh khắc sản phẩm: Claude Code thật (`claude -p`, headless) lái được canvas qua MCP.

### Added
- Grammar: nested groups + attribute `[icon, color, label]` trên node/group (DGC-29).
- Grammar ext: one-to-many fan-out edges, comment `//`, tên tiếng Việt, chất lượng thông báo lỗi (DGC-30).
- Golden fixtures: `url-shortener.arch`, `news-feed.arch`, `rate-limiter.arch` + snapshot test (DGC-31).
- Render: node theme B — icon chip, color accent (DGC-32); group render — handle nối vào group, depth tint, hover, icon group (DGC-33).
- Icon registry mở (~38 icon, lucide-static ISC + simple-icons CC0-1.0) với fallback + attribution (DGC-34).
- Render: cạnh orthogonal thật theo ELK bend-point, bo góc (DGC-35); layout prefs — spacing preset, direction override, fitView ổn định (DGC-36).
- MCP: endpoint `/mcp` Streamable HTTP + tool `ping` + `.mcp.json` project (DGC-38).
- MCP tools: `get_dsl_guide`, `list_icons` (DGC-39); `get_diagram`, `set_diagram` với lỗi validate tự-sửa-được (DGC-40); `list_diagrams`, `open_diagram` (DGC-42); `get_snapshot` — PNG canvas-render qua giao thức snapshot WS (DGC-44); `snapshot_diagram` — lưu bước tiến hóa cho học tập (DGC-58); `undo_diagram`/`redo_diagram` — history ring buffer (DGC-51).
- Server: xử lý client update — origin routing, loại trừ echo, xử lý conflict `baseVersion` (DGC-41); restart-safety acceptance test — state sống sót qua process chết (DGC-43); `POST /export` lưu ảnh diagram vào `--export-dir` (DGC-49); drag layout override qua sidecar `/api/layout` (DGC-50); `POST /api/open` cho diagram picker (DGC-57).
- Web: export PNG/SVG phía client + clipboard (DGC-48); drawer trượt với Monaco DSL editor (DGC-46); ngôn ngữ Monaco cho arch-dsl — highlight, markers, self-hosted editor (DGC-47); empty state onboarding + chip "đang tính layout" (DGC-54); dropdown diagram picker (DGC-57).
- Dev DX: `tsx watch`, script `pnpm dev` hợp nhất server+web (DGC-56).
- CI: GitHub Actions — install, build, test trên Node 22 + pnpm 11 (DGC-60).
- Eval harness cho DSL guide + guide v2 (thêm mục workflow) — 83% pass ngay lần đầu (DGC-55).

### Fixed
- Cạnh ELK bị lệch offset theo `edge.container` — sửa về tọa độ tuyệt đối đúng (DGC-53).
- Export thiếu cạnh/arrowhead — inline SVG stroke + chèn marker defs khi capture.
- CORS ở dev — Vite proxy `/api`, `/export` + URL tương đối (phát hiện lúc e2e T25).

### Demo
Phiên Claude Code thật: *"thiết kế hệ thống đặt vé, 5k rps"* → canvas hiện sơ đồ → *"thêm queue chống oversell"* → cập nhật live. Ảnh chụp: `docs/demos/t25-claude-drove-canvas.png`.

## [v0.1] — 2026-07-02 — "Walking Skeleton"

### Added
- Scaffold monorepo pnpm với 5 package: `core`, `layout`, `icons`, `server`, `web` (DGC-21).
- Contracts đóng băng: model + Zod schema, giao thức WebSocket, quy ước workspace (DGC-22).
- Server: serve static + WebSocket hub trên port cố định 4747 (DGC-23); watcher thư mục workspace (chokidar) — parse + broadcast khi file đổi, welcome message động (DGC-24).
- Web: shell + WS client với reconnect + status pill (DGC-25); render architecture doc — layout + toFlow + node/group + error banner (DGC-28).
- Core: Langium DSL parser tối thiểu — node/edge/direction (DGC-26).
- Layout: ELK adapter — `DiagramDoc` → graph đã định vị (DGC-27).
- Icons: registry icon mở ~40 icon với fallback + file attribution (DGC-34).

### Demo
Sửa `demo.arch` bằng vim → sơ đồ tự vẽ lại. Diagram-as-code tool chạy được lần đầu tiên.

[Unreleased]: https://github.com/xidoke/diagram-copilot/compare/v0.3...HEAD
[v0.3]: https://github.com/xidoke/diagram-copilot/compare/v0.1...v0.3
[v0.1]: https://github.com/xidoke/diagram-copilot/releases/tag/v0.1
