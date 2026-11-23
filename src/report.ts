// Everything that leaves the app: SharePoint/webhook fields, the HTML report, and the Excel export.

import pkg from "../package.json";
import { compute, draftMessage, formatDate, pathToApproval, summary, type Result } from "./engine";
import type { Assessment, Details, OrgSettings, Policy } from "./types";

export const APP_VERSION: string = pkg.version;

/** SharePoint list columns the app writes. Name = internal column name. */
/** Status values on the SharePoint list. The app sets "Submitted"; reviewers set the rest on the list. */
export const STATUSES = ["Submitted", "In review", "Approved", "Approved with conditions", "Denied"] as const;

export const SHAREPOINT_COLUMNS: { name: string; type: "Single line of text" | "Multiple lines of text" | "Number" | "Choice" }[] = [
  { name: "Vendor", type: "Single line of text" },
  { name: "Product", type: "Single line of text" },
  { name: "Plan", type: "Single line of text" },
  { name: "RequestingTeam", type: "Single line of text" },
  { name: "BusinessOwner", type: "Single line of text" },
  { name: "IntendedUse", type: "Multiple lines of text" },
  { name: "AssessmentDate", type: "Single line of text" },
  { name: "Assessors", type: "Single line of text" },
  { name: "RiskScore", type: "Number" },
  { name: "RiskBand", type: "Single line of text" },
  { name: "LikelihoodScore", type: "Number" },
  { name: "ImpactScore", type: "Number" },
  { name: "Decision", type: "Single line of text" },
  { name: "CalculatedDecision", type: "Single line of text" },
  { name: "OverrideJustification", type: "Multiple lines of text" },
  { name: "RiskAcceptedBy", type: "Single line of text" },
  { name: "ReReviewDate", type: "Single line of text" },
  { name: "Conditions", type: "Multiple lines of text" },
  { name: "Summary", type: "Multiple lines of text" },
  { name: "DraftMessage", type: "Multiple lines of text" },
  { name: "Answers", type: "Multiple lines of text" },
  { name: "ReviewFlags", type: "Multiple lines of text" },
  { name: "ChangedFromAI", type: "Multiple lines of text" },
  { name: "AssessmentJSON", type: "Multiple lines of text" },
  { name: "Status", type: "Choice" },
];

/** Columns reviewers fill in on the list. The app never writes these. */
export const REVIEW_COLUMNS: { name: string; type: string; note: string }[] = [
  { name: "DecisionNote", type: "Single line of text", note: "Reason for the decision; list validation requires it for Approved with conditions and Denied" },
  { name: "DecisionDetails", type: "Multiple lines of text, Append changes to existing text", note: "Optional longer explanation" },
];

export function answersText(policy: Policy, a: Assessment, r: Result): string {
  return r.factors
    .filter((f) => f.factor.enabled)
    .map((f) => {
      const ans = a.answers[f.factor.id];
      const src = ans?.origin === "ai" ? " [AI]" : "";
      let line = f.status === "Ignored" ? `${f.factor.id} ${f.factor.factor}: (ignored, not scored)` : `${f.factor.id} ${f.factor.factor}: ${f.response || "(blank)"} (${fmtPts(f.points, f.factor.section)})${src}`;
      if (ans?.notes) line += `\n   ${ans.notes}`;
      if (ans?.sources) line += `\n   Sources: ${ans.sources}`;
      return line;
    })
    .join("\n") + (aiAttestationText(a) ? `\n\n${aiAttestationText(a)}` : "") + `\n\nPolicy: ${policy.name} v${policy.version}`;
}

export function fmtPts(p: number, section: string): string {
  if (section === "Preference") return `+${p}x`;
  if (section === "Mitigation") return p ? `-${Math.round(p * 100)}%` : "0%";
  return `${p} pt${p === 1 ? "" : "s"}`;
}

/** Everything an approver should know before trusting this assessment. Empty = clean. */
/** Request fields that must be filled in before the assessment is complete. */
export const REQUIRED_DETAILS: [keyof Details, string][] = [
  ["vendor", "Vendor name"],
  ["product", "Product"],
  ["plan", "Plan / tier"],
  ["assessors", "Your name"],
  ["intendedUse", "Intended use"],
];

export const missingDetails = (d: Details): string[] =>
  REQUIRED_DETAILS.filter(([k]) => !String(d[k] ?? "").trim()).map(([, label]) => label);

/** The big number on the score tile: a percent of the approval limit when the policy has one. */
export function scoreHeadline(r: Result): string {
  if (r.finalDecision === "Incomplete") return "—";
  return r.meter ? `${r.meter.percent}%` : r.score.toFixed(1);
}

/** What the number means, in a line: lower is better, and where the limit is. */
export function scoreCaption(r: Result, n1: (x: number) => string = (x) => x.toFixed(1)): string {
  if (r.finalDecision === "Incomplete") return "Answer every required question to see it";
  const before = `${n1(r.unmitigated)} before mitigation`;
  return r.meter ? `${n1(r.score)} of ${n1(r.meter.limit)} allowed · lower is better · ${before}` : `lower is better · ${before}`;
}

