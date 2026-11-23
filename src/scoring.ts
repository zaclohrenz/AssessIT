import type { Policy, PolicyEdits, Section } from "./types";

/**
 * Editing the scoring weights. The defaults follow NIST / CISA guidance, so every change is checked, listed
 * against the baseline, needs a written reason, and is stamped on every report made with it.
 */

export const REASON_MIN = 10;
export const REASON_MAX = 500;

/** What a point value may be, per section. Mitigation points are a share of credit (0.05 = 5%). */
export const POINT_LIMITS: Record<Section, { min: number; max: number }> = {
  Likelihood: { min: 0, max: 10 },
  Impact: { min: 0, max: 10 },
  Preference: { min: 0, max: 2 },
  Mitigation: { min: 0, max: 0.5 },
};
export const MITIGATION_CAP_LIMITS = { min: 0, max: 0.5 };
export const PREFERENCE_BASE_LIMITS = { min: 0.5, max: 3 };
export const DECISIONS = ["Approved", "Approved with Conditions", "Denied"] as const;

export const clonePolicy = (p: Policy): Policy => JSON.parse(JSON.stringify(p));

const num = (x: unknown) => typeof x === "number" && Number.isFinite(x);

/**
 * Everything wrong with a scoring policy, in plain words. Empty = safe to save. Used by the editor; the loose
 * version of the same number checks also guards every policy that comes in from a file or URL.
 */
export function validateScoring(p: Policy): string[] {
  const errs: string[] = [];
  if (!num(p.maxMitigationCredit) || p.maxMitigationCredit < MITIGATION_CAP_LIMITS.min || p.maxMitigationCredit > MITIGATION_CAP_LIMITS.max)
    errs.push("Maximum mitigation credit must be between 0% and 50%.");
  if (!num(p.basePreferenceMultiplier) || p.basePreferenceMultiplier < PREFERENCE_BASE_LIMITS.min || p.basePreferenceMultiplier > PREFERENCE_BASE_LIMITS.max)
    errs.push("The base preference multiplier must be between 0.5 and 3.");
  if (!p.bands.length) errs.push("There must be at least one band.");
  p.bands.forEach((b, i) => {
    if (!num(b.scoreMin) || b.scoreMin < 0) errs.push(`Band “${b.name}”: the score cut-off must be a number, 0 or more.`);
    if (!num(b.likelihoodMin) || b.likelihoodMin < 0) errs.push(`Band “${b.name}”: the likelihood cut-off must be a number, 0 or more.`);
    if (!num(b.impactMin) || b.impactMin < 0) errs.push(`Band “${b.name}”: the impact cut-off must be a number, 0 or more.`);
    if (!num(b.reReviewMonths) || b.reReviewMonths < 1 || b.reReviewMonths > 60 || !Number.isInteger(b.reReviewMonths))
      errs.push(`Band “${b.name}”: re-review must be a whole number of months, 1 to 60.`);
    if (!DECISIONS.includes(b.decision)) errs.push(`Band “${b.name}”: unknown decision.`);
    if (i === 0 && b.scoreMin !== 0) errs.push("The first band must start at 0, or low scores would match no band.");
    if (i > 0 && num(b.scoreMin) && b.scoreMin <= p.bands[i - 1].scoreMin) errs.push(`Band “${b.name}” must start above the band before it.`);
  });
  if (!p.bands.some((b) => b.decision === "Denied")) errs.push("One band must be Denied: it sets the approval limit.");
  for (const f of p.factors) {
    const lim = POINT_LIMITS[f.section];
    for (const o of f.options) {
      if (!num(o.points) || o.points < lim.min || o.points > lim.max)
        errs.push(`${f.id} “${o.label}”: points must be a number from ${fmtPoints(f.section, lim.min)} to ${fmtPoints(f.section, lim.max)}.`);
    }
    if (f.hardStop !== null && !f.options.some((o) => o.label === f.hardStop)) errs.push(`${f.id}: the hard stop isn't one of its answers.`);
    if (f.required && !f.enabled) errs.push(`${f.id}: a question that's switched off can't be required.`);
  }
  return errs;
}

