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
}

export const DEFAULT_RULES: OrgRules = { allowOverride: true, allowYolo: true };

/** An org config file: any subset of Settings, plus a few distribution options. */
export interface OrgConfig {
  /** 1 = original format. 2 = needs AssessIT 0.2+ (default policy v4, where some Yes/No answers turned around), so older apps reject it and keep their last good copy. */
  assessitConfig: 1 | 2;
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

/**
 * Question IDs end up in element ids, data attributes and CSS selectors, and a policy can come from a URL an
 * organization controls. So they're checked at the door, once, for every way a policy gets in (default,
 * remote config, imported file): a letter, then letters, digits, "_" or "-". Output is also escaped, but a
 * bad ID never gets as far as output.
 */
export const FACTOR_ID = /^[A-Za-z][A-Za-z0-9_-]{0,15}$/;
const POLICY_VERSION = /^[A-Za-z0-9._+-]{1,20}$/;

/** The edit record is shown on reports, so it is rebuilt from plain strings and kept short. */
function cleanEdits(e: any): Policy["edits"] {
  if (!e || typeof e !== "object" || typeof e.at !== "string" || typeof e.reason !== "string") return undefined;
  const changes = Array.isArray(e.changes) ? e.changes.filter((c: unknown) => typeof c === "string").slice(0, 200).map((c: string) => c.slice(0, 200)) : [];
  return { at: e.at.slice(0, 40), reason: e.reason.slice(0, 500), changes };
}

export function validatePolicy(p: any): Policy {
  if (!p || !Array.isArray(p.factors) || !Array.isArray(p.bands) || !p.bands.length)
    throw new Error("Not a policy file: needs 'factors' and 'bands'.");
  if (p.version !== undefined && !POLICY_VERSION.test(String(p.version)))
    throw new Error("Policy version must be a short number or label, like 3 or 2.1.");
  const seen = new Set<string>();
  for (const f of p.factors) {
    if (typeof f.id !== "string" || !FACTOR_ID.test(f.id))
      throw new Error(`Question ID ${JSON.stringify(f.id)?.slice(0, 40) ?? "?"} isn't allowed: use a letter followed by letters, digits, "-" or "_" (16 characters at most), like L1.`);
    if (seen.has(f.id)) throw new Error(`Question ID ${f.id} is used twice.`);
    seen.add(f.id);
    if (!f.section || !Array.isArray(f.options) || !f.options.length)
      throw new Error(`Factor ${f.id} is missing section or options.`);
    if (!["Likelihood", "Impact", "Preference", "Mitigation"].includes(f.section))
      throw new Error(`Factor ${f.id}: unknown section "${f.section}".`);
  }
  const fin = (x: unknown, what: string) => {
    if (typeof x !== "number" || !Number.isFinite(x) || Math.abs(x) > 1000) throw new Error(`${what} must be a number.`);
  };
  for (const f of p.factors)
    for (const o of f.options) {
      if (typeof o?.label !== "string") throw new Error(`Factor ${f.id}: every answer needs a label.`);
      fin(o.points, `Factor ${f.id} “${o.label}”: points`);
    }
  for (const b of p.bands) {
    fin(b.scoreMin, "A band's score cut-off");
    fin(b.likelihoodMin, "A band's likelihood cut-off");
    fin(b.impactMin, "A band's impact cut-off");
  }
  if (p.maxMitigationCredit !== undefined) fin(p.maxMitigationCredit, "Max mitigation credit");
  if (p.basePreferenceMultiplier !== undefined) fin(p.basePreferenceMultiplier, "Base preference multiplier");
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
    edits: cleanEdits(p.edits),
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

/**
 * Default policy v4 rewrote negated questions as normal ones ("Does the vendor lack X?" became "Does the
 * vendor have X?"), so Yes and No swapped meaning on these. Answers made under v3 are swapped to match.
 */
export const FLIPPED_IN_V4 = ["L1", "L5", "L10", "L11", "L12", "L14", "L15", "P1", "P2", "P3", "P6"];

const swapYesNo = (v: string | undefined) => (v === "Yes" ? "No" : v === "No" ? "Yes" : v);

/**
 * Brings an older assessment up to date. Older files called the Organization-preference questions C1–C3
 * ("Culture"); they're P1–P3 now. And answers made under the default policy before v4 get Yes/No swapped on
 * the questions v4 turned around. That only happens under the built-in default policy: answers made under
 * someone's own policy are left exactly as they were. Answers are stamped with the policy version so this
 * runs once.
 */
export function migrateAssessment(a: Assessment, policy?: Policy): Assessment {
  for (const n of ["1", "2", "3"]) {
    const old = a.answers[`C${n}`];
    if (old && !a.answers[`P${n}`]) a.answers[`P${n}`] = old;
    delete a.answers[`C${n}`];
  }
  if (policy && policy.name === (defaultPolicy as Policy).name) {
    const was = a.policyVersion === undefined ? 3 : Number(a.policyVersion);
    if (was < 4 && Number(policy.version) >= 4) {
      for (const id of FLIPPED_IN_V4) {
        const ans = a.answers[id];
        if (!ans) continue;
        ans.response = swapYesNo(ans.response) ?? "";
        if (ans.aiResponse) ans.aiResponse = swapYesNo(ans.aiResponse);
      }
    }
    a.policyVersion = policy.version;
  } else if (policy && a.policyVersion === undefined) {
    // Made under someone's own policy: whatever its Yes/No meant, it isn't ours to swap, now or later.
    a.policyVersion = "custom";
  }
  return a;
}

export const loadCurrent = (): Assessment => read<Assessment>(CURRENT_KEY) ?? blankAssessment();
export const saveCurrent = (a: Assessment) => write(CURRENT_KEY, a);
