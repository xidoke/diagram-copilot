import { describe, expect, it } from "vitest";
import { presentKeyAction } from "../../src/components/PresentMode";

describe("presentKeyAction", () => {
  const both = { hasPrev: true, hasNext: true };
  const none = { hasPrev: false, hasNext: false };

  it("Escape exits regardless of step availability", () => {
    expect(presentKeyAction("Escape", both)).toBe("exit");
    expect(presentKeyAction("Escape", none)).toBe("exit");
  });

  it("ArrowLeft steps back only when a previous step exists", () => {
    expect(presentKeyAction("ArrowLeft", both)).toBe("prev");
    expect(presentKeyAction("ArrowLeft", { hasPrev: false, hasNext: true })).toBeNull();
  });

  it("ArrowRight steps forward only when a next step exists", () => {
    expect(presentKeyAction("ArrowRight", both)).toBe("next");
    expect(presentKeyAction("ArrowRight", { hasPrev: true, hasNext: false })).toBeNull();
  });

  it("n / N toggle the notes panel", () => {
    expect(presentKeyAction("n", none)).toBe("toggle-notes");
    expect(presentKeyAction("N", none)).toBe("toggle-notes");
  });

  it("ignores unrelated keys", () => {
    expect(presentKeyAction("a", both)).toBeNull();
    expect(presentKeyAction("Enter", both)).toBeNull();
    expect(presentKeyAction(" ", both)).toBeNull();
    expect(presentKeyAction("p", both)).toBeNull();
  });
});
