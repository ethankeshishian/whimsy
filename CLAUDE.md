# Whimsy

A private fork of Zen Browser (Firefox). Read `docs/whimsy/HANDOFF.md` first.

## Whimsy is an overlay: never edit Zen's files

Zen's files stay exactly as upstream ships them, so the nightly updater can replace them wholesale with each new Zen release without merge conflicts. Whimsy's code lives in Whimsy-owned paths:

- `src/zen/whimsy/`: modules, content (JS/CSS/images), tests, `moz.build`, `jar.inc.mn`
- `src/browser/components/preferences/whimsy-preferences-head.inc.xhtml`: the Settings UI
- `locales/en-US/browser/browser/whimsy.ftl`, `prefs/whimsy/`, `src/**/whimsy-*.patch`
- `whimsy/`: the overlay, updater and tooling. `configs/branding/` also belongs to Whimsy.

The few changes Whimsy needs inside Zen's files live in `whimsy/overlay.py`: one-line hooks, overrides of `surfer.json`, mozconfig, `package.json` and pref defaults, hotfixes, and fallback strings. To change a Zen file, add an entry there and run `python3 whimsy/overlay.py apply`. Don't hand-edit the file. `overlay.py check` (run by the precheck) fails if anything is missing.

Each feature has a `whimsy.feature.<id>` switch. `overlay.py` turns a feature off when its detector finds that Zen ships the same thing, so upstream wins. Add a `FEATURES` entry for every new feature.

## The loop: check before building, verify after

1. **Before building:** `python3 whimsy/precheck.py`. It checks:
   - syntax and string ids;
   - XHTML well-formedness and jar entries;
   - the app icons;
   - that no element with `data-l10n-id` is also filled by code;
   - that `overlay.py check` passes.

   It prints which build the change needs. For lint, run `cd engine && ./mach lint -l eslint <paths>` and ignore Prettier-only errors.
2. **Sync into the engine:** `npm run import`. It applies patches, prefs and links, and copies the en-US strings. A new file under `src/` needs an import.
3. **Build:** pick the smallest one.
   - JS, CSS, FTL or XHTML only: `cd engine && ./mach build faster` (minutes).
   - C++ or IDL patches: `cd engine && ./mach build binaries`.
   - `surfer.json`, `configs/` or mozconfig: `npm run build`. sccache is on, so after the first build this takes less than an hour.
4. **Verify:** `sh whimsy/verify.sh`, or `quick` for Whimsy tests and screenshots only. Read the PNGs in `.surfer/shots/`. Gecko draws them itself, so no Screen Recording permission is needed.
5. **Install:** `npm run build` and `build:ui` stage the app via the updater automatically. After `mach build faster`, run `npm run install:app`. It installs right away if Whimsy is closed, otherwise when it next quits, and keeps the old app for rollback.
6. **Ship (every finished change):** commit on `dev`, then `npm run ship`. It merges any newer published Zen release, builds, runs `verify.sh quick`, pushes `dev`, installs here, and publishes to the Dev channel in the background (`logs/publish-dev.log`).

## Branches and channels

- `dev`: every change. Each `npm run ship` publishes a Dev build (`1.24b-w3-dev.7`, a GitHub pre-release; the newest 5 are kept).
- `main`: what standard users get. Nightly, the updater takes `dev` plus the newest published Zen release, runs `verify.sh gate`, moves `main` there and publishes it to the Release channel (`1.24b-w3`).
- Settings → About Whimsy → Channel picks Release (default) or Dev (`whimsy.update-channel`); it only changes which `update.xml` Firefox's updater reads. On a Mac with the local updater installed, Firefox's updater is parked on a channel with no updates and the local updater installs builds instead (every ship; nightly releases too when the channel is Release).
- Whimsy only takes published Zen release tags, never Zen's branches.

## The updater

`whimsy/updater/updater.py` runs as launchd jobs, installed with `sh whimsy/updater/install.sh`. Run that again after editing `updater.py`, because the jobs run a copy.

- **Nightly at 3:30 am:** on `dev`, merges the newest Zen release tag after `whimsy/upstream.json`; if that or unreleased Whimsy changes need a release, builds, runs `verify.sh gate`, moves `main`, publishes (with `--publish`), and stages the result. A failure puts both branches back. It also takes a newer DuckDuckGo Autoconsent release (the cookie banner rules, `whimsy/autoconsent.py`) as a commit on `dev`; a failed fetch is only logged, and a rules version whose build failed is skipped.
- **Every minute:** installs a staged build once Whimsy is closed, and carries out rollbacks.

State and logs are in `~/Library/Application Support/Whimsy Updater/`. Settings → About Whimsy shows them. The nightly job waits while the repository has uncommitted changes or isn't on `dev`/`main`, so commit your work. It leaves the checkout on `dev`.

## Publishing (other Macs)

`python3 whimsy/publish.py` (or the nightly job when installed with `--publish`) runs `mach package`, ad-hoc signs, and builds a .dmg and a .mar signed with Whimsy's key. It publishes a GitHub Release and `update.xml` on GitHub Pages (`ethankeshishian.github.io/whimsy/updates/...`). Installed Whimsys poll that file; Firefox's updater downloads in the background and installs on restart. Only .mar files signed with Whimsy's key are accepted (`whimsy/engine_overrides.py` installs the public cert). The private key is in `~/Library/Application Support/Whimsy Updater/signing`: back it up, or existing installs can't take updates. The repo is public (MPL source availability), and GitHub Actions stay disabled.

## Versions

Whimsy's version is Zen's version plus a Whimsy revision: `1.24b-w3` (`whimsy/version.py`). The revision counts Whimsy releases on that Zen version and starts over at 1 when Zen's version changes. `whimsy/version.json` records the last release and the history; `publish.py` adds the next one (notes are the commit subjects since the last release), commits it as "Whimsy <version>", and tags `v<version>`. A build that isn't exactly a release is a dev build, `<next>-dev.N` (N = commits since the release). The compiled app version stays Zen's (changing it recompiles nearly everything; Firefox's updater orders same-version builds by build ID); the Whimsy version is `Contents/Resources/whimsy-version.json`, written when a build is staged or published and shown in Settings → About Whimsy with the version history.

## Gotchas

- Export engine edits with `npx surfer export <path>`, then rename the patch to `whimsy-*.patch`.
- Missing Zen strings make a window's whole Fluent bundle fail (blank menus, dead shortcuts). Tests run with `intl.l10n.strict`, where one bad id or a null argument blanks its whole batch.
- Keep Zen's `zen` code names in Zen code.
