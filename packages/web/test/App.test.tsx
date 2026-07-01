import { describe, expect, it } from "vitest";
import { APP_TITLE } from "../src/App";

describe("App", () => {
  it("exposes the diagram-copilot title", () => {
    expect(APP_TITLE).toBe("diagram-copilot");
  });
});
