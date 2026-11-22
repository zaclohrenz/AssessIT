import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import defaultPolicy from "../src/policy/default-policy.json";
import { sanitizeConfig } from "../src/orgconfig";
import { FACTOR_ID, validatePolicy } from "../src/settings";

const withId = (id: unknown) => ({
  ...defaultPolicy,
  factors: [{ ...defaultPolicy.factors[0], id }, ...defaultPolicy.factors.slice(1)],
});

describe("policy question IDs are checked at the door", () => {
  it("the default policy's IDs all pass", () => {
    for (const f of defaultPolicy.factors) expect(f.id).toMatch(FACTOR_ID);
    expect(() => validatePolicy(defaultPolicy)).not.toThrow();
  });
  it.each([
    ['L1"><img src=x onerror=alert(1)>'],
    ["L1' onfocus='x"],
    ["<script>"],
    ["L 1"],
    ["1L"],
    [""],
    ["L".repeat(17)],
    ["L1\n"],
    [42],
    [null],
  ])("rejects %j", (id) => {
    expect(() => validatePolicy(withId(id))).toThrow(/Question ID/);
  });
  it("rejects a repeated ID", () => {
    const dup = { ...defaultPolicy, factors: [defaultPolicy.factors[0], defaultPolicy.factors[0]] };
    expect(() => validatePolicy(dup)).toThrow(/used twice/);
  });
  it("rejects a version that isn't a short number or label", () => {
    expect(() => validatePolicy({ ...defaultPolicy, version: "<b>3</b>" })).toThrow(/version/i);
    expect(() => validatePolicy({ ...defaultPolicy, version: "2.1" })).not.toThrow();
  });
  it("also stops a bad ID arriving in an org config (the remote path)", () => {
    expect(() => sanitizeConfig("install", { assessitConfig: 1, policy: withId('x"y') })).toThrow(/Question ID/);
  });
});

describe("markup guard", () => {
  // Defence in depth: validation above keeps bad IDs out, and every policy ID that reaches markup is escaped too.
  it("never prints a policy question ID into HTML without esc()", () => {
    const src = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    expect(src.match(/\$\{f\.id\}/g) ?? []).toEqual([]);
  });
});
