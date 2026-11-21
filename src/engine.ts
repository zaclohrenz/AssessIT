// Scoring engine: a direct port of the "Weights" tab formulas in the reference workbook.
// Read SCORING.md first. The whole model is the riskScore() function below; the rest of
// this file adds up points from the answers and turns the score into a decision.

import type { Answer, Assessment, Band, Factor, OrgSettings, Policy, Section } from "./types";

export interface FactorResult {
  factor: Factor;
  response: string;
  points: number;
  maxPoints: number;
  status: "Not scored" | "Ignored" | "Answered" | "Required" | "Optional";
  missingRequired: boolean;
  hardStopHit: boolean;
  /** How far the final score would move if this factor had its lowest-risk answer. */
  scoreImpact: number;
}

export interface Driver {
  rank: number;
  factor: Factor;
  response: string;
  points: number;
  scoreReduction: number;
  evidence: string;
}

export interface Result {
  factors: FactorResult[];
  likelihood: number;
  likelihoodMax: number;
  likelihoodBand: string;
  impact: number;
  impactMax: number;
  impactBand: string;
  preference: number;
  preferenceMax: number;
  mitigationRaw: number;
  mitigationApplied: number;
  unmitigated: number;
  score: number;
  maxScore: number;
  band: Band;
  requiredCount: number;
  requiredUnanswered: string[];
  hardStops: string[];
  optionalAnswered: number;
  calculatedDecision: "Incomplete" | Band["decision"];
  finalDecision: "Incomplete" | Band["decision"];
  overridden: boolean;
  denialThreshold: number | null;
  creditedMitigations: string[];
  drivers: Driver[];
  mitigations: Driver[];
  reReviewMonths: number;
  reReviewDate: string | null; // YYYY-MM-DD
}

/**
 * THE FORMULA.
 *
 *   Risk Score = Likelihood × Impact × Preference multiplier × (1 − Mitigation credit)
 *
 * - likelihood:  sum of Likelihood points (signs an incident is more likely)
 * - impact:      sum of Impact points (how bad an incident would be)
 * - preference:  1.0 + 0.5 for each organization-preference concern answered "Yes"
 * - mitigation:  fraction of the score removed by controls in place, capped (default 25%)
 *
 * Likelihood × Impact follows NIST SP 800-30 Rev. 1. The golden cases in
 * tests/scoring-cases.csv pin this down; if you change it, those tests will tell you.
 */
export function riskScore(likelihood: number, impact: number, preference: number, mitigation: number): number {
  return likelihood * impact * preference * (1 - mitigation);
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** Excel MATCH(x, mins, 1): the last band whose minimum is <= x (mins ascend). */
export function bandFor<K extends "scoreMin" | "likelihoodMin" | "impactMin">(
  bands: Band[],
  key: K,
  value: number,
): Band {
  let hit = bands[0];
  for (const b of bands) if (b[key] <= value) hit = b;
  return hit;
}

/** Excel EDATE: add months, clamping to the last day of the target month. */
export function addMonths(isoDate: string, months: number): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1 + months;
  const d = Number(m[3]);
  const ty = y + Math.floor(mo / 12);
  const tm = ((mo % 12) + 12) % 12;
  const last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  const dt = new Date(Date.UTC(ty, tm, Math.min(d, last)));
  return dt.toISOString().slice(0, 10);
}

/** True when the question allows it and the assessor chose to ignore it. */
export const isIgnored = (f: Factor, ans?: Answer): boolean => !!f.ignorable && !!ans?.ignored;

