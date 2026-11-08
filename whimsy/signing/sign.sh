#!/bin/sh
# Signs an app bundle with Whimsy's stable self-signed code-signing identity
# ("Whimsy Self-Signed"), so every build gets the SAME designated requirement
# (anchored to the certificate, not the cdhash) and macOS keeps treating
# updates as the same app -- no repeated "access key"/"use confidential
# information" keychain prompts and no reset TCC grants (Local Network,
# camera/mic) after every update.
#
#   sh whimsy/signing/sign.sh <app-bundle>
#   sh whimsy/signing/sign.sh --check     (exit 0 iff the identity is usable here)
#
# Requires the identity to already be set up on this Mac (dedicated keychain
# ~/Library/Keychains/whimsy-signing.keychain-db, unlocked and on the user's
# keychain search list, with a `security set-key-partition-list` grant for
# codesign) and its SHA-1 hash recorded in
# ~/.config/whimsy/codesign-identity-sha1. Signs by that SHA-1 hash directly
# (not by common name), which works even though the cert is untrusted
# (self-signed, not Apple-issued) -- `security find-identity -v` would
# exclude it, but codesign accepts an explicit hash regardless of trust.
#
# Fails loudly (exit 1) and does NOT fall back to ad-hoc signing if the
# identity isn't available: this script is for the publish Mac, which must
# always have the key. A caller that may run on a Mac without the key (the
# updater applying a saved custom app icon after install) asks --check first
# and, without the identity, must NOT ad-hoc re-sign: an ad-hoc re-sign
# (even with --preserve-metadata=requirements) can't satisfy this designated
# requirement, so keychain ACLs and TCC grants stop matching. Those callers
# leave the sealed contents alone instead (a Finder custom icon). See
# whimsy/updater/updater.py's apply_app_icon and WhimsyAppIcon.sys.mjs.
set -eu

HASH_FILE="$HOME/.config/whimsy/codesign-identity-sha1"
KEYCHAIN="$HOME/Library/Keychains/whimsy-signing.keychain-db"
KEYCHAIN_PASS_FILE="$HOME/.config/whimsy/signing-keychain-pass"
IDENTITY_NAME="Whimsy Self-Signed"

app="${1:?usage: sign.sh <app-bundle> | --check}"

if [ ! -f "$HASH_FILE" ]; then
  echo "sign.sh: $HASH_FILE is missing -- the '$IDENTITY_NAME' identity hasn't been set up on this Mac. See whimsy/signing/sign.sh's header, or import the backed-up .p12 from ~/.config/whimsy/ on the Mac that created it." >&2
  exit 1
fi
hash=$(tr -d ' \t\n\r' < "$HASH_FILE")
if [ -z "$hash" ]; then
  echo "sign.sh: $HASH_FILE is empty" >&2
  exit 1
fi

# The password goes in on stdin, never argv (`-p` would show it to ps).
if [ -f "$KEYCHAIN_PASS_FILE" ] && [ -f "$KEYCHAIN" ]; then
  security unlock-keychain "$KEYCHAIN" < "$KEYCHAIN_PASS_FILE" >/dev/null 2>&1 || true
fi

if ! security find-key -s -l "$IDENTITY_NAME" "$KEYCHAIN" >/dev/null 2>&1; then
  echo "sign.sh: no private key for '$IDENTITY_NAME' in $KEYCHAIN (or it isn't unlocked/on the keychain search list). Not signing -- refusing to fall back to ad-hoc signing here." >&2
  exit 1
fi

[ "$app" = "--check" ] && exit 0

info_plist="$app/Contents/Info.plist"
bundle_id=$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$info_plist" 2>/dev/null) || true
if [ -z "$bundle_id" ]; then
  echo "sign.sh: couldn't read CFBundleIdentifier from $info_plist" >&2
  exit 1
fi

requirement="designated => identifier \"$bundle_id\" and certificate leaf = H\"$hash\""

# Two passes. --deep with --identifier/-r would stamp the main app's
# identifier and requirement onto every nested helper and dylib
# (plugin-container.app, updater.app, ...), so: first sign everything,
# nested code inside-out, with its own identifier and the default
# requirement (anchored to this certificate too); then re-sign just the
# outer bundle with the explicit designated requirement.
/usr/bin/codesign --force --deep --sign "$hash" --keychain "$KEYCHAIN" "$app"
exec /usr/bin/codesign --force --sign "$hash" --keychain "$KEYCHAIN" \
  --identifier "$bundle_id" -r="$requirement" "$app"
