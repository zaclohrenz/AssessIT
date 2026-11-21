// Replays every row of tests/scoring-cases.csv through the engine.
// The expected values in that file come from the original spreadsheet's formulas,
// so a failure here means the scoring changed, not that the CSV is wrong.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { compute } from "../src/engine";
import defaultPolicy from "../src/policy/default-policy.json";
import type { Assessment, Policy } from "../src/types";

const policy = defaultPolicy as Policy;

/** Minimal RFC 4180 parser: quoted fields may contain commas. Lines starting with # are comments. */
function parseCsv(text: string): string[][] {
  return text
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#"))
    .map((line) => {
      const cells: string[] = [];
      let cur = "";
      let quoted = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (quoted && ch === '"' && line[i + 1] === '"') (cur += '"'), i++;
        else if (ch === '"') quoted = !quoted;
        else if (ch === "," && !quoted) cells.push(cur), (cur = "");
        else cur += ch;
      }
      return [...cells, cur];
    });
}

const [header, ...rows] = parseCsv(readFileSync("tests/scoring-cases.csv", "utf8"));
const col = (name: string) => header.indexOf(name);
const ids = policy.factors.map((f) => f.id);

describe("golden scoring cases (from the original spreadsheet)", () => {
  it("CSV covers every factor in the policy", () => {
    for (const id of ids) expect(header, `missing column ${id}`).toContain(id);
    expect(rows.length).toBeGreaterThanOrEqual(40);
  });

  it.each(rows.map((r) => [r[0], r] as const))("%s", (_name, row) => {
    const a: Assessment = {
      details: {
        vendor: "", product: "", plan: "", requestingTeam: "", businessOwner: "", intendedUse: "",
        assessmentDate: "2026-01-01", assessors: "", resources: "", override: "", overrideJustification: "", riskAcceptedBy: "",
      },
      answers: Object.fromEntries(ids.map((id) => [id, { response: row[col(id)], notes: "", sources: "", origin: "user" }])),
    };
    const r = compute(policy, a);
    const num = (name: string) => Number(row[col(name)]);
    expect(r.likelihood).toBeCloseTo(num("likelihood"), 9);
    expect(r.impact).toBeCloseTo(num("impact"), 9);
    expect(r.preference).toBeCloseTo(num("preference_multiplier"), 9);
    expect(r.mitigationApplied).toBeCloseTo(num("mitigation_credit"), 9);
    expect(r.score).toBeCloseTo(num("score"), 4);
    expect(r.band.name).toBe(row[col("band")]);
    expect(r.calculatedDecision).toBe(row[col("decision")]);
  });
});
