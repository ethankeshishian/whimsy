#!/bin/zsh
# Run Whimsy test files against the built engine and say why they are red.
#   whimsy/tools/test.sh [--name NAME] [--jobs N] [--no-stack] FILE...
# FILE is relative to src/zen/whimsy/tests (browser_whimsy_x.js), or a path
# under the engine (zen/tests/...). Files are split round-robin into N
# parallel harness runs (default 3, like W24's par3.sh), started 20 s apart.
# Logs: $WHIMSY_RUNS/NAME/test-pN.log. The summary's first lines are
# RESULT green|red and one REASON per red chunk (reason.py), and a crash is
# followed by its native stack (crash-stack.sh) unless --no-stack.
# Must run with the engine lock held (lane.sh and queue.sh do that).
. "${0:A:h}/env.sh"
ROOT=${WHIMSY_ROOT:-$WHIMSY_MAIN}
name=test-$(date +%Y%m%d-%H%M%S); jobs=3; stack=1
while [ $# -gt 0 ]; do
  case $1 in
    --name) name=$2; shift 2;;
    --jobs) jobs=$2; shift 2;;
    --no-stack) stack=0; shift;;
    --) shift; break;;
    -*) echo "test.sh: unknown option $1" >&2; exit 2;;
    *) break;;
  esac
done
[ $# -gt 0 ] || { echo "RESULT red"; echo "REASON no test files requested"; exit 2; }
run=$WHIMSY_RUNS/$name; mkdir -p $run
cd $ROOT/engine || { echo "RESULT red"; echo "REASON no engine at $ROOT/engine"; exit 2; }

files=()
for f in "$@"; do
  case $f in
    /*) f=${f#$ROOT/engine/};;
    zen/*|browser/*|toolkit/*) ;;
    *) f=zen/whimsy/tests/$f;;
  esac
  files+=$f
done
missing=()
for f in $files; do [ -e "$f" ] || missing+=$f; done
if [ ${#missing} -gt 0 ]; then
  echo "RESULT red"
  echo "REASON test file not found: ${(j:, :)missing}"
  echo "PASSED 0 FAILED 0"
  exit 1
fi
[ ${#files} -lt $jobs ] && jobs=${#files}

# Round-robin chunks.
typeset -A chunk
i=0
for f in $files; do n=$((i % jobs + 1)); chunk[$n]="${chunk[$n]} $f"; i=$((i+1)); done

SP="--setpref=security.sandbox.content.mac.testing_read_path2=$ROOT/src"
headless=$([ -n "${WHIMSY_HEADED:-}" ] || echo --headless)
# Parallel harness runs each need their own manifest file (a plain name:
# the harness writes it under _tests/testing/mochitest).
mname=${name//[^A-Za-z0-9_.-]/-}
pids=(); started=$(date +%s)
for n in {1..$jobs}; do
  [ $n -gt 1 ] && sleep 20
  log=$run/test-p$n.log
  ( ./mach test $headless $SP --testrun-manifest-file=tests-whimsy-$mname-p$n.json ${=WHIMSY_ARGS:-} ${=chunk[$n]} > $log 2>&1; echo $? > $run/test-p$n.exit ) &
  pids+=$!
done
for p in $pids; do wait $p; done
took=$(( $(date +%s) - started ))

results=(); reasons=(); passed=0; failed=0; crashed=()
for n in {1..$jobs}; do
  rc=$(cat $run/test-p$n.exit 2>/dev/null || echo 1)
  out=$(python3 $WHIMSY_TOOLS/reason.py $run/test-p$n.log --exit $rc --file ${=chunk[$n]})
  echo "$out" > $run/test-p$n.reason
  results+=$(echo "$out" | sed -n 's/^RESULT //p')
  r=$(echo "$out" | sed -n 's/^REASON //p')
  [ "${results[-1]}" = red ] && reasons+="chunk $n: $r"
  p=$(echo "$out" | sed -n 's/^PASSED \([0-9?]*\).*/\1/p'); f=$(echo "$out" | sed -n 's/.*FAILED \([0-9?]*\)$/\1/p')
  [ "$p" != "?" ] && passed=$((passed + p)); [ "$f" != "?" ] && failed=$((failed + f))
  case $r in crashed*) crashed+=$(echo "$r" | sed -n 's/.* in \([^ :]*\).*/\1/p');; esac
done

red=0; for r in $results; do [ "$r" = green ] || red=1; done
{
  echo "RESULT $([ $red = 0 ] && echo green || echo red)"
  for r in $reasons; do echo "REASON $r"; done
  echo "PASSED $passed FAILED $failed in ${took}s (${#files} files, $jobs chunks)"
  for n in {1..$jobs}; do grep '^FAIL ' $run/test-p$n.reason | head -12; done
  echo "logs: $run"
} | tee $run/summary.txt
if [ $red = 1 ] && [ $stack = 1 ] && [ ${#crashed} -gt 0 ]; then
  for f in $crashed; do
    [ -n "$f" ] || continue
    echo "STACK for $f:"
    $WHIMSY_TOOLS/crash-stack.sh --name $name $f 2>&1 | tee -a $run/summary.txt
  done
fi
exit $red
