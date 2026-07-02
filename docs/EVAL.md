# EVAL — đo chất lượng DSL guide + bộ tool MCP

diagram-copilot có **hai** harness eval độc lập, đo hai thứ khác nhau. Cả hai
là tsx script chạy tay (không phải vitest suite trong CI) vì mỗi lần chạy tốn
token thật.

| | `packages/server/eval/run.ts` (T34 / DGC-55) | `packages/server/eval/run-live.ts` (v2 / DGC-75) |
|---|---|---|
| Đo gì | `DSL_GUIDE` text một mình có đủ để model viết arch-dsl hợp lệ **first-try, không có tool** không | Model + bộ tool MCP thật (`get_dsl_guide`, `list_icons`, `validate_dsl`, `get_diagram`, `set_diagram`, `undo_diagram`, ...) có hoàn thành yêu cầu **trên server thật** không |
| MCP server | KHÔNG chạm — `--strict-mcp-config` không server nào, `--disallowedTools` chặn hết tool | Chạm THẬT — server `diagram-copilot` thật spawn trên port tạm (mặc định `4950`), workspace tạm riêng mỗi scenario |
| Guide đưa vào | Nhét thẳng vào `--append-system-prompt` (spoon-fed) | KHÔNG nhét — model phải tự gọi `get_dsl_guide`/`list_icons` như một phiên thật (đây là chính điều v2 muốn đo) |
| Chấm điểm | `parseDsl` cục bộ trên text model trả về | Gọi `get_diagram`/`list_diagrams` thật qua MCP client SDK (`@modelcontextprotocol/sdk`) sau khi model chạy xong, rồi `parseDsl` trên DSL đọc được — "canvas state" thật, không phải text model tự xưng |
| Kết quả mới nhất | 5/6 (83%), baseline T34 | 10/10 (100%), 10/10 first-try — xem §4 |

Chạy từ `packages/server`:

```bash
# T34 — guide text only, không server
./node_modules/.bin/tsx eval/run.ts [run-name] [--limit N] [--model haiku] [--dry-run]

# v2 — live MCP tool calls, spawn server thật trên port tạm
./node_modules/.bin/tsx eval/run-live.ts [run-name] [--limit N] [--model haiku] [--port 4950] [--scenario <id>] [--dry-run]
```

Báo cáo Markdown ghi vào `eval/results/<run-name>.md` (đã có trong git — xem
`eval/results/t34-haiku.md` và `eval/results/v2-haiku.md`).

## 1. Vì sao có v2 (khoảng trống của T34)

T34 trả lời "guide text có đủ tốt để model tự viết DSL không", nhưng **không
bao giờ chạy MCP server thật** — nó `--strict-mcp-config` không server nào và
`--disallowedTools` chặn mọi tool, nên "5/6 pass" chỉ nói lên chất lượng text
`DSL_GUIDE`, không nói lên gì về:

- model có **tự phát hiện** ra `get_dsl_guide`/`list_icons` không (T34 nhét
  guide thẳng vào system prompt — không đại diện cho một phiên Claude Code
  thật, nơi guide chỉ là một tool có thể gọi hoặc không),
- vòng lặp tự-sửa `validate_dsl` → sửa lỗi `line X, col Y` → gọi lại có thật
  hoạt động không khi model tự lái, không phải khi harness ép một lần duy
  nhất,
- `set_diagram` có thật sự **ghi xuống workspace** đúng ý không (T34 không hề
  chạm workspace),
- `undo_diagram`, `list_diagrams`/`open_diagram` (điều hướng nhiều diagram) —
  các tool này T34 không test được vì không có server.

`run-live.ts` (v2) lấp khoảng trống đó: 10 scenario, mỗi scenario spawn một
server `diagram-copilot` **thật** (`src/index.ts`, cùng binary người dùng
chạy) trên workspace tạm riêng, cho `claude -p` chỉ thấy bộ tool MCP (không
guide nhét sẵn), rồi sau khi model chạy xong, harness **tự nối tới server
bằng chính MCP client SDK** và gọi `get_diagram`/`list_diagrams` để đọc lại
trạng thái đã áp dụng — đúng nghĩa "applied receipt / canvas state qua
get_diagram" chứ không phải suy diễn từ text model trả lời.

## 2. An toàn vận hành — không đụng server thật của Đô

Server dev thật của repo chạy cố định **port 4747**, workspace `examples/`
(xem `packages/server/src/index.ts`, `DEFAULT_PORT = 4747`). Harness v2:

- luôn spawn server riêng trên `--port` (mặc định **4950**), workspace là
  một temp dir `mkdtempSync` riêng cho **từng scenario** (`prepareWorkspace`
  trong `eval/live/harness.ts`) — không đụng `examples/`, không đụng workspace
  thật của Đô;