export function compute(policy: Policy, a: Assessment): Result {
  const rows = policy.factors.map((f) => {
    const response = (a.answers[f.id]?.response ?? "").trim();
    const ignored = isIgnored(f, a.answers[f.id]);
    const scored = f.enabled && !ignored;
    const opt = f.options.find((o) => o.label === response);
    const points = scored && response && opt ? opt.points : 0;
    const maxPoints = scored ? Math.max(0, ...f.options.map((o) => o.points)) : 0;
    const missingRequired = scored && f.required && !response;
    const hardStopHit = scored && !!f.hardStop && response === f.hardStop;
    const status: FactorResult["status"] = ignored
      ? "Ignored"
      : !scored
      ? "Not scored"
      : response
        ? "Answered"
        : f.required
          ? "Required"
          : "Optional";
    return { factor: f, response, points, maxPoints, status, missingRequired, hardStopHit, scoreImpact: 0 };
  });

  const total = (s: Section, k: "points" | "maxPoints") =>
    sum(rows.filter((r) => r.factor.section === s).map((r) => r[k]));

  const likelihood = total("Likelihood", "points");
  const impact = total("Impact", "points");
  const preference = policy.basePreferenceMultiplier + total("Preference", "points");
  const mitigationRaw = total("Mitigation", "points");
  const mitigationApplied = Math.min(policy.maxMitigationCredit, mitigationRaw);
  const unmitigated = riskScore(likelihood, impact, preference, 0);
  const score = riskScore(likelihood, impact, preference, mitigationApplied);
  const likelihoodMax = total("Likelihood", "maxPoints");
  const impactMax = total("Impact", "maxPoints");
  const preferenceMax = policy.basePreferenceMultiplier + total("Preference", "maxPoints");

  // Weights!Z: marginal effect of each factor on the final score.
  for (const r of rows) {
    if (r.points === 0) continue;
    const keep = 1 - mitigationApplied;
    switch (r.factor.section) {
      case "Likelihood":
        r.scoreImpact = r.points * impact * preference * keep;
        break;
      case "Impact":
        r.scoreImpact = r.points * likelihood * preference * keep;
        break;
      case "Preference":
        r.scoreImpact = r.points * likelihood * impact * keep;
        break;
      case "Mitigation":
        r.scoreImpact =
          -unmitigated * (mitigationApplied - Math.min(policy.maxMitigationCredit, mitigationRaw - r.points));
        break;
    }
  }

  const band = bandFor(policy.bands, "scoreMin", score);
  const requiredUnanswered = rows.filter((r) => r.missingRequired).map((r) => r.factor.id);
  const hardStops = rows
    .filter((r) => r.hardStopHit)
    .map((r) => `${r.factor.id} ${r.factor.factor} = ${r.response}`);
  const creditedMitigations = rows
    .filter((r) => r.factor.section === "Mitigation" && r.points > 0)
    .map((r) => r.factor.factor);

  let calculatedDecision: Result["calculatedDecision"];
  if (requiredUnanswered.length) calculatedDecision = "Incomplete";
  else if (hardStops.length) calculatedDecision = "Denied";
  else if (band.decision === "Approved" && mitigationApplied > 0 && policy.mitigationsMakeConditional)
    calculatedDecision = "Approved with Conditions";
  else calculatedDecision = band.decision;

  const override = a.details.override;
  const finalDecision = override || calculatedDecision;

  const evidence = (id: string) => a.answers[id]?.notes ?? "";
  // Ties break toward the earlier row, like the workbook's (100-ROW())/1e6 nudge.
  const drivers = rows
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.scoreImpact > 0)
    .sort((x, y) => y.r.scoreImpact - x.r.scoreImpact || x.i - y.i)
    .slice(0, 6)
    .map(({ r }, k) => ({
      rank: k + 1,
      factor: r.factor,
      response: r.response,
      points: r.points,
      scoreReduction: r.scoreImpact,
      evidence: evidence(r.factor.id),
    }));
  const mitigations = rows
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.factor.section === "Mitigation" && r.points > 0)
    // Weights!AB: rank by score reduction, then by nominal credit, then row order.
    .sort((x, y) => -y.r.scoreImpact + x.r.scoreImpact || y.r.points - x.r.points || x.i - y.i)
    .slice(0, 5)
    .map(({ r }, k) => ({
      rank: k + 1,
      factor: r.factor,
      response: r.response,
      points: r.points,
      scoreReduction: -r.scoreImpact,
      evidence: evidence(r.factor.id),
    }));

  const denied = policy.bands.find((b) => b.decision === "Denied");
  const reReviewMonths = band.reReviewMonths;
  const reReviewDate =
    calculatedDecision === "Incomplete" ? null : addMonths(a.details.assessmentDate, reReviewMonths);

  return {
    factors: rows,
    likelihood,
    likelihoodMax,
    likelihoodBand: bandFor(policy.bands, "likelihoodMin", likelihood).name,
    impact,
    impactMax,
    impactBand: bandFor(policy.bands, "impactMin", impact).name,
    preference,
    preferenceMax,
    mitigationRaw,
    mitigationApplied,
    unmitigated,
    score,
    maxScore: riskScore(likelihoodMax, impactMax, preferenceMax, 0),
    band,
    requiredCount: rows.filter((r) => r.status !== "Not scored" && r.status !== "Ignored" && r.factor.required).length,
    requiredUnanswered,
    hardStops,
    optionalAnswered: rows.filter((r) => r.status !== "Ignored" && r.factor.enabled && !r.factor.required && r.response).length,
    calculatedDecision,
    finalDecision,
    overridden: !!override,
    denialThreshold: denied ? denied.scoreMin : null,
    creditedMitigations,
    drivers,
    mitigations,
    reReviewMonths,
    reReviewDate,
  };
}

