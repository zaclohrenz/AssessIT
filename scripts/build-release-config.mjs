// Builds the public default config attached to every GitHub release.
// The app fetches it from releases/latest, so policy updates ship with releases, never from main.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const policy = JSON.parse(readFileSync("src/policy/default-policy.json", "utf8"));
const { version } = JSON.parse(readFileSync("package.json", "utf8"));
mkdirSync("release", { recursive: true });
writeFileSync("release/default-policy.json", JSON.stringify(policy, null, 2));
writeFileSync(
  "release/assessit-config.json",
  JSON.stringify({ assessitConfig: 1, name: `AssessIT public defaults (v${version})`, policy }, null, 2),
);
console.log("release/assessit-config.json, release/default-policy.json");
