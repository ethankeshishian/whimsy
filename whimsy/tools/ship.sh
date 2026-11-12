#!/bin/zsh
# Ship dev only when the full verify of exactly this commit is green.
#   whimsy/tools/ship.sh            # npm run ship, as a queue ticket, after the checks
#   whimsy/tools/ship.sh --check    # the checks alone
# W24 shipped 15f6b3cc after a green full verify of an older commit
# (c9ba338b); the landing in between was never verified and the ship's own
# quick verify found two real failures. This refuses to ship unless:
#   - the main checkout is on dev and clean,
#   - no .surfer/verify/red-dev marker (the last verify-dev run was green),
#   - .surfer/verify/verified.json has a green full run (all or gate) of
#     dev's HEAD, built from that same commit (what npm run promote needs).
# Otherwise it says which, and how to get there (npm run verify:dev).
. "${0:A:h}/env.sh"
R=$WHIMSY_MAIN
cd $R || exit 2
check=0; [ "$1" = --check ] && check=1
fail() { echo "ship: refused: $1"; echo "ship: run \`npm run verify:dev\` (a queue ticket) and ship when it is green."; exit 1; }
[ "$(git rev-parse --abbrev-ref HEAD)" = dev ] || fail "main checkout is on $(git rev-parse --abbrev-ref HEAD), not dev"
[ -z "$(git status --porcelain --untracked-files=no)" ] || fail "main checkout has uncommitted changes"
[ -f .surfer/verify/red-dev ] && fail "dev's last full verify was red: $(head -1 .surfer/verify/red-dev)"
sha=$(git rev-parse HEAD)
why=$(python3 - "$sha" <<'EOF'
import json, sys
sha = sys.argv[1]
try:
    entry = json.load(open(".surfer/verify/verified.json")).get(sha)
except (OSError, ValueError):
    entry = None
if not entry: print("no verify run is recorded for dev's HEAD"); sys.exit()
if entry.get("mode") not in ("all", "gate"): print(f"dev's HEAD was last verified in `{entry.get('mode')}` mode, not a full one"); sys.exit()
if entry.get("status") != 0: print("dev's HEAD's last full verify failed"); sys.exit()
if entry.get("dirty") or entry.get("build_dirty"): print("dev's HEAD was verified with uncommitted changes"); sys.exit()
if entry.get("built_commit") != sha: print(f"the verified build was of {str(entry.get('built_commit'))[:12]}, not dev's HEAD"); sys.exit()
print("")
EOF
)
[ -z "$why" ] || fail "$why"
echo "ship: dev $(git rev-parse --short HEAD) has a green full verify of its own build"
[ $check = 1 ] && exit 0
exec $WHIMSY_TOOLS/queue.sh run --name ship -- npm run ship
