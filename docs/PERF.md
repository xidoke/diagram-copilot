# Layout perf — ngân sách & số đo (T-PERF/DGC-76)

Nguồn sự thật của tài liệu này:
- `packages/layout/test/perf.test.ts` — test đo thật (`console.log` số ms mỗi lần CI chạy, không chỉ pass/fail).
- `packages/core/fixtures/microservices.arch` — fixture stress ~60 node, viết tay (không sinh runtime).
- `packages/layout/src/layout.ts` — nơi `elkjs` (`layered` algorithm) chạy.

## 1. Số đo máy local (M1 Pro)

Máy: **Apple M1 Pro** (arm64), macOS 26.5.1, Node v22.21.0. Đo bằng
`performance.now()`, median của 3 lần chạy liên tiếp trong cùng tiến trình
vitest (không cold-start riêng từng lần) — xem hàm `medianMs`/`medianMsAsync`
trong `perf.test.ts`. Ba lần đo độc lập (chạy lại toàn bộ suite 3 lần) cho
kết quả ổn định, dao động dưới ~5%:

| Fixture | Node | Group | Edge | `parseDsl` (median) | `layoutDiagram` (median) |
| --- | --- | --- | --- | --- | --- |
| `microservices.arch` | 60 | 12 (3 cấp lồng) | 92 | ~7.1–8.0ms | ~186–194ms |
| `news-feed.arch` (baseline nhỏ) | 12 | 3 | 11 | ~0.6–0.7ms | ~13.6–14.9ms |

Ghi chú: `layoutDiagram` chạy trong Node (vitest), KHÔNG có chi phí React
Flow render/DOM — số này là thuần chi phí elkjs. Số đo browser thật (render
+ layout) sẽ cao hơn nhưng cùng bậc độ lớn ở quy mô này (xem mục 3).

## 2. Ngân sách (budget) đặt ra trong `perf.test.ts`

| Fixture | Budget parse | Budget layout | Số đo thật (median) | Margin |
| --- | --- | --- | --- | --- |
| `microservices.arch` (~60 node) | 300ms | 1500ms | ~8ms / ~190ms | ~37x / ~8x |
| `news-feed.arch` (baseline nhỏ) | 100ms | 500ms | ~0.6ms / ~14ms | ~150x / ~35x |

Budget cố tình rộng hơn số đo thật khá nhiều (không phải ngưỡng "vừa đủ
pass") vì hai lý do: (1) CI runner thường chậm hơn máy Apple Silicon local
2–3 lần, (2) mục tiêu của test này là **bắt regression thật sự** (ví dụ một
đổi grammar/layout options vô tình làm chậm gấp 5-10 lần), không phải khóa
số đo hiện tại chính xác đến ms. `microservicesLayout: 1500ms` vẫn là ngân
sách "cứng" theo yêu cầu gốc của T-PERF/DGC-76 (< 1500ms cho ~60 node).

## 3. ELK chạy main-thread — 60 node vẫn ổn

`packages/layout/src/layout.ts` khởi tạo `new ElkConstructor()` (từ
`elkjs/lib/elk.bundled.js`) **không** truyền `workerFactory` — nghĩa là
thuật toán layout chạy đồng bộ trên main thread của tab trình duyệt (hoặc
tiến trình Node khi test), không có Web Worker nào tách riêng ở bước này.

Số tham chiếu từ spike v0.0 (`docs/ROADMAP.md`: *"Nested VPC render đẹp
trong 60ms"*) là cho **8 node** (`packages/layout/test/index.test.ts`'s
`fixtureDoc` — client/cdn/alb/api/worker/redis/postgres/queue), đo trong
browser bao gồm cả React Flow render, không chỉ elkjs. Số đo thật ở đây
(fixture 60-node mới, thuần elkjs trong Node) là ~190ms cho layout — tăng
~7.5x số node nhưng thời gian tăng ít hơn tuyến tính so với 60ms×7.5=450ms
gợi ý bởi con số spike, vì elkjs's `layered` algorithm không scale tuyến
tính đơn giản theo node count (phụ thuộc nhiều vào edge count, độ sâu lồng
group, và bend-point routing). Ở quy mô 60 node / 12 group / 92 edge,
main-thread vẫn ổn: 190ms là dưới một khung hình ở 5fps và không đủ để
người dùng cảm nhận "đứng hình" UI đáng kể (đặc biệt vì layout chỉ chạy lại
khi doc đổi, không chạy mỗi frame).

## 4. Khuyến nghị ngưỡng cảnh báo tương lai

Chưa cần Web Worker ở quy mô hiện tại (~60 node). Đề xuất ngưỡng để revisit:

- **> 150 node**: cân nhắc chuyển `layoutDiagram` sang Web Worker
  (`elkjs` hỗ trợ `workerFactory` sẵn, không cần đổi thuật toán) để main
  thread không bị block trong lúc user vẫn tương tác được với canvas
  (pan/zoom trên graph cũ trong lúc graph mới đang layout).
- **layout > 500ms đo được trên CI** (không phải máy local): coi là dấu
  hiệu sớm để bắt đầu đo thêm ở quy mô 100-150 node trước khi build worker,
  vì 500ms là ngưỡng người dùng bắt đầu cảm nhận độ trễ rõ rệt (Nielsen
  Norman Group's 1-second "flow" threshold, trừ hao margin cho phần
  render/commit sau layout).
- Khi thêm worker: giữ nguyên `layoutDiagram`'s API (`Promise<PositionedGraph>`
  đã là async sẵn — xem `packages/layout/src/index.ts`), chỉ đổi
  implementation bên trong `getElk()` (`packages/layout/src/layout.ts`) để
  truyền `workerFactory`; không cần đổi call site nào ở `packages/web`.

## 5. Chạy lại số đo

```
pnpm --filter @diagram-copilot/layout test -- perf.test.ts
```

Mỗi lần chạy in ra 4 dòng `[perf] …` (parse + layout, cho cả hai fixture)
kèm budget đang áp — copy số đó vào bảng ở mục 1 nếu cần cập nhật tài liệu
này sau một thay đổi lớn về layout options hoặc kích thước fixture.
