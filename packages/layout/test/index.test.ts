import { describe, expect, it } from "vitest";
import { placeholder, LAYOUT_PACKAGE_NAME } from "../src/index.js";

describe("layout placeholder", () => {
  it("returns the package name", () => {
    expect(placeholder()).toBe(`${LAYOUT_PACKAGE_NAME}+@diagram-copilot/core`);
  });
});
