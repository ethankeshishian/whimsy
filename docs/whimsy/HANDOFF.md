# Whimsy

Whimsy is a private fork of [Zen Browser](https://github.com/zen-browser/desktop) (MPL-2.0). "Whimsy" is a working name and may change.

- The first commit imports Zen's `dev` branch at `7133db8aee16c3cdf042307e9e11071359d92851` (2026-10-27) as a single snapshot. It has no history: Zen's history is about 6 GB, which is too big to push to a new repository.
- The `upstream` remote points at Zen. To take later Zen changes, merge or cherry-pick from it against that commit.
- Code keeps Zen's `zen` names (prefs, files, classes) so upstream changes still apply cleanly.

## Status: none of this has been built or run yet

The changes below have only been read and syntax-checked (`node --check`). Building Zen is required to verify them; see `docs/` and Zen's README (`npm i`, `npm run init`, `npm run build`, `npm start`).

## Changes in the first Whimsy commit

### 1. GitHub pull requests: yours vs your team's

`src/zen/live-folders/providers/GithubLiveFolder.sys.mjs`

- For a pull-request live folder, the provider also asks GitHub for the user's own open PRs (`author:@me`, with the folder's draft and repository filters). Any listed PR found there gets the subtitle token `zen-live-folder-github-mine`.
- `zen-tab-sublabel` in `locales/en-US/browser/browser/zen-vertical-tabs.ftl` shows that token as **"Yours"**. Team PRs keep showing their author.
- `src/zen/tabs/zen-tabs/vertical-tabs.css` colors "Yours" in the accent color.
- The subtitle is already saved with the live folder's tab state and synced across windows. Because of that, nothing else needed changing to keep the label after a restart.

To verify:
- Make a PR live folder with "assigned to me" or "review requested" on. Your own PRs should say "Yours" and your teammates' should show their usernames.
- Restart, then check the labels are still there.
- Check a second window shows the same labels.

Known limits:
- A PR tab that already existed before this change keeps its old label.
- The extra `author:@me` request costs one more GitHub request per refresh.

### 2. Interface zoom (web pages unaffected)

- **Setting:** new pref `zen.view.ui-zoom` (percent, default 100, clamped to 50–200), declared in `prefs/zen/view.yaml`.
- **Where to change it:** Settings → Look and Feel → **Interface zoom**. Defined in `zenLooksAndFeel.inc.xhtml` and registered in `zen-settings.js`; strings are in `zen-preferences.ftl`.
- **How it's applied:** `src/zen/common/zenThemeModifier.js` sets `--zen-ui-zoom` from the pref.
- **What gets zoomed:** `src/zen/common/styles/zen-browser-ui.css` applies CSS `zoom` to `#navigator-toolbox` (the sidebar), `#zen-appcontent-navbar-wrapper` (the top toolbar), `#sidebar-box`, `findbar`, `menupopup`, and any `panel` without a `browser` inside.
- **What isn't:** web pages are never zoomed, and they keep Firefox's own page zoom.

Interface zoom is deliberately not `layout.css.devPixelsPerPx`, because that would scale web pages too.

To verify at 80%, 125% and 200%:
- Tab drag-and-drop, folder drag, split-view drag, and resizing the sidebar.
- Compact mode hover and reveal.
- URL bar dropdown position, context menus, and the app menu.
- Extension popups should stay at 100%.
- Glance and the Library.

Zen's JS compares pointer coordinates with element rectangles in many places. Gecko's standardized CSS `zoom` keeps those consistent, but this is the riskiest part of the commit. If something misaligns, check it there first.

### 3. Whimsy icon

- `docs/whimsy/icon/make.py` generates the icon SVGs: six colorways (candy, sunset, lagoon, berry, citrus, night), each in two layouts.
  - Desktop: macOS grid, an 824 px body inside 1024.
  - Mobile: full bleed.
- 512 px PNG previews and a contact sheet (`colorways.png`) sit beside the SVGs.
- `configs/branding/release` uses **Candy**, and `configs/branding/twilight` uses **Night**.
- Each branding folder holds the logo PNGs, `firefox.icns`, `firefox.ico`/`firefox64.ico`, and the Windows `VisualElements_*`. Its `PrivateBrowsing_*` files use Night.
- To regenerate: run `python3 make.py`, render each SVG at 1024 px (headless Chrome works), then resize with ImageMagick and build the `.icns` with `iconutil`.

## Building locally (2026-10-28)

- macOS needs `brew install gnu-tar` and Rust (rustup puts it in `~/.cargo/bin`; add that to PATH).
- `npm run import` now also runs `import:strings` (`scripts/copy_language_pack.py en-US`). Without that step, Zen's `zen-*.ftl` files never reach the engine. The window's whole Fluent bundle then fails: menus render blank and keyboard shortcuts have no keys. Zen's CI runs this step in `download-language-packs.sh`. After editing anything in `locales/en-US`, rerun `npm run import:strings`.
- The brand is `release` (`npx surfer set brand release`). The full build takes about an hour, and `npm start` runs it. Tests: `npm test -- ui/<file>`. A new test file also needs a symlink under `engine/zen/tests/...` (or an import).

## Later changes

### 4. Arc-style Ctrl+Tab
Defaults `browser.ctrlTab.sortByRecentlyUsed` and `zen.ctrlTab.show-pending-tabs` to true. A quick tap flips to the last tab, holding Ctrl shows the switcher, and unloaded tabs stay in the history. Test: `tabs/browser_tabs_ctrl_tab_mru.js`.

### 5. Whimsy name and app icons
- `surfer.json` and the mozconfig now say Whimsy. `appId` and `MOZ_APP_BASENAME` changed too, so Whimsy no longer shares Zen's bundle id or profile folder. `updateHostname` and the GitHub release source were removed, so Whimsy never downloads Zen's builds.
- The icon set lives in `docs/whimsy/icon/set` (`make_set.py`, `build.sh`). The default is Daydream (glossy balloon), and Twilight uses Stargazer. `build.sh` writes `configs/branding/*` and `src/zen/images/app-icons/*.png`.
- **Settings → Look and Feel → App icon** (macOS only) sets pref `zen.app-icon`. `ZenAppIcon.sys.mjs` swaps the Dock icon while the app runs, through the new `nsIMacDockSupport.setApplicationIcon` (patches in `src/widget`). "Day & Night" follows the system's light/dark appearance. When the app isn't running, the Dock shows the bundle icon (Daydream). Test: `ui/browser_whimsy_app_icon.js`.

## Not done yet

- **Renaming leftovers.** Wordmarks, `about-logo.svg`, `MacOSInstaller.svg` and the Linux/Flatpak metadata still say Zen.
- **CI.** Zen's GitHub Actions workflows came over unchanged and still point at Zen's release infrastructure. Disable them, or point them at Whimsy, before anything runs on a schedule.
- **Other locales.** Only en-US has strings for the new setting and the "Yours" label.
