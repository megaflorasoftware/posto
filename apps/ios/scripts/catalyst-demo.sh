#!/usr/bin/env bash
# Builds the app as Mac Catalyst in demo mode and (unless --build-only)
# launches it. Needs only the Command Line Tools, so the UI can be tried on
# a Mac without Xcode. The Rust bridge is stubbed out: demo content only.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
cd "$here"
sdk="$(xcrun --show-sdk-path)"
out="${POSTO_CATALYST_OUT:-$here/build/catalyst}"
app="$out/Posto.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"

node engine/build.mjs "$app/Contents/Resources/engine.js" >/dev/null

files=()
while IFS= read -r file; do files+=("$file"); done < <(find Posto -name '*.swift' ! -path 'Posto/Native/*' | sort)
swiftc -parse-as-library -Onone -g -D DEBUG \
  -target "$(uname -m)-apple-ios17.0-macabi" \
  -sdk "$sdk" \
  -Fsystem "$sdk/System/iOSSupport/System/Library/Frameworks" \
  -I "$sdk/System/iOSSupport/usr/include" \
  -L "$sdk/System/iOSSupport/usr/lib" \
  -I "$sdk/System/iOSSupport/usr/lib/swift" \
  -L "$sdk/System/iOSSupport/usr/lib/swift" \
  -Xlinker -rpath -Xlinker /System/iOSSupport/usr/lib/swift \
  "${files[@]}" Tools/CatalystDemo/RustBackendStub.swift \
  -o "$app/Contents/MacOS/Posto"

cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>Posto</string>
  <key>CFBundleIdentifier</key><string>net.megaflora.posto.native.catalyst</string>
  <key>CFBundleName</key><string>Posto</string>
  <key>CFBundleDisplayName</key><string>Posto Native (Demo)</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.10.1</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleSupportedPlatforms</key><array><string>MacOSX</string></array>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>UIDeviceFamily</key><array><integer>2</integer></array>
  <key>UIApplicationSupportsIndirectInputEvents</key><true/>
  <key>UILaunchScreen</key><dict/>
</dict>
</plist>
PLIST

codesign --force --sign - "$app" >/dev/null 2>&1
echo "Built $app"
case "${1:-}" in
  --build-only) ;;
  --tour | --tour-compact)
    # Walks the demo and writes a snapshot per screen to $2 (default
    # build/tour); --tour-compact uses an iPhone-sized window.
    shots="${2:-$here/build/tour}"
    # The app reads relative tour paths as inside its Documents folder.
    case "$shots" in /*) ;; *) shots="$here/$shots" ;; esac
    compact=()
    [ "$1" = --tour-compact ] && compact=(-PostoTourCompact)
    [ -n "${POSTO_TOUR_DARK:-}" ] && compact+=(-PostoTourDark)
    rm -rf "$shots"
    "$app/Contents/MacOS/Posto" -PostoDemo -PostoTour "$shots" ${compact[@]+"${compact[@]}"} >/dev/null 2>&1 || true
    ls "$shots"
    ;;
  *) open -n "$app" --args -PostoDemo ;;
esac
