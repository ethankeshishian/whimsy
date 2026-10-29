# Instructions for coding agents (Codex etc.)

Read CLAUDE.md first; it applies to every agent. For the overnight feature build, also read docs/whimsy/AGENT-BRIEF.md, docs/whimsy/BUILD-PLAN.md and docs/whimsy/NIGHT-LOG.md (where work stands).

- Only one agent may run mach build / verify.sh at a time: there is one engine objdir. Check `pgrep -fl "mach|verify.sh|publish.py"` first.
- Commit on dev by path (git add <files>), one commit per feature, no AI attribution lines. Append what you did to docs/whimsy/NIGHT-LOG.md.