- `run-live.ts` **từ chối chạy nếu `--port 4747`** (chặn cứng ngay khi parse
  args);
- mỗi scenario: start server mới → chạy `claude -p` → chấm điểm → `server.stop()`
  (SIGTERM, force SIGKILL sau 2s nếu treo) → xoá temp workspace
  (`cleanupWorkspace`, `rmSync -rf`). Không có state rò rỉ giữa các scenario,
  không có process/port sót lại sau khi script thoát (đã verify thủ công:
  `lsof -ti tcp:4950` trống, `lsof -ti tcp:4747` vẫn là server thật của Đô,
  không đổi PID).

## 3. Chi tiết kỹ thuật đáng chú ý (đọc trước khi sửa harness)

- **`--setting-sources ""`**: bắt buộc. Không có nó, `claude -p` load
  hooks/skills/CLAUDE.md của user thật (máy chạy harness), model haiku bị
  buộc phải xử lý một khối `<EXTREMELY_IMPORTANT>` skill injection lớn từ
  `SessionStart` hook trước khi chạm tới prompt thật — nhiễu, tốn token, và
  không đại diện cho một phiên chấm điểm sạch.
- **`ToolSearch` phải nằm trong `--allowedTools`**: bản Claude Code đang chạy
  harness này defer schema của MCP tool phía sau `ToolSearch` (tool thật
  không "hiện" cho model tới khi nó gọi `ToolSearch` trước) — thiếu dòng này
  model không cách nào gọi được `mcp__diagram-copilot__*`. Xác nhận bằng
  test tay: bỏ `ToolSearch` → model kẹt, không gọi được tool nào.
- **`Skill`/`Agent` nằm trong `--disallowedTools`**: một lần smoke-test haiku
  tự ý gọi `Skill` (không được yêu cầu) trước khi vào việc — chặn lại cho
  harness deterministic, tools không liên quan tới việc sửa DSL.
- Chấm điểm bằng `@modelcontextprotocol/sdk`'s `Client` +
  `StreamableHTTPClientTransport` nối thẳng `http://127.0.0.1:<port>/mcp`
  **sau khi** `claude -p` đã thoát — độc lập với transcript của model, nên kể
  cả khi model tự nhận "đã lưu xong" sai sự thật, chấm điểm vẫn dựa trên state
  thật trên server (`eval/live/harness.ts#gradeWorkspace`).
- "first-try" (cột trong bảng kết quả) = **lệnh `set_diagram` ĐẦU TIÊN** model
  gọi có `isError` hay không — khác hẳn định nghĩa "first-try" của T34 (T34:
  model có sinh ra DSL hợp lệ ngay lần duy nhất, vì T34 không cho phép gọi
  lại). Ở v2, "pass" và "first-try" là hai trục **độc lập**: một scenario có
  thể pass sau vài lần `set_diagram` tự sửa lỗi (vẫn hợp lệ, vẫn đúng ý) mà
  "first-try" ghi "no" — đây là hành vi ĐÚNG của vòng lặp tự sửa mà
  `DSL_GUIDE` dạy, không phải lỗi.

## 4. Kết quả — v2, model `haiku`, 10/10 scenario (1 lần chạy, `eval/results/v2-haiku.md`)

Tổng chi phí: **$0.3178** (10 scenario, haiku — rẻ đúng như yêu cầu).

| # | scenario | category | pass | first-try | tools dùng | ghi chú |
|---|----------|----------|------|-----------|------------|---------|
| 1 | Create a diagram from scratch (EN) | create | PASS | yes | get_dsl_guide, list_icons, set_diagram | 3 node, 4 edge |
| 2 | Two-tier nested groups (EN) | create | PASS | yes | get_dsl_guide, set_diagram | nested group xác nhận đúng — 7 node, 2 group, 8 edge |
| 3 | Add a node into an existing group (EN, edit) — **(a)** | edit | PASS | yes | get_diagram, set_diagram | Cache thêm đúng vào trong group VPC, giữ nguyên node cũ |
| 4 | Validate-first workflow (EN, forced validate_dsl) — **(b)** | workflow | PASS | yes | get_dsl_guide, validate_dsl, set_diagram | validate_dsl được gọi TRƯỚC set_diagram đầu tiên |
| 5 | Vietnamese names with đ/Đ (VI) — **(c)** | unicode | PASS | yes | validate_dsl, set_diagram | giữ đúng "Đơn hàng" (đ/Đ nguyên vẹn) — 9 node |
| 6 | One-to-many fan-out edge (EN) — **(d)** | edges | PASS | yes | get_dsl_guide, set_diagram | Queue → cả 3 worker đều có edge |
| 7 | Undo after a wrong edit (EN, undo_diagram) — **(e)** | undo | PASS | yes | get_diagram, set_diagram, undo_diagram | xoá Database, gọi undo_diagram, Database quay lại đúng |
| 8 | Repair a broken existing diagram (self-correct) | self-correct | PASS | yes | get_diagram, validate_dsl, set_diagram | tương đương prompt 5 của T34 (T34 FAIL bản text-only) — v2 PASS nhờ vòng lặp validate_dsl thật |
| 9 | Look up an icon before using it (list_icons) | workflow | PASS | yes | list_icons, set_diagram | gọi list_icons trước, icon Database = "database" |
| 10 | List + open a non-active diagram, then edit it | workspace | PASS | yes | list_diagrams, get_diagram, set_diagram | xem §5 — model KHÔNG gọi open_diagram, dùng `set_diagram({name:"billing"})` thẳng |

