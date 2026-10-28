#!/bin/sh
# Installs the built app into /Applications/Whimsy.app (macOS).
# Dev builds are mostly symlinks into the source tree, so copy with -L to make
# a standalone app. Runs automatically after `npm run build` (postbuild).
set -e
cd "$(dirname "$0")/.."
[ "$(uname)" = "Darwin" ] || exit 0

SRC=$(ls -d engine/obj-*/dist/Whimsy.app 2>/dev/null | head -1)
DEST=/Applications/Whimsy.app
if [ -z "$SRC" ]; then
  echo "install_app: no built Whimsy.app found" >&2
  exit 1
fi

# Quit the installed copy (not dev runs from the build folder) so it can be replaced.
if pgrep -f "$DEST/Contents/MacOS/" > /dev/null; then
  echo "Quitting the installed Whimsy…"
  osascript -e 'tell application id "app.zen-browser.whimsy" to quit' 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    pgrep -f "$DEST/Contents/MacOS/" > /dev/null || break
    sleep 1
  done
fi

TMP="$DEST.installing"
rm -rf "$TMP"
rsync -aL --exclude ".DS_Store" "$SRC/" "$TMP/"
rm -rf "$DEST"
mv "$TMP" "$DEST"
# Let the Dock and Finder pick up the new icon.
touch "$DEST"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$DEST" 2>/dev/null || true
echo "Installed $DEST ($(du -sh "$DEST" | cut -f1))"
