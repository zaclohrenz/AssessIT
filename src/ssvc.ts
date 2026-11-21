// Vulnerability triage with CISA's SSVC decision trees. Pure functions: the tables are
// transcribed from CISA's own publications and checked row by row in tests/ssvc.test.ts.
//
//  - CISA SSVC decision (Track / Track* / Attend / Act):
//      CISA Stakeholder-Specific Vulnerability Categorization Guide (Nov 2022), Tables 8 and 9.
//  - Remediation timeline:
//      CISA BOD 26-04 "Prioritizing Security Updates Based on Risk" (June 10, 2026), Table 1.

export type Exploitation = "none" | "poc" | "active";
export type YesNo = "yes" | "no";
export type TechnicalImpact = "partial" | "total";
export type MissionPrevalence = "minimal" | "support" | "essential";
export type WellBeing = "minimal" | "material" | "irreversible";
export type MissionWellBeing = "low" | "medium" | "high";
export type CisaDecision = "Track" | "Track*" | "Attend" | "Act";
export type Timeline = "upgrade" | "60d" | "14d" | "3d" | "3d+forensic";

/** Where an answer came from, so the page can show it and the user can see what to trust. */
export type AnswerSource = "cisa" | "kev" | "you";

export interface VulnAnswers {
  exploitation?: Exploitation;
  automatable?: YesNo;
  technicalImpact?: TechnicalImpact;
  inKev?: YesNo;
  publiclyExposed?: YesNo;
  missionPrevalence?: MissionPrevalence;
  wellBeing?: WellBeing;
}
export type VulnKey = keyof VulnAnswers;

// ---------------- The two trees ----------------

/** SSVC Guide, Table 8: Mission Prevalence × Public Well-Being Impact. */
export function missionWellBeing(mp: MissionPrevalence, wb: WellBeing): MissionWellBeing {
  if (mp === "essential" || wb === "irreversible") return "high";
  if (mp === "minimal" && wb === "minimal") return "low";
  return "medium";
}

// SSVC Guide, Table 9. Index order: exploitation (none, poc, active) × automatable (no, yes)
// × technical impact (partial, total) × mission & well-being (low, medium, high).
const T = "Track", TS = "Track*", AT = "Attend", AC = "Act";
const CISA_TABLE: CisaDecision[] = [
  T, T, T,    T, T, TS,   // none,   automatable no:  partial | total
  T, T, AT,   T, T, AT,   // none,   automatable yes
  T, T, TS,   T, TS, AT,  // poc,    automatable no
  T, T, AT,   T, TS, AT,  // poc,    automatable yes
  T, T, AT,   T, AT, AC,  // active, automatable no
  AT, AT, AC, AT, AC, AC, // active, automatable yes
];

export function cisaDecision(e: Exploitation, a: YesNo, t: TechnicalImpact, mwb: MissionWellBeing): CisaDecision {
  const i =
    ["none", "poc", "active"].indexOf(e) * 12 + ["no", "yes"].indexOf(a) * 6 + ["partial", "total"].indexOf(t) * 3 + ["low", "medium", "high"].indexOf(mwb);
  return CISA_TABLE[i];
}

/** BOD 26-04, Table 1. */
export function remediationTimeline(exposed: YesNo, kev: YesNo, a: YesNo, t: TechnicalImpact): Timeline {
  const total = t === "total";
  if (kev === "yes") {
    if (total && (a === "yes" || exposed === "yes")) return "3d+forensic";
    if (exposed === "yes" && a === "yes") return "3d";
    return "14d";
  }
  if (exposed === "yes") {
    if (a === "yes") return total ? "3d" : "14d";
    return total ? "14d" : "60d";
  }
  return a === "yes" ? "60d" : "upgrade";
}

// ---------------- Answers -> results ----------------

export function cisaResult(x: VulnAnswers): CisaDecision | null {
  if (!x.exploitation || !x.automatable || !x.technicalImpact || !x.missionPrevalence || !x.wellBeing) return null;
  return cisaDecision(x.exploitation, x.automatable, x.technicalImpact, missionWellBeing(x.missionPrevalence, x.wellBeing));
}

