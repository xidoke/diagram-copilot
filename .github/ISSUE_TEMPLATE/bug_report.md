---
name: Bug report
about: Báo lỗi diagram-copilot (server, web canvas, DSL, hoặc MCP tools)
title: "[bug] "
labels: bug
---

**Mô tả lỗi**
Chuyện gì xảy ra? Mong đợi là gì?

**Các bước tái hiện**
1. Chạy server: `node packages/server/dist/index.js ...` (hoặc `pnpm dev`), cờ dùng: `--port` / `--workspace` / `--export-dir`
2. ...
3. Lỗi xuất hiện khi ...

**DSL liên quan (nếu có)**
```
// dán nội dung .arch gây lỗi, hoặc lệnh set_diagram/get_diagram đã gọi
```

**Môi trường**
- OS:
- Node version (`node -v`):
- pnpm version (`pnpm -v`):
- Cách chạy: `node packages/server/dist/index.js` / `pnpm dev` / khác:
- Claude Code MCP đã đăng ký (`claude mcp list`)? có / không

**Log / screenshot**
Dán log console server, lỗi trình duyệt, hoặc ảnh chụp canvas nếu có.
