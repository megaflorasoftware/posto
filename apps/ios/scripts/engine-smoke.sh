#!/usr/bin/env bash
# Builds the engine bundle and runs it in JavaScriptCore on macOS through the
# app's own Swift engine host, against the demo backend. Needs only the
# Command Line Tools.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
out="${TMPDIR:-/tmp}/posto-engine-smoke"
mkdir -p "$out"
node "$here/engine/build.mjs" "$out/engine.js" >/dev/null
swiftc -O -parse-as-library \
  "$here"/Posto/Engine/JSONValue.swift \
  "$here"/Posto/Engine/Backend.swift \
  "$here"/Posto/Engine/Engine.swift \
  "$here"/Posto/Engine/DemoBackend.swift \
  "$here"/Tools/EngineSmoke/main.swift \
  -o "$out/engine-smoke"
"$out/engine-smoke" "$out/engine.js"
