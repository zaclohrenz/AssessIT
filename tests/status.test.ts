import { describe, expect, it } from "vitest";
import { reviewFlags } from "../src/report";
import { compute } from "../src/engine";
import { navStatus, sectionStatus, submitConfigured } from "../src/status";
import { blankAssessment, DEFAULT_SETTINGS } from "../src/settings";
import defaultPolicy from "../src/policy/default-policy.json";
import example from "./fixtures/example-assessment.json";
import type { Assessment, Policy } from "../src/types";

const policy = defaultPolicy as Policy;
const hook = { ...DEFAULT_SETTINGS.submit, method: "webhook" as const, webhookUrl: "https://example.com/hook" };
const none = DEFAULT_SETTINGS.submit;
const fresh = (): Assessment => structuredClone(example) as Assessment;

describe("left-pane status bubbles", () => {
  it("a complete, reviewed assessment is all OK", () => {
    const s = navStatus(policy, fresh(), hook);
    expect(s).toEqual({ request: ["ok", "OK"], questions: ["ok", "OK"], report: ["ok", "OK"], settings: ["ok", "OK"] });
  });

  it("clearing vendor and plan turns Request and Report back to TODO", () => {
    const a = fresh();
    a.details.vendor = "";
    a.details.plan = "  ";
    const s = navStatus(policy, a, hook);
    expect(s.request).toEqual(["todo", "TODO 2"]);
    expect(s.report[0]).toBe("todo");
    expect(reviewFlags(compute(policy, a), a)[0]).toMatch(/Vendor name, Plan/);
  });

  it("every required request field counts", () => {
    expect(navStatus(policy, blankAssessment(), hook).request).toEqual(["todo", "TODO 5"]);
  });

  it("clearing a required answer shows TODO on its section and the questionnaire", () => {
    const a = fresh();
    const f = policy.factors.find((x) => x.required)!;
    a.answers[f.id].response = "";
    expect(sectionStatus(policy, a, f.section)).toEqual(["todo", "TODO 1"]);
    expect(navStatus(policy, a, hook).questions).toEqual(["todo", "TODO 1"]);
  });

  it("AI answers are a reminder, never a to-do: nothing is held up while some are still the AI's", () => {
    const a = fresh();
    const f = policy.factors.find((x) => x.section === "Impact")!;
    a.answers[f.id].origin = "ai";
    expect(sectionStatus(policy, a, "Impact")).toEqual(["ok", "OK"]);
    expect(navStatus(policy, a, hook).questions).toEqual(["ok", "OK"]);
    expect(navStatus(policy, a, hook).report).toEqual(["ok", "OK"]);
  });

  it("settings need a submit destination; submitted shows SENT", () => {
    const a = fresh();
    expect(navStatus(policy, a, none).settings).toEqual(["todo", "SETUP"]);
    expect(navStatus(policy, a, { ...hook, webhookUrl: " " }).settings).toEqual(["todo", "SETUP"]);
    expect(submitConfigured({ ...none, method: "sharepoint", tenant: "t", clientId: "c", siteUrl: "https://x" })).toBe(true);
    expect(submitConfigured({ ...none, method: "sharepoint", tenant: "t" })).toBe(false);
    a.submitted = { at: "2026-01-01T00:00:00Z", method: "webhook", flagged: false };
    expect(navStatus(policy, a, hook).report).toEqual(["sent", "SENT"]);
  });
});
