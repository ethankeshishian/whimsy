#!/bin/zsh
# Native stack of a test that crashes the parent process.
#   whimsy/tools/crash-stack.sh [--name NAME] [--timeout S] FILE
# The dev build has the crash reporter compiled out (mozconfig
# --disable-crashreporter), so there is no minidump: this runs the one file
# under lldb in batch mode (what found W24's adult-history crash: a module
# import of a resource:// URL Firefox no longer packages) and prints
#   CRASH <MOZ_CRASH reason or stop reason>
#   frame lines of the crashing thread
# Must run with the engine lock held.
. "${0:A:h}/env.sh"
ROOT=${WHIMSY_ROOT:-$WHIMSY_MAIN}
name=crash-$(date +%Y%m%d-%H%M%S); timeout=900; from=
while [ $# -gt 0 ]; do
  case $1 in
    --name) name=$2; shift 2;;
    --timeout) timeout=$2; shift 2;;
    --from-log) from=$2; shift 2;;   # read an existing lldb log instead of running
    *) break;;
  esac
done
if [ -n "$from" ]; then
  log=$from; rc=0
else
  f=$1
  [ -n "$f" ] || { echo "usage: crash-stack.sh [--name NAME] [--from-log LOG] FILE" >&2; exit 2; }
  case $f in /*) f=${f#$ROOT/engine/};; zen/*|browser/*|toolkit/*) ;; *) f=zen/whimsy/tests/$f;; esac
  run=$WHIMSY_RUNS/$name; mkdir -p $run
  log=$run/lldb-${f:t:r}.log
  cd $ROOT/engine || exit 2
  SP="--setpref=security.sandbox.content.mac.testing_read_path2=$ROOT/src"
  perl -e "alarm $timeout; exec @ARGV" ./mach mochitest --headless $SP \
    --debugger=lldb --debugger-args="--batch -o run -k 'thread backtrace all' -k quit" $f > $log 2>&1
  rc=$?
fi
reason=$(grep -o 'aReason="[^"]*"' $log | head -1 | sed 's/^aReason=//; s/"//g')
stop=$(grep -m1 -o 'stop reason = .*' $log)
if [ -n "$reason" ]; then echo "CRASH $reason"
elif [ -n "$stop" ]; then echo "CRASH $stop"
else echo "CRASH no stop in lldb output (rc $rc); see $log"; exit 1; fi
# The crashing thread's frames: lldb prints thread #1 once when it stops
# (one frame) and again in the backtrace; take the fuller block.
awk '/^\* thread #1/{n++} n && /frame #/{f[n]=f[n] $0 "\n"} END{best=1; for(i in f) if (length(f[i])>length(f[best])) best=i; printf "%s", f[best]}' $log \
  | sed -E 's/^[[:space:]]*//; s/ at [^ ]+:[0-9]+(:[0-9]+)?//; s/\(.*\)//' | head -14 | cut -c1-160
echo "lldb log: $log"
