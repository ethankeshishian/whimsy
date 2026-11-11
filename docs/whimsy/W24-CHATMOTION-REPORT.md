# W24 chatmotion: chat panel open/close matches the tabs sidebar

BUGS.md #24. Owner: "make sure the animation speed on the chat is identical
to the tabs, speed and ease too" / "when the panel opens and closes... use
what is best for the design system."

## The tabs sidebar's canonical motion (Zen-owned, not edited)

- Show: `src/zen/compact-mode/sidebar.inc.css:275-276` —
  `--zen-compact-mode-time: 0.25s;` with the spring curve
  `--zen-compact-mode-func` (the `linear(...)` at lines 172-274).
- Hide: `src/zen/compact-mode/sidebar.inc.css:83-85` —
  `transition: translate 0.15s ease, visibility 0.15s ease;`.

## Before

`src/zen/whimsy/WhimsyChatPanel.sys.mjs:54-58` (unchanged consts, still used
by the list/tasks subviews):

```
const EASE = "cubic-bezier(0.075, 0.82, 0.165, 1)";
const EASE_EXIT = "cubic-bezier(0.4, 0, 1, 1)";
const DUR_IN = 240;
const DUR_OUT = 180;
```

The panel's own `animateIn()`/`animateOut()` (open/close) used `DUR_IN`
(240ms) + `EASE` to open and `DUR_OUT` (180ms) + `EASE_EXIT` to close — close
but not identical to the sidebar's 250ms-spring / 150ms-ease, and not
sourced from any shared token.

The splitter's (resize-grip) accent-bar hover fade at
`src/zen/whimsy/content/whimsy-chat.css:135-139` (`opacity 0.2s ease-out`,
`transition-delay: 0.2s` on hover) was checked too: it's a hover-only
affordance on `.whimsy-chat-splitter::before`, unrelated to opening or
closing the panel, so it was left alone.

## After

New shared tokens, `src/zen/whimsy/content/whimsy-browser.css:28-133`
(inside the existing `:root` token block that already holds
`--whimsy-ease`/`--whimsy-dur-*`):

- `--whimsy-dur-panel: 250ms;` — copy of `--zen-compact-mode-time`.
- `--whimsy-ease-panel: linear(...)` — copy of `--zen-compact-mode-func`.
- `--whimsy-dur-panel-exit: 150ms;` / `--whimsy-ease-panel-exit: ease;` —
  copy of the sidebar's hide transition.

Each is commented with its Zen source lines, per the overlay rule (never
edit Zen's files; Whimsy keeps its own copy in a Whimsy-owned file).

`WhimsyChatPanel.sys.mjs` reads them through a new `panelMotion()` (next to
the existing `peekMotion()`, which already pulled the same sidebar values
live for the edge-hover peek):

```
panelMotion() {
  const style = this.win.getComputedStyle(this.doc.documentElement);
  return {
    in: { duration: cssMs(style.getPropertyValue("--whimsy-dur-panel")),
          easing: style.getPropertyValue("--whimsy-ease-panel").trim() },
    out: { duration: cssMs(style.getPropertyValue("--whimsy-dur-panel-exit")),
           easing: style.getPropertyValue("--whimsy-ease-panel-exit").trim() },
  };
}
```

`animateIn()` (`WhimsyChatPanel.sys.mjs:927`) and `animateOut()`
(`953`) now destructure `{ duration, easing }` from `panelMotion().in` /
`.out` for the width and slide/opacity animations, instead of the
hard-coded consts. `EASE`/`EASE_EXIT`/`DUR_IN`/`DUR_OUT` stay, now with a
comment, for the list/tasks subviews (`openList`/`closeList`/the tasks
strip) and the reduced-motion opacity-only fallback, which weren't part of
the owner's "opens and closes" complaint and weren't touched otherwise.

`prefers-reduced-motion` is unchanged: `reducedMotion(this.win)` still
short-circuits both methods to an opacity-only fade before `panelMotion()`
is read, so reduced motion never sees the width/slide transition.

## Why a token, not a literal duplicate

The brief allows "whatever is best for the design system." `peekMotion()`
already proved the pattern works by reading Zen's rules live; a second,
static copy in Whimsy's own token file (rather than a second live
stylesheet walk on every open/close) keeps `animateIn`/`animateOut` simple
and matches the existing `--whimsy-dur-fast/-base/-exit` token convention
in the same file. The new browser test cross-checks the static tokens
against `peekMotion()`'s live read, so a future Zen update that changes the
sidebar's curve is caught as a test failure rather than silent drift.

## Test

`src/zen/whimsy/tests/browser_whimsy_chat_motion.js` (registered in
`browser.toml` next to `browser_whimsy_chat_hover.js`), three tasks:

- `panel_tokens_equal_the_sidebars_own_motion` — `panelMotion()`'s in/out
  duration and easing equal `peekMotion()`'s enter/exit (Zen's live rules).
- `open_and_close_use_that_exact_motion` — opening and closing the panel
  produce `Animation`s whose `effect.getTiming()` duration/easing equal
  `panelMotion()`'s values exactly, with `delay: 0`; also asserts
  `getComputedStyle(...).transitionDelay == "0s"` on the panel and its
  inner panel.
- `reduced_motion_is_only_a_fade` — with `ui.prefersReducedMotion` set,
  every animation on open and close touches only `opacity`, never
  `width`/`translate`.

## Not done here

Per the hard rules for this lane, no build, `mach`, test run, or commit was
done. `browser.toml` was validated with `tomllib` only (syntax, not a test
run). Files that import `WhimsyChatPanel.sys.mjs` and would exercise this
code (`browser_whimsy_chat_shell.js`, `browser_whimsy_chat_hover.js`,
`browser_whimsy_chat_threads.js`, `browser_whimsy_chat_answer.js`,
`browser_whimsy_chat_context.js`, `browser_whimsy_chat_agent.js`, and the
W23 chat/agent/routines screenshot suites) were identified by grep but not
run; whoever next builds this lane should run them alongside the new test.

## Files changed

- `src/zen/whimsy/content/whimsy-browser.css` — new tokens.
- `src/zen/whimsy/WhimsyChatPanel.sys.mjs` — `panelMotion()`, `cssMs()`
  helper, `animateIn`/`animateOut` wired to the tokens, a comment on the
  now-narrower-scoped `EASE`/`EASE_EXIT`/`DUR_IN`/`DUR_OUT`.
- `src/zen/whimsy/tests/browser_whimsy_chat_motion.js` — new test.
- `src/zen/whimsy/tests/browser.toml` — registers it.
- `docs/whimsy/W24-CHATMOTION-REPORT.md` — this report.
