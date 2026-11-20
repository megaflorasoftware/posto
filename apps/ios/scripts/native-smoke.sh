#!/usr/bin/env bash
# The real stack on macOS, no Xcode: the app's RustBackend over the Rust
# bridge (host build), under the engine in JavaScriptCore, editing and
# reverting a file in a throwaway git copy of the docs site.
#
# On macOS the Rust host build reads desktop Posto's Keychain entries for
# GitHub and CDN credentials. Keep this test away from them: its repository
# has no remote, and it never calls auth, publish, pull, or media_credential_*.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
out="${TMPDIR:-/tmp}/posto-native-smoke"
rm -rf "$out"
mkdir -p "$out"

"$here/scripts/build-native.sh" --host >/dev/null
node "$here/engine/build.mjs" "$out/engine.js" >/dev/null

# A git repository of a real Astro site, outside this checkout.
site="$out/site"
rsync -a --exclude node_modules --exclude dist "$here/../docs/" "$site/"
git -C "$site" init -q -b main
git -C "$site" add -A
git -C "$site" -c user.name=smoke -c user.email=smoke@example.com commit -qm init

swiftc -O -parse-as-library \
  -I "$here/native/include" \
  "$here"/Posto/Engine/*.swift \
  "$here"/Posto/Native/RustBackend.swift \
  "$here"/Tools/NativeSmoke/main.swift \
  -L "$here/native/target/release" -lposto_native \
  -o "$out/native-smoke"
"$out/native-smoke" "$out/engine.js" "$site"
