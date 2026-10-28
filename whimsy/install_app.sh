#!/bin/sh
# Installs the built app at /Applications/Whimsy.app. Runs after
# `npm run build` and `npm run build:ui`, or by hand: `npm run install:app`.
# It goes through the updater: the build is staged (a standalone copy of the
# dev build's symlinks), installed right away if Whimsy is closed or when it
# next quits, and the current app is kept for rollback.
set -e
cd "$(dirname "$0")/.."
[ "$(uname)" = "Darwin" ] || exit 0
SRC=$(ls -d engine/obj-*/dist/Whimsy.app 2>/dev/null | head -1)
if [ -z "$SRC" ]; then
  echo "install_app: no built Whimsy.app found" >&2
  exit 1
fi
python3 whimsy/updater/updater.py stage "$SRC"
python3 whimsy/updater/updater.py status | python3 -c '
import json, sys
s = json.load(sys.stdin)["state"]
if s.get("staged"):
    print("Staged: installs when you next quit Whimsy.")
else:
    print("Installed /Applications/Whimsy.app")'
