# Overnight build plan (Oct 29, 2026 → dev build by 9:00 am)

Read this first after a context reset. The user's decisions and notes are in
`build-queue.md` (152 Build, 142 Maybe = deferred, 45 Skip), condensed from the
Feature Atlas artifact https://claude.ai/artifact/79JadUmMJPuCSTnKDLXF1K
(db collections `decisions` and `scopes`; scopes hold verified "already exists"
findings for the Arc/Tabs/Pins sections). Answers to the bedtime questions are
appended at the bottom.

## Ground rules from the user
- Build everything marked Build; never build Maybe (deferred) or Skip.
- Order: confident items first; items needing scoping or the user's input last
  (tier C below is "after the confident ones", not tonight unless time remains).
- Combine overlapping ideas into one feature. Notes override my scopes.
- Arc features: copy Arc's behavior exactly. Others: research the original and
  why it's loved before building; know the user flow.
- Every feature: considered animation, user-friendly, no bloat. Default-off
  toggles where the note says so. Respect reduced motion.
- Many notes say "thought this existed": verify first (see scopes); if it
  exists, only expose/verify it.
- Be mindful of context: work in small commits, keep tool output short, don't
  read large files whole. The user is asleep; never stall waiting for input.
- No Claude attribution in commits. Work on `dev`. Ship with `npm run ship`
  (builds, quick tests, pushes dev, installs, publishes the Dev channel).
- Overlay rule (CLAUDE.md): never edit Zen files directly; Whimsy code lives in
  src/zen/whimsy/, whimsy.ftl, prefs/whimsy/, whimsy-preferences-head.inc.xhtml;
  hooks/overrides go through whimsy/overlay.py. Each feature gets a
  `whimsy.feature.<id>` switch and a test in src/zen/whimsy/tests/.
- Loop per batch: precheck → `npm run import` if new files → `mach build faster`
  → `sh whimsy/verify.sh quick` → commit. Ship a dev build every few batches;
  final `npm run ship` before 9:00.

- (User, Oct 29, before sleep) BEFORE implementing ANY feature, search Zen and
  Firefox code/prefs for what already exists, even if the note doesn't say
  "thought this existed". If it exists, expose/polish it instead of rebuilding.
- (User) For Arc features, the goal is parity: match Arc's behavior, shortcuts,
  and feel, not an approximation.

## Already exists (verify only, no new code)
Back closes tab · return to previous tab on close · rename tabs (dblclick; add
context-menu item + check persistence) · edit pinned URL · close button on
hover · pinned tabs don't load at startup · folder previews (hover search) ·
Essentials per container (zen.workspaces.separate-essentials).

