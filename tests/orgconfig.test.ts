import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { chooseConfig, DEFAULT_CONFIG_URL, sanitizeConfig } from "../src/orgconfig";
import { DEFAULT_RULES, DEFAULT_SETTINGS, effectiveSettings, lockedPaths, migrateAssessment, orgRules, type OrgConfig } from "../src/settings";
import type { Policy } from "../src/types";
import defaultPolicy from "../src/policy/default-policy.json";

const none = { source: "none" as const, url: null };

describe("which config applies", () => {
  it("managed (MDM / Group Policy) beats everything, even a URL the user typed", () => {
    expect(chooseConfig({ source: "managed", url: "https://it.example/a.json" }, { configUrl: "https://mine.json" })).toEqual({
      kind: "managed",
      url: "https://it.example/a.json",
    });
  });
  it("a URL typed in Settings beats the install-time one", () => {
    expect(chooseConfig({ source: "install", url: "https://brew.example/c.json" }, { configUrl: "https://mine.example/c.json" }).kind).toBe("user");
  });
  it("install-time URL beats the public default", () => {
    expect(chooseConfig({ source: "install", url: "https://brew.example/c.json" }, {})).toEqual({ kind: "install", url: "https://brew.example/c.json" });
  });
  it("a locked install-time config stays put even if the user typed another URL or turned it off", () => {
    const install = { source: "install" as const, url: "https://corp.example/c.json" };
    expect(chooseConfig(install, { configUrl: "https://mine.example/c.json" }, true)).toEqual({ kind: "install", url: install.url });
    expect(chooseConfig(install, { configUrl: "" }, true).kind).toBe("install");
    expect(chooseConfig(install, { configUrl: "" }, false).kind).toBe("off");
  });
  it("falls back to the public defaults from the latest release", () => {
    expect(chooseConfig(none, {})).toEqual({ kind: "default", url: DEFAULT_CONFIG_URL });
  });
  it("users can turn remote config off", () => {
    expect(chooseConfig(none, { configUrl: "" })).toEqual({ kind: "off", url: null });
  });
});

describe("sanitizing configs", () => {
  const full = {
    assessitConfig: 1,
    lock: true,
    org: { orgName: "Contoso", reviewTeam: "Risk", evil: 1 },
    submit: { method: "webhook", webhookUrl: "https://prod.example/hook" },
    model: "opus",
    policy: defaultPolicy,
  };

  it("the public default config can only ship a policy, never a webhook", () => {
    const c = sanitizeConfig("default", full);
    expect(c.submit).toBeUndefined();
    expect(c.org).toBeUndefined();
    expect(c.lock).toBeUndefined();
    expect(c.policy?.factors).toHaveLength(35);
  });

  it("an organization's config keeps its settings and drops unknown keys", () => {
    const c = sanitizeConfig("managed", full);
    expect(c.org).toEqual({ orgName: "Contoso", reviewTeam: "Risk" });
    expect(c.submit).toEqual({ method: "webhook", webhookUrl: "https://prod.example/hook" });
    expect(c.lock).toBe(true);
  });

  it("keeps lock lists and rules, rejects unknown lock names", () => {
    const c = sanitizeConfig("install", { assessitConfig: 1, lock: ["submit", "policy"], rules: { allowYolo: false, allowOverride: "no", junk: false } });
    expect(c.lock).toEqual(["submit", "policy"]);
    expect(c.rules).toEqual({ allowYolo: false });
    expect(() => sanitizeConfig("install", { assessitConfig: 1, lock: ["scores"] })).toThrow(/Unknown lock "scores"/);
  });

  it("the public default config can't lock anything or set rules", () => {
    const c = sanitizeConfig("default", { assessitConfig: 1, lock: true, rules: { allowYolo: false } });
    expect(c.lock).toBeUndefined();
    expect(c.rules).toBeUndefined();
  });

  it("rejects files that aren't AssessIT configs, and insecure webhook URLs", () => {
    expect(() => sanitizeConfig("user", { hello: 1 })).toThrow(/assessitConfig/);
    expect(() => sanitizeConfig("user", { assessitConfig: 1, submit: { webhookUrl: "http://plain.example" } })).toThrow(/https/);
    expect(() => sanitizeConfig("user", { assessitConfig: 1, submit: { webhookUrl: "http://localhost.evil.example/x" } })).toThrow(/https/);
    expect(sanitizeConfig("user", { assessitConfig: 1, submit: { webhookUrl: "http://127.0.0.1:8765/hook" } }).submit?.webhookUrl).toBe("http://127.0.0.1:8765/hook");
    expect(() => sanitizeConfig("user", { assessitConfig: 1, policy: { factors: [] } })).toThrow(/policy/i);
  });
});

