import { describe, expect, it } from "vitest";
import { cautiousChoice } from "../src/engine";
import { FLIPPED_IN_V4 } from "../src/settings";
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
  it("no question is worded as a negation: they all ask about something that exists or happened", () => {
    const negation = /\b(lack|lacks|lacking|without|unwilling|refuse|refuses|decline|declines|fail to|set no|no public|has no|have no|no deadline|no current)\b/i;
    for (const f of policy.factors) expect(f.question, f.id).not.toMatch(negation);
  });
  it("the questions that were negations were turned around: Yes is the good answer, and scores 0", () => {
    for (const id of FLIPPED_IN_V4) {
      const f = policy.factors.find((x) => x.id === id)!;
      expect(f.options.find((o) => o.label === "Yes")!.points, id).toBe(0);
      expect(f.options.find((o) => o.label === "No")!.points, id).toBeGreaterThan(0);
    }
  });
  it("lookups of things that may have happened offer an honest Unknown, between the two answers", () => {
    for (const id of ["L2", "L3", "L4", "L8", "L10", "L13", "P4", "P5", "P7", "P8"]) {
      const f = policy.factors.find((x) => x.id === id)!;
      const unknown = f.options.find((o) => o.label === "Unknown")!;
      const worst = Math.max(...f.options.map((o) => o.points));
      expect(unknown, id).toBeTruthy();
      expect(unknown.hint, id).toBeTruthy();
      expect(unknown.points, id).toBeGreaterThan(0);
      expect(unknown.points, id).toBeLessThan(worst);
    }
  });
  it("controls and contract promises have no Unknown: no evidence means no credit", () => {
    for (const id of ["L1", "L11", "L12", "L14", "L15"]) {
      const f = policy.factors.find((x) => x.id === id)!;
      expect(f.options.map((o) => o.label), id).toEqual(["Yes", "No"]);
      expect(cautiousChoice(f), id).toBe("No");
    }
  });
  it("every question answered from the web says where to look, without that being a limit", () => {
    for (const f of policy.factors.filter((x) => x.research === "public")) {
      expect(f.lookWhere, f.id).toBeTruthy();
      expect(f.lookWhere, f.id).not.toMatch(/\bonly\b/i);
    }
  });
  it("the rating question explains how to convert the scales those services actually use", () => {
    const g = policy.factors.find((x) => x.id === "L7")!.guidance;
    expect(g).toMatch(/UpGuard/);
    expect(g).toMatch(/BitSight/);
  });
});
