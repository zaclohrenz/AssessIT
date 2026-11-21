import { describe, expect, it } from "vitest";
import { isNewer, releaseUrl } from "../src/update";

describe("update check", () => {
  it("compares versions numerically, not as text", () => {
    expect(isNewer("v0.1.5", "0.1.4")).toBe(true);
    expect(isNewer("0.10.0", "0.9.9")).toBe(true);
    expect(isNewer("1.0.0", "0.99.99")).toBe(true);
  });
  it("says nothing is newer when equal, older, or unreadable", () => {
    expect(isNewer("v0.1.4", "0.1.4")).toBe(false);
    expect(isNewer("0.1.3", "0.1.4")).toBe(false);
    expect(isNewer("latest", "0.1.4")).toBe(false);
  });
  it("links to the release tag", () => {
    expect(releaseUrl("0.1.3")).toBe("https://github.com/zaclohrenz/AssessIT/releases/tag/v0.1.3");
    expect(releaseUrl("v0.1.3")).toBe("https://github.com/zaclohrenz/AssessIT/releases/tag/v0.1.3");
  });
});
