# CLAUDE.md — diagram-copilot

Đọc theo thứ tự khi mở phiên: file này → `docs/WORKFLOW.md` (mô hình Master + worker song song, format task, model tiering) → `docs/PO-PLAYBOOK.md` (Claude là PO — quy trình tự quyết product, Đô là user) → `docs/ROADMAP.md` (release hiện tại) → 10 dòng đầu `CHANGELOG.md` (vừa ship gì). Kiến trúc + dev setup: `README.md`.

## Lệnh chuẩn

- Build: `pnpm build` (bắt buộc trước khi chạy `dist/`) · Test: `pnpm test` · Dev: `pnpm dev` (server :4747 + web :4700, tsx watch)
- Merge xong một wave: chạy `pnpm build && pnpm test` toàn workspace trước khi Done bất kỳ task nào.

## Task intake — Plane project DGC

- Backlog sống trên Plane local (web `http://localhost:3003/xidoke`), vòng đời + format task theo `docs/WORKFLOW.md` §4/§7. State là UUID (`list_states` đầu phiên); description/comment là HTML.
- **Quét dogfood intake mỗi đầu phiên và mỗi wave**: item từ dự án Chợ Phiên (`~/cho-phien` dùng tool này làm bảng kiến trúc). Nhận diện: description có mục "Repro" + ghi "dogfood Chợ Phiên". Ưu tiên trên task thường vì nó đang chặn user thật. Repro chứa tool call + output nguyên văn — đủ để làm; thiếu gì comment hỏi trên item, KHÔNG đoán.

## Chế độ tự hành (khi Đô không ngồi cùng)

Được tự quyết, không cần hỏi:
- Chọn task READY (Deps xong, Files không giao với task In Progress), dispatch worker theo lane + model tiering.
- Sửa mô tả task lỗi thời khi grooming (comment lý do), tách task quá to, tạo task mới cho bug phát hiện trong lúc làm.
- Merge về `main` khi diff đã review + `pnpm build && pnpm test` xanh; chuyển state tới **Done** sau merge (khác dự án Chợ Phiên — repo này Done không cần user verify).
- Tick ROADMAP.md, cập nhật CHANGELOG (Unreleased), ghi 3 dòng log vào vault `Research/diagram-copilot/output/log.md` cuối phiên.

Phải dừng và chờ Đô:
- Đổi contract chung (model/Zod/WS protocol) hoặc scope release — viết đề xuất vào Plane comment rồi dừng lane đó.
- `git push` — commit local thoải mái, KHÔNG push GitHub (CI chạy public).
- Xóa task / Cancelled.

## Server đang được session khác dùng

Đầu phiên PHẢI biết `SERVER_IN_USE` (Đô khai trong prompt khởi động, mặc định coi là `yes`):
- `yes` → server :4747 là dependency sống của session Chợ Phiên: KHÔNG restart/kill; chỉ build + unit test; thay đổi cần restart mới thấy → comment "cần restart" vào item.
- `no` → thoải mái restart (`pnpm dev` tự watch), test E2E qua canvas.

## Ngôn ngữ

Docs/comment Plane: tiếng Việt, giữ code identifier EN. Code + commit message: EN, Conventional Commits kèm mã task — `feat(core): ... (DGC-N)`.
