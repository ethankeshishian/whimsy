#!/bin/zsh
# usage: lock.sh <cmd...>  - run a command with the engine to itself.
# A shim over queue.sh: the command becomes a queue ticket (first come,
# first served) instead of polling a lock directory. Keep calling it the old
# way; ~/Repos/whimsy-handoff/wave13/lock.sh can be replaced with
#   exec ~/Repos/whimsy/whimsy/tools/lock.sh "$@"
exec "${0:A:h}/queue.sh" run --name "lock-${1:t}" -- "$@"
