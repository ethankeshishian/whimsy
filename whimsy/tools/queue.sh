#!/bin/zsh
# A first-come, first-served queue for the one engine on this Mac.
#   queue.sh run    [--low] [--name N] -- CMD ARGS...   submit, wait, stream output; exit as CMD did
#   queue.sh submit [--low] [--name N] [--dedupe] -- CMD ARGS...   print the ticket and return
#   queue.sh wait TICKET                                 stream a ticket's output; exit as it did
#   queue.sh start | stop | status | cancel TICKET | worker
# Tickets run in order (normal before --low, then by number) in one worker,
# which holds the mkdir lock that older scripts (whimsy-handoff/wave13/
# lock.sh) use, so both kinds of callers exclude each other. W24's polling
# lock let one lane wait 4.5 h while later arrivals won the dir. Inside a
# ticket ($WHIMSY_TICKET is set) `run` executes the command directly.
. "${0:A:h}/env.sh"
SELF=${0:A}
Q=$WHIMSY_QUEUE; L=$WHIMSY_LOCK
mkdir -p $Q/pending $Q/running $Q/done $Q/out

next_seq() {
  while ! mkdir $Q/seq.lock 2>/dev/null; do sleep 0.2; done
  n=$(( $(cat $Q/seq 2>/dev/null || echo 0) + 1 )); echo $n > $Q/seq
  rmdir $Q/seq.lock
  printf %06d $n
}

worker_alive() { p=$(cat $Q/worker.pid 2>/dev/null); [ -n "$p" ] && kill -0 $p 2>/dev/null; }

ensure_worker() {
  worker_alive && return 0
  nohup zsh "$SELF" worker >> $Q/worker.log 2>&1 &!
  for i in {1..20}; do worker_alive && return 0; sleep 0.25; done
  echo "queue: could not start the worker (see $Q/worker.log)" >&2; return 1
}

