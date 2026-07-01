# arch-dsl guide eval — t34-haiku

- date: 2026-07-01T23:33:29.744Z
- model: `haiku` (first-try, no self-correction loop)
- prompts: 6
- **pass rate: 5/6 (83%)**

| # | prompt | first-try | error |
|---|--------|-----------|-------|
| 1 | URL shortener (EN, from scratch) | PASS | — |
| 2 | Add a cache to an existing diagram (VI, edit) | PASS | — |
| 3 | Ticket booking, Vietnamese node names (VI) | PASS | — |
| 4 | News feed with a nested VPC group (EN, nesting) | PASS | — |
| 5 | Repair a broken diagram (mixed, self-correct) | FAIL | line 6, col 19: Unexpected '[icon: postgresql]'; expected a new line. |
| 6 | Fan-out queue to workers (EN, one-to-many) | PASS | — |

## Details

### 1. URL shortener (EN, from scratch) — PASS
_5 nodes · 4 edges · 1 groups_

prompt:

```
Draw an architecture diagram for a URL shortener service. Include a client, an API gateway, a shortener service, a Redis cache for hot lookups, and a database that stores the url mappings. Show the request flow with labelled edges. Use icons and colours where they help.
```

model output (parsed):

```
direction right

Client [icon: monitor, color: blue]

API Gateway [icon: server, color: orange]

Shortener Service [icon: server, color: orange]

Data Layer [color: gray] {
  Redis [icon: redis, color: red]
  Database [icon: database, color: blue]
}

Client > API Gateway: HTTP requests
API Gateway > Shortener Service: routes
Shortener Service > Redis: cache lookup/store
Shortener Service > Database: fetch/persist mappings
```

### 2. Add a cache to an existing diagram (VI, edit) — PASS
_4 nodes · 4 edges · 0 groups_

prompt:

```
Đây là diagram hiện tại của tôi:

direction right
Client [icon: browser]
API [icon: server]
Database [icon: postgresql]
Client > API: HTTPS
API > Database: query

Hãy thêm một Redis cache theo kiểu cache-aside nằm giữa API và Database: API đọc cache trước, nếu miss thì đọc Database rồi ghi lại cache. Trả về TOÀN BỘ DSL đã cập nhật (không chỉ phần thêm).
```

model output (parsed):

```
direction right

Client [icon: browser]
API [icon: server]
Cache [icon: redis]
Database [icon: postgresql]

Client > API: HTTPS
API > Cache: check first
API > Database: on miss
API > Cache: write back
```

### 3. Ticket booking, Vietnamese node names (VI) — PASS
_6 nodes · 6 edges · 0 groups_

prompt:

```
Vẽ sơ đồ kiến trúc cho hệ thống đặt vé xem phim. Dùng TÊN NODE TIẾNG VIỆT: Người dùng, Cổng API, Dịch vụ đặt vé, Cổng thanh toán, Hàng đợi thông báo, Cơ sở dữ liệu. Nối các node theo luồng đặt vé và ghi nhãn cạnh bằng tiếng Việt. Thêm icon phù hợp cho database và hàng đợi.
```

model output (parsed):

```
direction right

Người dùng [icon: monitor, color: blue]

Cổng API [icon: server, color: orange]

Dịch vụ đặt vé [icon: server, color: orange]

Cổng thanh toán [icon: credit-card, color: green]

Hàng đợi thông báo [icon: queue, color: teal]

Cơ sở dữ liệu [icon: postgresql, color: gray]

Người dùng > Cổng API: gửi yêu cầu

Cổng API > Dịch vụ đặt vé: xác thực & chuyển tiếp

Dịch vụ đặt vé > Cổng thanh toán: xử lý thanh toán

Dịch vụ đặt vé > Cơ sở dữ liệu: lưu đặt vé

Dịch vụ đặt vé > Hàng đợi thông báo: gửi sự kiện

Hàng đợi thông báo > Người dùng: gửi thông báo
```

### 4. News feed with a nested VPC group (EN, nesting) — PASS
_5 nodes · 4 edges · 2 groups_

prompt:

```
Design a news feed backend. Put the internal services inside a VPC group, and INSIDE that VPC nest a second group called 'Data Layer' that holds the database and a cache. Outside the VPC put the mobile client and a CDN. The client talks to an API inside the VPC (an edge that crosses the VPC boundary). Use colours to distinguish the groups.
```

model output (parsed):

```
direction right

Mobile Client [icon: mobile, color: blue]
CDN [icon: cdn, color: orange]

VPC [color: gray] {
  API [icon: server, color: purple]
  
  Data Layer [color: teal] {
    Database [icon: postgresql]
    Cache [icon: redis]
  }
  
  API > Database: reads/writes
  API > Cache: cache-aside
}

Mobile Client > API: API requests
Mobile Client > CDN: fetch assets
```

### 5. Repair a broken diagram (mixed, self-correct) — FAIL
**error:** line 6, col 19: Unexpected '[icon: postgresql]'; expected a new line.

prompt:

```
This arch-dsl fails to parse. Fix every syntax error and return the corrected, VALID DSL only — keep the same intent (a payment flow with Vietnamese user, gateway, auth, orders and a database):

direction downward
Người dùng
Người dùng > API Gateway
API Gateway [type: rest]
API Gateway > Auth, Orders
Orders > Database [icon = postgres]
```

model output (raw):

```
direction downward
Người dùng
Người dùng > API Gateway
API Gateway [icon: server]
API Gateway > Auth, Orders
Orders > Database [icon: postgresql]
```

### 6. Fan-out queue to workers (EN, one-to-many) — PASS
_6 nodes · 7 edges · 0 groups_

prompt:

```
Draw a diagram where an ingestion service publishes jobs to a message queue, and the queue fans out to three workers (Worker A, Worker B, Worker C) that each write results to a shared results store. Use a single one-to-many edge from the queue to the three workers.
```

model output (parsed):

```
direction right

Ingestion Service [icon: server]
Message Queue [icon: queue, color: orange]
Worker A [icon: server]
Worker B [icon: server]
Worker C [icon: server]
Results Store [icon: database, color: teal]

Ingestion Service > Message Queue: publishes jobs
Message Queue > Worker A, Worker B, Worker C: distributes
Worker A > Results Store: writes
Worker B > Results Store: writes
Worker C > Results Store: writes
```
