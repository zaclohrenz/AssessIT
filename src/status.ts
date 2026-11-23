import { compute, isIgnored } from "./engine";
import { aiAnswerIds, missingDetails, reviewFlags } from "./report";
import type { Settings } from "./settings";
import type { Assessment, Policy, Section } from "./types";

/** The status bubbles in the left-hand pane. */
export type BubbleKind = "todo" | "review" | "ok" | "opt" | "sent" | "hot" | "warm";
export type Bubble = [BubbleKind, string];

/** How many answers are still the AI's (a person editing one makes it theirs). */
export const aiAnswerCount = (a: Assessment) => aiAnswerIds(a).length;

export function sectionStatus(policy: Policy, a: Assessment, sec: Section): Bubble {
  const fs = policy.factors.filter((f) => f.section === sec && f.enabled && !isIgnored(f, a.answers[f.id]));
  const missing = fs.filter((f) => f.required && !a.answers[f.id]?.response).length;
  if (missing) return ["todo", `TODO ${missing}`];
  if (!fs.some((f) => a.answers[f.id]?.response) && !fs.some((f) => f.required)) return ["opt", "OPTIONAL"];
  return ["ok", "OK"];
}

/** A destination is only set up once the fields it needs are filled in. */
export function submitConfigured(s: Settings["submit"]): boolean {
  if (s.method === "webhook") return !!s.webhookUrl.trim();
  if (s.method === "sharepoint") return [s.tenant, s.clientId, s.siteUrl, s.listName].every((x) => x.trim());
  return false;
}

export function navStatus(policy: Policy, a: Assessment, submit: Settings["submit"]) {
  const r = compute(policy, a);
  const detailsMissing = missingDetails(a.details).length;
  const request: Bubble = detailsMissing ? ["todo", `TODO ${detailsMissing}`] : ["ok", "OK"];
  const questions: Bubble = r.requiredUnanswered.length
    ? ["todo", `TODO ${r.requiredUnanswered.length}`]
    : ["ok", "OK"];
  const report: Bubble = a.submitted
    ? ["sent", "SENT"]
    : r.finalDecision === "Incomplete" || detailsMissing
      ? ["todo", "TODO"]
      : reviewFlags(r, a, policy).length
        ? ["review", "REVIEW"]
        : ["ok", "OK"];
  const settings: Bubble = submitConfigured(submit) ? ["ok", "OK"] : ["todo", "SETUP"];
  return { request, questions, report, settings };
}
