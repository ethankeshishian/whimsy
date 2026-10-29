# Whimsy

Whimsy is a private fork of [Zen Browser](https://github.com/zen-browser/desktop) (MPL-2.0). "Whimsy" is a working name and may change.

- The first commit imports Zen's `dev` branch at `7133db8aee16c3cdf042307e9e11071359d92851` (2026-10-27) as a single snapshot. It has no history: Zen's history is about 6 GB, which is too big to push to a new repository.
- The `upstream` remote points at Zen. Whimsy takes new Zen releases automatically (see "Automatic updates" below); `whimsy/upstream.json` records which Zen commit it is on.
- Code keeps Zen's `zen` names (prefs, files, classes) so upstream changes still apply cleanly.

## How Whimsy is built on Zen

Whimsy is an **overlay**. Zen's files are kept exactly as upstream ships them. Whimsy's code lives in Whimsy-owned paths, and `whimsy/overlay.py` re-applies the few one-line changes Whimsy needs in Zen's files. Because of that, updating to a new Zen release means replacing Zen's files and re-running the overlay. There is never a merge. See `CLAUDE.md` for the layout, the build loop and the rules.

## Features

| Feature | Where | Switch |
|---|---|---|
| GitHub PR live folders: "My Review Requests" option, only reviews requested from you directly (mirrors Zen PR #16183, same option key; switches off when Zen ships it) | `WhimsyGithubReviews.sys.mjs` wraps Zen's provider | `whimsy.feature.github-reviews` |
| Interface zoom (Settings → Look and Feel) | `Whimsy.sys.mjs`, `whimsy-browser.css` | `whimsy.feature.ui-zoom` |
| App icon picker (12 icons, Daydream default) | `WhimsyAppIcon.sys.mjs`, `whimsy-*.patch` (native `setApplicationIcon`) | `whimsy.feature.app-icon` |
| Arc-style Ctrl+Tab (recently used order, unloaded tabs included) | prefs from `overlay.py` | `whimsy.feature.ctrl-tab` |
| Automatic updates, with an Updates panel and rollback | `whimsy/updater/`, `WhimsyUpdates.sys.mjs`, `whimsy-settings.js` | none |
| Whimsy name, bundle id and profile folder; no Zen update server | `overlay.py` overrides | none |

Hotfixes for Zen bugs live in `overlay.py` and switch themselves off once Zen changes that code: a null Fluent argument in `ZenPinnedTabManager` and a Firefox string that Zen still uses.

## Automatic updates

Zen's activity, measured over 91 days to 2026-10-27:
- About 3 commits a day on `dev`.
- A release tag every 4–8 days.
- A Firefox version update about once a week.
- Commits almost never land between 6 pm and 11 pm Pacific.

The updater follows **release tags**, which sit on `dev`, and only moves forward from `whimsy/upstream.json`.

- **Nightly (3:30 am, low priority):** waits rather than fails when on battery, below 15 GB free, while the repository isn't on a clean `main`, or while another build runs. Otherwise it syncs, updates the Firefox source if needed, builds, runs `whimsy/verify.sh gate`, fast-forwards `main`, and stages the app. Any failure resets the repository and logs why. A release that fails twice is skipped until a newer one ships.
- **Every minute:** installs a staged build only while Whimsy is closed (never while it's open, even idle) and keeps the old app for rollback.
- **Settings → Look and Feel → Updates:** shows status, pause/resume, check now, the log, and **Roll back**. Rolling back reopens the previous app and skips the version you left.
- **After an install,** a one-time sidebar notice appears with Zen's release notes and a roll-back shortcut. Zen's own sweep animation plays too.

## Not done yet

- **Renaming leftovers:** wordmarks, `about-logo.svg`, `MacOSInstaller.svg` and the Linux/Flatpak metadata still say Zen.
- **CI:** Zen's GitHub Actions workflows are unchanged and point at Zen's release infrastructure.
- **Other locales:** only en-US has Whimsy's strings.
- **Waking the Mac:** to run the nightly job while the Mac sleeps, run `sudo pmset repeat wakeorpoweron MTWRFSU 03:25:00` once. Otherwise the job runs at the next wake.
