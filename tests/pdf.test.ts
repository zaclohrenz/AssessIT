import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reportPdf } from "../src/pdf";
import defaultPolicy from "../src/policy/default-policy.json";
import example from "./fixtures/example-assessment.json";
import type { Assessment, Policy } from "../src/types";

// Node build of pdfmake with real font files; the app uses the browser build with the same document.
const require = createRequire(import.meta.url);
const pdfmake = require("pdfmake");
pdfmake.addFonts(require("pdfmake/fonts/Roboto"));

const policy = defaultPolicy as Policy;
const org = { orgName: "Example Org", reviewTeam: "IT Risk Review", policyLink: "[policy]" };

async function render(a: Assessment): Promise<Buffer> {
  return pdfmake.createPdf(reportPdf(policy, a, org)).getBuffer();
}

describe("PDF report", () => {
  it("renders a real multi-page PDF", async () => {
    const buf = await render(example as Assessment);
    expect(buf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(buf.length).toBeGreaterThan(20_000);
    expect((buf.toString("latin1").match(/\/Type\s*\/Page\b/g) ?? []).length).toBeGreaterThanOrEqual(2);
    writeFileSync(join(tmpdir(), "assessit-report-test.pdf"), buf);
  });

  it("puts open issues in the PDF when submitted YOLO-style", () => {
    const a = structuredClone(example) as Assessment;
    a.answers.L1.response = "";
    a.answers.L2.origin = "ai";
    expect(JSON.stringify(reportPdf(policy, a, org).content)).toContain("OPEN ISSUES: NOT READY TO SUBMIT");
    a.submitted = { at: "2026-01-01T00:00:00Z", method: "sharepoint", flagged: true };
    const dd = JSON.stringify(reportPdf(policy, a, org).content);
    expect(dd).toContain("SUBMITTED WITH OPEN ISSUES");
    expect(dd).toContain("1 required question(s) unanswered (L1)");
    expect(dd).toContain("weren't reviewed by a person (L2)");
  });

  it("shows the AI's original answer when a person changed it", () => {
    const a = structuredClone(example) as Assessment;
    a.answers.L2 = { ...a.answers.L2, response: "No", aiResponse: "Yes", origin: "user" };
    expect(JSON.stringify(reportPdf(policy, a, org).content)).toContain("AI said: Yes");
  });

  it("clean assessments carry no issues box", () => {
    expect(JSON.stringify(reportPdf(policy, example as Assessment, org).content)).not.toContain("OPEN ISSUES");
  });
});
