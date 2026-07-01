import { describe, expect, it } from "vitest";
import { placeholder, ICONS_PACKAGE_NAME } from "../src/index.js";

describe("icons placeholder", () => {
  it("returns the package name", () => {
    expect(placeholder()).toBe(ICONS_PACKAGE_NAME);
  });
});
