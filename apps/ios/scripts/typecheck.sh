#!/usr/bin/env bash
# Typechecks every app source as Mac Catalyst (UIKit and iOS-flavored
# SwiftUI from the macOS SDK's iOSSupport), with the Rust bridge's header
# module. Works with only the Command Line Tools; Xcode's iOS build remains
# the real check.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
cd "$here"
sdk="$(xcrun --show-sdk-path)"
files=()
while IFS= read -r file; do files+=("$file"); done < <(find Posto -name '*.swift' | sort)
swiftc -typecheck -parse-as-library \
  -target "$(uname -m)-apple-ios17.0-macabi" \
  -sdk "$sdk" \
  -Fsystem "$sdk/System/iOSSupport/System/Library/Frameworks" \
  -I "$sdk/System/iOSSupport/usr/include" \
  -L "$sdk/System/iOSSupport/usr/lib" \
  -I "$sdk/System/iOSSupport/usr/lib/swift" \
  -I native/include \
  "${files[@]}"
echo "typecheck: ${#files[@]} files OK"
