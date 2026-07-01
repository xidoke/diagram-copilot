# WORKFLOW — Vibe song song với master điều phối

- **Mục tiêu:** tốc độ lớn bằng cách chạy nhiều task đồng thời trong **git worktree** riêng biệt, với **Master** điều phối thông minh.
- **Đơn vị công việc:** 1 **task** = 1 work item Plane (DGC-N) = 1 worktree = 1 worker agent = ~30–90 phút. Nhỏ hơn "phiên" cũ.
- **"Phiên" trong roadmap giờ = integration checkpoint** (mốc gộp + demo), không còn là đơn vị tuần tự.

## 1. Vai trò

### Master (phiên Claude Code chính, Đô ngồi cùng)
1. **Chọn task READY** từ Plane: task có mọi `Deps:` đã Done, và **không đụng file** với task đang In Progress (xem `Files:` trong mô tả).
2. **Dispatch song song** worker agents — mỗi agent một worktree riêng, prompt = nội dung task + DoD + contracts liên quan.
3. **Review diff** từng worker trả về, chạy test, **merge về `main` theo thứ tự dependency** (rebase nếu cần).
4. **Cập nhật Plane** (state chuyển theo vòng đời bên dưới) + tick ROADMAP.md.
5. **Tự làm các task `[integration]`** — không giao cho worker (cần nhìn toàn cục + demo).

### Worker agent (1 task, 1 worktree)
- Chỉ sửa file trong phạm vi `Files:` của task. Cần đổi contract chung → DỪNG, báo Master.
- TDD cho code thuần (core/layout/server logic). Diff sạch, không refactor dạo.
- Trả về: tóm tắt thay đổi + file đã sửa + kết quả test + điều Master cần biết khi merge.

## 2. Quy ước Git
- Nhánh chính: `main`. Nhánh task: `task/DGC-<seq>-<slug>` (VD `task/DGC-23-langium-minimal`).
- Worktree do harness tạo (Agent isolation=worktree) hoặc `git worktree add .worktrees/DGC-<seq> -b task/...`.
- **Chỉ Master merge.** Worker không bao giờ tự merge/push.
- Commit message: `feat(core): ... (DGC-23)` — có mã task để trace về Plane.

## 3. Luật song song (chống conflict)
- **Contracts first:** T2 (model types + Zod + WS protocol) phải Done trước khi mở các lane. Contracts là file ĐÓNG BĂNG — đổi contract là việc của Master, tuần tự.
- **Lane theo package**, task khác lane = chạy song song an toàn:
  - `[core]` → `packages/core` · `[layout]` → `packages/layout` · `[server]`/`[mcp]` → `packages/server` · `[web]` → `packages/web` · `[assets]` → `packages/icons`
- Hai task cùng lane chỉ chạy song song khi `Files:` không giao nhau.
- `[integration]` task = barrier: đợi mọi deps merge xong, Master tự chạy, ra demo.

## 4. Vòng đời task trên Plane
`Backlog` → `Todo` (deps xong, sẵn sàng dispatch) → `In Progress` (worker đang chạy, ghi tên worktree vào comment) → `In Review` (diff về, Master đang review/test) → `Done` (đã merge main, test xanh).
- Task fail/blocked → comment lý do + về `Todo` hoặc tách task mới.

## 5. Nhịp một buổi vibe (với song song)
1. **Mở buổi:** Master đọc Plane (task Done/In Progress), chọn wave task READY (2–4 task khác lane).
2. **Dispatch wave** → các worker chạy song song trong worktree.
3. Trong lúc đợi: Master review diff wave trước / chuẩn bị integration / cập nhật docs.
4. **Merge theo thứ tự deps**, chạy test tổng, cập nhật Plane.
5. Đủ deps cho `[integration]` → Master chạy checkpoint, **demo nhìn thấy được**.
6. **Đóng buổi:** commit + tick ROADMAP + 3 dòng log vào vault `Research/diagram-copilot/output/log.md`.

## 5b. Vòng lặp chiến lược của Master (chạy khi worker đang bay — chống waterfall)

Thời gian chờ worker là thời gian suy nghĩ đắt nhất — KHÔNG ngồi đợi notification. Mỗi khoảng rỗi, Master chạy một lượt (chọn 1-2 mục, không cần đủ):

