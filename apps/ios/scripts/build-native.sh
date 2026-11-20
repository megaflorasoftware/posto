#!/usr/bin/env bash
# Builds the Rust engine in apps/ios/native.
#
#   build-native.sh          release static libraries for iOS devices and the
#                            simulator (Apple Silicon and Intel), packaged as
#                            apps/ios/native/build/PostoNative.xcframework
#   build-native.sh --host   a release static library for this Mac only, for
#                            trying the C ABI without Xcode
#
# The iOS mode needs Xcode (not just the Command Line Tools) for the iOS SDKs
# and `xcodebuild -create-xcframework`. It has not been run yet: the machine
# it was written on had only the Command Line Tools.
#
# The xcframework's headers carry a module map, so Swift can `import
# PostoNative`; the module map also autolinks the SDK libraries the engine
# needs (Security, CoreFoundation, libiconv, libz).
#
# IPHONEOS_DEPLOYMENT_TARGET (default 15.0, as for the Tauri app) sets the
# minimum iOS version the C dependencies are compiled for. Keep it at or
# below the app's deployment target.
set -euo pipefail

script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
native_dir="$(cd "$(dirname "$script")/../native" && pwd)"
cd "$native_dir"

mode=ios
case "${1:-}" in
  "") ;;
  --host) mode=host ;;
  -h | --help)
    # The header comment above.
    awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$script"
    exit 0
    ;;
  *)
    echo "error: unknown option '$1' (expected --host or nothing)" >&2
    exit 64
    ;;
esac

if ! command -v cargo >/dev/null 2>&1 || ! command -v rustup >/dev/null 2>&1; then
  echo "error: cargo and rustup are required (https://rustup.rs)" >&2
  exit 1
fi

# Run from an Xcode build phase, SDKROOT points at the app's SDK and would be
# used for build scripts that run on this Mac. The cc crate finds each
# target's SDK through xcrun on its own.
unset SDKROOT

# GitHub sign-in's OAuth client ID is compiled in (option_env! in auth.rs).
# The repository's .cargo/config.toml provides it; export it explicitly, as
# scripts/build-ios.sh does, so a build without that config still signs in.
if [ -z "${POSTO_GITHUB_CLIENT_ID:-}" ]; then
  POSTO_GITHUB_CLIENT_ID="$(sed -n 's/^POSTO_GITHUB_CLIENT_ID = { value = "\([^"]*\)".*/\1/p' \
    "$native_dir/../../../.cargo/config.toml" 2>/dev/null || true)"
fi
if [ -z "$POSTO_GITHUB_CLIENT_ID" ]; then
  echo "error: POSTO_GITHUB_CLIENT_ID is unset and .cargo/config.toml has no default" >&2
  exit 1
fi
export POSTO_GITHUB_CLIENT_ID

if [ "$mode" = host ]; then
  cargo build --release --locked --lib
  echo
  echo "Built $native_dir/target/release/libposto_native.a"
  echo "Headers and module map: $native_dir/include"
  exit 0
fi

if ! xcodebuild -version >/dev/null 2>&1; then
  echo "error: building for iOS needs Xcode, and xcodebuild is unavailable." >&2
  echo "Install Xcode, then point the developer directory at it:" >&2
  echo "  sudo xcode-select --switch /Applications/Xcode.app" >&2
  echo "(Use --host to build for this Mac without Xcode.)" >&2
  exit 1
fi
for sdk in iphoneos iphonesimulator; do
  if ! xcrun --sdk "$sdk" --show-sdk-path >/dev/null 2>&1; then
    echo "error: the $sdk SDK is missing from $(xcode-select -p)." >&2
    exit 1
  fi
done

export IPHONEOS_DEPLOYMENT_TARGET="${IPHONEOS_DEPLOYMENT_TARGET:-15.0}"

device_target=aarch64-apple-ios
simulator_targets=(aarch64-apple-ios-sim x86_64-apple-ios)
targets=("$device_target" "${simulator_targets[@]}")

# rust-toolchain.toml in $native_dir pins the toolchain these apply to.
installed="$(rustup target list --installed)"
for target in "${targets[@]}"; do
  if ! grep -qx "$target" <<<"$installed"; then
    rustup target add "$target"
  fi
done

for target in "${targets[@]}"; do
  echo "Building for $target"
  cargo build --release --locked --lib --target "$target"
done

library=libposto_native.a
build_dir="$native_dir/build"
xcframework="$build_dir/PostoNative.xcframework"
simulator_library="$build_dir/simulator/$library"
# A subdirectory named after the module, so its module.modulemap can't
# collide with another library's in Xcode's shared include directory.
headers="$build_dir/headers"

rm -rf "$xcframework" "$build_dir/simulator" "$headers"
mkdir -p "$build_dir/simulator" "$headers/PostoNative"
cp include/posto_native.h include/module.modulemap "$headers/PostoNative/"

simulator_inputs=()
for target in "${simulator_targets[@]}"; do
  simulator_inputs+=("target/$target/release/$library")
done
lipo -create "${simulator_inputs[@]}" -output "$simulator_library"

xcodebuild -create-xcframework \
  -library "target/$device_target/release/$library" -headers "$headers" \
  -library "$simulator_library" -headers "$headers" \
  -output "$xcframework"

echo
echo "Built $xcframework"
