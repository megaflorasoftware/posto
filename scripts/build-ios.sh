#!/usr/bin/env bash
set -euo pipefail

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

# build a debug-signed ipa and install it on the first connected device
pnpm tauri ios build --export-method debugging

IPA=$(find src-tauri/gen/apple/build -name '*.ipa' -newer src-tauri/gen/apple/project.yml -print -quit)
if [[ -z "$IPA" ]]; then
  IPA=$(find src-tauri/gen/apple/build -name '*.ipa' -print -quit)
fi
if [[ -z "$IPA" ]]; then
  echo "error: no .ipa found under src-tauri/gen/apple/build" >&2
  exit 1
fi

DEVICES_JSON="$(mktemp)"
trap 'rm -f "$DEVICES_JSON"' EXIT
xcrun devicectl list devices --json-output "$DEVICES_JSON" >/dev/null

UDID=$(node -e '
  const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const devices = (j.result && j.result.devices) || [];
  const d = devices.find(d => d.connectionProperties &&
    d.connectionProperties.tunnelState !== "unavailable");
  if (d) {
    console.error("Installing on: " + d.deviceProperties.name);
    console.log(d.identifier);
  }
' "$DEVICES_JSON")

if [[ -z "$UDID" ]]; then
  echo "error: no connected iOS device found (plug one in and trust this Mac)" >&2
  exit 1
fi

xcrun devicectl device install app --device "$UDID" "$IPA"
echo "Done — installed $IPA"
