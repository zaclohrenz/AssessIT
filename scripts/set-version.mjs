// Writes one version number everywhere the app carries it.
// Usage: node scripts/set-version.mjs 1.2.3
// Used by the Release workflow; also handy locally.
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  console.error(`Not a version (expected X.Y.Z): ${version ?? "(none)"}`);
  process.exit(1);
}

function edit(path, fn) {
  const before = readFileSync(path, "utf8");
  const after = fn(before);
  if (after === before && !before.includes(version)) throw new Error(`Couldn't find the version in ${path}`);
  writeFileSync(path, after);
}

const json = (path, set) =>
  edit(path, (s) => {
    const data = JSON.parse(s);
    set(data);
    return JSON.stringify(data, null, 2) + "\n";
  });

json("package.json", (p) => (p.version = version));
json("package-lock.json", (p) => {
  p.version = version;
  p.packages[""].version = version;
});
json("src-tauri/tauri.conf.json", (c) => (c.version = version));
// Only the [package] version, not dependency versions.
edit("src-tauri/Cargo.toml", (s) => s.replace(/(\[package\][^[]*?\nversion = )"[^"]*"/, `$1"${version}"`));
edit("src-tauri/Cargo.lock", (s) => s.replace(/(name = "assessit"\nversion = )"[^"]*"/, `$1"${version}"`));

console.log(version);
