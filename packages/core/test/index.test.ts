import { describe, expect, it } from "vitest";
import { placeholder, CORE_PACKAGE_NAME } from "../src/index.js";

describe("core placeholder", () => {
  it("returns the package name", () => {
    expect(placeholder()).toBe(CORE_PACKAGE_NAME);
  });
});