export function timelineResult(x: VulnAnswers): Timeline | null {
  if (!x.publiclyExposed || !x.inKev || !x.automatable || !x.technicalImpact) return null;
  return remediationTimeline(x.publiclyExposed, x.inKev, x.automatable, x.technicalImpact);
}

/** "What would the result be if this answer were `value`?" Used to label each option button. */
export function whatIf<K extends VulnKey>(x: VulnAnswers, key: K, value: NonNullable<VulnAnswers[K]>) {
  const y = { ...x, [key]: value };
  return { decision: cisaResult(y), timeline: timelineResult(y) };
}

// ---------------- Questions and meanings ----------------

export interface VulnQuestion {
  key: VulnKey;
  label: string;
  question: string;
  /** Who normally knows the answer. */
  from: "cisa" | "org";
  /** Which result this feeds. */
  feeds: ("decision" | "timeline")[];
  options: { value: string; label: string; meaning: string }[];
}

// Wording follows CISA's definitions (SSVC Guide; Vulnrichment / CERT/CC SSVC decision points; BOD 26-04).
export const VULN_QUESTIONS: VulnQuestion[] = [
  {
    key: "inKev",
    label: "In KEV",
    question: "Is it in CISA's Known Exploited Vulnerabilities catalog?",
    from: "cisa",
    feeds: ["timeline"],
    options: [
      { value: "no", label: "No", meaning: "Not listed in the KEV catalog." },
      { value: "yes", label: "Yes", meaning: "Listed in KEV: CISA has evidence it's being exploited in the wild." },
    ],
  },
  {
    key: "exploitation",
    label: "Exploitation",
    question: "What's the current state of exploitation?",
    from: "cisa",
    feeds: ["decision"],
    options: [
      { value: "none", label: "None", meaning: "No evidence of active exploitation and no public proof of concept." },
      { value: "poc", label: "Public PoC", meaning: "A typical public proof of concept exists (Metasploit, ExploitDB), or there's a well-known way to exploit it." },
      { value: "active", label: "Active", meaning: "Shared, observable, reliable evidence it's being used in the wild by real attackers." },
    ],
  },
  {
    key: "automatable",
    label: "Automatable",
    question: "Can an attacker reliably automate exploiting it?",
    from: "cisa",
    feeds: ["decision", "timeline"],
    options: [
      { value: "no", label: "No", meaning: "Attackers can't reliably automate reconnaissance, weaponization, delivery and exploitation." },
      { value: "yes", label: "Yes", meaning: "All four steps (reconnaissance, weaponization, delivery, exploitation) can be reliably automated." },
    ],
  },
  {
    key: "technicalImpact",
    label: "Technical impact",
    question: "How much control does exploiting it give the attacker?",
    from: "cisa",
    feeds: ["decision", "timeline"],
    options: [
      { value: "partial", label: "Partial", meaning: "Limited control over, or information exposure from, the vulnerable software. Denial of service counts here." },
      { value: "total", label: "Total", meaning: "Total control over the software's behavior, or total disclosure of all information on the system." },
    ],
  },
  {
    key: "publiclyExposed",
    label: "Publicly exposed",
    question: "Is the affected asset reachable from the internet?",
    from: "org",
    feeds: ["timeline"],
    options: [
      { value: "no", label: "No", meaning: "Not accessible to unauthenticated or untrusted people over public networks." },
      { value: "yes", label: "Yes", meaning: "Unauthenticated or untrusted people can reach it over public networks, such as the internet." },
    ],
  },
  {
    key: "missionPrevalence",
    label: "Mission prevalence",
    question: "How important is the affected component to what your organization does?",
    from: "org",
    feeds: ["decision"],
    options: [
      { value: "minimal", label: "Minimal", meaning: "Used, but not mission-essential and doesn't meaningfully support mission-essential functions." },
      { value: "support", label: "Support", meaning: "Supports mission-essential functions, but doesn't provide them directly." },
      { value: "essential", label: "Essential", meaning: "Directly provides a mission-essential function. Its failure may lead to mission failure." },
    ],
  },
  {
    key: "wellBeing",
    label: "Public well-being",
    question: "If it's exploited, what's the worst effect on people's safety, health or finances?",
    from: "org",
    feeds: ["decision"],
    options: [
      { value: "minimal", label: "Minimal", meaning: "Below the threshold for Material in every respect." },
      {
        value: "material",
        label: "Material",
        meaning: "Physical injury or safety hazards, major damage to others' property or environment, losses likely to bankrupt several people, or widespread psychological harm.",
      },
      {
        value: "irreversible",
        label: "Irreversible",
        meaning: "Multiple fatalities likely, a cyber-physical system destroyed, serious public-health or environmental damage, or social systems (elections, financial grid) destabilized.",
      },
    ],
  },
];

