export type Section = "Likelihood" | "Impact" | "Preference" | "Mitigation";
export type Decision = "Approved" | "Approved with Conditions" | "Denied";

export interface Option {
  label: string;
  points: number;
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
  /**
   * The assessor's confirmation that they reviewed the AI-proposed answers and submit them as their own
   * determination. Needed (and only shown) when some answers came from AI research.
   */
  aiAttestation?: { by: string; at: string };
}

export interface OrgSettings {
  orgName: string;
  reviewTeam: string;
  policyLink: string;
}
