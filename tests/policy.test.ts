// Guards the governance rule in CONTRIBUTING.md: default scoring follows published guidance.
import { describe, expect, it } from "vitest";
import defaultPolicy from "../src/policy/default-policy.json";
import type { Policy } from "../src/types";

const policy = defaultPolicy as Policy;

describe("default policy governance", () => {
  it.each(policy.factors.map((f) => [f.id, f] as const))("%s cites its basis", (_id, f) => {
    expect(["standard", "preference"]).toContain(f.basis);
    if (f.basis === "standard") expect(f.references.length, "standard factors must cite guidance").toBeGreaterThan(0);
    for (const r of f.references) {
      expect(r.source).toBeTruthy();
      expect(r.title).toBeTruthy();
      expect(r.url).toMatch(/^https:\/\//);
    }
    expect(f.justification, "every weight needs a written reason").toBeTruthy();
  });

  it("only value choices are ignorable, and each says why", () => {
    for (const f of policy.factors.filter((x) => x.ignorable)) {
      expect(f.basis, f.id).toBe("preference");
      expect(f.ignoreNote, `${f.id} needs an explanation`).toBeTruthy();
    }
  });

  it("every preference question links to related guidance where any exists", () => {
    for (const f of policy.factors.filter((x) => x.section === "Preference")) expect(f.references.length, f.id).toBeGreaterThan(0);
  });

  it("every Organization-preference factor is labeled as a preference", () => {
    for (const f of policy.factors.filter((x) => x.section === "Preference")) expect(f.basis).toBe("preference");
  });

  it("the formula and bands cite their sources", () => {
    expect(policy.sources?.formula.source).toBe("NIST SP 800-30 Rev. 1");
    expect(policy.sources?.bands.id).toBe("GV.RM-02");
  });

  it("factor IDs are unique and options are unique per factor", () => {
    expect(new Set(policy.factors.map((f) => f.id)).size).toBe(policy.factors.length);
    for (const f of policy.factors) expect(new Set(f.options.map((o) => o.label)).size).toBe(f.options.length);
  });
});
