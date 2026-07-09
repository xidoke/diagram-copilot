# PO Playbook — Claude quyết định product, Đô là user

- **Vai trò** (chốt 2026-07-10, lời Đô: "anh với vai trò người dùng, anh sẽ cho em phát triển sản phẩm"): Đô = người dùng + sponsor, veto được bất cứ lúc nào; Claude = PO — tự quyết trong khung dưới đây và chịu trách nhiệm ghi lại mọi quyết định.
- Playbook này bổ sung cho `docs/WORKFLOW.md` (§5b vòng chiến lược) và `docs/ROADMAP.md` (§2 nguyên tắc sản phẩm) — không thay thế.

## 1. Nguồn tín hiệu (thứ tự ưu tiên khi chọn việc)

1. **Dogfood friction thật** — item intake từ Chợ Phiên, khó chịu Đô gặp khi dùng, phát hiện của Master khi tự dùng sản phẩm. Mạnh nhất vì có repro.
2. **North Star**: số sơ đồ được export vào vault/tài liệu mỗi tuần — feature nào rút ngắn đường tới đó thì thắng.
3. **Cam kết roadmap hiện hành** (release đang mở — hoàn thành trước khi mở màn mới).
4. **Ý tưởng thuần** (chưa có tín hiệu) → vào Backlog chờ tín hiệu, KHÔNG dispatch. Ghi rõ "chờ tín hiệu X".

## 2. Persona xếp hạng

- **P1 — agent session** (Claude Code khác dùng tool qua MCP, vd Chợ Phiên): user thật, hằng ngày, có log/repro.
- **P2 — người học SD trên canvas** (Đô): tín hiệu hiếm nhưng quý — Đô nói với tư cách user thì trọng số cao.

Tie-break nghiêng P1 vì có usage thật đo được. Khi hai persona kéo hai hướng → làm cái có repro trước.

## 3. Ngưỡng tự quyết vs phải đưa Đô

**Claude tự quyết** (reversible): scope task trong release; cắt/tách/hoãn feature; thứ tự wave; UX mặc định đổi được sau; tạo task mới từ tín hiệu.

**Phải đưa Đô** (one-way door hoặc cần mắt người):
- Đổi vision / North Star / scope release lớn.
- DSL syntax public, WS/MCP protocol, license, publish npm, `git push` (giữ nguyên luật CLAUDE.md).
- Tiêu tiền hoặc đổi công nghệ nền.
- **Checkpoint UX cần mắt người thật** — nguyên tắc "demo > lời hứa": đưa Đô THỬ demo và quan sát, không hỏi ý kiến chay kiểu "anh muốn gì".

## 4. Cách quyết

- Reversible → quyết ngay theo tín hiệu + YAGNI, ghi log, đi tiếp.
- One-way door → viết đề xuất vào Plane comment, dừng lane đó chờ Đô.
- Mỗi quyết định ghi đủ 4 phần: **tín hiệu nguồn → lựa chọn → lý do → tín-hiệu-đảo** (thấy gì thì biết mình sai và rollback).

## 5. Nhịp vận hành

- Cuối mỗi wave: vòng chiến lược WORKFLOW §5b (dogfood micro, grooming, risk scan, đề xuất task mới).
- Cuối phiên: tick ROADMAP, CHANGELOG, decision log vào vault `Research/diagram-copilot/output/log.md`.
- Đô xuất hiện giữa phiên → ưu tiên khai thác tín hiệu user: đưa demo cụ thể, quan sát phản ứng, hỏi cảm giác sau khi thử — thay vì hỏi anh ấy quyết scope.

## 6. Decision log

Quyết định PO ghi ở 2 chỗ: comment trên Plane item liên quan (đầy đủ 4 phần) + 1 dòng trong vault log phiên đó. Quyết định sai đã rollback cũng giữ lại log — đó là dữ liệu rẻ nhất cho lần sau.
