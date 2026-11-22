// Builds the public default config attached to every GitHub release.
// The app fetches it from releases/latest, so policy updates ship with releases, never from main.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const policy = JSON.parse(readFileSync("src/policy/default-policy.json", "utf8"));
const { version } = JSON.parse(readFileSync("package.json", "utf8"));
mkdirSync("release", { recursive: true });
// Default policy v4 turned some Yes/No questions around, so apps older than 0.2 must not load it:
//  - the config says "assessitConfig": 2, which older apps reject (they keep their last good copy);
//  - the standalone policy has a new name, so old org configs pointing at default-policy.json get an
//    error (and keep their cached copy) instead of silently scoring Yes as No.
writeFileSync("release/default-policy-v4.json", JSON.stringify(policy, null, 2));
writeFileSync(
  "release/assessit-config.json",
  JSON.stringify({ assessitConfig: 2, name: `AssessIT public defaults (v${version})`, policy }, null, 2),
);
console.log("release/assessit-config.json, release/default-policy-v4.json");