export const DECISION_MEANING: Record<CisaDecision, { summary: string; detail: string; tone: "ok" | "info" | "warn" | "bad" }> = {
  Track: {
    summary: "No action needed right now",
    detail: "Keep tracking it and reassess if new information appears. CISA recommends remediating within standard update timelines.",
    tone: "ok",
  },
  "Track*": {
    summary: "Watch it more closely",
    detail: "It has characteristics that may need closer monitoring for changes. CISA recommends remediating within standard update timelines.",
    tone: "info",
  },
  Attend: {
    summary: "Supervisors need to look at this",
    detail: "Needs attention from supervisory-level people. May mean asking for help or more information, and notifying people internally or externally. CISA recommends remediating sooner than standard update timelines.",
    tone: "warn",
  },
  Act: {
    summary: "Leadership needs to act now",
    detail: "Needs supervisors and leadership. Ask for help or information and notify internally and/or externally. Typically internal groups meet to decide the response, then carry it out. CISA recommends remediating as soon as possible.",
    tone: "bad",
  },
};

export const TIMELINE_MEANING: Record<Timeline, { label: string; detail: string; tone: "ok" | "info" | "warn" | "bad" }> = {
  upgrade: { label: "Fix on system upgrade", detail: "Remediate the next time the asset gets a scheduled major upgrade or rebuild, unless conditions change.", tone: "ok" },
  "60d": { label: "60 days", detail: "Remediate within 60 calendar days.", tone: "info" },
  "14d": { label: "14 days", detail: "Remediate within 14 calendar days.", tone: "warn" },
  "3d": { label: "3 days", detail: "Remediate within 3 calendar days.", tone: "bad" },
  "3d+forensic": {
    label: "3 days + forensic triage",
    detail: "Remediate or mitigate within 3 calendar days, and do a forensic triage of the asset to check whether it's already compromised.",
    tone: "bad",
  },
};

// ---------------- Pre-filling from CISA data ----------------

export interface CveSummary {
  id: string;
  title: string;
  description: string;
  published: string;
  vendor: string;
  product: string;
}

export interface KevEntry {
  cveID: string;
  vendorProject?: string;
  product?: string;
  vulnerabilityName?: string;
  dateAdded?: string;
  dueDate?: string;
  knownRansomwareCampaignUse?: string;
  forensicTriage?: string;
  requiredAction?: string;
}

export interface Prefill {
  answers: VulnAnswers;
  sources: Partial<Record<VulnKey, AnswerSource>>;
  notes: string[];
  /** When CISA's SSVC analysis was recorded, if there is one. */
  cisaAnalyzed?: string;
}

export const CVE_ID = /^CVE-\d{4}-\d{4,}$/;

/** Accepts "cve-2024-3400", " CVE-2024-3400 ", etc. */
export function normalizeCveId(s: string): string | null {
  const id = s.trim().toUpperCase().replace(/\s+/g, "");
  return CVE_ID.test(id) ? id : null;
}

