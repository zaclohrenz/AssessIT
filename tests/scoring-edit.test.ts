import { describe, expect, it } from "vitest";
import defaultPolicy from "../src/policy/default-policy.json";
import { clonePolicy, diffPolicy, policyEditFlag, policyLabel, reasonProblem, validateScoring, withEdits } from "../src/scoring";
import { validatePolicy } from "../src/settings";
import { compute } from "../src/engine";
import { blankAssessment } from "../src/settings";
import { reviewFlags, answersText } from "../src/report";
import type { Policy } from "../src/types";

const base = () => defaultPolicy as unknown as Policy;
const edit = (fn: (p: Policy) => void) => {
  const p = clonePolicy(base());
  fn(p);
  return p;
};

describe("scoring editor rules", () => {
  it("the shipped weights are valid", () => expect(validateScoring(base())).toEqual([]));

  it("rejects numbers that are missing, NaN or out of range", () => {
    expect(validateScoring(edit((p) => (p.factors[0].options[0].points = NaN))).join(" ")).toMatch(/L1.*points must be a number/);
    expect(validateScoring(edit((p) => (p.factors[0].options[1].points = 99))).length).toBeGreaterThan(0);
    expect(validateScoring(edit((p) => (p.factors[0].options[1].points = -1))).length).toBeGreaterThan(0);
    expect(validateScoring(edit((p) => (p.maxMitigationCredit = 0.9))).join(" ")).toMatch(/0% and 50%/);
    expect(validateScoring(edit((p) => (p.basePreferenceMultiplier = 0))).join(" ")).toMatch(/0.5 and 3/);
    const mit = base().factors.findIndex((f) => f.section === "Mitigation");
    expect(validateScoring(edit((p) => (p.factors[mit].options[0].points = 0.9))).length).toBeGreaterThan(0);
  });

  it("keeps the bands usable", () => {
    expect(validateScoring(edit((p) => (p.bands[0].scoreMin = 3))).join(" ")).toMatch(/must start at 0/);
    expect(validateScoring(edit((p) => (p.bands[2].scoreMin = p.bands[1].scoreMin))).join(" ")).toMatch(/above the band before/);
    expect(validateScoring(edit((p) => p.bands.forEach((b) => b.decision === "Denied" && (b.decision = "Approved")))).join(" ")).toMatch(/One band must be Denied/);
    expect(validateScoring(edit((p) => (p.bands[0].reReviewMonths = 0))).length).toBeGreaterThan(0);
    expect(validateScoring(edit((p) => (p.bands[0].reReviewMonths = 1.5))).length).toBeGreaterThan(0);
  });

  it("keeps questions coherent", () => {
    expect(validateScoring(edit((p) => (p.factors[0].hardStop = "Maybe"))).join(" ")).toMatch(/hard stop isn't one of its answers/);
    expect(validateScoring(edit((p) => ((p.factors[0].enabled = false), (p.factors[0].required = true)))).join(" ")).toMatch(/switched off can't be required/);
  });

  it("lists every difference from the baseline, and nothing else", () => {
    expect(diffPolicy(base(), clonePolicy(base()))).toEqual([]);
    const d = diffPolicy(base(), edit((p) => ((p.factors[0].options[1].points = 1.5), (p.maxMitigationCredit = 0.2), (p.bands[1].scoreMin += 1))));
    expect(d).toHaveLength(3);
    expect(d.join("\n")).toMatch(/L1 “.*” points: 1 → 1.5/);
    expect(d.join("\n")).toMatch(/Maximum mitigation credit: 25% → 20%/);
  });

  it("shows mitigation points as percents in the change list", () => {
    const i = base().factors.findIndex((f) => f.section === "Mitigation");
    const j = base().factors[i].options.findIndex((o) => o.points > 0);
    const d = diffPolicy(base(), edit((p) => (p.factors[i].options[j].points = 0.07)));
    expect(d[0]).toMatch(/→ 7%/);
  });

  it("needs a real reason", () => {
    expect(reasonProblem("")).toMatch(/at least/);
    expect(reasonProblem("too short")).toMatch(/at least/);
    expect(reasonProblem("aaaaaaaaaaaaaaaa")).toMatch(/real reason/);
    expect(reasonProblem("x".repeat(600))).toMatch(/under/);
    expect(reasonProblem("Our regulator requires this as a hard stop.")).toBeNull();
  });

  it("saves the edit with what changed, when and why; nothing changed saves nothing", () => {
    expect(withEdits(base(), clonePolicy(base()), "no changes at all here")).toBeNull();
    const next = edit((p) => (p.maxMitigationCredit = 0.2));
    const saved = withEdits(base(), next, "  Lower the cap per audit finding 12  ", new Date("2026-11-23T10:00:00Z"))!;
    expect(saved.edits).toEqual({ at: "2026-11-23T10:00:00.000Z", reason: "Lower the cap per audit finding 12", changes: ["Maximum mitigation credit: 25% → 20%"] });
    expect(saved.maxMitigationCredit).toBe(0.2);
    expect(base().edits).toBeUndefined();
  });

  it("edited weights change the score, and say so on every report", () => {
    const a = blankAssessment();
    const saved = withEdits(base(), edit((p) => (p.factors[0].options[1].points = 3)), "Raising a weight for the test")!;
    expect(policyLabel(saved)).toMatch(/\(edited locally\)/);
    expect(policyLabel(base())).not.toMatch(/edited/);
    expect(reviewFlags(compute(saved, a), a, saved).join(" ")).toMatch(/edited locally on .*Raising a weight/);
    expect(reviewFlags(compute(base(), a), a, base()).join(" ")).not.toMatch(/edited/);
    expect(answersText(saved, a, compute(saved, a))).toMatch(/Policy: .*\(edited locally\)/);
    expect(policyEditFlag(base())).toBeNull();
  });
});

describe("policies that come in from files or URLs", () => {
  it("must have real numbers for points and cut-offs", () => {
    const bad = (fn: (p: any) => void) => () => {
      const p = clonePolicy(base());
      fn(p);
      return validatePolicy(p);
    };
    expect(bad((p) => (p.factors[0].options[0].points = "3"))).toThrow(/points must be a number/);
    expect(bad((p) => (p.factors[0].options[0].points = null))).toThrow(/points must be a number/);
    expect(bad((p) => (p.factors[0].options[0].points = 1e9))).toThrow(/points must be a number/);
    expect(bad((p) => (p.bands[1].scoreMin = "10"))).toThrow(/cut-off must be a number/);
    expect(bad((p) => (p.maxMitigationCredit = Infinity))).toThrow(/Max mitigation credit/);
    expect(bad((p) => (p.factors[0].options[0] = { points: 1 }))).toThrow(/needs a label/);
    expect(bad(() => {})).not.toThrow();
  });

  it("an edit record is rebuilt from plain, short strings", () => {
    const p: any = clonePolicy(base());
    p.edits = { at: "2026-01-01T00:00:00Z", reason: "r".repeat(2000), changes: ["ok", 5, { x: 1 }, "c".repeat(999)], extra: "<img src=x onerror=alert(1)>" };
    const out = validatePolicy(p);
    expect(out.edits!.reason).toHaveLength(500);
    expect(out.edits!.changes).toEqual(["ok", "c".repeat(200)]);
    expect(JSON.stringify(out.edits)).not.toContain("onerror");
    p.edits = "nonsense";
    expect(validatePolicy(p).edits).toBeUndefined();
  });
});
