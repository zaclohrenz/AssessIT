import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
// @ts-expect-error plain JS helper shared with the docs script
import { renderTables, replaceTables } from "../scripts/scoring-doc.mjs";
import defaultPolicy from "../src/policy/default-policy.json";

describe("SCORING.md", () => {
  it("tables match the default policy (run `npm run docs:scoring` to fix)", () => {
    const doc = readFileSync("SCORING.md", "utf8");
    expect(doc).toBe(replaceTables(doc, renderTables(defaultPolicy)));
  });
});
