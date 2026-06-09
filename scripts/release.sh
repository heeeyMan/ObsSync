#!/usr/bin/env bash
#
# Cut a GitHub release for GitSync that BRAT and the Obsidian community store
# can consume.
#
# Obsidian's rules: the release tag must EXACTLY equal the version in
# manifest.json (no leading "v"), and main.js / manifest.json / styles.css must
# be attached as individual binary assets (not zipped).
#
# Usage:
#   ./scripts/release.sh                 # release the version in manifest.json
#   DRY_RUN=1 ./scripts/release.sh       # build + validate only, no tag/push/release
#
# Requires: node, npm, git, and the GitHub CLI (`gh auth login` done once).

set -euo pipefail
cd "$(dirname "$0")/.."

step() { printf '\n\033[1m▶ %s\033[0m\n' "$1"; }
fail() { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

# --- preconditions ----------------------------------------------------------
command -v gh >/dev/null   || fail "GitHub CLI (gh) not found. Install it and run 'gh auth login'."
command -v node >/dev/null || fail "node not found."
gh auth status >/dev/null 2>&1 || fail "Not authenticated with GitHub. Run 'gh auth login'."

VERSION="$(node -p "require('./manifest.json').version")"
[ -n "$VERSION" ] || fail "Could not read version from manifest.json."
step "Releasing GitSync $VERSION"

# manifest version must be registered in versions.json (Obsidian requirement).
node -e "const v=require('./versions.json'); if(!v['$VERSION']) { console.error('versions.json is missing an entry for $VERSION'); process.exit(1); }" \
  || fail "Add \"$VERSION\": \"<minAppVersion>\" to versions.json first."

# clean working tree, so the release reflects committed state.
if [ -n "$(git status --porcelain)" ]; then
  fail "Working tree is dirty. Commit or stash changes before releasing."
fi

# tag must not already exist.
if git rev-parse -q --verify "refs/tags/$VERSION" >/dev/null; then
  fail "Tag $VERSION already exists. Bump the version in manifest.json + versions.json."
fi

# --- build ------------------------------------------------------------------
step "Building (npm run build)"
npm run build

step "Running regression suite (npm test)"
npm test

ASSETS=(main.js manifest.json styles.css)
for f in "${ASSETS[@]}"; do
  [ -f "$f" ] || fail "Missing release asset: $f"
done
printf '\033[32m✓ assets present: %s\033[0m\n' "${ASSETS[*]}"

if [ "${DRY_RUN:-0}" = "1" ]; then
  step "DRY_RUN=1 — stopping before tag/push/release. Everything above is valid."
  exit 0
fi

# --- confirm before doing anything remote/irreversible ----------------------
step "About to: tag $VERSION, push the tag, and create a GitHub release with the 3 assets."
read -r -p "Proceed? [y/N] " reply
[[ "$reply" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 1; }

# --- tag, push, release -----------------------------------------------------
step "Tagging and pushing $VERSION"
git tag -a "$VERSION" -m "GitSync $VERSION"
git push origin "$VERSION"

step "Creating GitHub release"
gh release create "$VERSION" "${ASSETS[@]}" \
  --title "$VERSION" \
  --notes "GitSync $VERSION. Install via BRAT (paste this repo URL) or download the three assets into .obsidian/plugins/gitsync/. See README for setup."

step "Done. Release $VERSION published with assets: ${ASSETS[*]}"
echo "BRAT users can now add this repo; store submitters can reference tag $VERSION."
