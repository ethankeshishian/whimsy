#!/bin/zsh
# Run Whimsy's AI quality evals against the real model and write a report.
#   whimsy/tools/aievals.sh [--lane LANE] [--budget USD] [--only id,id,...] [FILE...]
# The cases live in src/zen/whimsy/tests/aievals/cases.json and run through
# the four browser_whimsy_aievals_*.js mochitests (all of them unless FILEs
# are named). Without --lane the files must already be imported into the
# engine (they are on dev); with --lane the run goes through lane.sh test,
# which merges the lane onto dev, imports, builds, and runs the same files.
# Everything runs as one engine-queue ticket. The key is read by the browser
# from ~/.config/whimsy/anthropic-api-key; this script only checks the file
# exists and never reads it. Results: $WHIMSY_MAIN/.surfer/aievals/runs/<time>/
# (per-file JSON, report.md), and `latest` points at the newest run.
. "${0:A:h}/env.sh"
budget=${WHIMSY_AIEVALS_BUDGET_USD:-12}; lane=; only=
while [ $# -gt 0 ]; do
  case $1 in
    --lane) lane=$2; shift 2;;
    --budget) budget=$2; shift 2;;
    --only) only=$2; shift 2;;
    --) shift; break;;
    -*) echo "aievals.sh: unknown option $1" >&2; exit 2;;
    *) break;;
  esac
done
files=("$@")
[ ${#files} -gt 0 ] || files=(browser_whimsy_aievals_chat.js browser_whimsy_aievals_text.js browser_whimsy_aievals_tabs.js browser_whimsy_aievals_agent.js)
keyfile=$HOME/.config/whimsy/anthropic-api-key
[ -s "$keyfile" ] || { echo "aievals.sh: no key at $keyfile" >&2; exit 2; }

ts=$(date +%Y%m%d-%H%M%S)
runs=$WHIMSY_MAIN/.surfer/aievals/runs
out=$runs/$ts
mkdir -p $out
export WHIMSY_AIEVALS=1 WHIMSY_AIEVALS_OUT=$out WHIMSY_AIEVALS_BUDGET_USD=$budget WHIMSY_AIEVALS_ONLY=$only
# The mochitest runner makes any non-local connection a fatal crash
# (MOZ_DISABLE_NONLOCAL_CONNECTIONS=1 via mozrunner). Only this script turns
# it off, for the browser under test; lane.sh and verify.sh never set it, so
# their runs keep the crash as the backstop against ever reaching the model.
# In its place head_aievals.js wraps the harness proxy PAC so only the fixture
# hosts, localhost, and api.anthropic.com resolve; every other host goes to a
# dead proxy (cases net-01 and net-02 prove it each run). --setenv is applied
# after mozrunner's default, and test.sh passes WHIMSY_ARGS through to mach.
export WHIMSY_ARGS="${WHIMSY_ARGS:+$WHIMSY_ARGS }--setenv MOZ_DISABLE_NONLOCAL_CONNECTIONS=0"
echo "aievals: run $ts, budget \$$budget, results in $out"
if [ -n "$lane" ]; then
  # lane.sh queues itself; the ticket carries every WHIMSY_* variable.
  $WHIMSY_TOOLS/lane.sh test $lane --test $files; rc=$?
else
  $WHIMSY_TOOLS/queue.sh run --name aievals-$ts -- $WHIMSY_TOOLS/test.sh --name aievals/$ts $files; rc=$?
fi
echo "aievals: tests exited $rc"
python3 $WHIMSY_TOOLS/aievals_report.py $out || exit $?
ln -sfn $ts $runs/latest
echo "aievals: report at $out/report.md"