**So với baseline T34 (5/6, 83%, text-only, một lần thử duy nhất): v2 đạt
10/10 (100%), 10/10 first-try.** Đây không phải vì 10 scenario của v2 "dễ
hơn" — scenario 8 chính là bài mà T34 **FAIL** (`line 6, col 19: Unexpected
'[icon: postgresql]'; expected a new line`). Khác biệt là T34 không cho model
sửa lại; v2 cho model đọc lỗi `validate_dsl`/`set_diagram` trả về
(`line X, col Y: message`) và tự sửa — đúng vòng lặp `WORKFLOW` mà
`DSL_GUIDE` dạy. Kết luận thật: **guide + tool loop hoạt động đúng thiết kế**
khi model được phép dùng chúng như một phiên thật; điểm số thấp hơn của T34
đo một tình huống khắt khe hơn thực tế (one-shot, không tool) — cả hai số đều
có ích, đo hai câu hỏi khác nhau, không nên gộp làm một.

Lưu ý: đây là **1 lần chạy** (n=1) mỗi scenario, giống cách T34 làm — haiku có
tính ngẫu nhiên, một run 10/10 không đảm bảo 10/10 mọi lần. Nếu nghi ngờ
regressions, chạy lại `--scenario <id>` cho riêng bài đó trước khi kết luận.

## 5. Ghi chú / đề xuất (không tự sửa guide — Master quyết)

Không có scenario nào FAIL trong lần chạy này, nên **không có đề xuất sửa
`DSL_GUIDE` bắt buộc**. Một quan sát đáng ghi lại (không phải lỗi, không cần
sửa gấp):

- **Scenario 10** yêu cầu model "open the one called 'billing' (not the
  active/default one)" — nhưng model hoàn thành đúng mục tiêu (đọc + sửa đúng
  diagram `billing`, giữ nguyên node cũ) **mà không gọi `open_diagram`**, vì
  cả `get_diagram`/`set_diagram` đều nhận `name` optional và có thể target
  thẳng một diagram không active (xem mô tả tool trong
  `packages/server/src/mcp/tools/diagram.ts`). Đây là một lối đi hợp lệ, hiệu
  quả hơn (ít round-trip hơn) — KHÔNG phải bug hay guide gap. Nếu Master
  muốn ép `open_diagram` phải được dùng (ví dụ để nó trở thành active trên
  canvas web cho người dùng thấy), có thể cân nhắc thêm một câu vào
  `DSL_GUIDE`/mô tả tool: *"Use open_diagram first when you also want the
  diagram to become active on the canvas — set_diagram's `name` alone
  updates the file but does not require it to have been opened."* Đây chỉ là
  gợi ý làm rõ, không phải fix cho lỗi thật.

## 6. File liên quan

- `packages/server/eval/prompts.ts`, `eval/run.ts` — T34, giữ nguyên không
  đổi (v2 không thay thế, hai harness bổ sung cho nhau, xem bảng ở đầu file).
- `packages/server/eval/live/scenarios.ts` — 10 scenario v2 (prompt + seed
  `.arch` + hàm `assert` chấm cấu trúc `DiagramDoc`, không chấm text thô).
- `packages/server/eval/live/harness.ts` — spawn/stop server thật, temp
  workspace, chạy `claude -p` + parse `stream-json` thành transcript tool
  call, chấm điểm qua MCP client SDK thật.
- `packages/server/eval/run-live.ts` — CLI driver, in bảng console + ghi
  `eval/results/<run-name>.md`.
- `packages/server/eval/results/v2-haiku.md` — báo cáo đầy đủ (prompt + note
  + cost từng scenario) của lần chạy trong §4.
