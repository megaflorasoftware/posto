#!/usr/bin/env bash
# Builds the iOS app (apps/ios, SwiftUI) and installs it on a paired iPhone or
# iPad without launching it.
#
#   scripts/build-ios.sh            Release build
#   scripts/build-ios.sh --debug    Debug build
#   scripts/build-ios.sh --no-install
#
# DEVICE picks the device by name or identifier (see
# scripts/install-ios-device.mjs). The Rust bridge is rebuilt every time;
# cargo only recompiles what changed, so after the first build (several
# minutes) that takes seconds. The Tauri iOS build is scripts/build-ios-tauri.sh.
set -euo pipefail

cd "$(dirname "$0")/.."

configuration=Release
install=1
for argument in "$@"; do
  case "$argument" in
    --debug) configuration=Debug ;;
    --no-install) install=0 ;;
    -h | --help)
      awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"
      exit 0
      ;;
    *)
      echo "error: unknown option '$argument'" >&2
      exit 64
      ;;
  esac
done

# JS dependencies, engine.js, the Rust xcframework, and Posto.xcodeproj.
POSTO_BOOTSTRAP_QUIET=1 apps/ios/scripts/bootstrap.sh

derived=apps/ios/build/DerivedData-device
echo "==> Building Posto ($configuration)"
xcodebuild -project apps/ios/Posto.xcodeproj -scheme Posto -configuration "$configuration" \
  -destination generic/platform=iOS -derivedDataPath "$derived" \
  -allowProvisioningUpdates -quiet build

app="$derived/Build/Products/$configuration-iphoneos/Posto.app"
if [[ "$install" == 1 ]]; then
  node scripts/install-ios-device.mjs "$app"
  echo "Done: installed $app"
else
  echo "Built $app"
fi
