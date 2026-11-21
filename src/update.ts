// "Is there a newer release?" Pure helpers; the app asks GitHub through the `latest_release` command
// (src-tauri/src/update.rs) because the webview can't make network requests itself.

const RELEASES_URL = "https://github.com/zaclohrenz/AssessIT/releases";
export const releaseUrl = (version: string) => `${RELEASES_URL}/tag/v${version.replace(/^v/, "")}`;

const parse = (v: string): number[] | null => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};

/** True when `latest` is a higher X.Y.Z than `current`. Anything unparseable counts as not newer. */
export function isNewer(latest: string, current: string): boolean {
  const a = parse(latest);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

export type UpdateState = { kind: "checking" } | { kind: "latest" } | { kind: "available"; latest: string } | { kind: "error"; message: string };
