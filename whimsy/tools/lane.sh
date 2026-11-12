#!/bin/zsh
# Land (or just test) a lane: merge it onto dev, precheck, import, build the
# smallest build the change needs, lint, run the lane's tests, and on green
# fast-forward dev to that very commit.
#   whimsy/tools/lane.sh land LANE [options]   test the merge; on green dev := it, verify queued
#   whimsy/tools/lane.sh test LANE [options]   the same without moving dev
# LANE is a branch (lane/w25-x, or just w25-x). Options:
#   --dev BRANCH      the branch to merge onto and fast-forward (default dev)
#   --test FILE...    test files to run besides the ones the lane changed
#   --jobs N          parallel harness runs (default 3)
#   --message TEXT    the merge commit's subject
#   --fix             land even while the dev verify is red (a fix lane)
#   --no-verify       don't queue the full verify after landing
# The run goes through the engine queue by itself. It refuses a dirty main
# checkout, and on every exit (red, green, killed) returns the main checkout
# to dev with no changes left: anything a step dirtied is saved to the run
# folder and discarded. A red run keeps the merge commit at
# refs/tested/<lane> for the fixer. Summary: $WHIMSY_RUNS/<lane>/<time>/summary.txt
. "${0:A:h}/env.sh"
mode=$1; lane=$2; shift 2 2>/dev/null
[ "$mode" = land ] || [ "$mode" = test ] || { sed -n '2,20p' "${0:A}"; exit 2; }
[ -n "$lane" ] || { echo "lane.sh: which lane?" >&2; exit 2; }
DEV=dev; extra=(); jobs=3; message=; fix=0; verify=1
while [ $# -gt 0 ]; do
  case $1 in
    --dev) DEV=$2; shift 2;;
    --test) shift; while [ $# -gt 0 ] && [[ $1 != --* ]]; do extra+=$1; shift; done;;
    --jobs) jobs=$2; shift 2;;
    --message) message=$2; shift 2;;
    --fix) fix=1; shift;;
    --no-verify) verify=0; shift;;
    *) echo "lane.sh: unknown option $1" >&2; exit 2;;
  esac
