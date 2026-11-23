import { describe, expect, it } from "vitest";
import { cautiousChoice, compute, draftMessage, optionTone, pathToApproval, riskMeter, summary, toneWords } from "../src/engine";
import { extractUrls, linkLabel } from "../src/links";
import { aiAnswerIds, aiAttestationText, answersText, reviewFlags, scoreCaption, scoreBreakdown, scoreCaptionPlain, scoreHeadline, webhookPayload } from "../src/report";
import defaultPolicy from "../src/policy/default-policy.json";
import example from "./fixtures/example-assessment.json";
import type { Assessment, Policy } from "../src/types";

const policy = defaultPolicy as Policy;
const fresh = () => structuredClone(example) as Assessment;
const org = { orgName: "X", reviewTeam: "Y", policyLink: "Z" };

describe("risk meter", () => {
  const base = { applied: 0, possible: 0.25, hardStop: false, incomplete: false };
  it("is green under the denial line, with the score as a share of it", () => {
    const m = riskMeter({ ...base, score: 29, unmitigated: 29, limit: 58 })!;
    expect(m).toMatchObject({ zone: "green", percent: 50, limit: 58 });
  });
  it("is yellow over the line when the mitigations still on offer could bring it under", () => {
    // 70 unmitigated; the most credit possible (25%) gets to 52.5, which is under 58.
    expect(riskMeter({ ...base, score: 70, unmitigated: 70, limit: 58 })!.zone).toBe("yellow");
  });
  it("is red when even every mitigation couldn't get under the line", () => {
    expect(riskMeter({ ...base, score: 90, unmitigated: 90, limit: 58 })!.zone).toBe("red");
  });
  it("is red on a hard stop whatever the score, and absent while incomplete or without a denial band", () => {
    expect(riskMeter({ ...base, score: 1, unmitigated: 1, limit: 58, hardStop: true })!.zone).toBe("red");
    expect(riskMeter({ ...base, score: 1, unmitigated: 1, limit: 58, incomplete: true })).toBeNull();
    expect(riskMeter({ ...base, score: 1, unmitigated: 1, limit: null })).toBeNull();
  });
  it("shrinks the yellow zone as credit is already taken, and has none once it's maxed out", () => {
    const some = riskMeter({ score: 60, unmitigated: 70, applied: 0.1, possible: 0.25, limit: 58, hardStop: false, incomplete: false })!;
    const none = riskMeter({ score: 60, unmitigated: 80, applied: 0.25, possible: 0.25, limit: 58, hardStop: false, incomplete: false })!;
    expect(some.yellowUntilPercent).toBeGreaterThan(100);
    expect(some.yellowUntilPercent).toBeLessThan(133);
    expect(none.yellowUntilPercent).toBe(100);
    expect(none.zone).toBe("red");
  });
  it("is part of a real result and reads as a percent, not 'of 1782'", () => {
    const r = compute(policy, fresh());
    expect(r.meter).not.toBeNull();
    expect(scoreHeadline(r)).toBe(`${r.meter!.percent}%`);
    expect(scoreCaption(r)).toContain("lower is better");
    expect(scoreCaption(r)).not.toContain("1782");
  });
});

describe("cautious answer when you're unsure", () => {
  const f = (id: string) => policy.factors.find((x) => x.id === id)!;
  it("is the answer that scores worst: No for 'does it have X?' questions, Yes for 'did something bad happen?' ones", () => {
    expect(cautiousChoice(f("L1"))).toBe("No"); // can't show a current audit: no credit
    expect(cautiousChoice(f("L14"))).toBe("No");
    expect(cautiousChoice(f("L6"))).toBe("Yes");
    expect(cautiousChoice(f("I3"))).toBe("Sensitive");
  });
  it("is No for mitigations, because Yes there earns a credit", () => {
    for (const id of ["M1", "M2", "M3", "M4", "M5"]) expect(cautiousChoice(f(id))).toBe("No");
  });
  it("uses the policy's own 'Not rated' / 'Unknown' option when it counts partway against approval", () => {
    expect(cautiousChoice(f("L7"))).toBe("Not rated");
    for (const id of ["L2", "L3", "L9", "L13", "P4", "P5"]) expect(cautiousChoice(f(id)), id).toBe("Unknown");
  });
  it("never suggests a hard-stop answer, or a 'worse' unknown that the policy scores as harmless", () => {
    expect(cautiousChoice({ section: "Likelihood", hardStop: "Yes", options: [{ label: "Yes", points: 2 }, { label: "No", points: 0 }] })).toBeNull();
    expect(cautiousChoice({ section: "Likelihood", hardStop: null, options: [{ label: "Yes", points: 4 }, { label: "Unknown", points: 0 }] })).toBe("Yes");
  });
  it("gives every question in the default policy a suggestion", () => {
    for (const q of policy.factors) expect(cautiousChoice(q), q.id).not.toBeNull();
  });
});

