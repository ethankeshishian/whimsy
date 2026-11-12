#!/bin/zsh
# Build dev in the main checkout and run the full verify; record the result.
#   whimsy/tools/verify-dev.sh [--dev BRANCH] [--mode all|quick|gate]
# lane.sh queues this (low priority, one per branch at a time) after every
# landing, so a test another lane broke shows up after that landing, not at
# the end of the wave (W24 found seven such files 4 h after the last merge).
# A red run writes .surfer/verify/red-<branch> (the commit and the failing
# files); lane.sh then refuses to land anything but --fix lanes until a green
# run removes it. Runs as a queue ticket; returns the checkout to dev.
. "${0:A:h}/env.sh"
DEV=dev; MODE=all
while [ $# -gt 0 ]; do
  case $1 in
    --dev) DEV=$2; shift 2;;
    --mode) MODE=$2; shift 2;;
    *) echo "verify-dev.sh: unknown option $1" >&2; exit 2;;
  esac
done
[ -n "${WHIMSY_TICKET:-}" ] || exec $WHIMSY_TOOLS/queue.sh run --name "verify-${DEV//\//_}" -- "${0:A}" --dev "$DEV" --mode "$MODE"
R=$WHIMSY_MAIN; export WHIMSY_ROOT=$R
SRC=${WHIMSY_TOOLS:h:h}
run=$WHIMSY_RUNS/verify-${DEV//\//_}/$(date +%Y%m%d-%H%M%S); mkdir -p $run
summary=$run/summary.txt; t0=$(date +%s); result=; reasons=(); steps=()
REWRITES=(surfer.json docs/whimsy/NIGHT-LOG.md)
marker=$R/.surfer/verify/red-${DEV//\//_}
step() { steps+="STEP $(printf '%-9s %-5s %5ss' $1 $2 $3) ${4:-}"; echo "${steps[-1]}"; }
finish() {
  took=$(( $(date +%s) - t0 ))
  { echo "RESULT $result (verify $MODE of $DEV $(git -C $R rev-parse --short $sha 2>/dev/null), ${took}s, build=${build_kind:-none})"
    for r in $reasons; do echo "REASON $r"; done
    for s in $steps; do echo "$s"; done
    echo "logs: $run"; } > $summary
  printf '%s\tverify-%s\t%s\t%s\t%s\t%s\t%s\n' "$(date '+%F %T')" "${DEV//\//_}" "$MODE" "$result" "${build_kind:-none}" "$took" "${reasons[1]:-}" >> $WHIMSY_RUNS/tickets.tsv
  echo "---"; cat $summary
}
red() { result=red; reasons+="$1"; finish; exit 1; }
cd $R || exit 2
cleanup() {
  cd $R; git checkout -q -- $REWRITES 2>/dev/null
  left=$(git status --porcelain --untracked-files=no)
  [ -z "$left" ] || { git diff > $run/leftover.diff; git checkout -q -- .; echo "note: discarded changes the run left (saved to $run/leftover.diff): $left"; }
  git checkout -q dev 2>/dev/null || git checkout -q -f dev
}
trap cleanup EXIT
trap 'red interrupted' INT TERM
git checkout -q -- $REWRITES 2>/dev/null
[ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "main checkout has uncommitted changes; refusing"; git status --short --untracked-files=no | head; result=refused; finish; exit 2; }
sha=$(git rev-parse $DEV) || exit 2
git checkout -q --detach $sha

# The build the changes since the last recorded build need; full if unknown.
ts=$(date +%s)
built=$(python3 -c "import json;print(json.load(open('.surfer/verify/build.json'))['commit'])" 2>/dev/null)
if [ -n "$built" ] && git merge-base --is-ancestor $built HEAD 2>/dev/null; then since=$built; else since=; fi
python3 $SRC/whimsy/precheck.py ${since:+--since $since} ${since:---all} > $run/precheck.log 2>&1; prc=$?
build_kind=$(sed -n 's/^BUILD: //p' $run/precheck.log | tail -1); [ -n "$since" ] || build_kind=full
[ $prc = 0 ] || { step precheck red $(( $(date +%s) - ts )); red "precheck: $(grep -m1 '^PROBLEM' $run/precheck.log | cut -c1-300)"; }
step precheck ok $(( $(date +%s) - ts )) "build=$build_kind since ${since:-(none)}"

ts=$(date +%s)
{ npx surfer set brand release && npm run import; } > $run/import.log 2>&1 || { step import red $(( $(date +%s) - ts )); red "import failed ($run/import.log)"; }
git checkout -q -- $REWRITES 2>/dev/null
dirtied=$(git status --porcelain --untracked-files=no)
[ -z "$dirtied" ] || { step import red $(( $(date +%s) - ts )); red "import changed tracked files: $(echo $dirtied | tr '\n' ' ')"; }
find -L engine/zen engine/browser/base/content/zen-components 2>/dev/null -type l -exec rm {} + 2>/dev/null
step import ok $(( $(date +%s) - ts ))

ts=$(date +%s)
case $build_kind in
  faster) bcmd='./mach build faster';;
  backend) bcmd='./mach build-backend && ./mach build faster';;
  binaries) bcmd='./mach build binaries && ./mach build faster';;
  *) bcmd='./mach build'; build_kind=full;;
esac
(cd engine && eval "$bcmd") > $run/build.log 2>&1 || { step build red $(( $(date +%s) - ts )) $build_kind; red "build ($build_kind) failed: $(grep -m1 -E 'error:|failed' $run/build.log | cut -c1-200)"; }
python3 whimsy/updater/updater.py record-build >/dev/null 2>&1 || true
step build ok $(( $(date +%s) - ts )) $build_kind

ts=$(date +%s)
WHIMSY_ROOT=$R sh $SRC/whimsy/verify.sh $MODE > $run/verify.log 2>&1; vrc=$?
cp .surfer/verify/failed.txt $run/failed.txt 2>/dev/null; cp .surfer/verify/flaky.txt $run/flaky.txt 2>/dev/null
failing=$(grep -c . $run/failed.txt 2>/dev/null || echo 0)
flaky=$(grep -c . $run/flaky.txt 2>/dev/null || echo 0)
if [ $vrc != 0 ]; then
  step verify red $(( $(date +%s) - ts )) "$failing failing file(s), $flaky flaky"
  { echo "$(git rev-parse --short $sha) red $(date '+%F %T'): $failing failing file(s)"; cat $run/failed.txt; } > $marker
  for f in ${(f)"$(head -12 $run/failed.txt)"}; do reasons+="failing: $f"; done
  red "verify red on $sha: $failing failing file(s) ($run/failed.txt); landings on $DEV blocked until a --fix lane turns it green"
fi
rm -f $marker
step verify ok $(( $(date +%s) - ts )) "$(grep -hE '^(whimsy|zen-tabs|zen-ui): passed' $run/verify.log | tr '\n' ';') $flaky flaky"
result=green; finish; exit 0
