#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ $# -ne 1 ]]; then
  echo "usage: scripts/release.sh <version>   e.g. scripts/release.sh 0.2.0" >&2
  exit 1
fi

VERSION="$1"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "error: version must be semver like 0.2.0" >&2
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "error: working tree is not clean, commit or stash first" >&2
  exit 1
fi

if git rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null; then
  echo "error: tag v$VERSION already exists" >&2
  exit 1
fi

echo "Bumping to $VERSION"

node -e '
  const fs = require("fs");
  for (const f of ["package.json", "src-tauri/tauri.conf.json"]) {
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    j.version = process.argv[1];
    fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n");
  }
' "$VERSION"

sed -i '' "s/^version = \".*\"/version = \"$VERSION\"/" src-tauri/Cargo.toml

# refresh Cargo.lock so it picks up the new package version
cargo metadata --manifest-path src-tauri/Cargo.toml --format-version 1 >/dev/null

git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "release v$VERSION"
git tag "v$VERSION"
git push origin HEAD "v$VERSION"

echo "Pushed v$VERSION — release workflow is running: https://github.com/$(git remote get-url origin | sed -E 's#(git@github.com:|https://github.com/)##; s/\.git$//')/actions"
