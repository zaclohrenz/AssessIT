import { describe, expect, it } from "vitest";
import { cautiousChoice, compute, riskMeter } from "../src/engine";
import { extractUrls, linkLabel } from "../src/links";
import { aiAnswerIds, aiAttestationText, answersText, needsAiAttestation, reviewFlags, scoreCaption, scoreHeadline, webhookPayload } from "../src/report";
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
  it("is the answer that scores worst: Yes for risk questions", () => {
    expect(cautiousChoice(f("L1"))).toBe("Yes");
    expect(cautiousChoice(f("I3"))).toBe("Sensitive");
  });
  it("is No for mitigations, because Yes there earns a credit", () => {
    for (const id of ["M1", "M2", "M3", "M4", "M5"]) expect(cautiousChoice(f(id))).toBe("No");
  });
  it("uses the policy's own 'Not rated' / 'Unknown' option when it counts against approval", () => {
    expect(cautiousChoice(f("L7"))).toBe("Not rated");
    expect(cautiousChoice(f("L9"))).toBe("Unknown");
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

describe("AI review attestation", () => {
  it("isn't needed when no answer came from AI", () => {
    const a = fresh();
    expect(aiAnswerIds(a)).toEqual([]);
    expect(needsAiAttestation(a)).toBe(false);
    expect(aiAttestationText(a)).toBe("");
    expect(webhookPayload(policy, a, org).aiReview).toBeNull();
  });
  it("is needed while AI answers remain, and stops being once confirmed or once the person edited them", () => {
    const a = fresh();
    a.answers.L2.origin = "ai";
    expect(needsAiAttestation(a)).toBe(true);
    a.aiAttestation = { by: "Pat", at: "2026-02-03T10:00:00Z" };
    expect(needsAiAttestation(a)).toBe(false);
    a.aiAttestation = undefined;
    a.answers.L2.origin = "user";
    expect(needsAiAttestation(a)).toBe(false);
  });
  it("is no longer a review flag: it has its own gate that YOLO can't skip", () => {
    const a = fresh();
    a.answers.L2.origin = "ai";
    expect(reviewFlags(compute(policy, a), a).join(" ")).not.toMatch(/AI/);
  });
  it("is recorded in the report text, the payload and the answers list", () => {
    const a = fresh();
    a.answers.L2.origin = "ai";
    expect(aiAttestationText(a)).toContain("has not confirmed");
    a.aiAttestation = { by: "Pat", at: "2026-02-03T10:00:00Z" };
    a.details.assessors = "Pat Q.";
    expect(aiAttestationText(a)).toBe("1 answer came from AI research (L2). Pat Q. reviewed them and submits them as their own determination (2026-02-03).");
    const p = webhookPayload(policy, a, org);
    expect(p.aiReview).toEqual({ answers: ["L2"], attestation: a.aiAttestation });
    expect(answersText(policy, a, compute(policy, a))).toContain("submits them as their own determination");
    expect(answersText(policy, a, compute(policy, a))).toMatch(/L2 .*\[AI\]/);
  });
});
