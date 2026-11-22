#!/usr/bin/env bash
# Previews the app on a real site without Xcode: the Mac Catalyst debug
# build talks to the Rust bridge (host build) running in Tools/BackendHost
# over a Unix domain socket. GitHub sign-in is skipped, so deployments and
# pushing don't work here; everything else runs for real.
#
#   scripts/live-preview.sh <git repo> <owner/name>                launch the app
#   scripts/live-preview.sh <git repo> <owner/name> --tour [DIR]   snapshot each screen
#   scripts/live-preview.sh <git repo> <owner/name> --tour-compact [DIR]
#
# The site is copied (git clone) into build/live, where the tour's edits land;
# the repository you pass is never modified. POSTO_TOUR_DARK=1 for dark mode.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
cd "$here"
source_repo="$(cd "$1" && pwd)"
slug="$2"
mode="${3:-}"
data="$here/build/live/data"
# The bridge only opens repositories in its managed folder, <data>/repos/owner/name.
root="$data/repos/$slug"

rm -rf "$root"
mkdir -p "$(dirname "$root")"
git clone --quiet "$source_repo" "$root"
branch="$(git -C "$root" rev-parse --abbrev-ref HEAD)"

scripts/build-native.sh --host >/dev/null
out="$here/build/live"
socket="$out/backend.sock"
swiftc -O -parse-as-library \
  -I native/include \
  Posto/Engine/JSONValue.swift Posto/Engine/Backend.swift \
  Posto/Native/RustBackend.swift Tools/BackendHost/main.swift \
  -L native/target/release -lposto_native \
  -o "$out/backend-host"
scripts/catalyst-demo.sh --build-only >/dev/null
app="$here/build/catalyst/Posto.app"

"$out/backend-host" "$socket" "$data" >"$out/backend-host.log" 2>&1 &
host_pid=$!
trap 'kill $host_pid 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do
  grep -q listening "$out/backend-host.log" 2>/dev/null && break
  sleep 0.2
done

args=(-PostoBackendSocket "$socket" -PostoOpenRepo "$root" -PostoRepo "$slug" -PostoBranch "$branch")
case "$mode" in
  "")
    "$app/Contents/MacOS/Posto" "${args[@]}"
    ;;
  --tour | --tour-compact)
    shots="${4:-$here/build/tour-live}"
    case "$shots" in /*) ;; *) shots="$here/$shots" ;; esac
    source "$here/scripts/tour-output.sh"
    prepare_tour_output "$shots"
    [ "$mode" = --tour-compact ] && args+=(-PostoTourCompact)
    [ -n "${POSTO_TOUR_DARK:-}" ] && args+=(-PostoTourDark)
    "$app/Contents/MacOS/Posto" "${args[@]}" -PostoTour "$shots" >/dev/null 2>&1 || true
    ls "$shots"
    ;;
  *)
    echo "error: unknown option $mode" >&2
    exit 64
    ;;
esac
