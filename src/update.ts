// In-app updates. The app checks a signed manifest (latest.json) on GitHub Releases through
// tauri-plugin-updater; main.ts drives it. Only the pure bits live here, so they can be tested.

const RELEASES_URL = "https://github.com/zaclohrenz/AssessIT/releases";
export const releaseUrl = (version: string) => `${RELEASES_URL}/tag/v${version.replace(/^v/, "")}`;

export type UpdateState =
  | { kind: "checking" }
  | { kind: "latest" }
  /** `failed` is why the last install attempt didn't work, so the badge can offer a retry and the release page. */
  | { kind: "available"; latest: string; failed?: string }
  /** `pct` is null until the download size is known. */
  | { kind: "installing"; latest: string; pct: number | null }
  | { kind: "error"; message: string };

/** Download progress as a whole percent, or null while the total size is unknown. */
export function percent(received: number, total: number): number | null {
  if (!total || total <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((received / total) * 100)));
}
