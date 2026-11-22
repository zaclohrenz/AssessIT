#!/usr/bin/env bash
# Builds the universal macOS app and zips it for the Homebrew cask.
# Usage: scripts/package-mac.sh   -> prints the tar.gz path, then the zip path and its sha256 (the last two lines)
set -euo pipefail
cd "$(dirname "$0")/.."

version=$(node -p "require('./package.json').version")
npx tauri build --target universal-apple-darwin --bundles app

app="src-tauri/target/universal-apple-darwin/release/bundle/macos/AssessIT.app"
out="release/AssessIT-${version}-macos-universal.zip"
mkdir -p release
rm -f "$out"
# ditto keeps the bundle's signature and extended attributes intact.
ditto -c -k --keepParent "$app" "$out"

# The in-app updater installs from a .app.tar.gz (AssessIT.app at the top level), not the zip.
# COPYFILE_DISABLE keeps macOS from adding ._ metadata files to the archive.
tgz="release/AssessIT-${version}-macos-universal.app.tar.gz"
rm -f "$tgz"
COPYFILE_DISABLE=1 tar -czf "$tgz" -C "$(dirname "$app")" AssessIT.app
echo "$tgz"

echo "$out"
shasum -a 256 "$out" | cut -d' ' -f1