/** Points as the page shows them: mitigation as a percent, preference as ×. */
export const fmtPoints = (s: Section, v: number): string => (s === "Mitigation" ? `${round(v * 100)}%` : s === "Preference" ? `+${round(v)}×` : String(round(v)));
const round = (x: number) => Math.round(x * 1000) / 1000;

/** Every difference from the baseline policy, one short line each. */
export function diffPolicy(base: Policy, next: Policy): string[] {
  const out: string[] = [];
  const g = (label: string, a: unknown, b: unknown) => a !== b && out.push(`${label}: ${a} → ${b}`);
  g("Maximum mitigation credit", `${round(base.maxMitigationCredit * 100)}%`, `${round(next.maxMitigationCredit * 100)}%`);
  g("Base preference multiplier", base.basePreferenceMultiplier, next.basePreferenceMultiplier);
  g("Mitigations make approval conditional", base.mitigationsMakeConditional, next.mitigationsMakeConditional);
  next.bands.forEach((nb, i) => {
    const bb = base.bands[i];
    if (!bb) return out.push(`Band “${nb.name}” added`);
    g(`Band “${nb.name}” score cut-off`, bb.scoreMin, nb.scoreMin);
    g(`Band “${nb.name}” likelihood cut-off`, bb.likelihoodMin, nb.likelihoodMin);
    g(`Band “${nb.name}” impact cut-off`, bb.impactMin, nb.impactMin);
    g(`Band “${nb.name}” decision`, bb.decision, nb.decision);
    g(`Band “${nb.name}” re-review months`, bb.reReviewMonths, nb.reReviewMonths);
  });
  for (const nf of next.factors) {
    const bf = base.factors.find((f) => f.id === nf.id);
    if (!bf) continue;
    for (const o of nf.options) {
      const bo = bf.options.find((x) => x.label === o.label);
      if (bo) g(`${nf.id} “${o.label}” points`, fmtPoints(nf.section, bo.points), fmtPoints(nf.section, o.points));
    }
    g(`${nf.id} on`, bf.enabled, nf.enabled);
    g(`${nf.id} required`, bf.required, nf.required);
    g(`${nf.id} hard stop`, bf.hardStop ?? "none", nf.hardStop ?? "none");
  }
  return out;
}

/** The reason has to say something: not blank, not a single repeated character. */
export function reasonProblem(reason: string): string | null {
  const r = reason.trim();
  if (r.length < REASON_MIN) return `Say why in at least ${REASON_MIN} characters. It's kept on every report made with these weights.`;
  if (r.length > REASON_MAX) return `Keep the reason under ${REASON_MAX} characters.`;
  if (new Set(r.toLowerCase().replace(/\s/g, "")).size < 4) return "Give a real reason.";
  return null;
}

/**
 * The policy to save: the edited weights plus a record of what changed against the baseline and why.
 * Null when nothing differs from the baseline (the caller then drops the local copy).
 */
export function withEdits(base: Policy, next: Policy, reason: string, now = new Date()): Policy | null {
  const changes = diffPolicy(base, next);
  if (!changes.length) return null;
  const edits: PolicyEdits = { at: now.toISOString(), reason: reason.trim().slice(0, REASON_MAX), changes: changes.slice(0, 200) };
  return { ...clonePolicy(next), edits };
}

/** "Name v4", or "Name v4 (edited locally)": what reports and exports print. */
export const policyLabel = (p: Pick<Policy, "name" | "version" | "edits">): string => `${p.name} v${p.version}${p.edits ? " (edited locally)" : ""}`;

/** One review flag for approvers when the weights aren't the stock ones. */
export const policyEditFlag = (p: Pick<Policy, "edits">): string | null =>
  p.edits ? `Scoring weights were edited locally on ${p.edits.at.slice(0, 10)} (${p.edits.changes.length} change${p.edits.changes.length === 1 ? "" : "s"}). Reason given: ${p.edits.reason}` : null;
