// Builds latest.json, the manifest the app's updater reads, from the signed files in a folder.
// Usage: node scripts/updater-manifest.mjs <folder> <version>
//
// It refuses to write anything unless every file has a signature that checks out against the public
// key in src-tauri/tauri.conf.json and was made for this exact version. That catches a wrong or
// missing signing key before publishing, instead of shipping an update that no app can install.
// It never reads or prints the private key.
import { createHash, createPublicKey, verify } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "zaclohrenz/AssessIT";

const b64 = (s) => Buffer.from(s, "base64");
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const ed25519 = (key32) => createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, key32]), format: "der", type: "spki" });

/** Reads a minisign public key as Tauri stores it (the file's text, base64-encoded). */
export function parsePublicKey(pubkey) {
  const lines = b64(pubkey).toString("utf8").trim().split("\n");
  const raw = b64(lines[1] ?? "");
  if (raw.length !== 42 || raw.subarray(0, 2).toString() !== "Ed") throw new Error("The updater public key in tauri.conf.json is not a valid Tauri/minisign key.");
  return { id: raw.subarray(2, 10), key: raw.subarray(10) };
}

/**
 * Checks a .sig file (minisign, base64-encoded) against a file's bytes and the public key.
 * Returns the version recorded in the signature. Throws if anything doesn't match.
 */
export function verifySignature(fileBytes, sigText, pubkey, name = "file") {
  const pub = parsePublicKey(pubkey);
  const lines = b64(sigText).toString("utf8").split("\n");
  const raw = b64(lines[1] ?? "");
  const trusted = (lines[2] ?? "").replace(/^trusted comment: /, "");
  const globalSig = b64(lines[3] ?? "");
  if (raw.length !== 74 || globalSig.length !== 64 || !lines[2]?.startsWith("trusted comment: ")) throw new Error(`${name}: the signature file is malformed.`);
  if (!raw.subarray(2, 10).equals(pub.id)) throw new Error(`${name}: signed with a different key than the public key in tauri.conf.json.`);
  const alg = raw.subarray(0, 2).toString();
  if (alg !== "Ed" && alg !== "ED") throw new Error(`${name}: unknown signature type.`);
  const key = ed25519(pub.key);
  const message = alg === "ED" ? createHash("blake2b512").update(fileBytes).digest() : fileBytes;
  if (!verify(null, message, key, raw.subarray(10))) throw new Error(`${name}: the signature doesn't match the file.`);
  if (!verify(null, Buffer.concat([raw.subarray(10), Buffer.from(trusted)]), key, globalSig)) throw new Error(`${name}: the signature's comment was altered.`);
  const version = trusted.split("\t").find((f) => f.startsWith("version:"))?.slice("version:".length);
  if (!version) throw new Error(`${name}: the signature isn't tied to a version.`);
  return version;
}

/** Which manifest keys each kind of release file serves. Keys are {os}-{arch}-{bundle type}, then {os}-{arch}. */
const TARGETS = [
  { match: /-macos-universal\.app\.tar\.gz$/, keys: ["darwin-aarch64-app", "darwin-x86_64-app", "darwin-aarch64", "darwin-x86_64"] },
  { match: /-setup\.exe$/, keys: ["windows-x86_64-nsis", "windows-x86_64"] },
  { match: /\.AppImage$/, keys: ["linux-x86_64-appimage", "linux-x86_64"] },
  { match: /\.deb$/, keys: ["linux-x86_64-deb"] },
];

export function buildManifest({ dir, version, pubkey, notes = "" }) {
  const files = readdirSync(dir).filter((f) => !f.endsWith(".sig") && TARGETS.some((t) => t.match.test(f)));
  const platforms = {};
  const used = new Set();
  for (const file of files) {
    const target = TARGETS.find((t) => t.match.test(file));
    const sigPath = join(dir, `${file}.sig`);
    if (!existsSync(sigPath)) throw new Error(`${file}: no signature file (${basename(sigPath)}).`);
    const signed = verifySignature(readFileSync(join(dir, file)), readFileSync(sigPath, "utf8").trim(), pubkey, file);
    if (signed !== version) throw new Error(`${file}: signed for version ${signed}, expected ${version}.`);
    const entry = { signature: readFileSync(sigPath, "utf8").trim(), url: `https://github.com/${REPO}/releases/download/v${version}/${file}` };
    for (const key of target.keys) {
      if (key in platforms) continue; // first file wins a shared key (e.g. linux-x86_64: AppImage before deb)
      platforms[key] = entry;
      used.add(target);
    }
  }
  for (const t of TARGETS) if (!used.has(t)) throw new Error(`No release file for ${t.keys[0]}. Expected a file matching ${t.match}.`);
  return { version, notes, pub_date: new Date().toISOString(), platforms };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [dir, version] = process.argv.slice(2);
  if (!dir || !/^\d+\.\d+\.\d+$/.test(version ?? "")) {
    console.error("Usage: node scripts/updater-manifest.mjs <folder> <X.Y.Z>");
    process.exit(1);
  }
  try {
    const pubkey = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8")).plugins?.updater?.pubkey;
    if (!pubkey) throw new Error("tauri.conf.json has no updater public key.");
    const manifest = buildManifest({ dir, version, pubkey, notes: `https://github.com/${REPO}/releases/tag/v${version}` });
    writeFileSync(join(dir, "latest.json"), JSON.stringify(manifest, null, 2) + "\n");
    console.log(`latest.json: v${version}, ${Object.keys(manifest.platforms).join(", ")}`);
  } catch (e) {
    console.error(`::error::${e.message}`);
    process.exit(1);
  }
}