export const ZONE_LABEL = {
  green: "Within the approval limit",
  yellow: "Over the limit, but more mitigations could bring it under",
  red: "Over the limit, even with every mitigation",
} as const;

/** Answers still marked as coming from AI research (a person editing one makes it theirs). */
export const aiAnswerIds = (a: Assessment): string[] =>
  Object.entries(a.answers)
    .filter(([, x]) => x.origin === "ai" && (x.response || x.notes))
    .map(([id]) => id);

/** One sentence for reports and exports about whether the assessor agreed with the AI's answers. Empty when AI wasn't used. */
export function aiAttestationText(a: Assessment): string {
  const ids = aiAnswerIds(a);
  if (!ids.length) return "";
  const n = `${ids.length} answer${ids.length === 1 ? "" : "s"} came from AI research (${ids.join(", ")})`;
  const at = a.aiAttestation;
  if (!at) return `${n}. The assessor didn't tick the box to say they agree with them.`;
  const when = at.at.slice(0, 10);
  const who = a.details.assessors.trim() || at.by || "The assessor";
  return `${n}. ${who} agreed with them (${when}).`;
}

/**
 * Answers a person changed after AI research proposed something else. Not a problem by itself
 * (that's what reviewing is for), but approvers see it, so a score can't be quietly talked down.
 */
export function changedFromAi(a: Assessment): { id: string; ai: string; now: string }[] {
  return Object.entries(a.answers)
    .filter(([, x]) => x.aiResponse && x.origin === "user" && x.response !== x.aiResponse)
    .map(([id, x]) => ({ id, ai: x.aiResponse!, now: x.response || "(blank)" }));
}

const changedText = (a: Assessment) =>
  changedFromAi(a)
    .map((c) => `${c.id}: AI said ${c.ai}, changed to ${c.now}`)
    .join("\n");

export function reviewFlags(r: Result, a: Assessment): string[] {
  const flags: string[] = [];
  const missing = missingDetails(a.details);
  if (missing.length) flags.push(`Request details missing: ${missing.join(", ")}.`);
  if (r.requiredUnanswered.length)
    flags.push(`${r.requiredUnanswered.length} required question(s) unanswered (${r.requiredUnanswered.join(", ")}), so the decision is Incomplete.`);
  if (a.details.override && !a.details.overrideJustification.trim()) flags.push("Decision was overridden without a justification.");
  return flags;
}

export function listFields(policy: Policy, a: Assessment, org: OrgSettings) {
  const r = compute(policy, a);
  const d = a.details;
  return {
    Title: [d.product, d.vendor].filter(Boolean).join(" — ") || "Untitled assessment",
    Vendor: d.vendor,
    Product: d.product,
    Plan: d.plan,
    RequestingTeam: d.requestingTeam,
    BusinessOwner: d.businessOwner,
    IntendedUse: d.intendedUse,
    AssessmentDate: d.assessmentDate,
    Assessors: d.assessors,
    RiskScore: Math.round(r.score * 100) / 100,
    RiskBand: r.band.name,
    LikelihoodScore: r.likelihood,
    ImpactScore: r.impact,
    Decision: r.finalDecision,
    CalculatedDecision: r.calculatedDecision,
    OverrideJustification: d.overrideJustification,
    RiskAcceptedBy: d.riskAcceptedBy,
    ReReviewDate: r.reReviewDate ?? "",
    Conditions: r.creditedMitigations.join("; "),
    Summary: summary(r, a),
    DraftMessage: draftMessage(r, a, org),
    Answers: answersText(policy, a, r),
    // Empty when the assessment was complete and reviewed; otherwise what the approver should double-check.
    ReviewFlags: reviewFlags(r, a).join("\n"),
    ChangedFromAI: changedText(a),
    // Every raw value from the form, exactly as entered, for audits and reporting.
    AssessmentJSON: JSON.stringify({ appVersion: APP_VERSION, policy: { name: policy.name, version: policy.version }, assessment: a }),
    Status: STATUSES[0],
  };
}

export function webhookPayload(policy: Policy, a: Assessment, org: OrgSettings) {
  const r = compute(policy, a);
  return {
    source: "AssessIT",
    appVersion: APP_VERSION,
    submittedAt: new Date().toISOString(),
    organization: org.orgName,
    reviewFlags: reviewFlags(r, a),
    changedFromAi: changedFromAi(a),
    // Who vouched for AI-proposed answers; null when none came from AI. (Also inside `assessment`.)
    aiReview: aiAnswerIds(a).length ? { answers: aiAnswerIds(a), attestation: a.aiAttestation ?? null } : null,
    fields: listFields(policy, a, org),
    result: {
      score: r.score,
      unmitigatedScore: r.unmitigated,
      maxScore: r.maxScore,
      band: r.band.name,
      likelihood: r.likelihood,
      impact: r.impact,
      preferenceMultiplier: r.preference,
      mitigationCredit: r.mitigationApplied,
      decision: r.finalDecision,
      calculatedDecision: r.calculatedDecision,
      hardStops: r.hardStops,
      drivers: r.drivers.map((x) => ({ factor: x.factor.factor, answer: x.response, scoreReduction: x.scoreReduction })),
      conditions: r.creditedMitigations,
      reReviewDate: r.reReviewDate,
    },
    assessment: a,
    policy: { name: policy.name, version: policy.version },
  };
}