submit() {
  prio=1; name=job; dedupe=0
  while [ $# -gt 0 ]; do
    case $1 in
      --low) prio=2; shift;;
      --name) name=${2//[^A-Za-z0-9_.-]/_}; shift 2;;
      --dedupe) dedupe=1; shift;;
      --) shift; break;;
      *) break;;
    esac
  done
  [ $# -gt 0 ] || { echo "queue: no command" >&2; return 2; }
  if [ $dedupe = 1 ]; then
    for j in $Q/pending/*-$name.job(N); do echo ${${j:t}%.job}; return 0; done
  fi
  t=$prio-$(next_seq)-$name
  job=$Q/pending/$t.job
  {
    echo "# whimsy queue ticket $t, submitted $(date '+%F %T')"
    echo "cd ${(q)PWD} || exit 2"
    env | grep '^WHIMSY_' | sed 's/^/export /; s/=\(.*\)$/=\x27\1\x27/' | grep -v WHIMSY_TICKET
    echo "export WHIMSY_TICKET=$t"
    echo "export PATH=${(q)PATH}"
    echo "exec ${(q)@}"
  } > $job.tmp && mv $job.tmp $job
  date +%s > $Q/out/$t.submitted
  ensure_worker || return 1
  echo $t
}

wait_for() {
  t=$1; out=$Q/out/$t.out; pos=0
  while [ ! -f $Q/out/$t.exit ]; do
    [ -f $Q/pending/$t.job ] || [ -f $Q/running/$t.job ] || { [ -f $Q/out/$t.exit ] || { echo "queue: ticket $t vanished" >&2; return 1; }; }
    if [ -f $out ]; then size=$(stat -f %z $out); [ $size -gt $pos ] && { tail -c +$((pos+1)) $out | head -c $((size-pos)); pos=$size; }; fi
    sleep 2
  done
  if [ -f $out ]; then size=$(stat -f %z $out); [ $size -gt $pos ] && tail -c +$((pos+1)) $out; fi
  return $(cat $Q/out/$t.exit)
}

# Another process may use the engine without the queue: wave13/lock.sh (an
# mkdir on the same dir with its pid inside), or a build, test, verify or
# ship someone started by hand. The worker waits while the lock dir exists
# and its pid is alive, and never breaks a dead holder's lock while any
# engine process is still running (a killed lock.sh can leave its mach or
# verify.sh alive).
# WHIMSY_ENGINE_BUSY overrides the pattern, so the tools' tests can run a
# private queue while the real engine is building.
engine_busy() { pgrep -f "${WHIMSY_ENGINE_BUSY:-mach (build|test|mochitest|package|lint)|whimsy/verify\.sh|surfer build|updater\.py (ship|nightly|publish)}" >/dev/null 2>&1; }
take_lock() {
  while :; do
    if mkdir $L 2>/dev/null; then
      if engine_busy; then rmdir $L 2>/dev/null; sleep 5; continue; fi
      break
    fi
    holder=$(cat $L/pid 2>/dev/null)
    if [ -n "$holder" ] && ! kill -0 $holder 2>/dev/null && ! engine_busy; then
      echo "lock: holder $holder is gone and no engine process runs; taking over $(date '+%F %T')"
      rm -rf $L; continue
    fi
    sleep 2
  done
  echo $$ > $L/pid
}
drop_lock() { [ "$(cat $L/pid 2>/dev/null)" = "$$" ] && rm -rf $L; }

worker() {
  echo $$ > $Q/worker.pid
  child=
  cleanup() { [ -n "$child" ] && kill -TERM $child 2>/dev/null; drop_lock; rm -f $Q/worker.pid; exit 143; }
  trap cleanup INT TERM
  echo "worker $$ started $(date '+%F %T')"
  while :; do
    [ -f $Q/stop ] && { rm -f $Q/stop; echo "worker $$ stopping"; rm -f $Q/worker.pid; exit 0; }
    job=$(ls $Q/pending 2>/dev/null | sort | head -1)
    [ -n "$job" ] || { sleep 3; continue; }
    t=${job%.job}
    take_lock
    mv $Q/pending/$job $Q/running/$job
    date +%s > $Q/out/$t.started
    echo "run $t $(date '+%F %T')"
    zsh $Q/running/$job > $Q/out/$t.out 2>&1 &
    child=$!
    wait $child; rc=$?
    child=
    echo $rc > $Q/out/$t.exit.tmp && mv $Q/out/$t.exit.tmp $Q/out/$t.exit
    date +%s > $Q/out/$t.finished
    mv $Q/running/$job $Q/done/$job
    drop_lock
    echo "done $t exit $rc $(date '+%F %T')"
    # Take turns: a script still using wave13/lock.sh polls every 15 s, so
    # give it that long to win the lock before the next ticket tries.
    sleep ${WHIMSY_QUEUE_YIELD:-16}
    # Keep the newest 200 finished tickets.
    ls -t $Q/done | tail -n +201 | while read -r old; do rm -f $Q/done/$old $Q/out/${old%.job}.*; done
  done
}

status() {
  echo "worker: $(worker_alive && echo "running (pid $(cat $Q/worker.pid))" || echo stopped)"
  if [ -d $L ]; then echo "engine lock: held by pid $(cat $L/pid 2>/dev/null) ($(ps -p $(cat $L/pid 2>/dev/null) -o etime= 2>/dev/null | tr -d ' ') elapsed)"; else echo "engine lock: free"; fi
  for j in $Q/running/*.job(N); do t=${${j:t}%.job}; echo "running: $t since $(date -r $(cat $Q/out/$t.started) '+%T')"; done
  for j in $Q/pending/*.job(N); do t=${${j:t}%.job}; echo "pending: $t (submitted $(date -r $(cat $Q/out/$t.submitted) '+%T'))"; done
  ls $Q/done 2>/dev/null | sort | tail -8 | while read -r j; do t=${j%.job}; s=$(cat $Q/out/$t.started 2>/dev/null); f=$(cat $Q/out/$t.finished 2>/dev/null); echo "done: $t exit $(cat $Q/out/$t.exit 2>/dev/null) in $(( ${f:-0} - ${s:-0} ))s, waited $(( ${s:-0} - $(cat $Q/out/$t.submitted 2>/dev/null || echo ${s:-0}) ))s"; done
}

case ${1:-} in
  submit) shift; submit "$@";;
  wait) wait_for $2;;
  run)
    shift
    if [ -n "${WHIMSY_TICKET:-}" ]; then
      while [ $# -gt 0 ]; do case $1 in --low|--dedupe) shift;; --name) shift 2;; --) shift; break;; *) break;; esac; done
      exec "$@"
    fi
    t=$(submit "$@") || exit 1
    echo "queue: ticket $t $( [ -n "$(ls $Q/running 2>/dev/null)" ] && echo "(engine busy; waiting)" )" >&2
    wait_for $t;;
  start) ensure_worker && echo "worker pid $(cat $Q/worker.pid)";;
  stop) touch $Q/stop; echo "worker stops after the current ticket";;
  status) status;;
  cancel) rm -f $Q/pending/$2.job && echo "cancelled $2";;
  worker) worker;;
  *) sed -n '2,12p' "$SELF"; exit 2;;
esac
