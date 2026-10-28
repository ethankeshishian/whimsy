# Whimsy

A private fork of Zen Browser (Firefox). Read `docs/whimsy/HANDOFF.md` first.

## The loop: check before building, verify after

A full build takes about an hour, so verify cheaply first and pick the smallest rebuild.

1. **Before building:** `python3 scripts/whimsy_precheck.py`. It checks:
   - JS syntax;
   - that every string id on an added line exists in an en-US `.ftl`;
   - that XHTML is well-formed;
   - that every file in a jar manifest exists;
   - that the app icon list, PNGs and strings agree.

   It also prints which build the change needs. For lint, run `cd engine && ./mach lint -l eslint <paths under engine/>` and ignore Prettier-only errors: the repo's existing files don't pass Prettier either.
2. **Sync into the engine:** `npm run import`. This applies patches, regenerates prefs, links `src/` and copies the en-US strings. After editing only `locales/en-US`, run `npm run import:strings`. After editing only `prefs/`, run `npm run ffprefs`. A new file under `src/` needs an import (or a symlink in `engine/`).
3. **Build:** pick the smallest one.
   - JS, CSS, FTL or XHTML only: `cd engine && ./mach build faster` (minutes).
   - C++ or IDL patches: `cd engine && ./mach build binaries` (minutes to tens of minutes).
   - `surfer.json`, `configs/` or mozconfig: `npm run build` (about an hour).
4. **Verify:** `sh scripts/whimsy_verify.sh`, or `quick` for Whimsy tests and screenshots only. Then read the PNGs in `.surfer/shots/`. They come from Gecko drawing its own window, because the terminal has no Screen Recording permission.
5. **Install and show the user:** `npm run build` and `npm run build:ui` copy the app to `/Applications/Whimsy.app` afterwards (`scripts/install_app.sh`, which dereferences the dev build's symlinks). After `mach build faster`, run `npm run install:app`. `npm start` runs the dev copy with a throwaway profile.

## Gotchas

- Export engine edits with `npx surfer export <path>`, which writes them into `src/**.patch`. Otherwise the next `surfer import` loses them.
- Missing Zen strings make the window's whole Fluent bundle fail: blank menus and dead shortcuts. The precheck flags this.
- Keep Zen's `zen` code names, so upstream merges stay clean.
