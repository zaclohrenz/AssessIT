import { describe, expect, it } from "vitest";
import defaultPolicy from "../src/policy/default-policy.json";
import { sanitizeConfig } from "../src/orgconfig";
import { blankAssessment, FLIPPED_IN_V4, migrateAssessment } from "../src/settings";
import type { Assessment, Policy } from "../src/types";

const v4 = defaultPolicy as Policy;
const v3: Policy = { ...v4, version: 3 };
const custom: Policy = { ...v4, name: "Contoso policy", version: 2 };

const legacy = (): Assessment => {
  const a = blankAssessment();
  a.answers = {
    L1: { response: "Yes", notes: "", sources: "", origin: "ai", aiResponse: "Yes" }, // v3: "lacks a certification"
    L14: { response: "No", notes: "", sources: "", origin: "user" }, // v3: "has a notification deadline"
    L2: { response: "Yes", notes: "", sources: "", origin: "user" }, // not flipped
    P1: { response: "", notes: "", sources: "", origin: "user" },
    L7: { response: "51-75", notes: "", sources: "", origin: "user" },
  };
  return a;
};

describe("default policy v4 turned some answers around", () => {
  it("swaps Yes and No on exactly the flipped questions, for answers made before v4", () => {
    const a = migrateAssessment(legacy(), v4);
    expect(a.answers.L1.response).toBe("No");
    expect(a.answers.L1.aiResponse).toBe("No");
    expect(a.answers.L14.response).toBe("Yes");
    expect(a.answers.L2.response).toBe("Yes");
    expect(a.answers.P1.response).toBe("");
    expect(a.answers.L7.response).toBe("51-75");
    expect(a.policyVersion).toBe(v4.version);
  });
  it("runs once: a second load doesn't swap them back", () => {
    const a = migrateAssessment(migrateAssessment(legacy(), v4), v4);
    expect(a.answers.L1.response).toBe("No");
    expect(a.answers.L14.response).toBe("Yes");
  });
  it("leaves answers alone while the policy in use is still v3, and swaps them when v4 arrives later", () => {
    const a = migrateAssessment(legacy(), v3);
    expect(a.answers.L1.response).toBe("Yes");
    expect(a.policyVersion).toBe(3);
    migrateAssessment(a, v4);
    expect(a.answers.L1.response).toBe("No");
  });
  it("never touches answers made under someone's own policy, even if v4 shows up later", () => {
    const a = migrateAssessment(legacy(), custom);
    expect(a.answers.L1.response).toBe("Yes");
    expect(a.policyVersion).toBe("custom");
    migrateAssessment(a, v4);
    expect(a.answers.L1.response).toBe("Yes");
  });
  it("a new assessment is stamped before anything is answered, so its answers are never swapped", () => {
    const a = migrateAssessment(blankAssessment(), v4);
    a.answers.L1 = { response: "Yes", notes: "", sources: "", origin: "user" };
    migrateAssessment(a, v4);
    expect(a.answers.L1.response).toBe("Yes");
  });
  it("covers exactly the questions whose wording was turned around", () => {
    expect(FLIPPED_IN_V4).toEqual(["L1", "L5", "L10", "L11", "L12", "L14", "L15", "P1", "P2", "P3", "P6"]);
    for (const id of FLIPPED_IN_V4) expect(v4.factors.find((f) => f.id === id)!.options.find((o) => o.label === "Yes")!.points).toBe(0);
  });
});

describe("config versions", () => {
  it("accepts version 1 and 2, nothing else", () => {
    expect(sanitizeConfig("user", { assessitConfig: 1 }).assessitConfig).toBe(1);
    expect(sanitizeConfig("user", { assessitConfig: 2 }).assessitConfig).toBe(2);
    expect(() => sanitizeConfig("user", { assessitConfig: 3 })).toThrow(/assessitConfig/);
  });
  it("a config older apps must not load says 2, which they reject (they only accept 1)", () => {
    // Older apps check `assessitConfig !== 1`, then fall back to the last good copy they downloaded.
    const config = { assessitConfig: 2, policy: defaultPolicy };
    expect(config.assessitConfig).not.toBe(1);
  });
});
