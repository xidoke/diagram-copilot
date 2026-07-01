import { describe, expect, it } from "vitest";
import { statusPillContent } from "../../src/components/StatusPill";

describe("statusPillContent", () => {
  it("renders the connected state (theme B, green)", () => {
    expect(statusPillContent("connected")).toEqual({
      tone: "connected",
      icon: "●",
      text: "connected · live",
    });
  });

  it("renders the connecting state", () => {
    expect(statusPillContent("connecting")).toEqual({
      tone: "connecting",
      icon: "○",
      text: "connecting…",
    });
  });

  it("renders the disconnected state (theme B, muted red)", () => {
    expect(statusPillContent("disconnected")).toEqual({
      tone: "disconnected",
      icon: "⏸",
      text: "disconnected — reconnecting",
    });
  });
});
