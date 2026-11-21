import { describe, expect, it } from "vitest";
import { addMonths, compute, draftMessage, pathToApproval, summary } from "../src/engine";
import defaultPolicy from "../src/policy/default-policy.json";
import example from "./fixtures/example-assessment.json";
import type { Assessment, Policy } from "../src/types";

const policy = defaultPolicy as Policy;
const org = { orgName: "Example Org", reviewTeam: "Digital Operations Team", policyLink: "[policy]" };
const clone = (): Assessment => structuredClone(example) as Assessment;

// Expected values are the cached results from the reference workbook (Claude.xlsx).
describe("matches the reference workbook", () => {
  const a = clone();
  const r = compute(policy, a);

  it("scores", () => {
    expect(r.likelihood).toBe(9);
    expect(r.likelihoodMax).toBe(22);
    expect(r.likelihoodBand).toBe("High");
    expect(r.impact).toBe(5);
    expect(r.impactMax).toBe(18);
    expect(r.impactBand).toBe("Moderate");
    expect(r.preference).toBe(1);
    expect(r.preferenceMax).toBe(5);
    expect(r.mitigationRaw).toBeCloseTo(0.05);
    expect(r.mitigationApplied).toBeCloseTo(0.05);
    expect(r.unmitigated).toBe(45);
    expect(r.score).toBeCloseTo(42.75);
    expect(r.maxScore).toBe(1980);
    expect(r.band.name).toBe("Low");
    expect(r.reReviewMonths).toBe(12);
    expect(r.reReviewDate).toBe("2027-10-21");
  });

  it("decides", () => {
    expect(r.requiredCount).toBe(22);
    expect(r.requiredUnanswered).toEqual([]);
    expect(r.hardStops).toEqual([]);
    expect(r.calculatedDecision).toBe("Approved with Conditions");
    expect(r.finalDecision).toBe("Approved with Conditions");
    expect(r.denialThreshold).toBe(58);
    expect(r.creditedMitigations).toEqual(["SSO with automatic provisioning"]);
  });

  it("ranks drivers like the Report tab", () => {
    expect(r.drivers.map((d) => [d.factor.factor, +d.scoreReduction.toFixed(2)])).toEqual([
      ["Most sensitive data it will touch", 17.1],
      ["Access to our systems", 17.1],
      ["Breach in the last 3 years", 9.5],
      ["Privacy trouble", 9.5],
      ["Third-party security rating", 9.5],
      ["Acts on its own", 9.5],
    ]);
    expect(r.mitigations.map((m) => [m.factor.factor, +m.scoreReduction.toFixed(2)])).toEqual([
      ["SSO with automatic provisioning", 2.25],
    ]);
  });

  it("writes the same narrative", () => {
    expect(summary(r, a)).toBe(
      "Risk score 42.8 lands in the Low band (29+), which policy maps to Approved. Approval depends on keeping these mitigations in place: SSO with automatic provisioning. Biggest drivers: Most sensitive data it will touch, Access to our systems, Breach in the last 3 years.",
    );
    expect(pathToApproval(r, policy.maxMitigationCredit)).toBe("Already below the denial line (58).");
    expect(draftMessage(r, a, org)).toBe(
      "Subject: Claude approved with conditions\n\nHi IT,\n\nThanks for submitting Claude for review. It is approved for use (risk score 42.8, Low band) as long as these conditions stay in place: SSO with automatic provisioning.\n\nIf any of these change, please let us know so we can re-assess. Re-review is due around October 2027.\n\nThanks,\nDigital Operations Team",
    );
  });
});

