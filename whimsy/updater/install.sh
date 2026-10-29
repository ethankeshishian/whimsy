#!/bin/sh
# Turns on Whimsy's automatic updates (macOS). Safe to run again, for example
# after editing updater.py.
#   sh whimsy/updater/install.sh            install or refresh
#   sh whimsy/updater/install.sh uninstall  stop and remove the jobs
set -e
REPO=$(cd "$(dirname "$0")/../.." && pwd)
DATA="$HOME/Library/Application Support/Whimsy Updater"
AGENTS="$HOME/Library/LaunchAgents"
DOMAIN="gui/$(id -u)"
PATH_VALUE="$HOME/.cargo/bin:$HOME/.mozbuild/sccache:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

for job in app.whimsy.updater app.whimsy.applier; do
  launchctl bootout "$DOMAIN/$job" 2>/dev/null || true
done
if [ "$1" = "uninstall" ]; then
  rm -f "$AGENTS/app.whimsy.updater.plist" "$AGENTS/app.whimsy.applier.plist"
  echo "Automatic updates removed. (State and logs stay in $DATA.)"
  exit 0
fi

mkdir -p "$DATA/bin" "$DATA/logs" "$AGENTS"
# The jobs run a copy, so a sync that rewrites the repository can't change
# the updater under them.
cp "$REPO/whimsy/updater/updater.py" "$DATA/bin/updater.py"
cp "$REPO/whimsy/version.py" "$DATA/bin/version.py"
# --publish: also publish each nightly build for other Macs (whimsy/publish.py).
PUBLISH=false
for arg in "$@"; do [ "$arg" = "--publish" ] && PUBLISH=true; done
printf '{\n  "repo": "%s",\n  "publish": %s\n}\n' "$REPO" "$PUBLISH" > "$DATA/config.json"

# Record what's installed now, the first time.
python3 - "$REPO" "$DATA" <<'PY'
import json, os, sys, uuid, datetime
repo, data = sys.argv[1:]
path = os.path.join(data, "state.json")
state = json.load(open(path)) if os.path.exists(path) else {}
if not state.get("installed") and os.path.isdir("/Applications/Whimsy.app"):
    base = json.load(open(os.path.join(repo, "whimsy", "upstream.json")))
    state["installed"] = {"id": uuid.uuid4().hex, "version": base.get("tag") or base.get("label"),
                          "zen_sha": base["sha"],
                          "installed_at": datetime.datetime.now().astimezone().isoformat(timespec="seconds")}
    state.setdefault("status", "idle")
    json.dump(state, open(path, "w"), indent=2)
PY

plist() { # plist <label> <command> <schedule xml>
  cat > "$AGENTS/$1.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$1</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/env</string>
    <string>python3</string>
    <string>$DATA/bin/updater.py</string>
    <string>$2</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$PATH_VALUE</string></dict>
  $3
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>Nice</key><integer>10</integer>
  <key>StandardOutPath</key><string>$DATA/logs/$2.out.log</string>
  <key>StandardErrorPath</key><string>$DATA/logs/$2.out.log</string>
</dict>
</plist>
PLIST
  plutil -lint "$AGENTS/$1.plist" > /dev/null
  launchctl bootstrap "$DOMAIN" "$AGENTS/$1.plist"
}

# Nightly at 3:30 am (after Zen's quiet evening hours); if the Mac was asleep,
# launchd runs it when it wakes.
plist app.whimsy.updater run '<key>StartCalendarInterval</key><dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>30</integer></dict>'
# Every minute: install a staged build once Whimsy is closed; rollbacks.
plist app.whimsy.applier apply '<key>StartInterval</key><integer>60</integer><key>RunAtLoad</key><true/>'

echo "Automatic updates are on: nightly at 3:30 am. Logs: $DATA/logs/update.log"
