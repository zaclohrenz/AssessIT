// The PDF report as a pdfmake document definition. Pure data: the app renders it with the
// browser build (src/main.ts), tests render it with the Node build (tests/pdf.test.ts).

import type { Content, TableCell, TDocumentDefinitions } from "pdfmake/interfaces";
import { bandFor, compute, draftMessage, formatDate, pathToApproval, summary } from "./engine";
import { APP_VERSION, decisionTone, fmtPts, reviewFlags } from "./report";
import type { Assessment, OrgSettings, Policy } from "./types";

const NAVY = "#1f3a5f";
const MUTED = "#5b6475";
const TONES = {
  ok: { fill: "#e3f4e8", ink: "#14532d" },
  warn: { fill: "#fff1bf", ink: "#5c4400" },
  bad: { fill: "#fde2e1", ink: "#7f1d1d" },
  muted: { fill: "#eef0f4", ink: "#1d2433" },
};
const BAND_FILLS = ["#cfe8d6", "#e4efc4", "#fbe6a6", "#f8c79a", "#f2a3a0"];

// headlineLevel lets pageBreakBefore() keep a heading with the content under it.
const h2 = (text: string): Content => ({ text: text.toUpperCase(), style: "h2", headlineLevel: 1 });
const th = (text: string): TableCell => ({ text, style: "th" });
const lines = { hLineColor: () => "#dde2ea", vLineColor: () => "#dde2ea", hLineWidth: () => 0.5, vLineWidth: () => 0 };

