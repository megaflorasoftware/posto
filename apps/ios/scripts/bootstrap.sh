#!/usr/bin/env bash
# Prepares the native iOS app for Xcode: bundles the engine, builds the Rust
# xcframework, and generates Posto.xcodeproj with XcodeGen.
#
#   scripts/bootstrap.sh            everything
#   scripts/bootstrap.sh --no-rust  skip the Rust build (reuse the last one)
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
cd "$here"

if ! command -v xcodegen >/dev/null 2>&1; then
  echo "error: XcodeGen is required: brew install xcodegen" >&2
  exit 1
fi

echo "==> Bundling the engine"
node engine/build.mjs Posto/Resources/engine.js

if [ "${1:-}" != "--no-rust" ]; then
  echo "==> Building the Rust bridge (first build takes a while)"
  scripts/build-native.sh
fi

echo "==> Generating Posto.xcodeproj"
xcodegen generate --quiet
echo "Open $here/Posto.xcodeproj, or build with scripts/run-simulator.sh"
