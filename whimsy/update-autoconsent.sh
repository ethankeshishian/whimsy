#!/bin/sh
# Refresh the vendored DuckDuckGo Autoconsent (MPL-2.0) behind "Reject cookie
# banners": the add-on's content script, the library (for the compact rule
# filter and eval snippets) and the compact rule set only.
# Usage: sh whimsy/update-autoconsent.sh [version]
set -e
cd "$(dirname "$0")/.."
dest=src/zen/whimsy/cookie-banners
tmp=$(mktemp -d)
(cd "$tmp" && npm pack --silent "@duckduckgo/autoconsent@${1:-latest}" >/dev/null && tar xzf ./*.tgz)
p="$tmp/package"
cp "$p/dist/addon-firefox/content.bundle.js" "$dest/autoconsent/content.js"
cp "$p/dist/autoconsent.esm.js" "$dest/autoconsent/autoconsent.mjs"
cp "$p/rules/compact-rules.json" "$dest/autoconsent/compact-rules.json"
cp "$p/LICENSE" "$dest/autoconsent/LICENSE"
version=$(node -p "require('$p/package.json').version")
python3 - "$dest/manifest.json" "$version" <<'PY'
import json, sys
path, version = sys.argv[1:]
manifest = json.load(open(path))
manifest["version"] = version
open(path, "w").write(json.dumps(manifest, indent=2) + "\n")
PY
rm -rf "$tmp"
echo "Autoconsent $version vendored into $dest"
