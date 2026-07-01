# diagram-copilot

**System Design Studio, local-first, AI-native.** Sơ đồ cloud architecture đẹp, sinh/sửa bằng cách trò chuyện với Claude Code (qua MCP) — chạy hoàn toàn local, không cần API key riêng.

> Trạng thái: pre-v0.1 — đang xây theo [ROADMAP](docs/ROADMAP.md).

## Tài liệu
- **Roadmap sản phẩm:** [`docs/ROADMAP.md`](docs/ROADMAP.md) — release train v0.1 → v2.0, module map M1–M8.
- **Design spec (v2):** [`docs/superpowers/specs/2026-07-02-diagram-copilot-design.md`](docs/superpowers/specs/2026-07-02-diagram-copilot-design.md)
- **Workflow vibe song song:** [`docs/WORKFLOW.md`](docs/WORKFLOW.md) — master điều phối + worker agents trong git worktree.
- **Tracking:** Plane local, project `DGC` · **Research:** Obsidian vault `Research/diagram-copilot/`.

## Kiến trúc (tóm tắt)
DSL kiểu eraser (Langium) → model (Zod) → auto-layout (elkjs) → render (React Flow, theme dark blueprint). Local Node server: serve canvas + WebSocket live-sync + MCP endpoint `/mcp` (Streamable HTTP, port 4747) cho Claude Code.

## Spike đã verify
`spikes/reactflow-elk-layout/` — nested VPC/subnet + cross-tier edges, layout ~60ms. `npm i && npm run dev` (port 5178).
