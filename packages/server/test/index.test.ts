import { describe, expect, it } from "vitest";
import { placeholder, SERVER_PACKAGE_NAME } from "../src/index.js";

describe("server placeholder", () => {
  it("returns the package name", () => {
    expect(placeholder()).toBe(SERVER_PACKAGE_NAME);
  });
});