done
R=$WHIMSY_MAIN; export WHIMSY_ROOT=$R
SRC=${WHIMSY_TOOLS:h:h}          # the tree this tooling runs from (may be a worktree)
if git -C $R rev-parse -q --verify "refs/heads/lane/$lane" >/dev/null; then LANE=lane/$lane
elif git -C $R rev-parse -q --verify "$lane" >/dev/null; then LANE=$lane
else echo "lane.sh: no branch lane/$lane or $lane" >&2; exit 2; fi
short=${LANE#lane/}; short=${short//\//_}

# Everything that builds or tests runs as one ticket on the engine queue.
[ -n "${WHIMSY_TICKET:-}" ] || exec $WHIMSY_TOOLS/queue.sh run --name "lane-$mode-$short" -- "${0:A}" "$mode" "$lane" \
  --dev "$DEV" --jobs "$jobs" ${message:+--message "$message"} $( [ $fix = 1 ] && echo --fix ) $( [ $verify = 0 ] && echo --no-verify ) \
  ${extra:+--test} $extra

run=$WHIMSY_RUNS/$short/$(date +%Y%m%d-%H%M%S); mkdir -p $run
summary=$run/summary.txt; steps=(); t0=$(date +%s); result=; reasons=()
REWRITES=(surfer.json docs/whimsy/NIGHT-LOG.md)   # files import rewrites on every run

say() { echo "$@"; }
step() { # step NAME STATUS SECONDS [DETAIL]
  steps+="STEP $(printf '%-9s %-5s %5ss' $1 $2 $3) ${4:-}"; say "${steps[-1]}"
}
finish() {
  took=$(( $(date +%s) - t0 ))
  {
    echo "RESULT $result ($LANE $(git -C $R rev-parse --short $LANE) onto $DEV, ${took}s, build=${build_kind:-none})"
    for r in $reasons; do echo "REASON $r"; done
    [ -n "$mergesha" ] && [ "$result" != green ] && echo "merge commit kept at refs/tested/$short ($(git -C $R rev-parse --short $mergesha)); $DEV unchanged"
    for s in $steps; do echo "$s"; done
    echo "logs: $run"
  } > $summary
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$(date '+%F %T')" "$short" "$mode" "$result" "${build_kind:-none}" "$took" "${reasons[1]:-}" >> $WHIMSY_RUNS/tickets.tsv
  say "---"; cat $summary
}
red() { result=red; reasons+="$1"; [ -n "$mergesha" ] && git -C $R update-ref refs/tested/$short $mergesha; finish; exit 1; }
fault() { [ "${WHIMSY_FAULT:-}" = "$1" ] && { red "injected fault after $1 (WHIMSY_FAULT)"; }; }

cd $R || exit 2
cleanup() {
  cd $R
  [ -e .git/MERGE_HEAD ] || [ -e "$(git rev-parse --git-dir)/MERGE_HEAD" ] && git merge --abort 2>/dev/null
  git checkout -q -- $REWRITES 2>/dev/null
  left=$(git status --porcelain --untracked-files=no)
  if [ -n "$left" ]; then
    git diff > $run/leftover.diff 2>/dev/null
    git checkout -q -- . 2>/dev/null
    say "note: discarded changes the run left in the main checkout (saved to $run/leftover.diff):"; say "$left"
  fi
  git checkout -q dev 2>/dev/null || git checkout -q -f dev
}
trap 'cleanup' EXIT
trap 'red "interrupted"' INT TERM

# 0. A clean start on dev.
git checkout -q -- $REWRITES 2>/dev/null
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  say "main checkout has uncommitted changes; refusing:"; git status --short --untracked-files=no | head; result=refused; finish; exit 2
fi
[ "$(git rev-parse --abbrev-ref HEAD)" = dev ] || { say "main checkout is on $(git rev-parse --abbrev-ref HEAD), not dev; refusing"; result=refused; finish; exit 2; }
whimsy_git_setup $R $WHIMSY_TOOLS

# 1. Merge the lane onto dev, detached, with the derived-file drivers.
devsha=$(git rev-parse $DEV); lanesha=$(git rev-parse $LANE); mergesha=
ts=$(date +%s)
if git merge-base --is-ancestor $lanesha $devsha; then
  say "$LANE is already in $DEV; nothing to land"; result=green; step merge ok 0 "already in $DEV"; finish; exit 0
fi
git checkout -q --detach $devsha || { result=red; reasons+="could not check out $DEV"; finish; exit 1; }
if ! git merge --no-ff --no-commit $LANE > $run/merge.log 2>&1; then
  conflicts=$(git diff --name-only --diff-filter=U | tr '\n' ' ')
  git merge --abort
  step merge red $(( $(date +%s) - ts )) "conflict"
  red "merge conflict (the drivers could not resolve): ${conflicts:-see $run/merge.log}"
fi
# Derived files: the overlay must be a no-op on the merged tree except for
# its generated files, which are regenerated here so the commit is exact.
python3 whimsy/overlay.py check > $run/overlay-check.log 2>&1; orc=$?
if grep -q "^NOT APPLIED: .*'id'" $run/overlay-check.log || grep -q '^PROBLEM' $run/overlay-check.log; then
  step merge red $(( $(date +%s) - ts )) "overlay not committed"
  git merge --abort
  red "overlay hook/hotfix is not applied in the merged tree (apply and commit it on the lane): $(grep -E "^(NOT APPLIED|PROBLEM)" $run/overlay-check.log | head -3 | tr '\n' ' ')"
fi
if [ $orc != 0 ]; then
  python3 whimsy/overlay.py apply >> $run/overlay-check.log 2>&1
  git add -u -- prefs locales/en-US surfer.json package.json configs/common/mozconfig src/build 2>/dev/null
  regen=" (regenerated $(grep -c "^NOT APPLIED" $run/overlay-check.log) derived file(s))"
fi
[ -n "$message" ] || message="Merge $LANE: $(git log -1 --format=%s $LANE)"
git commit -q --no-verify -m "$message" || { git merge --abort; red "could not commit the merge (see $run/merge.log)"; }
mergesha=$(git rev-parse HEAD)
step merge ok $(( $(date +%s) - ts )) "$(git rev-parse --short $mergesha)${regen:-}"
fault merge

# 2. Precheck, before anything costs engine time.
ts=$(date +%s)
python3 $SRC/whimsy/precheck.py --since $devsha > $run/precheck.log 2>&1; prc=$?
build_kind=$(sed -n 's/^BUILD: //p' $run/precheck.log | tail -1)
if [ $prc != 0 ]; then
  step precheck red $(( $(date +%s) - ts ))
  red "precheck: $(grep -m1 '^PROBLEM' $run/precheck.log | cut -c1-300) ($(grep -c '^PROBLEM' $run/precheck.log) problem(s), $run/precheck.log)"
fi
step precheck ok $(( $(date +%s) - ts )) "build=$build_kind"
fault precheck

# 3. Import (ffprefs, patches, links, strings, engine overrides).
ts=$(date +%s)
npm run import > $run/import.log 2>&1 || { step import red $(( $(date +%s) - ts )); red "import failed: $(grep -m1 -iE 'error|failed|panicked' $run/import.log | cut -c1-200) ($run/import.log)"; }
git checkout -q -- $REWRITES 2>/dev/null
dirtied=$(git status --porcelain --untracked-files=no)
[ -z "$dirtied" ] || { step import red $(( $(date +%s) - ts )); red "import changed tracked files (commit them or fix the overlay): $(echo $dirtied | tr '\n' ' ')"; }
find -L engine/zen engine/browser/base/content/zen-components 2>/dev/null -type l -exec rm {} + 2>/dev/null
step import ok $(( $(date +%s) - ts ))
fault import

# 4. The smallest build the change needs (precheck decided).
ts=$(date +%s)
case $build_kind in
  faster)   bcmd='./mach build faster';;
  backend)  bcmd='./mach build-backend && ./mach build faster';;
  binaries) bcmd='./mach build binaries && ./mach build faster';;
  *)        bcmd='./mach build'; build_kind=full;;
