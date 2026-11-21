// Decides which org config applies and cleans it before use. Pure functions; the app
// supplies what the OS reported (src-tauri/src/config.rs) and what it downloaded.

import { DEFAULT_RULES, LOCK_GROUPS, validatePolicy, type LockGroup, type OrgConfig, type UserSettings } from "./settings";

/** Public defaults: attached to every GitHub release, so they only change when a release ships. */
export const DEFAULT_CONFIG_URL = "https://github.com/zaclohrenz/AssessIT/releases/latest/download/assessit-config.json";

export type ConfigKind = "managed" | "user" | "install" | "default" | "off";

export interface ConfigChoice {
  kind: ConfigKind;
  url: string | null;
}

/**
 * Lookup order:
 *   1. managed: IT pushed a ConfigURL by MDM / Group Policy. Users can't change it.
 *   2. user: typed in Settings ("" means the user turned remote config off).
 *   3. install: written at install time (HOMEBREW_ASSESSIT_CONFIG_URL).
 *   4. default: the public defaults from this project's latest release.
 * A locked install-time config (installLocked) stays in place even if the user typed another URL.
 */
export function chooseConfig(
  os: { source: "managed" | "install" | "none"; url: string | null },
  user: UserSettings,
  installLocked = false,
): ConfigChoice {
  if (os.source === "managed" && os.url) return { kind: "managed", url: os.url };
  if (os.source === "install" && os.url && installLocked) return { kind: "install", url: os.url };
  if (user.configUrl !== undefined) return user.configUrl.trim() ? { kind: "user", url: user.configUrl.trim() } : { kind: "off", url: null };
  if (os.source === "install" && os.url) return { kind: "install", url: os.url };
  return { kind: "default", url: DEFAULT_CONFIG_URL };
}

/**
 * Validates a downloaded config. The public default config may only ship a policy:
 * a project-wide file must never be able to redirect anyone's submissions.
 */
export function sanitizeConfig(kind: ConfigKind, raw: unknown): OrgConfig {
  if (!raw || typeof raw !== "object" || (raw as any).assessitConfig !== 1)
    throw new Error('Not an AssessIT config: it needs "assessitConfig": 1.');
  const r = raw as any;
  const out: OrgConfig = { assessitConfig: 1, name: typeof r.name === "string" ? r.name : undefined };
  if (r.policy) out.policy = validatePolicy(r.policy);
  if (typeof r.policyUrl === "string") out.policyUrl = r.policyUrl;
  if (kind === "default") return out;

  if (r.lock === true) out.lock = true;
  else if (Array.isArray(r.lock)) {
    const bad = r.lock.filter((g: unknown) => !LOCK_GROUPS.includes(g as LockGroup));
    if (bad.length) throw new Error(`Unknown lock "${bad[0]}". Use true or any of: ${LOCK_GROUPS.join(", ")}.`);
    out.lock = r.lock;
  }
  if (r.rules && typeof r.rules === "object") {
    const rules = Object.fromEntries(Object.keys(DEFAULT_RULES).filter((k) => typeof r.rules[k] === "boolean").map((k) => [k, r.rules[k]]));
    if (Object.keys(rules).length) out.rules = rules;
  }
  const str = (o: any, keys: string[]) =>
    o && typeof o === "object" ? Object.fromEntries(keys.filter((k) => typeof o[k] === "string").map((k) => [k, o[k]])) : undefined;
  out.org = str(r.org, ["orgName", "reviewTeam", "policyLink"]);
  out.submit = str(r.submit, ["method", "webhookUrl", "tenant", "clientId", "siteUrl", "listName"]);
  if (out.submit?.method && !["none", "webhook", "sharepoint"].includes(out.submit.method))
    throw new Error(`Unknown submit.method "${out.submit.method}".`);
  for (const k of ["webhookUrl", "siteUrl"] as const) {
    const v = out.submit?.[k];
    if (v && !/^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1)[:/])/.test(v)) throw new Error(`submit.${k} must start with https://`);
  }
  if (typeof r.model === "string") out.model = r.model;
  return out;
}
