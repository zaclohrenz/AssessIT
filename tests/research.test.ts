import { describe, expect, it } from "vitest";
import { manualPrompt, mergeResearch, parseManualResponse, researchPrompt, researchSchema } from "../src/research";
import defaultPolicy from "../src/policy/default-policy.json";
import type { Assessment, Policy } from "../src/types";

const policy = defaultPolicy as Policy;
const blank = (): Assessment => ({
  details: {
    vendor: "Acme", product: "Widget", plan: "", requestingTeam: "", businessOwner: "", intendedUse: "",
    assessmentDate: "2026-11-20", assessors: "", resources: "", override: "", overrideJustification: "", riskAcceptedBy: "",
  },
  answers: {},
});
const ans = (id: string, response: string) => ({
  id, response, notes: `n-${id}`, sources: ["https://example.com"], confidence: "high" as const, needs_confirmation: false,
});

describe("research", () => {
  it("prompt lists every enabled question and marks internal ones", () => {
    const p = researchPrompt(policy, blank().details, "2026-11-20");
    for (const f of policy.factors) expect(p).toContain(`- ${f.id} (`);
    expect(p).toMatch(/- M1 \(Mitigation\)[^\n]*\n\s+Options:[\s\S]*?\n\s+INTERNAL/);
  });

  it("spells out what each answer means, so negatively worded questions can't be inverted", () => {
    const p = researchPrompt(policy, blank().details, "2026-11-20");
    expect(p).toContain('"Yes" = No specific time limit found');
    expect(p).toContain('"No" = The contract commits to a specific time limit');
    expect(p).toMatch(/Yes means the good thing is MISSING/);
  });

  it("tells the AI that looking and finding nothing is an answer, not a blank", () => {
    const p = researchPrompt(policy, blank().details, "2026-11-20");
    expect(p).toMatch(/found no evidence it exists, answer Yes/);
    expect(p).toMatch(/A search that finds nothing is a No, not a blank/);
    expect(p).toMatch(/notes say something is missing[^.]*the response must be the option that means missing/);
  });

  it("asks for the evidence before the answer", () => {
    const props = Object.keys((researchSchema(policy) as any).properties.answers.items.properties);
    expect(props.indexOf("notes")).toBeLessThan(props.indexOf("response"));
  });

  it("schema restricts ids", () => {
    const s = researchSchema(policy) as any;
    expect(s.properties.answers.items.properties.id.enum).toHaveLength(policy.factors.length);
  });

  it("never overwrites user answers and drops invalid options", () => {
    const a = blank();
    a.answers.L1 = { response: "No", notes: "", sources: "", origin: "user" };
    const res = mergeResearch(policy, a, {
      answers: [ans("L1", "Yes"), ans("L2", "Maybe"), ans("L3", "No"), ans("M1", "No")],
      resources_consulted: "trust center",
    });
    expect(res).toEqual({ filled: 3, skipped: 1 });
    expect(a.answers.L1.response).toBe("No");
    expect(a.answers.L2.response).toBe("");
    expect(a.answers.L2.notes).toBe("n-L2");
    expect(a.answers.L3).toMatchObject({ response: "No", origin: "ai", needsConfirmation: false });
    expect(a.answers.M1.needsConfirmation).toBe(true);
    expect(a.details.resources).toBe("trust center");
  });

  it("re-running research replaces earlier AI answers", () => {
    const a = blank();
    mergeResearch(policy, a, { answers: [ans("L3", "No")], resources_consulted: "" });
    mergeResearch(policy, a, { answers: [ans("L3", "Yes")], resources_consulted: "" });
    expect(a.answers.L3.response).toBe("Yes");
  });
});

describe("copy & paste with other AIs", () => {
  it("prompt asks for a single JSON block", () => {
    const p = manualPrompt(policy, blank().details, "2026-11-20");
    expect(p).toContain("reply with ONLY one JSON code block");
    expect(p).toContain("- P3 (Preference)");
  });

  it("parses a chatty reply with a fenced block and normalizes sloppy fields", () => {
    const reply = `Sure! Here's what I found.

\`\`\`json
{"answers":[
  {"id":"l1","response":"no","notes":"SOC 2 listed","sources":"https://a.com; https://b.com","confidence":"HIGH"},
  {"id":"L7","response":"Not Rated","notes":"none found","sources":[],"confidence":"low","needs_confirmation":false},
  {"id":"ZZ9","response":"Yes","notes":"","sources":[]}
],"resources_consulted":"trust center"}
\`\`\`
Let me know if you need more.`;
    const out = parseManualResponse(policy, reply);
    expect(out.answers).toEqual([
      { id: "L1", response: "No", notes: "SOC 2 listed", sources: ["https://a.com", "https://b.com"], confidence: "high", needs_confirmation: false },
      { id: "L7", response: "Not rated", notes: "none found", sources: [], confidence: "low", needs_confirmation: false },
    ]);
    const a = blank();
    expect(mergeResearch(policy, a, out).filled).toBe(2);
    expect(a.answers.L7.response).toBe("Not rated");
  });

  it("accepts bare JSON without a code fence", () => {
    const out = parseManualResponse(policy, `{"answers":[{"id":"L2","response":"Yes","notes":"x","sources":["u"],"confidence":"medium","needs_confirmation":true}],"resources_consulted":""}`);
    expect(out.answers[0]).toMatchObject({ id: "L2", response: "Yes", confidence: "medium" });
  });

  it("explains when there's nothing to parse", () => {
    expect(() => parseManualResponse(policy, "I can't browse the web, sorry.")).toThrow(/Couldn't find the answers/);
  });
});