esac
(cd engine && eval "$bcmd") > $run/build.log 2>&1 || { step build red $(( $(date +%s) - ts )) "$build_kind"; red "build ($build_kind) failed: $(grep -m1 -E 'error:|Error|failed' $run/build.log | cut -c1-200) ($run/build.log)"; }
python3 whimsy/updater/updater.py record-build >/dev/null 2>&1 || true
step build ok $(( $(date +%s) - ts )) "$build_kind"
fault build

# 5. Lint the lane's JS.
ts=$(date +%s)
jsfiles=(${(f)"$(git diff --name-only $devsha HEAD -- '*.js' '*.mjs' | while read -r f; do [ -f "$f" ] && echo "../$f"; done)"})
if [ ${#jsfiles} -gt 0 ]; then
  (cd engine && ./mach lint -l eslint $jsfiles 2>&1 | grep -v -i prettier) > $run/lint.log
  nerr=$(grep -cE '^ *[0-9]+:[0-9]+ +error' $run/lint.log)
  [ "$nerr" = 0 ] || { step lint red $(( $(date +%s) - ts )) "$nerr errors"; red "lint: $nerr eslint error(s): $(grep -m1 -B1 -E '^ *[0-9]+:[0-9]+ +error' $run/lint.log | tr '\n' ' ' | cut -c1-200) ($run/lint.log)"; }
  step lint ok $(( $(date +%s) - ts )) "${#jsfiles} files"
else
  step lint ok 0 "no JS changed"
fi

# 6. The lane's tests: every test file it changed or added, plus --test.
ts=$(date +%s)
tests=(${(f)"$(git diff --name-only $devsha HEAD -- 'src/zen/whimsy/tests/browser_*.js' | while read -r f; do [ -f "$f" ] && echo "${f#src/}"; done)"})
for e in $extra; do tests+=$e; done
tests=(${(u)tests})
if [ ${#tests} -gt 0 ]; then
  $WHIMSY_TOOLS/test.sh --name $short/${run:t} --jobs $jobs $tests > $run/tests.out 2>&1; trc=$?
  cat $run/tests.out
  if [ $trc != 0 ]; then
    step tests red $(( $(date +%s) - ts )) "${#tests} files"
    for r in ${(f)"$(sed -n 's/^REASON //p' $run/tests.out)"}; do reasons+="tests: $r"; done
    for r in ${(f)"$(sed -n 's/^CRASH //p' $run/tests.out)"}; do reasons+="crash: $r"; done
    red "tests red ($(sed -n 's/^PASSED //p' $run/tests.out | head -1))"
  fi
  step tests ok $(( $(date +%s) - ts )) "$(sed -n 's/^PASSED //p' $run/tests.out | head -1)"
else
  step tests ok 0 "none changed (the full verify covers the lane)"
fi
fault test

# 7. Land: dev fast-forwards to exactly the tested commit.
if [ $mode = land ]; then
  marker=$R/.surfer/verify/red-${DEV//\//_}
  if [ -f $marker ] && [ $fix = 0 ]; then
    red "$DEV's full verify is red ($(head -1 $marker)); fix it first, or land a fix lane with --fix"
  fi
  [ "$(git rev-parse $DEV)" = "$devsha" ] || red "$DEV moved during the run ($(git rev-parse --short $DEV) now); run again"
  git branch -f $DEV $mergesha || red "could not fast-forward $DEV"
  step land ok 0 "$DEV -> $(git rev-parse --short $mergesha)"
  if [ $verify = 1 ]; then
    t=$($WHIMSY_TOOLS/queue.sh submit --low --dedupe --name verify-${DEV//\//_} -- $WHIMSY_TOOLS/verify-dev.sh --dev $DEV)
    step verify queued 0 "ticket $t"
  fi
else
  git update-ref refs/tested/$short $mergesha
  step land skip 0 "test only; merge commit at refs/tested/$short"
fi
result=green; finish; exit 0
