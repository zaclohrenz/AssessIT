import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { percent, releaseUrl } from "../src/update";

describe("update helpers", () => {
  it("links to the release tag", () => {
    expect(releaseUrl("0.1.3")).toBe("https://github.com/zaclohrenz/AssessIT/releases/tag/v0.1.3");
    expect(releaseUrl("v0.1.3")).toBe("https://github.com/zaclohrenz/AssessIT/releases/tag/v0.1.3");
  });
  it("reports download progress, and nothing while the size is unknown", () => {
    expect(percent(50, 200)).toBe(25);
    expect(percent(300, 200)).toBe(100);
    expect(percent(10, 0)).toBeNull();
  });
});

describe("hard stop tooltip", () => {
  it("the scoring page explains hard stop next to the toggle", () => {
    const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    expect(main).toMatch(/Hard stop \$\{tip\(HARD_STOP_TIP\)\}/);
    expect(main).toMatch(/HARD_STOP_TIP = "A dealbreaker\. If this answer is chosen, the vendor is Denied/);
  });
});
