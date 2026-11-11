# W24 site report

Implemented README refresh and BUGS.md item 23 in this worktree. No build,
import, precheck, browser tests, commit, or publish was run, as required by
`brief-w24-site.md`. No engine exists in this worktree.

## Root causes and recording caveat

Line references in this section refer to the original files at this lane's HEAD.

- `src/zen/whimsy/content/whimsy-home.js:83`: selection waited for `click`,
  leaving Changelog selected throughout a press on Home. The selection loop
  at `:60–65` already assigned exactly one `aria-selected` tab; the recording
  does not establish two semantic selections.
- `src/zen/whimsy/content/whimsy-home.css:221–228`: hover uses the same text
  color as selection, while selection has its own background and shadow.
  Unlike the brief's hypothesized cause, this checkout does **not** give hover
  the selected background. `:866–867` also transitions each button's background
  and shadow independently, allowing the old selection to fade away as the
  new one appears. There was no shared moving indicator.
- `whimsy-home.js:65` and `whimsy-home.css:233–234`: toggling `hidden` switches
  panel layout immediately, without an outgoing fade. The incoming-only
  `wh-panel-in` at `whimsy-home.css:870–871` cannot crossfade panels.
- `whimsy-home.css:874–893`: unscoped `wh-rise` and `wh-arrive` animations
  restart after Home's `display:none` is removed, including backwards-filled
  opacity, translation, and scale. That matches the balloon and text arriving
  again in `z.png`.

I viewed both readable PNG contact sheets. Their apparent held-press interval
and abrupt Home arrival are consistent with these causes. The images cannot
prove the event timing, an actual two-tab ARIA state, or why hover appears to
have a filled pill in the recorded build. No artificial delay was added.

## Changes

- One decorative selected indicator slides and resizes between all three tabs
  in 180 ms. Unselected hover has a weaker, translucent fill and no selected
  shadow. A ResizeObserver keeps the indicator aligned after localization,
  font loading, zoom, and resizing; physical offsets also follow RTL layout.
- Primary pointerdown selects immediately. The click handler remains for
  keyboard and programmatic activation; the following click is idempotent.
  Arrow keys, Home/End, roving tabindex, ARIA relationships, fragments,
  anchored release notes, and user-triggered scroll-to-top remain supported.
- A 160 ms opacity crossfade replaces `wh-panel-in`. The outgoing visual copy
  is inert, aria-hidden, clipped to the panel area, and has remapped IDs and
  SVG references. Only the selected real tabpanel is unhidden. Copies are
  retired on completion, interrupted selection, pagehide, or reduced-motion
  preference changes; there are no timers or polling loops in product code.
- First-load hero decoration is scoped to `wh-home-entrance`. It is removed
  on the first tab change and never restored. A direct Changelog/Privacy load
  does not defer the hero entrance until a later Home visit. Balloon pokes
  remain available. Reduced motion skips panel fades and indicator transitions.
- README uses existing `configs/branding/release/logo128.png` (Daydream),
  with no new asset. `prefs/whimsy/whimsy.yaml:13`, the app-icon module's
  default/picker, and branding assets agree. Icon history was inspected;
  recent app-icon changes concern installed-bundle handling, not a new default.
- README summarizes the features recorded in `whimsy/changelog.json` through
  W23/W24, including AI, private browsing, profiles, splits, Mini Whimsy,
  Library, and Easel. Download instructions follow `whimsy/publish.py`'s
  Apple silicon DMG instructions; Release/Dev wording follows the channel pref
  and updater documentation. The badge no longer includes pre-releases as
  the default release. MPL header, licensing, and credits are preserved.

## Verification and remaining integration work

- Passed JavaScript syntax checks (`node --check`) for the changed page and
  browser test source, and scoped whitespace review (`git diff --check`).
  These are static checks, not runtime tests.
- Added two browser regression tasks in `browser_whimsy_home.js`: selection
  before mouseup and after click, exactly one selected tab/visible real panel/
  tab stop, indicator geometry, inert outgoing visuals, unique IDs during
  crossfades, rapid switches and fade cleanup, first-load-only hero animation,
  and instant reduced-motion switches. Existing keyboard/anchor tests remain.
- Browser execution and visual verification are **unrun**, per brief. The
  integration run should exercise the new tests and the existing consumers
  listed below, plus review light/dark, RTL, forced colors, scrolling, rapid
  switches, and reduced motion in the actual browser.
- `surfer.json` and `whimsy/upstream.json` confirm Zen 1.24b and configured
  Firefox 159.0. The engine's independent version file could not be checked
  because `engine/` is absent; the README retains those configured versions.
- Local README images exist. Remote link checking reached Zen, Mozilla,
  Firefox, MPL, Blacksmith, and Zen's GitHub repository (some redirect normally).
  Whimsy's source, issues, releases, and latest-release URLs returned cache
  misses in the browsing tool, so their live availability is unverified. Their
  owner/repository matches the publishing configuration; no replacement URL
  was invented.

Related test consumers found by searching page/CSS names and `about:whimsy`
under `src/zen/whimsy/tests` (broad route users included):
`browser_whimsy_home.js`, `browser_whimsy_home_choices.js`,
`browser_whimsy_changelog_channel.js`, `browser_whimsy_access_commands.js`,
`browser_whimsy_agent_core.js`, `browser_whimsy_claude_replay.js`,
`browser_whimsy_designfix_copy.js`, `browser_whimsy_easel.js`,
`browser_whimsy_favicon_home.js`, `browser_whimsy_game.js`,
`browser_whimsy_legacy.js`, `browser_whimsy_neterror.js`,
`browser_whimsy_onboarding_finish.js`, `browser_whimsy_screens.js`,
`browser_whimsy_screens_2.js`, `browser_whimsy_screens_3.js`,
`browser_whimsy_screens_5.js`, `browser_whimsy_screens_w23_agent-chat.js`,
`browser_whimsy_seasonal_decor.js`, `browser_whimsy_seasonal_themes.js`,
`browser_whimsy_settings_commands.js`, and `browser_whimsy_url_schemes.js`.
None was executed in this lane.
