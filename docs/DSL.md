# arch-dsl — cú pháp diagram DSL

Nguồn sự thật của tài liệu này:
- `packages/server/src/mcp/tools/guide.ts` (`DSL_GUIDE` — cùng nội dung trả về bởi MCP tool `get_dsl_guide`, Claude Code đọc trực tiếp).
- `packages/core/src/dsl/parse.ts` (semantics mapping thật — id/label, comment-wins, implicit node...).
- `packages/core/src/dsl/arch-dsl.langium` (grammar).
- `packages/core/fixtures/*.arch` (fixture thật, có snapshot test ở `packages/core/test/golden.test.ts`).
- `packages/web/src/render/colors.ts` (bảng màu) và `packages/icons/src/aliases.ts` (alias icon).

Nếu bạn đang ngồi trong một phiên Claude Code, gọi tool `get_dsl_guide` — nó trả về bản rút gọn (không có bảng ví dụ dài) cùng nguồn với file này.

## 1. Quy tắc chung

- Một statement mỗi dòng.
- Khoảng trắng bên trong một tên bị gộp về một dấu cách; dòng trắng đầu/cuối và thụt lề bị bỏ qua.
- Id của node/group phân biệt hoa-thường, hỗ trợ Unicode đầy đủ (tên tiếng Việt hoạt động bình thường — xem `rate-limiter.arch` dùng `Người dùng`).

## 2. Workflow sửa một diagram đang có

1. Gọi `get_diagram` trước để đọc DSL hiện tại — không bao giờ sửa "mù".
2. Sửa text, rồi gọi `set_diagram` với **toàn bộ** document (whole-file write, không phải patch — nó ghi đè tất cả).
3. `set_diagram` validate trước khi ghi: nếu lỗi, không có gì được lưu và mỗi lỗi trả về dạng `"line X, col Y: message"` — sửa đúng dòng/cột đó rồi gọi lại `set_diagram` đến khi qua. (Diagram hoàn toàn mới có thể bỏ qua bước 1, gọi thẳng `set_diagram`.)

## 3. Direction (tùy chọn, một dòng)

```
direction right   // hoặc: left, up, down
```
Mặc định `right`. Nếu khai báo nhiều lần, dòng cuối cùng thắng (`last statement wins`).

## 4. Node — khai báo trần

Một tên trần (không có `>`) khai báo một node. Tên nhiều từ và tên Unicode đều hợp lệ.

```
Server
Load Balancer
Người dùng
```

## 5. Attribute — `[key: value, key: value]`

Đặt ngay sau tên, chỉ chấp nhận đúng 3 khóa: `icon`, `color`, `label`. Khóa khác là lỗi parse. Giá trị không được chứa dấu phẩy (dấu phẩy tách các cặp `key:value`).

```
API [icon: server, color: orange, label: API Gateway]
```

- **`icon`** — id/alias icon (gọi `list_icons` để tra id hợp lệ). Id không xác định **không bao giờ lỗi** — nó chỉ render thành box generic (fallback).
- **`color`** — một trong các token màu ở mục 8. Chuỗi lạ **âm thầm** rơi về accent màu mặc định của theme, không lỗi.
- **`label`** — ghi đè text hiển thị; id/tên vẫn giữ nguyên như đã viết (xem mục 9 "id vs label").

## 6. Group — `{ ... }`

`{ ... }` lồng các statement bên trong một container có tên. Group nhận cùng bộ attribute `[icon:, color:, label:]` như node, đặt trước dấu `{`.

```
VPC [color: gray] {
  API [icon: server]
  Database [icon: postgresql]
}
```

Group lồng sâu tùy ý, và có thể là điểm đầu/cuối của edge (xem `news-feed.arch`: group `VPC` chứa hai group con `Feed service` / `Data stores` cộng một node `Kafka Queue` khai báo trực tiếp trong group ngoài).

## 7. Edge — `Source > Target`

