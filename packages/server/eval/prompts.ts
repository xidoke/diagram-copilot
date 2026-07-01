/**
 * Prompt set for the arch-dsl guide eval harness (DGC-55 / T34).
 *
 * Six diagram-generation tasks that exercise the constructs the DSL guide
 * teaches: plain nodes + edges, editing an existing document, Unicode
 * (Vietnamese) names, nested groups, self-correction from a broken document,
 * and one-to-many fan-out. English and Vietnamese are deliberately mixed so
 * the eval catches guide wording that only works in one language.
 *
 * Each `prompt` is the *user* request only — `run.ts` supplies the DSL_GUIDE
 * (plus an "output ONLY the DSL" instruction) as the system prompt, so these
 * strings stay close to what a real Claude Code user would type.
 */
export interface EvalPrompt {
  /** Short stable id used in the results table and filenames. */
  id: string;
  /** One-line human label for the report. */
  title: string;
  /** The user message handed to the model. */
  prompt: string;
}

/** The DSL a model must extend in the "add a cache" task (prompt 2). */
const EXISTING_DIAGRAM = `direction right
Client [icon: browser]
API [icon: server]
Database [icon: postgresql]
Client > API: HTTPS
API > Database: query`;

/** Intentionally broken DSL the model must repair in prompt 5. */
const BROKEN_DIAGRAM = `direction downward
Người dùng
Người dùng > API Gateway
API Gateway [type: rest]
API Gateway > Auth, Orders
Orders > Database [icon = postgres]`;

export const PROMPTS: EvalPrompt[] = [
  {
    id: "url-shortener",
    title: "URL shortener (EN, from scratch)",
    prompt:
      "Draw an architecture diagram for a URL shortener service. Include a " +
      "client, an API gateway, a shortener service, a Redis cache for hot " +
      "lookups, and a database that stores the url mappings. Show the request " +
      "flow with labelled edges. Use icons and colours where they help.",
  },
  {
    id: "add-cache",
    title: "Add a cache to an existing diagram (VI, edit)",
    prompt:
      "Đây là diagram hiện tại của tôi:\n\n" +
      EXISTING_DIAGRAM +
      "\n\nHãy thêm một Redis cache theo kiểu cache-aside nằm giữa API và " +
      "Database: API đọc cache trước, nếu miss thì đọc Database rồi ghi lại " +
      "cache. Trả về TOÀN BỘ DSL đã cập nhật (không chỉ phần thêm).",
  },
  {
    id: "ticket-booking-vi",
    title: "Ticket booking, Vietnamese node names (VI)",
    prompt:
      "Vẽ sơ đồ kiến trúc cho hệ thống đặt vé xem phim. Dùng TÊN NODE TIẾNG " +
      "VIỆT: Người dùng, Cổng API, Dịch vụ đặt vé, Cổng thanh toán, Hàng đợi " +
      "thông báo, Cơ sở dữ liệu. Nối các node theo luồng đặt vé và ghi nhãn " +
      "cạnh bằng tiếng Việt. Thêm icon phù hợp cho database và hàng đợi.",
  },
  {
    id: "news-feed-nested-vpc",
    title: "News feed with a nested VPC group (EN, nesting)",
    prompt:
      "Design a news feed backend. Put the internal services inside a VPC " +
      "group, and INSIDE that VPC nest a second group called 'Data Layer' " +
      "that holds the database and a cache. Outside the VPC put the mobile " +
      "client and a CDN. The client talks to an API inside the VPC (an edge " +
      "that crosses the VPC boundary). Use colours to distinguish the groups.",
  },
  {
    id: "fix-broken",
    title: "Repair a broken diagram (mixed, self-correct)",
    prompt:
      "This arch-dsl fails to parse. Fix every syntax error and return the " +
      "corrected, VALID DSL only — keep the same intent (a payment flow with " +
      "Vietnamese user, gateway, auth, orders and a database):\n\n" +
      BROKEN_DIAGRAM,
  },
  {
    id: "fanout-queue",
    title: "Fan-out queue to workers (EN, one-to-many)",
    prompt:
      "Draw a diagram where an ingestion service publishes jobs to a message " +
      "queue, and the queue fans out to three workers (Worker A, Worker B, " +
      "Worker C) that each write results to a shared results store. Use a " +
      "single one-to-many edge from the queue to the three workers.",
  },
];