describe("decision rules", () => {
  it("blank required answers make it Incomplete, never low risk", () => {
    const a = clone();
    a.answers.L1.response = "";
    a.answers.I3.response = "";
    const r = compute(policy, a);
    expect(r.calculatedDecision).toBe("Incomplete");
    expect(r.requiredUnanswered).toEqual(["L1", "I3"]);
    expect(r.reReviewDate).toBeNull();
  });

  it("optional blanks don't block a decision", () => {
    const a = clone();
    a.answers.L8.response = "";
    expect(compute(policy, a).calculatedDecision).not.toBe("Incomplete");
  });

  it("hard stop denies regardless of score", () => {
    const p = structuredClone(policy);
    p.factors.find((f) => f.id === "I7")!.hardStop = "Yes";
    const a = clone();
    a.answers.I7.response = "Yes";
    const r = compute(p, a);
    expect(r.calculatedDecision).toBe("Denied");
    expect(r.hardStops).toEqual(["I7 Data about vulnerable people = Yes"]);
  });

  it("mitigation credit is capped", () => {
    const a = clone();
    for (const id of ["M1", "M2", "M3", "M4", "M5"]) a.answers[id].response = "Yes";
    const r = compute(policy, a);
    expect(r.mitigationRaw).toBeCloseTo(0.4);
    expect(r.mitigationApplied).toBe(0.25);
    expect(r.score).toBeCloseTo(45 * 0.75);
  });

  it("organization preferences scale the whole score", () => {
    const a = clone();
    a.answers.P1.response = "Yes";
    const r = compute(policy, a);
    expect(r.preference).toBe(1.5);
    expect(r.score).toBeCloseTo(45 * 1.5 * 0.95);
    expect(r.band.name).toBe("Moderate");
    expect(r.calculatedDecision).toBe("Denied");
    expect(pathToApproval(r, 0.25)).toMatch(/^Score must fall below 58 \(now 64\.1\)/);
  });

  it("each new organization preference scales the score like the original three", () => {
    for (const id of ["P4", "P5", "P6", "P7", "P8"]) {
      const a = clone();
      a.answers[id].response = "Yes";
      const r = compute(policy, a);
      expect(r.preference, id).toBe(1.5);
      expect(r.score, id).toBeCloseTo(45 * 1.5 * 0.95);
    }
    const all = clone();
    for (const id of ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8"]) all.answers[id].response = "Yes";
    expect(compute(policy, all).preference).toBe(5);
  });

  it("a downplayed breach adds 2 likelihood points; the other new risk questions add 1", () => {
    const base = compute(policy, clone()).likelihood;
    for (const [id, pts] of [["L13", 2], ["L14", 1], ["L15", 1]] as const) {
      const a = clone();
      a.answers[id].response = "Yes";
      expect(compute(policy, a).likelihood - base, id).toBe(pts);
    }
  });

  it("an ignored question is neither scored nor required, and only ignorable questions can be ignored", () => {
    const a = clone();
    a.answers.P4.response = "Yes";
    expect(compute(policy, a).preference).toBe(1.5);
    a.answers.P4 = { response: "", notes: "", sources: "", origin: "user", ignored: true };
    const r = compute(policy, a);
    expect(r.preference).toBe(1);
    expect(r.preferenceMax).toBe(4.5);
    expect(r.requiredUnanswered).toEqual([]);
    expect(r.requiredCount).toBe(21);
    expect(r.factors.find((f) => f.factor.id === "P4")!.status).toBe("Ignored");
    // P1 is not ignorable, so the flag does nothing there.
    a.answers.P1 = { response: "", notes: "", sources: "", origin: "user", ignored: true };
    expect(compute(policy, a).requiredUnanswered).toEqual(["P1"]);
  });

  it("override wins over the calculated decision", () => {
    const a = clone();
    a.details.override = "Denied";
    const r = compute(policy, a);
    expect(r.calculatedDecision).toBe("Approved with Conditions");
    expect(r.finalDecision).toBe("Denied");
    expect(summary(r, a)).toContain("OVERRIDE to Denied: [justification missing]");
  });

  it("disabled factors don't score", () => {
    const p = structuredClone(policy);
    p.factors.find((f) => f.id === "I3")!.enabled = false;
    const r = compute(p, clone());
    expect(r.impact).toBe(3);
    expect(r.factors.find((f) => f.factor.id === "I3")!.status).toBe("Not scored");
  });

  it("EDATE clamps month ends", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2026-08-31", 6)).toBe("2027-02-28");
    expect(addMonths("bad", 1)).toBeNull();
  });
});
