#!/bin/sh
# Installs the built app at /Applications/Whimsy.app. Runs after
# `npm run build` and `npm run build:ui`, or by hand: `npm run install:app`.
# It goes through the updater: the build is staged (a standalone copy of the
# dev build's symlinks), installed right away if Whimsy is closed or when it
# next quits (that needs the local updater, whimsy/updater/install.sh), and
# the current app is kept for rollback.
set -e
cd "$(dirname "$0")/.."
[ "$(uname)" = "Darwin" ] || exit 0
SRC=$(ls -d engine/obj-*/dist/Whimsy.app 2>/dev/null | head -1)
if [ -z "$SRC" ]; then
  echo "install_app: no built Whimsy.app found" >&2
  exit 1
fi
# Prints whether it installed, or when it will (and how, without the local
# updater's applier job).
python3 whimsy/updater/updater.py stage "$SRC"