export function decisionTone(decision: string): "ok" | "warn" | "bad" | "muted" {
  if (decision === "Approved") return "ok";
  if (decision === "Approved with Conditions") return "warn";
  if (decision === "Denied") return "bad";
  return "muted";
}

export function xlsxSheets(policy: Policy, a: Assessment, org: OrgSettings) {
  const r = compute(policy, a);
  const d = a.details;
  const n1 = (x: number) => x.toFixed(1);
  return [
    {
      name: "Report",
      title: "Software Risk Assessment Report",
      subtitle: `${d.product || "[Software]"} · ${d.vendor || "[Vendor]"} · assessed ${formatDate(d.assessmentDate)} by ${d.assessors || "[assessor]"}`,
      widths: [28, 22, 16, 12, 16, 70],
      sections: [
        {
          heading: "Decision",
          rows: [[r.finalDecision.toUpperCase() + (r.overridden ? " (OVERRIDE)" : ""), summary(r, a)], ...(aiAttestationText(a) ? [["AI review", aiAttestationText(a)]] : [])],
        },
        {
          heading: "Scores",
          rows: [
            ["Risk score", r.meter ? `${r.meter.percent}% of limit` : n1(r.score), scoreCaption(r, n1)],
            ["Risk band", r.band.name, `Band policy: ${r.band.decision}`],
            ["Likelihood", String(r.likelihood), `${r.likelihoodBand} (max ${r.likelihoodMax})`],
            ["Impact", String(r.impact), `${r.impactBand} (max ${r.impactMax})`],
            ["Preference multiplier", String(r.preference), `max ${r.preferenceMax}`],
            ["Mitigation credit", String(r.mitigationApplied), `cap ${policy.maxMitigationCredit}`],
            ["Required answered", `${r.requiredCount - r.requiredUnanswered.length} / ${r.requiredCount}`, `+ ${r.optionalAnswered} optional`],
            ["Re-review by", r.reReviewDate ?? "—", `every ${r.reReviewMonths} months`],
          ],
        },
        {
          heading: "Biggest risk drivers",
          header: ["Factor", "Section", "Answer", "Points", "Score reduction", "Evidence"],
          rows: r.drivers.map((x) => [x.factor.factor, x.factor.section, x.response, String(x.points), n1(x.scoreReduction), x.evidence]),
        },
        {
          heading: "Mitigations credited",
          header: ["Mitigation", "", "Answer", "Credit", "Score reduction", "Evidence"],
          rows: r.mitigations.map((x) => [x.factor.factor, "", x.response, String(x.points), n1(x.scoreReduction), x.evidence]),
        },
        {
          heading: "Hard stops & path to approval",
          rows: [
            ["Hard stops", r.hardStops.join("; ") || "None triggered."],
            ["Path to approval", pathToApproval(r, policy.maxMitigationCredit)],
          ],
        },
        { heading: "Draft outcome message", rows: [[draftMessage(r, a, org)]] },
      ],
    },
    {
      name: "Input",
      title: "Assessment Input",
      subtitle: "Yellow = entered by the assessor or AI research. Gray = calculated.",
      widths: [6, 12, 60, 20, 70, 50, 12, 10, 16],
      sections: [
        {
          heading: "Assessment details",
          input_cols: [1],
          rows: [
            ["Vendor name", d.vendor],
            ["Software / product", d.product],
            ["Plan / tier", d.plan],
            ["Requesting team", d.requestingTeam],
            ["Business owner", d.businessOwner],
            ["Intended use", d.intendedUse],
            ["Assessment date", d.assessmentDate],
            ["Assessor(s)", d.assessors],
            ["Resources consulted", d.resources],
            ["Decision override", d.override],
            ["Override justification", d.overrideJustification],
            ["Risk accepted by", d.riskAcceptedBy],
          ],
        },
        {
          heading: "Questionnaire",
          header: ["ID", "Section", "Question", "Response", "Notes / evidence", "Source(s)", "Status", "Points", "Answered by"],
          input_cols: [3, 4, 5],
          rows: r.factors.map((f) => {
            const ans = a.answers[f.factor.id];
            const by = !ans?.response ? "" : ans.origin === "ai" ? `AI (${ans.confidence ?? "?"})` : "Assessor";
            const pts = f.factor.section === "Mitigation" && f.points ? -f.points : f.points;
            return [f.factor.id, f.factor.section, f.factor.question, f.response, ans?.notes ?? "", ans?.sources ?? "", f.status, String(pts), by];
          }),
        },
      ],
    },
  ];
}
