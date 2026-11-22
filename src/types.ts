export type Section = "Likelihood" | "Impact" | "Preference" | "Mitigation";
export type Decision = "Approved" | "Approved with Conditions" | "Denied";

export interface Option {
  label: string;
  points: number;
  /** What choosing this answer means, in plain words ("No written deletion promise found"). Shown to the person and sent to the AI. */
  hint?: string;
}

export interface Factor {
  id: string;
  section: Section;
  factor: string;
  question: string;
  options: Option[];
  enabled: boolean;
  required: boolean;
  /** If the response equals this label, the decision is Denied regardless of score. */
  hardStop: string | null;
  /** "public" = answerable from web research; "internal" = only the requester knows. */
  research: "public" | "internal";
  /** "standard" = grounded in published guidance (NIST, CISA, ...); "preference" = an organizational value choice. */
  basis: "standard" | "preference";
  references: Reference[];
  justification: string;
  guidance: string;
  /** What to do when unsure, if the standard wording ("check the places above; if you still can't tell, choose X") doesn't fit. */
  unsure?: string;
  /** Common places to look, as examples rather than a limit: shown to the person and given to the AI. */
  lookWhere?: string;
  /** A pure value choice: assessors may switch it off for one assessment ("Ignore"). */
  ignorable?: boolean;
  /** Shown under "Why it matters" when ignorable: why it is fine to skip. */
  ignoreNote?: string;
}

export interface Reference {
  source: string; // e.g. "NIST CSF 2.0"
  id?: string; // e.g. "GV.SC-06"
  title: string;
  url: string;
}

export interface Band {
  name: string;
  scoreMin: number;
  likelihoodMin: number;
  impactMin: number;
  decision: Decision;
  reReviewMonths: number;
  justification: string;
}

export interface Policy {
  name: string;
  version: number;
  /** Where the formula and the band thresholds come from. */
  sources?: { formula: Reference; bands: Reference };
  basePreferenceMultiplier: number;
  maxMitigationCredit: number;
  mitigationsMakeConditional: boolean;
  bands: Band[];
  factors: Factor[];
}

export type AnswerOrigin = "user" | "ai";

export interface Answer {
  response: string;
  notes: string;
  sources: string;
  origin: AnswerOrigin;
  confidence?: "high" | "medium" | "low";
  /** AI flagged that a person inside the org must confirm this. */
  needsConfirmation?: boolean;
  /** What AI research answered, kept so approvers can see when a person changed it. */
  aiResponse?: string;
  /** The assessor chose to ignore this question (only allowed when it is ignorable). It is not scored or required. */
  ignored?: boolean;
}

export interface Details {
  vendor: string;
  product: string;
  plan: string;
  requestingTeam: string;
  businessOwner: string;
  intendedUse: string;
  assessmentDate: string; // YYYY-MM-DD
  assessors: string;
  resources: string;
  override: "" | Decision;
  overrideJustification: string;
  riskAcceptedBy: string;
}

export interface Assessment {
  details: Details;
  answers: Record<string, Answer>;
  /** Set once sent for approval. flagged = sent with open issues ("YOLO"). */
  submitted?: { at: string; method: string; flagged: boolean };
  /** Version of the default policy these answers were made under, so a policy that changed what Yes/No mean can migrate them. */
  policyVersion?: number | string;
  /**
   * The assessor ticked "I agree with the AI's research". Optional: it never blocks submitting, it just
   * records (for approvers) who agreed and when. Only offered when some answers came from AI research.
   */
  aiAttestation?: { by: string; at: string };
}

export interface OrgSettings {
  orgName: string;
  reviewTeam: string;
  policyLink: string;
}
