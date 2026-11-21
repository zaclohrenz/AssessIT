import defaultPolicy from "./policy/default-policy.json";
import type { Assessment, OrgSettings, Policy } from "./types";

export type SubmitMethod = "none" | "webhook" | "sharepoint";

export interface Settings {
  org: OrgSettings;
  model: string;
  submit: {
    method: SubmitMethod;
    webhookUrl: string;
    tenant: string;
    clientId: string;
    siteUrl: string;
    listName: string;
  };
  /** null = built-in default policy */
  policy: Policy | null;
}

/** What a user has changed locally. Stored separately so org config updates still reach them. */
export interface UserSettings {
  org?: Partial<Settings["org"]>;
  model?: string;
  submit?: Partial<Settings["submit"]>;
  policy?: Policy | null;
  /** undefined = automatic (managed / install-time / public default); "" = turned off */
  configUrl?: string;
}

/** Parts of Settings an org config can lock. */
export const LOCK_GROUPS = ["org", "submit", "model", "policy"] as const;
export type LockGroup = (typeof LOCK_GROUPS)[number];

/** Workflow rules an org config can set. Users can't change these; anything left out stays allowed. */
export interface OrgRules {
  /** false = no "Decision override" on the report */
  allowOverride: boolean;
  /** false = can't submit with open issues ("Submit YOLO") */
  allowYolo: boolean;
  /** false = no one-click "Mark all AI answers reviewed"; each answer is reviewed on its own */
  allowBulkReview: boolean;
}

export const DEFAULT_RULES: OrgRules = { allowOverride: true, allowYolo: true, allowBulkReview: true };

/** An org config file: any subset of Settings, plus a few distribution options. */
export interface OrgConfig {
  assessitConfig: 1;
  name?: string;
  /**
   * true = users can't change anything this file provides; or a list of the parts to lock.
   * Locking "policy" also pins the scoring policy (this file's, or the default) so users can't import their own.
   */
  lock?: boolean | LockGroup[];
  rules?: Partial<OrgRules>;
  org?: Partial<Settings["org"]>;
  model?: string;
  submit?: Partial<Settings["submit"]>;
  policy?: Policy;
  /** Fetch the policy from a separate URL (lets one policy serve many configs). */
  policyUrl?: string;
}

export const DEFAULT_SETTINGS: Settings = {
  org: { orgName: "our organization", reviewTeam: "IT Risk Review", policyLink: "our software and AI governance policy" },
  model: "sonnet",
  submit: { method: "none", webhookUrl: "", tenant: "", clientId: "", siteUrl: "", listName: "Software Risk Assessments" },
  policy: null,
};

const SETTINGS_KEY = "assessit.user-settings";
const CURRENT_KEY = "assessit.current";

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: settings just won't persist */
  }
}

export const loadUserSettings = (): UserSettings => read<UserSettings>(SETTINGS_KEY) ?? {};
export const saveUserSettings = (u: UserSettings) => write(SETTINGS_KEY, u);

function overlay(base: Settings, patch: UserSettings | OrgConfig | undefined): Settings {
  if (!patch) return base;
  return {
    org: { ...base.org, ...(patch.org ?? {}) },
    model: patch.model ?? base.model,
    submit: { ...base.submit, ...(patch.submit ?? {}) },
    policy: patch.policy === undefined ? base.policy : patch.policy,
  };
}

/**
 * Effective settings = defaults, then org config, then the user's own edits,
 * then anything the org config locks, so locked values can't be overridden.
 */
export function effectiveSettings(user: UserSettings, org: OrgConfig | null): Settings {
  const s = overlay(overlay(DEFAULT_SETTINGS, org ?? undefined), user);
  for (const path of lockedPaths(org)) {
    const [group, field] = path.split(".") as [keyof Settings, string?];
    if (group === "model") s.model = org!.model!;
    else if (group === "policy") s.policy = org!.policy ?? null;
    else (s[group] as unknown as Record<string, string>)[field!] = (org![group] as Record<string, string>)[field!];
  }
  return s;
}

export const lockGroups = (org: OrgConfig | null): LockGroup[] =>
  org?.lock === true ? [...LOCK_GROUPS] : Array.isArray(org?.lock) ? org.lock : [];

/** Dotted paths ("org.orgName", "policy") an org config pins down. */
export function lockedPaths(org: OrgConfig | null): Set<string> {
  const out = new Set<string>();
  const groups = lockGroups(org);
  for (const k of ["org", "submit"] as const) if (groups.includes(k)) for (const f of Object.keys(org![k] ?? {})) out.add(`${k}.${f}`);
  if (groups.includes("model") && org!.model !== undefined) out.add("model");
  if (groups.includes("policy")) out.add("policy");
  return out;
}

export const orgRules = (org: OrgConfig | null): OrgRules => ({ ...DEFAULT_RULES, ...org?.rules });

export function validatePolicy(p: any): Policy {
  if (!p || !Array.isArray(p.factors) || !Array.isArray(p.bands) || !p.bands.length)
    throw new Error("Not a policy file: needs 'factors' and 'bands'.");
  for (const f of p.factors) {
    if (!f.id || !f.section || !Array.isArray(f.options) || !f.options.length)
      throw new Error(`Factor ${f.id ?? "?"} is missing id, section or options.`);
    if (!["Likelihood", "Impact", "Preference", "Mitigation"].includes(f.section))
      throw new Error(`Factor ${f.id}: unknown section "${f.section}".`);
  }
  for (let i = 1; i < p.bands.length; i++)
    if (p.bands[i].scoreMin <= p.bands[i - 1].scoreMin) throw new Error("Band minimums must increase top to bottom.");
  return {
    name: p.name ?? "Custom policy",
    version: p.version ?? 1,
    sources: p.sources,
    basePreferenceMultiplier: p.basePreferenceMultiplier ?? 1,
    maxMitigationCredit: p.maxMitigationCredit ?? 0.25,
    mitigationsMakeConditional: p.mitigationsMakeConditional ?? true,
    bands: p.bands,
    factors: p.factors.map((f: any) => ({
      enabled: true,
      required: false,
      hardStop: null,
      research: "public",
      basis: "standard",
      references: [],
      justification: "",
      guidance: "",
      factor: f.id,
      question: "",
      ...f,
    })),
  };
}

export const activePolicy = (s: Settings): Policy => s.policy ?? (defaultPolicy as Policy);

export function blankAssessment(): Assessment {
  return {
    details: {
      vendor: "",
      product: "",
      plan: "",
      requestingTeam: "",
      businessOwner: "",
      intendedUse: "",
      assessmentDate: new Date().toLocaleDateString("en-CA"),
      assessors: "",
      resources: "",
      override: "",
      overrideJustification: "",
      riskAcceptedBy: "",
    },
    answers: {},
  };
}

/** Older files called the Organization-preference questions C1–C3 ("Culture"); they're P1–P3 now. */
export function migrateAssessment(a: Assessment): Assessment {
  for (const n of ["1", "2", "3"]) {
    const old = a.answers[`C${n}`];
    if (old && !a.answers[`P${n}`]) a.answers[`P${n}`] = old;
    delete a.answers[`C${n}`];
  }
  return a;
}

export const loadCurrent = (): Assessment => migrateAssessment(read<Assessment>(CURRENT_KEY) ?? blankAssessment());
export const saveCurrent = (a: Assessment) => write(CURRENT_KEY, a);
