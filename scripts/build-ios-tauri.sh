#!/usr/bin/env bash
set -euo pipefail

# The Tauri mobile app (apps/mobile), kept for Android. On iOS the native app
# (apps/ios, `pnpm build:ios`) replaced it; this build installs separately, as
# "Posto (Tauri)" (net.megaflora.posto.tauri, from src-tauri/tauri.ios.conf.json).

cd "$(dirname "$0")/.."

# the client id is compiled in via option_env!; the Xcode-driven build doesn't
# reliably pick up .cargo/config.toml, so export it explicitly (env wins if set)
if [[ -z "${POSTO_GITHUB_CLIENT_ID:-}" ]]; then
  POSTO_GITHUB_CLIENT_ID=$(sed -n 's/^POSTO_GITHUB_CLIENT_ID = { value = "\([^"]*\)".*/\1/p' .cargo/config.toml)
fi
if [[ -z "$POSTO_GITHUB_CLIENT_ID" ]]; then
  echo "error: POSTO_GITHUB_CLIENT_ID is not set and no default found in .cargo/config.toml" >&2
  exit 1
fi
export POSTO_GITHUB_CLIENT_ID

# build a debug-signed ipa and install it on the first reachable device
pnpm tauri ios build --export-method debugging

IPA=$(find src-tauri/gen/apple/build -name '*.ipa' -newer src-tauri/gen/apple/project.yml -print -quit)
if [[ -z "$IPA" ]]; then
  IPA=$(find src-tauri/gen/apple/build -name '*.ipa' -print -quit)
fi
if [[ -z "$IPA" ]]; then
  echo "error: no .ipa found under src-tauri/gen/apple/build" >&2
  exit 1
fi

node scripts/install-ios-device.mjs "$IPA"