/** Title, description and affected product from a CVE record (CVE JSON 5). */
export function summarizeCve(record: any): CveSummary {
  const cna = record?.containers?.cna ?? {};
  const desc = (cna.descriptions ?? []).find((d: any) => String(d.lang ?? "").startsWith("en")) ?? cna.descriptions?.[0];
  const affected = cna.affected?.[0] ?? {};
  return {
    id: record?.cveMetadata?.cveId ?? "",
    title: cna.title ?? "",
    description: desc?.value ?? "",
    published: String(record?.cveMetadata?.datePublished ?? "").slice(0, 10),
    vendor: affected.vendor ?? "",
    product: affected.product ?? "",
  };
}

/** CISA's SSVC answers from the CVE record's "CISA ADP Vulnrichment" container, plus KEV. */
export function prefillFromCisa(record: any, kev: KevEntry | null): Prefill {
  const out: Prefill = { answers: {}, sources: {}, notes: [] };
  const adp = (record?.containers?.adp ?? []).find((c: any) => c?.providerMetadata?.shortName === "CISA-ADP");
  const ssvc = (adp?.metrics ?? []).map((m: any) => m?.other).find((o: any) => o?.type === "ssvc")?.content;
  const opt = (name: string) =>
    String((ssvc?.options ?? []).find((o: any) => o && name in o)?.[name] ?? "")
      .toLowerCase()
      .trim();
  const e = opt("Exploitation");
  if (e === "none" || e === "poc" || e === "active") out.answers.exploitation = e;
  else if (e === "public poc") out.answers.exploitation = "poc";
  const a = opt("Automatable");
  if (a === "yes" || a === "no") out.answers.automatable = a;
  const t = opt("Technical Impact");
  if (t === "partial" || t === "total") out.answers.technicalImpact = t;
  for (const k of ["exploitation", "automatable", "technicalImpact"] as const) if (out.answers[k]) out.sources[k] = "cisa";
  if (ssvc?.timestamp) out.cisaAnalyzed = String(ssvc.timestamp).slice(0, 10);

  const kevInRecord = (adp?.metrics ?? []).some((m: any) => m?.other?.type === "kev");
  out.answers.inKev = kev || kevInRecord ? "yes" : "no";
  out.sources.inKev = "kev";
  // KEV only lists vulnerabilities with evidence of active exploitation, and can be newer than the SSVC analysis.
  if (out.answers.inKev === "yes" && out.answers.exploitation !== "active") {
    if (out.answers.exploitation) out.notes.push(`CISA's SSVC analysis said exploitation was "${out.answers.exploitation}", but it's now in KEV, so it's active.`);
    out.answers.exploitation = "active";
    out.sources.exploitation = "kev";
  }
  if (!ssvc) out.notes.push("CISA hasn't published an SSVC analysis for this CVE yet, so answer those questions yourself.");
  return out;
}

/** Plain-text summary for a ticket or chat message. */
export function triageText(cve: CveSummary | null, x: VulnAnswers, kev: KevEntry | null): string {
  const d = cisaResult(x);
  const tl = timelineResult(x);
  const lines = [
    cve ? `${cve.id}${cve.title ? `: ${cve.title}` : ""}` : "Vulnerability triage",
    d ? `CISA SSVC decision: ${d} (${DECISION_MEANING[d].summary.toLowerCase()})` : "CISA SSVC decision: not enough answers yet",
    tl ? `BOD 26-04 remediation timeline: ${TIMELINE_MEANING[tl].label}` : "BOD 26-04 remediation timeline: not enough answers yet",
    "",
    ...VULN_QUESTIONS.map((q) => `${q.label}: ${q.options.find((o) => o.value === x[q.key])?.label ?? "(not answered)"}`),
  ];
  if (kev) lines.push("", `KEV: added ${kev.dateAdded ?? "?"}, federal due date ${kev.dueDate ?? "?"}, ransomware use ${kev.knownRansomwareCampaignUse ?? "unknown"}`);
  return lines.join("\n");
}