// ---------- Narrative text (Report tab formulas) ----------

const f1 = (n: number) => n.toFixed(1);
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function formatDate(iso: string | null, style: "short" | "monthYear" = "short"): string {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  if (style === "monthYear") return `${MONTHS[m - 1]} ${y}`;
  return `${MONTHS[m - 1].slice(0, 3)} ${d}, ${y}`;
}

export function summary(r: Result, a: Assessment): string {
  let s: string;
  if (r.calculatedDecision === "Incomplete") {
    s = `No decision yet: ${r.requiredUnanswered.length} required question(s) unanswered (${r.requiredUnanswered.join(", ")}). Finish the questionnaire.`;
  } else if (r.hardStops.length) {
    s = `Denied by hard-stop rule regardless of score: ${r.hardStops.join("; ")}.`;
  } else {
    s = `Risk score ${f1(r.score)} lands in the ${r.band.name} band (${r.band.scoreMin}+), which policy maps to ${r.band.decision}.`;
    if (r.calculatedDecision === "Approved with Conditions")
      s += ` Approval depends on keeping these mitigations in place: ${r.creditedMitigations.join("; ")}.`;
    if (r.drivers.length)
      s += ` Biggest drivers: ${r.drivers.slice(0, 3).map((d) => d.factor.factor).join(", ")}.`;
  }
  if (r.overridden) {
    s += `  OVERRIDE to ${a.details.override}: ${a.details.overrideJustification || "[justification missing]"}`;
    if (a.details.riskAcceptedBy) s += ` (risk accepted by ${a.details.riskAcceptedBy})`;
  }
  return s;
}

export function pathToApproval(r: Result, maxCredit: number): string {
  if (r.calculatedDecision === "Incomplete") return "Answer the remaining required questions first.";
  if (r.hardStops.length) return "Resolve the hard stop(s) above. The score alone cannot approve this.";
  if (r.denialThreshold === null) return "No band is set to Denied in the policy.";
  if (r.score < r.denialThreshold) return `Already below the denial line (${r.denialThreshold}).`;
  const top = r.drivers[0]?.scoreReduction ?? 0;
  return (
    `Score must fall below ${r.denialThreshold} (now ${f1(r.score)}). ` +
    `Resolving the top driver alone would bring it to ${f1(r.score - top)}; ` +
    `mitigations can remove up to ${Math.round(maxCredit * 100)}% (currently ${Math.round(r.mitigationApplied * 100)}%).`
  );
}

export function draftMessage(r: Result, a: Assessment, org: OrgSettings): string {
  const sw = a.details.product || "[Software]";
  const team = a.details.requestingTeam || "team";
  const when = formatDate(r.reReviewDate, "monthYear");
  const scoreTxt = `risk score ${f1(r.score)}, ${r.band.name} band`;
  switch (r.finalDecision) {
    case "Incomplete":
      return "(Finish the questionnaire to generate a message.)";
    case "Approved":
      return `Subject: ${sw} approved for use\n\nHi ${team},\n\nThanks for submitting ${sw} for review. We have finished the risk assessment and it is approved for use (${scoreTxt}).\n\nPlease follow any usage guidelines in ${org.policyLink}. We will re-review it around ${when}.\n\nThanks,\n${org.reviewTeam}`;
    case "Approved with Conditions":
      return `Subject: ${sw} approved with conditions\n\nHi ${team},\n\nThanks for submitting ${sw} for review. It is approved for use (${scoreTxt}) as long as these conditions stay in place: ${r.creditedMitigations.join("; ") || "[list conditions]"}.\n\nIf any of these change, please let us know so we can re-assess. Re-review is due around ${when}.\n\nThanks,\n${org.reviewTeam}`;
    default: {
      let body = `Thanks for submitting ${sw} for review. After assessment it carries more risk than ${org.orgName} can accept (${scoreTxt}).`;
      if (r.hardStops.length) body += ` It also triggered a hard-stop rule: ${r.hardStops.join("; ")}.`;
      if (r.drivers.length) body += ` The main concerns: ${r.drivers.slice(0, 3).map((d) => d.factor.factor).join(", ")}.`;
      return `Subject: ${sw} not approved for use\n\nHi ${team},\n\n${body}\n\nIf this tool is essential and no alternative fits, leadership can review and formally accept the risk. See ${org.policyLink}.\n\nThanks,\n${org.reviewTeam}`;
    }
  }
}