describe("effective settings", () => {
  const org: OrgConfig = { assessitConfig: 1, org: { orgName: "Contoso" }, submit: { method: "webhook", webhookUrl: "https://h" } };

  it("unlocked org config sets defaults the user can still change", () => {
    const s = effectiveSettings({ org: { orgName: "My team" } }, org);
    expect(s.org.orgName).toBe("My team");
    expect(s.submit.webhookUrl).toBe("https://h");
    expect(s.org.reviewTeam).toBe(DEFAULT_SETTINGS.org.reviewTeam);
  });

  it("locked org config wins over the user's edits", () => {
    const s = effectiveSettings({ org: { orgName: "My team" }, submit: { method: "none" } }, { ...org, lock: true });
    expect(s.org.orgName).toBe("Contoso");
    expect(s.submit.method).toBe("webhook");
    expect([...lockedPaths({ ...org, lock: true })].sort()).toEqual(["org.orgName", "policy", "submit.method", "submit.webhookUrl"]);
  });

  it("an unlocked destination is a default the user can change", () => {
    const s = effectiveSettings({ submit: { webhookUrl: "https://my-own-flow" } }, org);
    expect(s.submit.method).toBe("webhook");
    expect(s.submit.webhookUrl).toBe("https://my-own-flow");
  });

  it("locking only some parts leaves the rest editable", () => {
    const s = effectiveSettings({ org: { orgName: "My team" }, submit: { webhookUrl: "https://elsewhere" } }, { ...org, lock: ["submit"] });
    expect(s.org.orgName).toBe("My team");
    expect(s.submit.webhookUrl).toBe("https://h");
  });

  it("locking the policy stops users scoring with an imported policy", () => {
    const mine = { ...(defaultPolicy as Policy), name: "Lenient" };
    expect(effectiveSettings({ policy: mine }, org).policy?.name).toBe("Lenient");
    expect(effectiveSettings({ policy: mine }, { ...org, lock: ["policy"] }).policy).toBeNull(); // null = built-in default
  });

  it("rules default to allowed; an org config can turn them off", () => {
    expect(orgRules(null)).toEqual(DEFAULT_RULES);
    expect(orgRules({ ...org, rules: { allowOverride: false } })).toEqual({ ...DEFAULT_RULES, allowOverride: false });
  });

  it("no config, no edits = built-in defaults", () => {
    expect(effectiveSettings({}, null)).toEqual(DEFAULT_SETTINGS);
  });
});

describe("migrating old assessments", () => {
  it("moves Culture answers C1–C3 to Organization preferences P1–P3", () => {
    const a = migrateAssessment({
      details: {} as any,
      answers: { C1: { response: "Yes", notes: "n", sources: "", origin: "user" }, P2: { response: "No", notes: "", sources: "", origin: "user" }, C2: { response: "Yes", notes: "", sources: "", origin: "user" } },
    });
    expect(a.answers.P1.response).toBe("Yes");
    expect(a.answers.P2.response).toBe("No"); // an existing P answer wins
    expect(a.answers.C1).toBeUndefined();
  });
});

describe("example configs in config/", () => {
  const load = (f: string) => JSON.parse(readFileSync(new URL(`../config/${f}`, import.meta.url), "utf8"));

  it("the everyday example pre-fills a destination users can still change", () => {
    const c = sanitizeConfig("install", load("example-org-config.json"));
    expect(c.lock).toBeUndefined();
    const s = effectiveSettings({ submit: { method: "none" } }, c);
    expect(s.submit.method).toBe("none");
  });

  it("the managed example locks everything and turns on every rule", () => {
    const c = sanitizeConfig("managed", load("example-locked-org-config.json"));
    expect(lockedPaths(c)).toContain("submit.siteUrl");
    expect(lockedPaths(c)).toContain("policy");
    expect(orgRules(c)).toEqual({ allowOverride: false, allowYolo: false });
  });
});
