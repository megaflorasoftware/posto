#!/usr/bin/env bash
# Builds the app and runs it on an iOS simulator.
#
#   scripts/run-simulator.sh                 sign in with GitHub (real backend)
#   scripts/run-simulator.sh --demo          fixture content, no network
#   scripts/run-simulator.sh --tour [DIR]    demo walkthrough; snapshots of every
#                                            screen are copied to DIR
#                                            (default build/tour-simulator)
#
# SIMULATOR picks a device by name (e.g. SIMULATOR="iPhone 17 Pro"); by
# default the first available iPhone is used. Run scripts/bootstrap.sh once
# first so the Rust xcframework and the Xcode project exist.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
cd "$here"
bundle_id=net.megaflora.posto
mode="${1:-}"

if [ ! -d Posto.xcodeproj ] || [ ! -d native/build/PostoNative.xcframework ]; then
  echo "error: run scripts/bootstrap.sh first" >&2
  exit 1
fi

udid="$(xcrun simctl list devices available -j | node -e '
  const name = process.argv[1];
  const devices = Object.values(JSON.parse(require("fs").readFileSync(0, "utf8")).devices).flat();
  const match = devices.find((d) => (name ? d.name === name : d.name.startsWith("iPhone")));
  if (match) console.log(match.udid);
' "${SIMULATOR:-}")"
if [ -z "$udid" ]; then
  echo "error: no matching simulator; install an iOS runtime in Xcode > Settings > Components" >&2
  exit 1
fi

echo "==> Building for $udid"
xcodebuild -project Posto.xcodeproj -scheme Posto -configuration Debug \
  -destination "id=$udid" -derivedDataPath build/DerivedData -quiet build

xcrun simctl boot "$udid" 2>/dev/null || true
# Xcode 27 replaced Simulator.app with Device Hub.
open -a Simulator 2>/dev/null || open -a DeviceHub
xcrun simctl install "$udid" build/DerivedData/Build/Products/Debug-iphonesimulator/Posto.app

case "$mode" in
  "")
    xcrun simctl launch --terminate-running-process "$udid" "$bundle_id"
    ;;
  --demo)
    xcrun simctl launch --terminate-running-process "$udid" "$bundle_id" -PostoDemo
    ;;
  --tour)
    out="${2:-$here/build/tour-simulator}"
    data="$(xcrun simctl get_app_container "$udid" "$bundle_id" data)"
    rm -rf "$data/Documents/tour"
    xcrun simctl launch --terminate-running-process "$udid" "$bundle_id" -PostoDemo -PostoTour tour
    for _ in $(seq 1 120); do
      [ -f "$data/Documents/tour/done" ] && break
      sleep 1
    done
    rm -rf "$out"
    mkdir -p "$out"
    cp "$data"/Documents/tour/*.png "$out"/
    ls "$out"
    ;;
  *)
    echo "error: unknown option $mode" >&2
    exit 64
    ;;
esac