describe("source links", () => {
  it("finds https links in prose and lists, without trailing punctuation", () => {
    const t = "See https://example.com/trust, and (https://vendor.io/security-policy). Also https://example.com/trust ; http://insecure.test/x";
    expect(extractUrls(t)).toEqual(["https://example.com/trust", "https://vendor.io/security-policy"]);
  });
  it("ignores things that aren't real links", () => {
    expect(extractUrls("javascript:alert(1) https://localhost https:// nothing here")).toEqual([]);
  });
  it("labels links shortly", () => {
    expect(linkLabel("https://www.example.com/")).toBe("example.com");
    expect(linkLabel("https://example.com/a/b?x=1")).toBe("example.com/a/b?x=1");
    expect(linkLabel("https://example.com/" + "a".repeat(100)).length).toBeLessThanOrEqual(60);
  });
});

describe("AI agreement (a reminder, never a gate)", () => {
  it("isn't shown or recorded when no answer came from AI", () => {
    const a = fresh();
    expect(aiAnswerIds(a)).toEqual([]);
    expect(aiAttestationText(a)).toBe("");
    expect(webhookPayload(policy, a, org).aiReview).toBeNull();
  });
  it("is not a review flag, so it can't hold up or YOLO-flag a submission", () => {
    const a = fresh();
    a.answers.L2.origin = "ai";
    expect(reviewFlags(compute(policy, a), a).join(" ")).not.toMatch(/AI/);
  });
  it("records whether the assessor agreed, for approvers", () => {
    const a = fresh();
    a.answers.L2.origin = "ai";
    expect(aiAttestationText(a)).toContain("didn't tick the box");
    expect(webhookPayload(policy, a, org).aiReview).toEqual({ answers: ["L2"], attestation: null });
    a.aiAttestation = { by: "Pat", at: "2026-02-03T10:00:00Z" };
    a.details.assessors = "Pat Q.";
    expect(aiAttestationText(a)).toBe("1 answer came from AI research (L2). Pat Q. agreed with them (2026-02-03).");
    expect(webhookPayload(policy, a, org).aiReview).toEqual({ answers: ["L2"], attestation: a.aiAttestation });
    expect(answersText(policy, a, compute(policy, a))).toContain("agreed with them");
    expect(answersText(policy, a, compute(policy, a))).toMatch(/L2 .*\[AI\]/);
  });
  it("stops being mentioned once the person has edited every AI answer", () => {
    const a = fresh();
    a.answers.L2.origin = "user";
    expect(aiAttestationText(a)).toBe("");
  });
});

describe("option colour cue", () => {
  const f = (id: string) => policy.factors.find((x) => x.id === id)!;
  const tones = (id: string) => Object.fromEntries(f(id).options.map((o) => [o.label, optionTone(f(id), o.label)]));
  it("marks the answer that adds risk, whichever way round the question is worded", () => {
    expect(tones("L1")).toEqual({ Yes: "good", No: "bad" }); // "has an audit?" Yes is the good answer
    expect(tones("L6")).toEqual({ Yes: "bad", No: "good" }); // "bought outside review?" Yes is the bad one
  });
  it("shows an honest Unknown as in-between", () => {
    expect(tones("L2")).toEqual({ Yes: "bad", No: "good", Unknown: "mid" });
  });
  it("grades ladders by how much of the question's maximum each step adds", () => {
    expect(tones("I3")).toEqual({ Sensitive: "bad", Confidential: "bad", Internal: "mid", Public: "good" });
  });
  it("shows mitigations you have as good, and ones you don't as no credit rather than bad", () => {
    expect(tones("M1")).toEqual({ Yes: "good", No: "none" });
  });
  it("every option of every default question has a tone, and 'none' only on mitigations", () => {
    for (const q of policy.factors)
      for (const o of q.options) {
        const t = optionTone(q, o.label);
        expect(["good", "mid", "bad", "none"], `${q.id} ${o.label}`).toContain(t);
        if (t === "none") expect(q.section, q.id).toBe("Mitigation");
      }
  });
  it("describes each tone in words for the tooltip", () => {
    expect(toneWords("bad")).toBe("adds the most risk");
    expect(toneWords("none")).toBe("no credit");
  });
});

