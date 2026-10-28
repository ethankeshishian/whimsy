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

## The updater

`whimsy/updater/updater.py` runs as launchd jobs, installed with `sh whimsy/updater/install.sh`. Run that again after editing `updater.py`, because the jobs run a copy.

- **Nightly at 3:30 am:** syncs the newest Zen release tag after `whimsy/upstream.json`, builds, runs `verify.sh gate`, and stages the result.
- **Every minute:** installs a staged build once Whimsy is closed, and carries out rollbacks.

State and logs are in `~/Library/Application Support/Whimsy Updater/`. The Settings → Look and Feel → Updates panel shows them. The nightly job waits while the repository has uncommitted changes or isn't on `main`, so commit your work.

## Publishing (other Macs)

`python3 whimsy/publish.py` (or the nightly job when installed with `--publish`) runs `mach package`, ad-hoc signs, and builds a .dmg and a .mar signed with Whimsy's key. It publishes a GitHub Release and `update.xml` on GitHub Pages (`ethankeshishian.github.io/whimsy/updates/...`). Installed Whimsys poll that file; Firefox's updater downloads in the background and installs on restart. Only .mar files signed with Whimsy's key are accepted (`whimsy/engine_overrides.py` installs the public cert). The private key is in `~/Library/Application Support/Whimsy Updater/signing`: back it up, or existing installs can't take updates. The repo is public (MPL source availability), and GitHub Actions stay disabled.

## Gotchas

- Export engine edits with `npx surfer export <path>`, then rename the patch to `whimsy-*.patch`.
- Missing Zen strings make a window's whole Fluent bundle fail (blank menus, dead shortcuts). Tests run with `intl.l10n.strict`, where one bad id or a null argument blanks its whole batch.
- Keep Zen's `zen` code names in Zen code.
