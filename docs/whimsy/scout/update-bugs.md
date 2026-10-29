# Update bugs — root cause scout (read-only)

Tester has no local updater installed, so #4 is expected for them; the rest
checked against stock Firefox update code + Whimsy's overlay.

## 1. "Install Failed" after a successful Dev install — CONFIRMED

- `UpdateService.sys.mjs` `serialize()` (~2563) stamps the stored update
  record's `channel` from `this.channel` = `lazy.UpdateUtils.UpdateChannel`
  → `UpdateUtils.sys.mjs:36-41`: `getDefaultBranch(null).getCharPref(
  "app.update.channel", ...)` — the same pref used for `%CHANNEL%` in the
  URL (`UpdateUtils.sys.mjs:96-98`).
- On next startup, `#asyncInit()` → `channelChanged()`
  (`UpdateService.sys.mjs:3024-3031`) compares `update.channel` to
  `UpdateChannel` again; on mismatch every update is set `STATE_FAILED` /
  `errorCode = ERR_CHANNEL_CHANGE` (3046-3048), then `cleanupActiveUpdates()`
  (1528-1546) writes that now-FAILED record into update *history* via
  `addUpdateToHistory()` — what About reads, even though the native updater
  already applied the MAR correctly.
- `UpdateServiceStub.sys.mjs` runs this at raw app startup (reads
  `update.status` before any window exists). `WhimsyUpdates.initChannel()`
  only runs from `Whimsy.initWindow()` (`src/zen/whimsy/Whimsy.sys.mjs:135`),
  per browser window — strictly later. The record was stamped
  `channel="dev"` at download time, but at this early check
  `app.update.channel` is still the build's locked default (`release`)
  because `initChannel()` hasn't re-applied the Dev choice yet. Mismatch →
  false failure overwrites a real success.

**Alternative evaluated** (never touch `app.update.channel`; vary the URL
instead): `app.update.url` was removed as a runtime pref (Bug 1568994, see
`engine/browser/app/profile/firefox.js:161`); `Services.appinfo.updateURL`
is baked in at build time. The only runtime URL override is **enterprise
policy** `AppUpdateURL` (`UpdateService.sys.mjs` `getUpdateURL()`
5503-5508) — not `app.update.url.override` (no such pref is read anywhere
in this tree). That decouples URL from channel correctly, but
`Services.policies` reads `policies.json` once at startup, so a Dev/Release
toggle would need a policy-file rewrite plus effectively a restart —
heavier than needed.

**Minimal fix:** keep `%CHANNEL%`/`app.update.channel`, but close the race:
run `WhimsyUpdates.initChannel()`'s pref-apply at the same early
(`profile-after-change`-class) timing `UpdateServiceStub` uses, instead of
waiting for the first browser window.

## 2. Re-downloads the already-installed build every check — CONFIRMED, same cause

Direct consequence of #1: `cleanupActiveUpdates()` clears `readyUpdate`/
`downloadingUpdate`, so the next check has no "already installed" state to
compare against and starts over. Fixing #1 fixes this; not a separate bug.

## 3. Updater installs OLDER builds over newer ones at equal appVersion — CONFIRMED

`UpdateService.sys.mjs` `updateIsAtLeastAsOldAs()` (1955-1964):

```js
let versionComparison = Services.vc.compare(update.appVersion, version);
return versionComparison < 0 ||
  (versionComparison == 0 && update.buildID == buildID);
```

At equal `appVersion` this is an **equality** check on `buildID`, not an
ordering check. If the candidate's `buildID` differs in *either* direction,
this returns `false` ("not at least as old"), so the candidate is accepted
and installed. No numeric/lexical buildID ordering exists anywhere in this
file — stock Firefox assumes upstream always publishes monotonically.

`whimsy/publish.py` `app_info()`/`update_xml()` (72-85, 133-143) writes
`appVersion`/`buildID` straight from the packaged `application.ini`
(`App.Version`, `App.BuildID`). All channels and hand builds share one
`appVersion` ("1.24b" — CLAUDE.md: "the compiled app version stays Zen's"),
so buildID is the only differentiator, and Firefox doesn't enforce its
order.

**Minimal fix:** enforce "newer" in Whimsy's own tooling before Firefox
ever sees it — `publish.py`/`updater.py` should refuse to publish/stage a
build whose `buildID` isn't strictly greater than the previously
published/installed one for the same `appVersion` (buildID is a timestamp
string; plain comparison works).

## 4. Staged build never installs without the local updater's applier job — CONFIRMED

`install_app.sh` → `updater.py stage` → `stage()` (updater.py:298-315)
writes `staged/` state and calls `kick("app.whimsy.applier")` (315).
`kick()` (318-319): `subprocess.run(["/bin/launchctl", "kickstart", ...],
capture_output=True)` — no `check=True`, exit code discarded. If
`app.whimsy.applier` was never loaded (`whimsy/updater/install.sh` never
run), this silently no-ops. The promote-to-`/Applications` step lives in
`cmd_apply` (~580-590), reached only when that launchd job runs (every
minute, or on quit, per CLAUDE.md). With no job installed, the build sits
in `staged/` forever; `install_app.sh`'s final line ("Staged: installs when
you next quit Whimsy.") is misleading since nothing watches for quit
either. Matches the claim exactly.

**Minimal fix:** have `install_app.sh`/`updater.py stage` check for the
job itself (same test `WhimsyUpdates.isInstalled()` uses:
`~/Library/LaunchAgents/app.whimsy.updater.plist`) and fail loudly, telling
the dev to run `whimsy/updater/install.sh` first, instead of silently
staging into a void.

## 5. Building without `npx surfer set brand release` yields Nightly.app — CONFIRMED

`package.json`: `"build": "surfer build"`, `"build:ui": "surfer build
--ui"` — neither passes `--brand`. Only `"ci": "surfer ci --brand release
--display-version"` pins it. `surfer.json` defines `brands.release` plus
other brands (e.g. `twilight`); which one plain `surfer build` uses is
whatever `npx surfer set brand <x>` last persisted to `.surfer/`, which is
git-ignored and unmentioned in `CLAUDE.md`'s build loop or
`docs/whimsy/HANDOFF.md`. A fresh checkout has no persisted brand, so
surfer's own default (nightly) wins, producing `Nightly.app`, which neither
`install_app.sh`'s glob (`engine/obj-*/dist/Whimsy.app`) nor the local
updater expect.

**Minimal fix:** don't rely on a local, gitignored, one-time manual step —
pin the brand the way `ci` already does: add `--brand release` to
`"build"`/`"build:ui"` in `package.json`, so a fresh clone can't silently
build the wrong brand.
