#!/usr/bin/env bash
# Prepares the native iOS app for Xcode: installs JS dependencies if needed,
# bundles the engine, builds the Rust xcframework, and generates
# Posto.xcodeproj with XcodeGen.
#
#   scripts/bootstrap.sh            everything
#   scripts/bootstrap.sh --no-rust  skip the Rust build (reuse the last one)
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
repo="$(cd "$here/../.." && pwd)"
cd "$here"

missing=0
need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "error: $1 is required. $2" >&2
    missing=1
  fi
}
# The Command Line Tools ship an xcodebuild stub that only works with Xcode.
if ! xcodebuild -version >/dev/null 2>&1; then
  echo "error: Xcode is required. Install it, then: sudo xcode-select --switch /Applications/Xcode.app" >&2
  missing=1
fi
need xcodegen "Install it with: brew install xcodegen"
need node "Install Node 24 (see the repository's .nvmrc)."
need pnpm "Install it with: corepack enable pnpm"
need rustup "Install Rust from https://rustup.rs"
[ "$missing" = 0 ] || exit 1

if [ ! -d "$here/node_modules/esbuild" ]; then
  echo "==> Installing JS dependencies"
  (cd "$repo" && pnpm install --frozen-lockfile)
fi

echo "==> Bundling the engine"
node engine/build.mjs Posto/Resources/engine.js

if [ "${1:-}" != "--no-rust" ]; then
  echo "==> Building the Rust bridge (the first build takes several minutes)"
  scripts/build-native.sh
fi

echo "==> Generating Posto.xcodeproj"
xcodegen generate --quiet
# scripts/build-ios.sh carries on with the build itself.
[ -z "${POSTO_BOOTSTRAP_QUIET:-}" ] || exit 0
echo
echo "Done. Open $here/Posto.xcodeproj and run the Posto (or Posto Demo) scheme,"
echo "or run scripts/run-simulator.sh [--demo | --tour]."
