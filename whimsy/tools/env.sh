# Shared environment for Whimsy's build tools. Source it; don't run it.
#   . "$(dirname "$0")/env.sh"
# zsh and sh both read it. Every tool used to carry its own PATH line; a new
# one without it lost a W24 build to "cargo: command not found".
export _ZO_DOCTOR=0
case ":$PATH:" in
  *":$HOME/.cargo/bin:"*) ;;
  *) export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$HOME/.cargo/bin:/opt/homebrew/bin:$PATH" ;;
esac

# The checkout that owns the engine (one objdir on this Mac). Tools may run
# from a worktree; anything that builds or tests runs here.
: "${WHIMSY_MAIN:=$HOME/Repos/whimsy}"
# Where the runner keeps per-run logs and summaries.
: "${WHIMSY_RUNS:=$WHIMSY_MAIN/.surfer/lanes}"
# The engine queue and the lock legacy scripts share with it.
: "${WHIMSY_QUEUE:=/tmp/w13/queue}"
: "${WHIMSY_LOCK:=/tmp/w13/engine.lock.d}"
export WHIMSY_MAIN WHIMSY_RUNS WHIMSY_QUEUE WHIMSY_LOCK

# Objdir name, for tools that look at built files.
: "${WHIMSY_OBJDIR:=obj-aarch64-apple-darwin}"
export WHIMSY_OBJDIR

# Install the merge drivers for Whimsy's derived files into the repository
# that $1 (default: $WHIMSY_MAIN) belongs to. Idempotent. Git reads the
# driver commands from config and the file patterns from .gitattributes;
# info/attributes carries the patterns too, so a merge of a branch that
# predates them still uses the drivers. $2 names the tools folder whose
# drivers to use (default: the folder this file is in).
whimsy_git_setup() {
  _repo="${1:-$WHIMSY_MAIN}"
  _tools="${2:-$WHIMSY_TOOLS}"
  _common="$(git -C "$_repo" rev-parse --git-common-dir)" || return 1
  case "$_common" in /*) ;; *) _common="$_repo/$_common" ;; esac
  git -C "$_repo" config --replace-all merge.whimsy-patch.name "Whimsy patch (3-way merge of the patched source)"
  git -C "$_repo" config --replace-all merge.whimsy-patch.driver "python3 $_tools/patchtools.py merge %O %A %B %P"
  git -C "$_repo" config --replace-all merge.whimsy-features.name "Whimsy features.yaml (merge by block)"
  git -C "$_repo" config --replace-all merge.whimsy-features.driver "python3 $_tools/merge_features.py %O %A %B %P"
  git -C "$_repo" config --replace-all merge.whimsy-list.name "Whimsy overlay.py (both sides' list entries)"
  git -C "$_repo" config --replace-all merge.whimsy-list.driver "python3 $_tools/merge_listfile.py %O %A %B %P"
  mkdir -p "$_common/info"
  _attrs="$_common/info/attributes"
  touch "$_attrs"
  grep -q 'merge=whimsy-patch' "$_attrs" 2>/dev/null || printf '%s\n' 'src/**/whimsy-*.patch merge=whimsy-patch' >> "$_attrs"
  grep -q 'merge=whimsy-features' "$_attrs" 2>/dev/null || printf '%s\n' 'prefs/whimsy/features.yaml merge=whimsy-features' >> "$_attrs"
  grep -q 'overlay.py merge=whimsy-list' "$_attrs" 2>/dev/null || printf '%s\n' 'whimsy/overlay.py merge=whimsy-list' >> "$_attrs"
  grep -q 'moz.build merge=whimsy-list' "$_attrs" 2>/dev/null || printf '%s\n' 'src/zen/whimsy/moz.build merge=whimsy-list' >> "$_attrs"
}

# The folder this file lives in (zsh and bash/sh forms).
if [ -n "${ZSH_VERSION:-}" ]; then
  WHIMSY_TOOLS="${${(%):-%x}:A:h}"
elif [ -n "${BASH_SOURCE:-}" ]; then
  WHIMSY_TOOLS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
else
  WHIMSY_TOOLS="${WHIMSY_TOOLS:-$WHIMSY_MAIN/whimsy/tools}"
fi
export WHIMSY_TOOLS