1. **Dogfood micro:** dùng thử sản phẩm ở trạng thái hiện tại 2 phút (mở canvas, sửa DSL, gọi tool MCP) → ghi khó chịu thật.
2. **Backlog grooming:** đọc lại task sắp tới — mô tả còn đúng sau những gì vừa học? Deps đổi? Task nào nên tách/gộp/hủy?
3. **Nghĩ nghiệp vụ:** quay về câu hỏi gốc "người học SD cần gì?" — tính năng nào đang thiếu trong roadmap mà usage thật vừa lộ ra? Đề xuất task mới (đưa Đô duyệt nếu đổi scope).
4. **Risk scan:** nợ kỹ thuật mới phát sinh từ báo cáo worker (bug tìm thấy, quyết định tạm) — cái nào cần thành task trước khi bị quên?
5. **Đồng bộ tri thức:** phát hiện đáng giá của worker → Plane comment vào task tương ứng hoặc vault; spec/ROADMAP lệch thực tế → sửa ngay.

Nguyên tắc: **plan là tài liệu sống** — mỗi wave xong, backlog phải tốt hơn wave trước. Thêm/sửa task nhỏ trong scope: Master tự quyết + ghi lại; đổi scope release: hỏi Đô.

## 6. Model tiering (tiết kiệm chi phí, không tiếc với task khó)

Master chọn model cho worker khi dispatch (tham số `model` của Agent). Nguyên tắc: **mechanical → Sonnet 5 · vừa → Opus 4.8 · khó/kiến trúc/tích hợp → Fable 5**. Đừng hạ tier cho task khó để tiết kiệm — sửa sai đắt hơn chạy đúng một lần.

| Tier | Task | Vì sao |
|---|---|---|
| **Fable 5** | T2 contracts · T6 Langium grammar · T15 ELK bend-points · T18 MCP skeleton · T21 state/echo · T24 get_snapshot · T8/T17/T25 integration (Master) | Quyết định kiến trúc, công nghệ mới dễ kẹt (Langium/MCP), hình học routing, chống echo-loop — sai ở đây lan xuống mọi thứ |
| **Opus 4.8** | T3 server WS · T7 ELK adapter (port spike) · T9/T10 grammar mở rộng · T13 group render · T20 get/set tools · T23 restart-safety | Logic thật nhưng có mẫu/spike/spec rõ để bám |
| **Sonnet 5** | T1 scaffold · T4 file watch · T5 web shell · T11 golden tests · T12 node styling (từ spike) · T14 icons · T16 spacing · T19 guide/icons tools · T22 workspace tools | Mechanical, đường mòn quen, DoD đo được rõ |

- Worker kẹt/lệch hướng ở tier thấp → Master **thăng tier ngay** (dispatch lại bằng Fable), không cố nhồi.
- Master (điều phối, review diff, merge, integration) chạy model của phiên chính.

## 7. Định dạng task trên Plane (bắt buộc trong mô tả)
- `Lane:` [core|layout|server|mcp|web|assets|integration]
- `Files:` phạm vi file được sửa
- `Deps:` các T# phải Done trước
- `Branch:` task/DGC-<seq>-<slug>
- `DoD:` điều kiện nghiệm thu đo được (test/hành vi nhìn thấy)

## 8. Bản đồ task hiện tại (v0.1 → v0.3, chi tiết trong Plane)

```
T1 scaffold ──► T2 contracts ──┬─► T3 server WS ──► T4 workspace watch ──┐
                               ├─► T5 web shell ─────────────────────────┤
                               ├─► T6 grammar min ───────────────────────┼─► T8 [integration] DEMO v0.1
                               └─► T7 elk adapter ───────────────────────┘
T6 ──► T9 grammar groups ──┬─► T11 golden tests ─┐
T6 ──► T10 comment/VN/lỗi ─┘                     │
T5 ──► T12 node theme B ──► T13 group render ──► T15 elk edges ─┼─► T17 [integration] DEMO v0.2
T1 ──► T14 icons (độc lập, làm bất cứ lúc nào)  T13 ──► T16 spacing ─┘
T3 ──► T18 /mcp skeleton ──┬─► T19 guide+icons tools ─┐
T10 ─────────────► T20 get/set_diagram ──► T21 state/echo ──► T23 restart-safety ─┼─► T25 [integration] DEMO v0.3 ⭐
T4 ──► T22 list/open tools ─┘              T21+T15 ──► T24 get_snapshot ─┘
```

Ví dụ wave song song ngay sau T2: **T3 + T5 + T6 + T7 + T14** (5 worker cùng lúc, 5 lane khác nhau).