## Tier A: confident, small (tonight, first)
Copy & share (combined, MUST): Supercopy + copy URL shortcuts + copy URLs of
selected tabs (multi-select, Markdown variant, "Copy Links" menu item, toast).
Privacy (MUST): reject cookie banners (toggle, on), strip tracking from links
(toggle), private window indicator, AI kill switch.
Tabs: duplicate shortcut, new tab below current (toggle), new tabs in active
folder (toggle; pref zen.folders.owned-tabs-in-folder), dim sleeping tabs
(toggle, default off), title lines 1/2/3 (setting), new-tab button fixed at
bottom, collapse pinned section, folder colors, loading progress bar,
audio/mic/camera badges, group by domain, notification badges + Essentials
dots (combined), rename in context menu.
Spaces: drag tabs onto space icons, return to last tab per space, searchable
emoji picker, hide space switcher, reorder spaces, open link in another space.
Look: hex colors, transparency control, menu icons, interface font, site-tinted
toolbar (toggle).
Media: mute background tabs (toggle), remember muted sites, per-tab volume,
PiP snaps back, playback speed.
Page: capture tool + full-page to clipboard, edit text on page, allow copy and
paste, Internet Archive for dead pages, image info, translate selection,
reader typography, reading time, dark PDFs (toggle).
Glance/split: Peek from pinned tabs, Glance shortcuts, Glance size, keep Glance
across tabs, external links in Glance, open Glance into split, open link in
split, new tab in split, close other pane, swap panes, split from command bar,
splits survive restart.
Command bar: actions filter (/), recent tabs, extensions, create things
(Arc parity: new Doc/Meet/Linear…), offline bangs.
Misc: keyboard sidebar navigation, shortcut cheat sheet, Dock download
progress, Quick Look downloads, drag downloads into sites, upload from
clipboard, keep window when last tab closes, full URL on click, hardware video
decoding toggle, developer mode tabs, cookie editor, per-site user agent,
whimsy:// URL schemes (Arc parity) + open in space from command line.
Delight: inbox-zero balloons, offline Balloon-Fight-style game (setting for
retro vs gradient style; reachable at whimsy://game), seasonal themes, year in
tabs.

## Tier B: confident, medium (tonight after A)
Quick window (Little Arc) · automatic PiP + PiP over full-screen apps +
floating video calls (Arc parity) · media hub · follower tabs · snooze · undo
for tab actions · archive view with restore · tree tabs with Islands mode
(toggle, off by default; see tree-style-tabs scope) · Scratch / private tab
model (see answers) · notes · space manager · archive/hide space · lock space ·
find heavy tabs · fire button · screenshot to sidebar · space-aware history ·
more split layouts · pin a split · Essentials per space (if answer says so) ·
people cards · preview from history · smarter RSS · bionic reading · print a
clean page · Finder folders in sidebar · menu bar extra (native) · next
meeting in sidebar · live folder "Push" refresh + Linear/Jira folders.

## Tier C: needs scoping or the user's input (after A and B, likely not tonight)
All AI items (tab grouping, agent mode, memories, chat with tabs, compare,
local summaries, skills, feed from any page, natural-language history,
search inside tabs) · local API / "Claude space" · built-in VPN (Vivaldi uses
Proton; needs account/partner) · iOS companion (low priority) · Handoff
(check if it exists) · cast to TV · playlist · faster downloads · faster
DevTools · startup speed · per-space extensions · notification center ·
email aliases · Sidebery panels (user wants to hear more) · Liquid Glass
(explicitly last; user wants to talk it through).

## Answers to bedtime questions
(appended below)

1. Spaces and private browsing (user, Oct 29): Cmd+N = new space. Cmd+Shift+N =
   new temporary + private space ("Scratch": forgets everything when closed;
   this replaces both the private window and temporary containers).
   Cmd+Opt+N = private tab in the current space (Waterfox-style private tab).
   Normal "New Window" moves to the File menu. Duplicate tab = Cmd+Shift+D.
2. Tree tabs: off by default; style options Tree and Islands (Opera-like, one
   level, colored). Anything closed is archived (restorable from the Archive
   view), so closing a parent closes its branch into the Archive. Max depth 4.
3. Live folders "Push" refresh option: smart checks every 1 minute using
   conditional requests (ETag/If-None-Match), shown as "Push" alongside the
   interval choices. Do NOT refresh on window focus.
4. Use subagents for self-contained features (one at a time, same repo, short
   summaries back) to keep context small; keep an eye on total session usage
   and stop starting new work well before limits. Defaults I chose: keep the
   selected pinned tab visible when the pinned section is collapsed;
   Essentials stay per container (Arc's model) unless the user says otherwise.

5. (User, Oct 29, before sleep)
   - Release is HELD tonight: `paused: true` in the updater's control.json (only
     the nightly checks it; ship still works). Only Dev gets tonight's work.
     Morning: remove `paused` from control.json to resume nightly releases.
   - Defaults: every new feature defaults ON unless its note says otherwise.
   - A feature that gets stuck (failing test not fixable in reasonable time):
     revert it, note why in the morning report, move on. Ship stays green.
   - Before building each feature, write down (in the commit body or scope)
     WHY users love it and HOW they actually use it (the original's user flow),
     and build to that flow, not just the feature name.
   - Arc vs Zen conflicts are decided case by case:
     - Cmd+Opt+N = Little Arc (quick window), matching Arc. Private tab in the
       current space = Cmd+Opt+T.
     - Links opened from other apps open in Little Arc by default (Arc parity),
       with a "Move to space" button; Glance-for-external-links stays a setting.
     - Archive includes Arc's auto-archive: unused unpinned tabs archive after
       12 h, adjustable (12 h / 24 h / 7 days / 30 days / Never). Never pinned,
       Essentials, or tabs playing audio.
     - Peek: add Arc's Peek (cross-site links from pinned tabs/Essentials open
       in Glance) and keep Zen's Glance triggers. Verify first; Zen may already
       do this (zen.glance.* prefs).
   - Any other Arc-vs-Zen conflict found tonight: pick Arc's behavior by
     default, keep Zen's as a setting, and list the call in the morning report.
   - Testing (user): every feature must be thoroughly tested: a browser
     mochitest in src/zen/whimsy/tests/ covering the main flow, the switch off,
     and edge cases (empty state, many tabs, private/space boundaries), plus a
     screenshot check in browser_whimsy_screens.js for anything visual. Run the
     full `verify.sh quick` before each commit; nothing ships red.