```
API > Database: reads/writes
```
`: label` tùy chọn, chạy đến hết dòng (label có thể chứa dấu `:` khác, ví dụ `ratio 2:1`). Tham chiếu một tên chưa từng khai báo sẽ **tự động tạo node trần** (implicit node — xem mục 9).

### One-to-many (fan-out)

```
Gateway > Auth, Users, Billing: routes to
```
`Source > A, B, C` tách thành một edge riêng cho mỗi target (theo đúng thứ tự viết, `e1..eN`); `: label` cuối dòng (nếu có) áp dụng cho **tất cả** các edge đó.

## 8. Comment — `//`

```
// internal services
Cache [icon: redis] // cache-aside, 60s TTL
```
`//` đến hết dòng, đứng riêng một dòng hoặc theo sau một statement. Một dấu `/` đơn lẻ trong tên/label vẫn hợp lệ (`read/write`, `TCP/IP`) — chỉ `//` mới bắt đầu comment. Nên dùng comment để ghi lại lý do thiết kế (tại sao có queue, TTL/failover nào).

**Comment thắng label** (comment-wins): `A > B: cache // hot` cho ra label `"cache"` — mọi thứ từ `//` trở đi bị cắt bỏ, kể cả khi nó nằm trong phần label. Lý do kỹ thuật (từ `parse.ts`): edge label lex "tham lam" (greedy `:`) có thể nuốt luôn một `//…` theo sau; mapper cắt label tại `//` đầu tiên trước khi dùng.

## 9. Semantics quan trọng (từ `packages/core/src/dsl/parse.ts`)

- **id vs label:** id/label mặc định của một node/group là chính cái tên đã viết (đã gộp khoảng trắng, trim, giữ nguyên Unicode — không Unicode-normalize). `label:` chỉ ghi đè **text hiển thị**, id dùng để tham chiếu (trong edge, trong group) không bao giờ đổi.
- **Node ngầm định (implicit node):** một edge tham chiếu một tên chưa khai báo ở đâu khác sẽ tự tạo node đó — không group, không icon/màu — ngay lần xuất hiện đầu tiên. `API > Queue, Worker` mà chưa từng khai `Queue`/`Worker` ở đâu sẽ tạo cả hai như node trần.
- **Khai báo tường minh thắng (explicit wins):** nếu một node được tạo ngầm định qua edge trước, rồi sau đó được khai báo tường minh trong một group (có/không attribute), nó "thăng cấp" nhận group + attribute đó. Tham chiếu ngầm định qua edge **không bao giờ** sửa một node đã tồn tại. Khai báo lại bên trong group khác → lần khai báo sau cùng thắng về group membership.
- **Merge khi khai báo lại:** khai báo lại cùng một tên (node đã tồn tại) merge attribute mới vào node đó, không tạo bản sao.
- **Thứ tự:** node xuất hiện theo đúng thứ tự lần đầu xuất hiện trong nguồn (duyệt depth-first); id của edge là vị trí (`e1`, `e2`, …) theo thứ tự viết.
- **Group tham chiếu trong edge:** một endpoint trùng tên với group đã biết được giữ nguyên là group (không auto-tạo node); nếu không khớp group nào, nó auto-tạo node trần như trên.
- **Edge label rỗng bị bỏ:** label sau khi trim rỗng thì bị lược khỏi edge (không lưu chuỗi rỗng).

## 10. Bảng màu (token hợp lệ)

Nguồn: `packages/web/src/render/colors.ts`. Token lạ rơi về accent mặc định của theme (`var(--accent)`), không lỗi.

| Token | Hex |
|---|---|
| `blue` | `#336fe0` |
| `orange` | `#ff9900` |
| `green` | `#28c840` |
| `red` | `#ff6b6b` |
| `purple` | `#8a63d2` |
| `pink` | `#d64ea3` |
| `yellow` | `#ffb454` |
| `teal` | `#61dafb` |
| `gray` | `#7f92c0` |

## 11. Icon — alias phổ biến

