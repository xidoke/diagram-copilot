import { describe, expect, it } from "vitest";
import { placeholder, LAYOUT_PACKAGE_NAME } from "../src/index.js";

describe("layout placeholder", () => {
  it("returns the package name plus a real core contract export", () => {
    expect(placeholder()).toBe(`${LAYOUT_PACKAGE_NAME}+.arch`);
  });
});