export function reportPdf(policy: Policy, a: Assessment, org: OrgSettings): TDocumentDefinitions {
  const r = compute(policy, a);
  const d = a.details;
  const tone = TONES[decisionTone(r.finalDecision)];
  const flags = reviewFlags(r, a);
  const n1 = (x: number) => x.toFixed(1);
  const pct = (x: number) => `${Math.round(x * 100)}%`;

  const tile = (k: string, v: string, s: string): TableCell => ({
    stack: [
      { text: k.toUpperCase(), style: "tileKey" },
      { text: v, style: "tileVal" },
      { text: s, style: "tileSub" },
    ],
    margin: [6, 6, 6, 6],
  });

  const bandIndex = (score: number) => policy.bands.indexOf(bandFor(policy.bands, "scoreMin", score));
  const fill = (score: number) =>
    BAND_FILLS[Math.min(4, Math.round((bandIndex(score) / Math.max(1, policy.bands.length - 1)) * 4))];
  const k = r.preference * (1 - r.mitigationApplied);
  const L = Math.max(1, Math.min(12, Math.round(r.likelihood)));
  const I = Math.max(1, Math.min(12, Math.round(r.impact)));
  const heat: TableCell[][] = [];
  for (let i = 12; i >= 1; i--) {
    const row: TableCell[] = [{ text: String(i), style: "axis" }];
    for (let l = 1; l <= 12; l++) {
      const v = l * i * k;
      const me = l === L && i === I && r.finalDecision !== "Incomplete";
      row.push(me ? { text: String(Math.round(v)), fillColor: NAVY, style: "heatMe" } : { text: String(Math.round(v)), fillColor: fill(v), style: "heat" });
    }
    heat.push(row);
  }
  heat.push([{ text: "" }, ...Array.from({ length: 12 }, (_, j) => ({ text: String(j + 1), style: "axis" }))]);

  const content: Content[] = [
    { text: "Software Risk Assessment", style: "h1" },
    { text: `${d.product || "[Software]"} · ${d.vendor || "[Vendor]"}${d.plan ? ` · ${d.plan}` : ""}`, style: "sub" },
    {
      text: `Assessed ${formatDate(d.assessmentDate)} by ${d.assessors || "[assessor]"} · Requested by ${d.requestingTeam || "[team]"} · Owner ${d.businessOwner || "—"}`,
      style: "sub",
      margin: [0, 0, 0, 10],
    },
    {
      table: {
        widths: ["*"],
        body: [[{
          stack: [
            { text: r.finalDecision.toUpperCase() + (r.overridden ? " (OVERRIDE)" : ""), bold: true, fontSize: 18, color: tone.ink },
            { text: summary(r, a), color: tone.ink, margin: [0, 4, 0, 0] },
          ],
          fillColor: tone.fill,
          margin: [10, 8, 10, 8],
        }]],
      },
      layout: "noBorders",
    },
  ];

  if (flags.length)
    content.push({
      table: {
        widths: ["*"],
        body: [[{
          stack: [
            { text: a.submitted?.flagged ? "SUBMITTED WITH OPEN ISSUES" : "OPEN ISSUES: NOT READY TO SUBMIT", bold: true, color: TONES.bad.ink, fontSize: 9 },
            { ul: flags, color: TONES.bad.ink, margin: [0, 3, 0, 0] },
          ],
          fillColor: TONES.bad.fill,
          margin: [10, 6, 10, 6],
        }]],
      },
      layout: "noBorders",
      margin: [0, 6, 0, 0],
    });

  content.push(
    {
      table: {
        widths: ["*", "*", "*", "*"],
        body: [
          [
            tile("Risk score", r.finalDecision === "Incomplete" ? "—" : n1(r.score), `of ${r.maxScore.toFixed(0)} max · ${n1(r.unmitigated)} before mitigation`),
            tile("Risk band", r.band.name, `Band policy: ${r.band.decision}`),
            tile("Likelihood", String(r.likelihood), `${r.likelihoodBand} (max ${r.likelihoodMax})`),
            tile("Impact", String(r.impact), `${r.impactBand} (max ${r.impactMax})`),
          ],
          [
            tile("Preference multiplier", `×${r.preference.toFixed(1)}`, `max ×${r.preferenceMax.toFixed(1)}`),
            tile("Mitigation credit", r.mitigationApplied ? `−${pct(r.mitigationApplied)}` : "0%", `cap ${pct(policy.maxMitigationCredit)}`),
            tile("Required answered", `${r.requiredCount - r.requiredUnanswered.length} / ${r.requiredCount}`, `+ ${r.optionalAnswered} optional`),
            tile("Re-review by", formatDate(r.reReviewDate) || "—", `every ${r.reReviewMonths} months`),
          ],
        ],
      },
      layout: lines,
      margin: [0, 10, 0, 0],
    },
    h2("Intended use"),
    { text: d.intendedUse || "—" },
    h2("Biggest risk drivers"),
    r.drivers.length
      ? {
          table: {
            headerRows: 1,
            keepWithHeaderRows: 1,
            dontBreakRows: true,
            widths: [14, 110, 70, 40, "*"],
            body: [
              [th("#"), th("Factor"), th("Answer"), th("Reduction"), th("Evidence")],
              ...r.drivers.map((x) => [String(x.rank), x.factor.factor, x.response, n1(x.scoreReduction), { text: x.evidence, fontSize: 8 }]),
            ],
          },
          layout: lines,
        }
      : { text: "No factors are adding to the score.", color: MUTED },
    h2("Mitigations credited"),
    r.mitigations.length
      ? {
          table: {
            headerRows: 1,
            keepWithHeaderRows: 1,
            dontBreakRows: true,
            widths: [130, 45, 45, "*"],
            body: [
              [th("Mitigation"), th("Credit"), th("Reduction"), th("Evidence")],
              ...r.mitigations.map((x) => [x.factor.factor, fmtPts(x.points, "Mitigation"), n1(x.scoreReduction), { text: x.evidence, fontSize: 8 }]),
            ],
          },
          layout: lines,
        }
      : { text: "None credited.", color: MUTED },
    h2("Hard stops & path to approval"),
    {
      text: [
        { text: "Hard stops: ", bold: true },
        r.hardStops.join("; ") || "None triggered.",
        "\n",
        { text: "Path to approval: ", bold: true },
        pathToApproval(r, policy.maxMitigationCredit),
      ],
    },
    h2("Heat map"),
    { text: "Columns are likelihood, rows are impact. The dark cell is this assessment.", color: MUTED, fontSize: 8, margin: [0, 0, 0, 4] },
    { table: { widths: [12, ...Array(12).fill(18)], body: heat }, layout: "noBorders" },
    h2("Draft outcome message"),
    { table: { widths: ["*"], body: [[{ text: draftMessage(r, a, org), fillColor: "#f4f6f9", margin: [8, 6, 8, 6] }]] }, layout: "noBorders" },
    { text: "", pageBreak: "before" },
    h2("Questionnaire"),
    {
      table: {
        headerRows: 1,
        keepWithHeaderRows: 1,
        dontBreakRows: true,
        widths: [20, "*", 62, 30, "*"],
        body: [
          [th("ID"), th("Question"), th("Answer"), th("Points"), th("Notes, sources & basis")],
          ...r.factors
            .filter((f) => f.factor.enabled)
            .map((f): TableCell[] => {
              const ans = a.answers[f.factor.id];
              const basis =
                f.factor.basis === "preference"
                  ? "Org preference"
                  : f.factor.references.map((x) => `${x.source}${x.id ? ` ${x.id}` : ""}`).join("; ");
              return [
                f.factor.id,
                { text: f.factor.question, fontSize: 8 },
                {
                  stack: [
                    { text: [f.status === "Ignored" ? "Ignored" : f.response || "—", ans?.origin === "ai" ? { text: "  AI", color: "#3b2a8f", bold: true, fontSize: 7 } : ""] },
                    // A person changed what AI research found: show the original.
                    ...(ans?.aiResponse && ans.origin === "user" && ans.response !== ans.aiResponse
                      ? [{ text: `AI said: ${ans.aiResponse}`, fontSize: 7, color: TONES.warn.ink, bold: true }]
                      : []),
                  ],
                },
                fmtPts(f.points, f.factor.section),
                {
                  stack: [
                    { text: ans?.notes ?? "", fontSize: 8 },
                    ...(ans?.sources ? [{ text: ans.sources, fontSize: 7, color: MUTED }] : []),
                    { text: basis, fontSize: 7, color: NAVY, italics: true },
                  ],
                },
              ];
            }),
        ],
      },
      layout: lines,
    },
    h2("Resources consulted"),
    { text: d.resources || "—" },
  );

  return {
    info: { title: `Risk Assessment: ${d.product || "Software"}`, creator: `AssessIT ${APP_VERSION}` },
    pageSize: "LETTER",
    pageMargins: [40, 40, 40, 50],
    defaultStyle: { font: "Roboto", fontSize: 9.5, color: "#1d2433", lineHeight: 1.2 },
    styles: {
      h1: { fontSize: 20, bold: true, color: NAVY },
      sub: { color: MUTED },
      h2: { fontSize: 10, bold: true, color: NAVY, margin: [0, 14, 0, 4], characterSpacing: 0.5 },
      th: { bold: true, fontSize: 8, color: MUTED, fillColor: "#f4f6f9" },
      tileKey: { fontSize: 7, bold: true, color: MUTED, characterSpacing: 0.4 },
      tileVal: { fontSize: 16, bold: true },
      tileSub: { fontSize: 7.5, color: MUTED },
      heat: { fontSize: 6.5, alignment: "center" },
      heatMe: { fontSize: 7, bold: true, alignment: "center", color: "#ffffff" },
      axis: { fontSize: 6.5, color: MUTED, alignment: "center" },
    },
    // Never leave a section heading alone at the bottom of a page.
    pageBreakBefore: (node, rest) => node.headlineLevel === 1 && rest.getFollowingNodesOnPage().length < 2,
    footer: (page: number, pages: number) => ({
      columns: [
        { text: `AssessIT ${APP_VERSION} · ${policy.name} v${policy.version}`, color: MUTED, fontSize: 7.5 },
        { text: `Page ${page} of ${pages}`, alignment: "right", color: MUTED, fontSize: 7.5 },
      ],
      margin: [40, 16, 40, 0],
    }),
    content,
  };
}
