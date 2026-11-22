import { describe, expect, it } from "vitest";
import { cautiousChoice } from "../src/engine";
import defaultPolicy from "../src/policy/default-policy.json";
import type { Policy } from "../src/types";

const policy = defaultPolicy as Policy;
const yesNo = policy.factors.filter((f) => f.options.some((o) => o.label === "Yes") && f.options.some((o) => o.label === "No"));

describe("default questions are self-explanatory", () => {
  it("every Yes/No question says what each answer means", () => {
    expect(yesNo.length).toBeGreaterThan(25);
    for (const f of yesNo)
      for (const o of f.options) expect(o.hint, `${f.id} "${o.label}"`).toBeTruthy();
  });
  it("hints are plain sentences, not restatements of the label", () => {
    for (const f of yesNo)
      for (const o of f.options) {
        expect(o.hint!.length, `${f.id} ${o.label}`).toBeGreaterThan(8);
        expect(o.hint!.trim().toLowerCase(), `${f.id} ${o.label}`).not.toBe(o.label.toLowerCase());
      }
  });
  it("no question's rationale leans on project history the user can't see", () => {
    const text = JSON.stringify(policy);
    expect(text).not.toMatch(/original template|carried over from/i);
  });
  it("negatively worded questions (where Yes means something is missing) all say so in the Yes hint", () => {
    const negative = /\b(lack|lacks|no |decline|unwilling|refuse|without)\b/i;
    for (const f of yesNo.filter((x) => x.section === "Likelihood" && negative.test(x.question)))
      expect(f.options.find((o) => o.label === "Yes")!.hint, f.id).toMatch(/\b(no|not|only|doesn't|isn't|can't|without|missing)\b/i);
  });
  it("questions that are looked up, not guessed, say to look first rather than to assume the worst", () => {
    const f = (id: string) => policy.factors.find((x) => x.id === id)!;
    for (const id of ["L2", "L3", "L13"]) expect(f(id).unsure, id).toMatch(/search|compare|answer/i);
    // ...while a missing control defaults to the cautious answer (no override).
    for (const id of ["L1", "L11", "L12", "L14"]) {
      expect(f(id).unsure, id).toBeUndefined();
      expect(cautiousChoice(f(id)), id).toBe("Yes");
    }
  });
  it("the rating question explains how to convert the scales those services actually use", () => {
    const g = policy.factors.find((x) => x.id === "L7")!.guidance;
    expect(g).toMatch(/UpGuard/);
    expect(g).toMatch(/BitSight/);
  });
});
