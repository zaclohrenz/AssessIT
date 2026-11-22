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

  it("lists exactly the questions that have an Unknown answer, so the rationale can't drift from the policy", () => {
    const doc = readFileSync("SCORING.md", "utf8");
    const withUnknown = (defaultPolicy as { factors: { id: string; options: { label: string }[] }[] }).factors
      .filter((f) => f.options.some((o) => o.label === "Unknown") && f.id !== "L9")
      .map((f) => f.id);
    expect(doc).toContain(`**Questions with an Unknown answer:** ${withUnknown.join(", ")}.`);
  });
  it("states the figures the code uses", () => {
    const doc = readFileSync("SCORING.md", "utf8");
    const denied = (defaultPolicy as { bands: { decision: string; scoreMin: number }[] }).bands.find((b) => b.decision === "Denied")!;
    expect(doc).toContain(`(${denied.scoreMin} in the defaults)`);
    expect(doc).toMatch(/at least two kinds of source/);
  });
});
