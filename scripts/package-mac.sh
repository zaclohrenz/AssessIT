#!/usr/bin/env bash
# Builds the universal macOS app and zips it for the Homebrew cask.
# Usage: scripts/package-mac.sh   -> prints the zip path and its sha256
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

echo "$out"
shasum -a 256 "$out" | cut -d' ' -f1
