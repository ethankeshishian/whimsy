#!/bin/sh
# After a build: run the Whimsy tests, Zen's tab/UI suites, and save
# screenshots of the real window to $WHIMSY_SHOTS (default .surfer/shots).
#   sh scripts/whimsy_verify.sh            # everything
#   sh scripts/whimsy_verify.sh quick      # Whimsy tests + screenshots only
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH" _ZO_DOCTOR=0
export WHIMSY_SHOTS="${WHIMSY_SHOTS:-$PWD/.surfer/shots}"
rm -rf "$WHIMSY_SHOTS" && mkdir -p "$WHIMSY_SHOTS" .surfer/verify

status=0
run() { # run <name> <test path>
  log=.surfer/verify/$1.log
  npm test -- "$2" > "$log" 2>&1
  passed=$(grep -E "INFO Passed:" "$log" | tail -1 | awk '{print $NF}')
  failed=$(grep -E "INFO Failed:" "$log" | tail -1 | awk '{print $NF}')
  echo "$1: passed ${passed:-?}, failed ${failed:-?}"
  if [ "${failed:-1}" != "0" ]; then
    status=1
    grep -E "^FAIL|TEST-UNEXPECTED" "$log" | grep -v "finished in" | cut -c1-220 | sort -u | head -15
  fi
}

run whimsy-app-icon ui/browser_whimsy_app_icon.js
run whimsy-strings-keys ui/browser_whimsy_strings_and_keys.js
run whimsy-ctrl-tab tabs/browser_tabs_ctrl_tab_mru.js
run whimsy-screens ui/browser_whimsy_screens.js
if [ "$1" != "quick" ]; then
  run zen-tabs tabs
  run zen-ui ui
fi

echo "Screenshots: $WHIMSY_SHOTS"
ls "$WHIMSY_SHOTS"
exit $status