describe("the screen speaks in percent; the numbers are one hover away", () => {
  const a = fresh();
  const r = compute(policy, a);
  const org2 = { orgName: "Contoso", reviewTeam: "IT Risk", policyLink: "our policy" };
  it("the plain summary quotes the percentage of the limit, with no score, band or points", () => {
    const s = summary(r, a, true);
    expect(s).toMatch(new RegExp(`At ${r.meter!.percent}% of the approval limit`));
    expect(s).not.toMatch(/Risk score|band \(|\d+\.\d/);
    // ...while the default keeps the reference workbook's exact wording for exports.
    expect(summary(r, a)).toMatch(/^Risk score \d+\.\d lands in the \w+( \w+)? band \(\d+\+\)/);
  });
  it("says 'over the limit' at or beyond 100%", () => {
    const over = compute(policy, { ...a, answers: { ...a.answers, P2: { response: "No", notes: "", sources: "", origin: "user" } } });
    const s = summary({ ...over, meter: { ...over.meter!, percent: 130 }, calculatedDecision: "Denied", hardStops: [] }, a, true);
    expect(s).toContain("At 130% of the approval limit, this is over the limit");
  });
  it("the plain path to approval is in percent of the limit", () => {
    const over = { ...r, calculatedDecision: "Denied" as const, score: 70, denialThreshold: 58, hardStops: [], meter: { ...r.meter!, percent: 121 } };
    const text = pathToApproval(over, 0.25, true);
    expect(text).toMatch(/^Needs to fall below 100% of the approval limit \(now 121%\)/);
    expect(text).not.toMatch(/\d+\.\d/);
    expect(pathToApproval(over, 0.25)).toMatch(/Score must fall below 58 \(now 70\.0\)/);
    expect(pathToApproval({ ...over, score: 30 }, 0.25, true)).toBe("Already within the approval limit.");
  });
  it("the plain draft message quotes a percentage, the exported one keeps the score", () => {
    expect(draftMessage(r, a, org2, true)).toContain(`${r.meter!.percent}% of the approval limit`);
    expect(draftMessage(r, a, org2, true)).not.toMatch(/risk score|band\)/i);
    expect(draftMessage(r, a, org2)).toMatch(/risk score \d+\.\d, \w+/);
  });
  it("the \"i\" breakdown carries every figure the page no longer shows, section by section", () => {
    const b = scoreBreakdown(r, policy)!;
    expect(b.parts.map((x) => x.key)).toEqual(["likelihood", "impact", "preference", "mitigation"]);
    expect(b.parts[0].value).toBe(`${r.likelihood} of ${r.likelihoodMax}`);
    expect(b.parts[1].value).toBe(`${r.impact} of ${r.impactMax}`);
    expect(b.parts[2].value).toBe(`×${r.preference.toFixed(1)}`);
    expect(b.parts[3].value).toBe(`−${Math.round(r.mitigationApplied * 100)}%`);
    expect(b.working).toContain(`${r.likelihood} × ${r.impact}`);
    expect(b.score).toBe(r.score.toFixed(1));
    expect(b.against).toContain(`${r.meter!.percent}% of the approval limit`);
    for (const x of b.parts) expect(x.fill).toBeGreaterThanOrEqual(0), expect(x.fill).toBeLessThanOrEqual(1);
  });
  it("compares the score to the approval limit: the limit, the score, over or under by how much, and whether mitigations can fix it", () => {
    const b = scoreBreakdown(r, policy)!;
    const l = b.limit!;
    expect(l.limit).toBe(r.meter!.limit.toFixed(1));
    expect(l.percent).toBe(r.meter!.percent);
    expect(l.zone).toBe(r.meter!.zone);
    expect(l.deltaAmount).toBe(`${Math.abs(r.meter!.percent - 100)}%`);
    expect(l.deltaLabel).toBe(r.meter!.percent > 100 ? "Over the limit by" : "Under the limit by");
    expect(l.note).toMatch(/limit/);
    expect(l.markAt).toBeGreaterThan(0), expect(l.markAt).toBeLessThanOrEqual(1);
    expect(l.fillTo).toBeLessThanOrEqual(1);
    const over = { ...r, meter: { ...r.meter!, percent: 119, zone: "yellow" as const } };
    expect(scoreBreakdown(over, policy)!.limit).toMatchObject({ deltaLabel: "Over the limit by", deltaAmount: "19%", note: "Mitigations could still bring this under the limit." });
    const red = { ...r, meter: { ...r.meter!, percent: 119, zone: "red" as const } };
    expect(scoreBreakdown(red, policy)!.limit!.note).toMatch(/even with every mitigation/i);
    expect(scoreBreakdown({ ...r, meter: { ...r.meter!, percent: 62, zone: "green" as const } }, policy)!.limit).toMatchObject({ deltaLabel: "Under the limit by", deltaAmount: "38%" });
  });
  it("explains the preference multiplier and the mitigation cap in words", () => {
    const concerned = fresh();
    concerned.answers.P3 = { response: "No", notes: "", sources: "", origin: "user" }; // a concern, since v4
    const rc = compute(policy, concerned);
    const pref = scoreBreakdown(rc, policy)!.parts[2];
    expect(pref.detail).toMatch(/1 value concern raises the whole score by 50%/);
    expect(scoreBreakdown(compute(policy, fresh()), policy)!.parts[2].detail).toMatch(/^1 value concern|^No value concerns/);
    const mit = scoreBreakdown(rc, policy)!.parts[3];
    expect(mit.detail).toMatch(/up to 25%/);
  });
  it("has nothing to show while incomplete", () => {
    expect(scoreBreakdown({ ...r, finalDecision: "Incomplete" }, policy)).toBeNull();
  });
  it("the plain caption has no numbers at all", () => {
    expect(scoreCaptionPlain(r)).not.toMatch(/\d/);
    expect(scoreCaptionPlain(r)).toContain("lower is better");
  });
});
