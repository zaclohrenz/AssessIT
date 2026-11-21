import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { changedFromAi, listFields, REVIEW_COLUMNS, SHAREPOINT_COLUMNS, STATUSES, webhookPayload, xlsxSheets } from "../src/report";
import defaultPolicy from "../src/policy/default-policy.json";
import example from "./fixtures/example-assessment.json";
import type { Assessment, Policy } from "../src/types";

const policy = defaultPolicy as Policy;
const org = { orgName: "Example Org", reviewTeam: "IT Risk Review", policyLink: "[policy]" };
const a = example as Assessment;

describe("outbound payloads", () => {
  it("SharePoint fields match the documented columns exactly", () => {
    const keys = Object.keys(listFields(policy, a, org)).filter((k) => k !== "Title");
    expect(keys).toEqual(SHAREPOINT_COLUMNS.map((c) => c.name));
  });

  it("number columns get numbers", () => {
    const f = listFields(policy, a, org) as Record<string, unknown>;
    for (const c of SHAREPOINT_COLUMNS) expect(typeof f[c.name]).toBe(c.type === "Number" ? "number" : "string");
    expect(f.RiskScore).toBe(42.75);
    expect(f.Decision).toBe("Approved with Conditions");
  });

  it("documented Power Automate schema covers every field the app sends", () => {
    const schema = JSON.parse(readFileSync("docs/webhook-schema.json", "utf8"));
    const p = webhookPayload(policy, a, org);
    expect(Object.keys(schema.properties.fields.properties).sort()).toEqual(Object.keys(p.fields).sort());
  });
});

describe("exports", () => {
  it("Excel sheets match the Rust export_xlsx contract (all cells are strings)", () => {
    const sheets = xlsxSheets(policy, a, org);
    expect(sheets.map((x) => x.name)).toEqual(["Report", "Input"]);
    for (const sh of sheets) {
      expect(typeof sh.title).toBe("string");
      expect(sh.widths.every((w) => typeof w === "number")).toBe(true);
      for (const sec of sh.sections) {
        expect(typeof sec.heading).toBe("string");
        for (const row of sec.rows) for (const cell of row) expect(typeof cell).toBe("string");
        for (const h of ("header" in sec ? sec.header : []) ?? []) expect(typeof h).toBe("string");
      }
    }
    const input = sheets[1].sections[1];
    expect(input.rows).toHaveLength(policy.factors.length);
    expect(input.rows.find((r) => r[0] === "M3")!.slice(3, 4).concat(input.rows.find((r) => r[0] === "M3")![7])).toEqual(["Yes", "-0.05"]);
  });


  it("approvers see answers a person changed from what AI research found", () => {
    const a = structuredClone(example) as Assessment;
    a.answers.L2 = { response: "No", notes: "", sources: "", origin: "user", aiResponse: "Yes" };
    a.answers.L3 = { response: "Yes", notes: "", sources: "", origin: "user", aiResponse: "Yes" }; // reviewed, unchanged
    a.answers.L4 = { response: "No", notes: "", sources: "", origin: "ai", aiResponse: "No" }; // not reviewed yet
    expect(changedFromAi(a)).toEqual([{ id: "L2", ai: "Yes", now: "No" }]);
    const p = webhookPayload(defaultPolicy as Policy, a, { orgName: "X", reviewTeam: "Y", policyLink: "Z" });
    expect(p.fields.ChangedFromAI).toBe("L2: AI said Yes, changed to No");
    expect(p.changedFromAi).toHaveLength(1);
  });
});

describe("SharePoint setup guide", () => {
  const doc = readFileSync(new URL("../docs/sharepoint-setup.md", import.meta.url), "utf8");
  it("documents every column the app writes, and every status", () => {
    for (const c of SHAREPOINT_COLUMNS) expect(doc).toContain(`| ${c.name} | ${c.type} |`);
    for (const s of STATUSES) expect(doc).toContain(`\`${s}\``);
    for (const c of REVIEW_COLUMNS) expect(doc).toContain(`| ${c.name} |`);
  });
  it("the note rule names real statuses and the review column", () => {
    const formula = doc.match(/^=IF\(.*$/m)![0];
    for (const s of formula.match(/"([^"]+)"/g)!) expect(STATUSES).toContain(s.slice(1, -1));
    expect(formula).toContain("[DecisionNote]");
  });
  it("the setup script creates every column, status and the same note rule", () => {
    const script = readFileSync(new URL("../scripts/sharepoint-setup.js", import.meta.url), "utf8");
    const cols = [...script.matchAll(/\["(\w+)", "\w+"\]/g)].map((m) => m[1]);
    expect(cols.sort()).toEqual([...SHAREPOINT_COLUMNS, ...REVIEW_COLUMNS].map((c) => c.name).sort());
    expect(script).toContain(JSON.stringify(STATUSES).replaceAll(",", ", "));
    expect(script).toContain(`'${doc.match(/^=IF\(.*$/m)![0]}'`);
  });
  it("new submissions start as Submitted and carry the raw form values", () => {
    const f = listFields(policy, a, org);
    expect(f.Status).toBe("Submitted");
    expect(JSON.parse(f.AssessmentJSON).assessment).toEqual(a);
  });
});