Registry đầy đủ (~38 icon, `lucide-static` ISC + `simple-icons` CC0-1.0, xem `packages/icons/ATTRIBUTION.md`): gọi `list_icons` (tùy chọn `query` để lọc theo id/title). Bảng dưới là các alias hay dùng nhất, từ `packages/icons/src/aliases.ts` — alias là stand-in "khái niệm chung" khi chưa có icon chuyên biệt.

| Alias | Trỏ tới id thật | Ghi chú |
|---|---|---|
| `postgres`, `pg` | `postgresql` | |
| `k8s` | `kubernetes` | |
| `kafka` | `apachekafka` | |
| `node`, `nodejs` | `nodedotjs` | |
| `git`, `vcs` | `github` | |
| `ci`, `ci-cd`, `cicd` | `githubactions` | |
| `mq` | `rabbitmq` | |
| `es` | `elasticsearch` | |
| `cache` | `redis` | |
| `payment`, `payments` | `stripe` | |
| `frontend` | `react` | |
| `db` | `database` | |
| `lb`, `load-balancer` | `network` | chưa có icon LB chuyên biệt, mượn `network` |
| `client`, `desktop` | `monitor` | client generic |
| `cdn` | `cloud` | |
| `queue` | `list` | chưa có icon queue chuyên biệt |
| `auth` | `lock` | |
| `security` | `shield` | |
| `notification`, `notifications` | `bell` | |
| `mobile` | `smartphone` | |

Một id không nằm trong registry và không khớp alias nào **vẫn render được** — nó rơi về box generic (fallback), không bao giờ làm hỏng parse/set_diagram.

## 12. Ví dụ đầy đủ (từ `get_dsl_guide`)

Direction, group lồng hai tầng, icon, màu, one-to-many, comment, và một edge băng qua biên group:

```
direction right

Client [icon: monitor, color: blue]

VPC [color: gray] {              // outer group
  API [icon: server, color: orange]
  Data Layer [color: teal] {     // group nested inside VPC (tier 2)
    Database [icon: postgresql]
    Cache [icon: redis]          // cache-aside, 60s TTL
  }

  API > Database: reads/writes
  API > Cache: cache-aside
}

Client > API: HTTPS              // edge crosses the VPC boundary
API > Queue, Worker: publishes   // fan-out to two implicit nodes
```

## 13. Fixture thật (golden, có snapshot test)

Ba fixture dưới nằm ở `packages/core/fixtures/`, được test bởi `packages/core/test/golden.test.ts` (parse + structural assertions) và dùng để QA visual của renderer. Chi tiết đầy đủ ở `packages/core/fixtures/README.md`.

| Fixture | Kịch bản | Exercise |
|---|---|---|
| `url-shortener.arch` | Client → LB → 2 API server instance dùng chung Redis + Postgres + queue analytics | one-to-many fan-out (`LB > API Server A, API Server B`), 2 group phẳng, 5 icon (`monitor`, `network`, `server`, `redis`, `postgresql`, `list`) |
| `news-feed.arch` | CDN + LB trước một `VPC` chứa 2 group con (`Feed service`, `Data stores`) cộng một Kafka queue dùng chung | group lồng 2 tầng, node khai trực tiếp trong group ngoài cạnh 2 subgroup, icon `apachekafka`/`hard-drive`/`elasticsearch` |
| `rate-limiter.arch` | `Người dùng` → `Gateway` → `Rate Limiter` kiểm token-bucket trong `Rules Cache` (Redis) → `API Backend` | tên node tiếng Việt + label edge tiếng Việt xuyên suốt, 2 group phẳng (`Edge`, `Backend`) |

Ví dụ trích từ `url-shortener.arch` (one-to-many fan-out xuyên group):

```
Service tier {
  LB [icon: network, color: blue]
  API Server A [icon: server, color: orange]
  API Server B [icon: server, color: orange]
}

LB > API Server A, API Server B: round robin
```
