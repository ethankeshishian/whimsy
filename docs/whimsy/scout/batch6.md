# Scout batch 6: Glance, split view, command bar

Read-only research, 2026-10-29. Paths are relative to ~/Repos/whimsy. "Overlay" means
new code in src/zen/whimsy/ (+ prefs/whimsy/whimsy.yaml, whimsy-settings.js), no Zen edits.
Zen feature requests live in GitHub Discussions, cited as D#. Open PRs are cited as PR#.

BUILD-PLAN answers that apply here: **Peek** means adding Arc's Peek while keeping Zen's Glance
triggers. Links opened from other apps go to the quick window (Little Arc, Cmd+Opt+N), so
"external links in Glance" is only a setting.

Shared building blocks:
- Glance: `gZenGlanceManager` (src/zen/glance/ZenGlanceManager.mjs). Commands `cmd_zenGlanceClose|Expand|Split`
  (`handleMainCommandSet`, :243). `openGlance(data, existingTab, ownerTab)` :538, `fullyOpenGlance()` :1779,
  `splitGlance()` :1961, `getTabOrGlanceParent/Child` :2010. Detached glance (no tab): `openDetachedGlance` :97,
  used today only by the Boosts library section. Content trigger: actor src/zen/glance/actors/ZenGlanceChild.sys.mjs
  (modifier+click, Escape → "ZenGlance:CloseGlance" :178).
- Glance prefs (prefs/zen/glance.yaml): `zen.glance.enabled`, `zen.glance.enable-contextmenu-search`,
  `zen.glance.open-essential-external-links` (true), `zen.glance.activation-method` ("alt"; the child actor's fallback is "ctrl"),
  `zen.glance.animation-duration` (350), `zen.glance.deactivate-docshell-during-animation`.
- Split: `gZenViewSplitter` (src/zen/split-view/ZenViewSplitter.mjs, 2,659 lines). `splitTabs(tabs, gridType, activeIdx)`,
  `splitLinkInNewTab()` :1243, `swapNodes()` :1057, `removeTabFromSplit`, `createEmptySplit(side)` :2567,
  `storeDataForSessionStore/restoreDataFromSessionStore` :2418/:2447. Prefs: prefs/zen/split-view.yaml (`zen.splitView.*`).
- Keys (src/browser/base/content/zen-keysets.inc.xhtml): split grid/vertical/horizontal/unsplit = Cmd+Opt+G/V/H/U,
  new empty split = Cmd+Shift+*, Glance expand = Cmd+O. Commands map to code in src/zen/common/zen-sets.js:64–75.
- Command bar: `globalActions` in src/zen/urlbar/ZenUBGlobalActions.sys.mjs (each `{l10nId, command, icon, isAvailable}`),
  served by `ZenUrlbarProviderGlobalActions` (src/zen/urlbar/ZenUBActionsProvider.sys.mjs). Commands mode =
  `RESULT_SOURCE.ZEN_ACTIONS`, entered by pressing **Tab in an empty URL bar** (UrlbarChildController patch →
  `ZenUrlbarController.enableCommandsMode`, :336). Firefox's own `>` restrict token is Firefox quick actions; Zen adds `` ` `` for spaces.
- Open PR worth tracking: **PR#15241 "Content Link Handling options"**: configurable modifier+click for Glance / Split / New tab / New window.
  If it merges, several items below become a pref flip.
- Tests: mochitests in src/zen/whimsy/tests/. Zen's own fixtures to copy: src/zen/tests/glance/head.js (`openGlanceOnTab`),
  src/zen/tests/split_view/head.js.

---

## 1. Peek from pinned tabs / Essentials
Queue: `[quick|partial|S]` (no note).
- (a) **Already exists.** `shouldOpenTabInGlance(tab, uri)` (:1708): if the opener is pinned (Firefox sets `browsingContext.isAppTab` on
  every pinned tab, so this covers Essentials *and* pinned tabs), the new link's host differs (`tabDomainsDiffer`, exact host,
  http/https/file only), and `zen.glance.open-essential-external-links` is true, the new tab opens as a Glance. Default on.
- (b) Issue #16221 (sibling subdomains glance, same host doesn't; host compare is too strict). D#14572 asks for a way to turn it off.
- (c) Arc Peek: a link from a pinned tab or Favorite that leads to another site opens in a floating card over the app, so
  Gmail/Linear never get navigated away. Esc closes it; buttons expand it to a tab or open it in split.
- (d) No new feature. Add a Settings checkbox for `zen.glance.open-essential-external-links` labeled "Peek: open other-site links
  from pinned tabs in Glance". Optional fix: compare base domains (`Services.eTLD.getBaseDomain`) instead of host so
  mail.google.com → docs.google.com stays in place (this needs a Zen edit or wrapping `gZenGlanceManager.tabDomainsDiffer` from Whimsy init).
  Test: pin example.com, click a link to example.org → a tab with `zen-glance-tab` appears. Pref off → normal tab.

## 2. Glance shortcuts
Queue: `[quick|partial|S]` (no note).
- (a) Open: Alt+click by default (`zen.glance.activation-method`: ctrl|alt|shift|meta), context menu "Open Link in Glance"
  (`context-zenOpenLinkInGlance`), and selecting a search result in Glance (`onSearchSelectCommand`, :2072). Close: Escape
  (child actor) or click on the backdrop. Expand to a tab: **Cmd+O** (`zen-glance-expand`, customizable). Split: **button only**;
  `cmd_zenGlanceSplit` has no `<key>`.
- (b) #13609 (Cmd+Down doesn't work in Glance tabs). D#10375 (split shortcut for Glance). PR#16143 (macOS modifier names in labels),
  PR#15336 (long-press activation).
- (c) Arc Peek is used almost entirely from the keyboard: Esc closes; buttons "Open in Split View" and "Open as Tab".
- (d) In WhimsyShortcuts, add `<key id="whimsy-glance-split" key="=" modifiers="accel,shift" command="cmd_zenGlanceSplit"/>` and register it
  in the Zen shortcuts list so users can rebind it. Add a Settings dropdown for the activation modifier (writes `zen.glance.activation-method`).
  Test: open a glance via `openGlanceOnTab`, synthesize the key → `gZenViewSplitter.splitData` has 2 tabs and there is no `zen-glance-tab` left.

## 3. Glance size
Queue: `[quick|new|S]` "Glance size and position" (no note).
- (a) **Hard-coded at 80% width x 100% height:** CSS `.browserContainer { width: 80% }` (zen-glance.css:127) plus JS
  `const widthPercent = 0.8` in the opening animation (ZenGlanceManager.mjs:816) and `style.width = "80%"` at :979.
- (b) D#13326 "Resize Glances" (2 votes). D#813 (Enhance Split View, 138) mentions it.
- (c) Arc's Peek card is a fixed size. Safari's link preview and Raycast's floating notes let you drag a corner. People want a narrow card for chat apps and a wide one for docs.
- (d) Changing the size only in CSS breaks the open/close animation, which measures 0.8. It needs a one-line Zen edit: read
  `whimsy.glance.width-percent` (default 80) in both JS spots and set `--zen-glance-width` for the CSS. Then add a drag handle on the card's
  left and right edges that writes the pref, plus a Settings slider (60–95).
  Test: set the pref to 60 → after opening, `browserWrapper.getBoundingClientRect().width ≈ 0.6 * tabpanels width` (±2px).

## 4. Keep Glance across tab switches
Queue: `[quick|new|S]` (no note).
- (a) **Partly exists:** the parent and glance tabs share a `glance-id`. Switching away hides the Glance (`onLocationChange`, :1568 →
  `quickCloseGlance`), and switching back to the parent reselects the Glance (test src/zen/tests/glance/browser_glance_select_parent.js).
  What is missing is a Glance that stays visible over *other* tabs.
- (b) D#2718 "Persist glance on tab switch" (8 votes). #14602 (the parent still counts as active during Ctrl+Tab).
- (c) Arc ties Peek to its tab as well. Floating over every tab is Vivaldi-style "web panel" behavior, which is closer to the
  detached glance (`openDetachedGlance`), since that one is not owned by a tab.
- (d) Check first that Zen's per-tab restore already matches what the user wants (it probably does). If not, add a "Pin Glance" button
  that calls `openDetachedGlance({url})` and closes the tab-owned one. The detached host lives in `#zen-main-app-wrapper`, so it survives `TabSelect`.
  Test: open a glance, switch to another tab, then back → the glance tab is selected again. Pinned: switch tabs → `#zen-glance-detached` is still in the DOM.

## 5. External links in Glance (setting only)
Queue: `[quick|new|S]` "Open external links in Glance" (no note). BUILD-PLAN: the default goes to the quick window. This is just a toggle.
- (a) Nothing in Zen. Links from other apps come in through `BrowserContentHandler` (engine/browser/components/BrowserContentHandler.sys.mjs:1375,
  `OPEN_EXTERNAL`) and `browser.link.open_newwindow.override.external`.
- (b) D#9274 "Open links from external applications in Glance" (24 votes). D#5293 (Little Arc, 102). D#16181.
- (c) Arc sends links from other apps to Little Arc by default. Some users would rather see a Peek over their current tab.
- (d) Radio button `whimsy.external-links.target` = "quick-window" (default) | "glance" | "tab". In the quick-window handler, for "glance",
  call `gZenGlanceManager.openGlance({url, triggeringPrincipal: system})` on the most recent window's selected tab instead.
  Test: call `nsIBrowserDOMWindow.openURI` with `OPEN_EXTERNAL` on example.com under each value → a quick window, a `zen-glance-tab`, or a normal tab.

## 6. Open Glance into a split
Queue: `[split|new|S]` (no note).
- (a) **Already exists:** the split button in the Glance sidebar → `cmd_zenGlanceSplit` → `splitGlance()` (:1961) calls `fullyOpenGlance({forSplit:true})`
  and then `splitTabs([parent, glance], "vsep")`. It is disabled while the parent is already in a split (`maybeDisableOpeningTabOnSplitView`).
  Zen test: src/zen/tests/split_view/browser_split_view_with_glance.js.
- (b) D#10375, D#8946.
- (c) Arc Peek's "Open in Split View" button. The whole point is to read a Linear issue next to the Slack thread that linked it.
- (d) Just add a key (see #2) and a command-bar action ("Split Glance", `isAvailable: w => !!w.gZenGlanceManager... current glance`).
  Allowing it when the parent is already split means calling `addTabToSplit(glanceTab, splitNode)` instead.
  Test: as in #2. Plus: parent already in a 2-pane split → after the action, 3 panes.

## 7. Open a link in split
Queue: `[split|partial|S]` (no note).
- (a) Context menu "Open Link in Split View" (`zen-split-link` menuitem, ZenViewSplitter.mjs:146 → `splitLinkInNewTab()`). No modifier+click.
- (b) D#16105 "Modifier+click to open link directly in Split View (like Arc's Shift+click)". D#2137 (45). **PR#15241** adds exactly this.
- (c) Arc: Shift+click a link → it opens in a split beside the current tab.
- (d) Wait for PR#15241 if it merges soon. Otherwise, in a small Whimsy actor (or by extending the existing glance child actor's click
  handler through an `actorParent` message), catch Shift+click on an http(s) link in the capture phase, `preventDefault`, and have the parent
  open a tab next to it, then `splitTabs([current, newTab], undefined, 1)`. Watch out: Shift+click is Firefox's "new window", so add a pref.
  Test: Shift+click a link on a test page → 2-pane split, new pane selected, no new window.

## 8. New tab in split
Queue: `[split|new|S]` "Open a new tab inside a split" (no note).
- (a) **Already exists:** `cmd_zenNewEmptySplit` (Cmd+Shift+*, command-bar action "New Split View") → `createEmptySplit("right")` opens an empty
  pane focused on the URL bar. Closing the URL bar without picking anything removes the pane (`ZenURLBarClosed` listener). Missing: Cmd+T while a split is focused replaces the focused pane.
- (b) D#2137 "Ability to open a new tab within a split view" (45). #15128 (dragging the splitter while an empty split is staged).
- (c) Arc: when a split view is focused, Cmd+T opens the command bar, and the result *replaces the focused pane* (Arc keeps the split).
  Users love that the split behaves like a single tab.
- (d) Add a pref `whimsy.split.cmdt-replaces-pane` (default on). Wrap `BrowserCommands.openTab` / the Cmd+T path: if the selected tab is in a split,
  open the URL bar in "replace pane" mode, and on commit load the URL into the focused pane's browser (or open a tab and `addTabToSplit` in the
  same slot, then close the old one). Test: 2-pane split, Cmd+T, type example.org, Enter → still 2 panes, focused pane URL = example.org.

## 9. Close the other pane
Queue: `[split|partial|S]` (no note).
- (a) Each pane header has an "unsplit" button (`zen-tab-unsplit-button`, `_createHeader` :1704 → `removeTabFromSplit`) that removes *that* pane.
  Cmd+Opt+U unsplits everything. No "keep this one, close the others".
- (b) D#15203 (closing an unloaded split tab by accident too easily). D#14240 (split view QoL).
- (c) Arc: pane menu → "Close other split views" / close the pane's tab. People use it when they finished the reference doc and want the main one full-width.
- (d) Command-bar action and pane context item "Close Other Panes": take `gZenViewSplitter.splitData` for the selected tab and call
  `gBrowser.removeTab(t)` for every other tab (or `removeTabFromGroup` to just unsplit them, which is a pref: close vs unsplit).
  Add a key, Cmd+Opt+Shift+W. Test: 3-pane split, focus B → action → only B remains, and it is not split. The unsplit variant keeps A and C as normal tabs.

## 10. Swap panes
Queue: `[split|new|S]` (no note).
- (a) The rearrange button in the pane header (`zen-tab-rearrange-button` → `enableTabRearrangeView`, :708) lets you drag panes around, and that uses
  `swapNodes(node1, node2)` (:1057) under the hood. There is no one-step swap.
- (b) D#13169 "Swap tab in a split view". D#14240.
- (c) Arc: drag a pane's top handle onto the other side. Vivaldi: "Swap tiles". People want a single key to flip left/right.
- (d) Add the action "Swap Panes" (command bar + key Cmd+Opt+S): find the focused leaf with `getSplitNodeFromTab`, pick its sibling
  (or the next leaf), `swapNodes(a, b)`, then `applyGridLayout(splitData.layoutTree)`. Test: split [A,B] → swap → A's container's `getBoundingClientRect().left`
  is greater than B's. Swap again → back to the start.

## 11. Split from the command bar
Queue: `[split|new|S]` (no note).
- (a) The command bar has "New Split View" (`zen-action-new-split-view` → `cmd_zenNewEmptySplit`) and "Unsplit View".
  No "split with <tab>".
- (b) D#10577 "More ideas for Command Bar actions" (33).
- (c) Arc: Cmd+T, type a tab or URL, and Shift+Enter (or "Open in Split View") puts the result beside the current tab.
- (d) In the URL bar result handler, Shift+Enter (or Opt+Enter, to avoid Firefox's Shift+Enter meanings) on a switch-to-tab or URL result:
  for a tab, `splitTabs([current, thatTab])`; for a URL, open the tab and then split. Add actions "Split Vertically / Horizontally / Grid" that call
  `toggleShortcut(...)` with the selected tabs. Test: two tabs, command bar, type the other title, the modifier+Enter → `splitData.tabs.length == 2`.

## 12. Splits survive restart
Queue: `[split|partial|S]` (no note).
- (a) **Already wired:** SessionStore patch (src/browser/components/sessionstore/SessionStore-sys-mjs.patch:283/348) saves
  `gZenViewSplitter.storeDataForSessionStore()` into `winData.splitViewData` and restores it (layout tree, sizes, gridType).
  Split groups are tab groups with `split-view-group`.
- (b) #12403 "Restoring Split Tabs Ignored" (pinned 3-pane split restores only the last tab). #7363 (split view with Essentials).
- (c) Arc saves a split as one sidebar item that survives restarts and can be pinned. People build "Gmail + Calendar" layouts and expect them back.
- (d) Write a test first, since this may already work in the general case: build a split, call `SessionStore.getWindowState(window)`, check
  `splitViewData`, then `SessionStore.setWindowState` into a new window and check that the pane count and sizes match. Fix #12403 (pinned splits)
  if it reproduces. Likely cause: restore runs before pinned tabs exist, so `restoreDataFromSessionStore` → `document.getElementById(tabId)` returns null.

## 13. Command bar actions-only filter (`/`)
Queue: `[command|new|S]` (no note).
- (a) Commands mode exists (`ZEN_ACTIONS` search mode, shows *all* actions, no history), but only when you press **Tab in an empty URL bar**.
  Firefox's `>` restrict token opens Firefox's quick actions, not Zen's list. No `/` token.
- (b) D#10577, D#15371 (word-order matching and keywords for actions).
- (c) Raycast and VS Code (`>`), Linear (`/`). Arc doesn't really have a filter. Typing at the start of the line jumps straight to commands, so search results never crowd them.
- (d) When the URL bar value is exactly `/` (and the view is open), call `gZenUIManager.enableCommandsMode(event)` and clear the value.
  This fits in the same UrlbarChildController hook Zen uses for Tab. If that has to stay a Zen patch, do it in WhimsyShortcuts
  with an `input` listener on `gURLBar.inputField`. Use a pref, since `/path` is a valid (rare) query. Test: focus the URL bar, type "/" →
  `gURLBar.searchMode.source == ZEN_ACTIONS` and the value is empty. Type "/foo" quickly → still commands mode with "foo".

## 14. Recent tabs in the command bar (Arc parity)
Queue: `[command|partial|S]`. NOTE: "Get parity".
- (a) Firefox offers open tabs as "Switch to Tab" results (`UrlbarProviderOpenTabs`, `%` restrict, `browser.urlbar.suggest.openpage`).
  Zen adds sidebar tabs and folders from the session (`ZenUrlbarProviderSidebar`). On an empty URL bar Zen shows top sites. There is no MRU list.
  Whimsy already tracks MRU for Ctrl+Tab (tests browser_whimsy_ctrl_tab_mru.js), using `tab.lastAccessed`.
- (b) No issue.
- (c) Arc: Cmd+T on an empty query lists your open tabs/recent pages first, so Cmd+T → Enter goes back to the last tab, and typing filters
  open tabs above history. People use it instead of Ctrl+Tab.
- (d) Add a `WhimsyUrlbarRecentTabs` provider (PROFILE type, active when `searchString == ""`): the top 5 tabs in the current space by `lastAccessed`,
  excluding the selected tab, as `TAB_SWITCH` results, plus "recently closed" from `SessionStore.getClosedTabDataForWindow`. Register it with
  `UrlbarProvidersManager.registerProvider`. Test: visit A, B, C, then open the bar empty → first rows are B, A (C is selected).

## 15. Extensions from the command bar
Queue: `[command|partial|S]` (no note).
- (a) **Already exists:** `#getExtensionActions` (ZenUBActionsProvider.sys.mjs:206) lists every active, non-system extension that has a browser action
  ("Extension: <name>"). Running one opens its popup (:575, via `gUnifiedExtensions`). Hidden on empty tabs. "Manage Extensions" → `Tools:Addons`.
- (b) None open.
- (c) Arc: type the extension name in Cmd+T to open its popup. Same as Zen.
- (d) Small extras: "Disable/Enable <extension>" actions (`AddonManager.getAddonByID(id).disable()`), "Extension options" (`BrowserAddonUI.openAddonsMgr("addons://detail/"+id+"/preferences")`),
  and show the actions on empty tabs too, labeled "(opens a tab first)". Test: install a test extension with a browser action → typing its name shows the row,
  and running "Disable" sets `addon.userDisabled`.

## 16. Create things from the command bar (Arc parity)
Queue: `[command|new|S]`. NOTE: "Get parity".
- (a) Nothing in Zen or Firefox. The `.new` shortcut domains already exist on the web (docs.new etc.), so these are just URL actions.
- (b) D#10577 lists a few.
- (c) Arc's Cmd+T "New …" actions (added v0.77, Nov 2022, plus later): **New Google Doc, New Google Sheet, New Google Slides, New Google Form,
  New Google Meet, New Google Calendar Event, New Notion Page, New Linear Issue, New Figma File, New FigJam File, New GitHub Repo, New GitHub Gist,
  New Word/Excel/PowerPoint doc, New Confluence page, New Miro board, New Loom, New Spotify playlist, New Canva design**, plus "New Note" which uses the default notes app set in
  Settings → General → New Documents (Notion, Google Docs, Word or Confluence). Exact set unverified: Arc's list page (browserinc.notion.site "Command Bar T Actions") didn't render.
  Check it in Arc itself before shipping. People love that a doc exists before they finish thinking about it.
- (d) Add a data table in `WhimsyCommandCreate.sys.mjs`: `{label, url}` → docs.new, sheets.new, slides.new, forms.new, meet.new, cal.new,
  notion.new, linear.new, figma.new, figjam.new, repo.new, gist.new, word.new, excel.new, powerpoint.new, miro.new, loom.new, canva.new, playlist.new.
  Push them into `globalActions` (or a Whimsy provider) with the site favicon. "New Note" reads `whimsy.new-note.target`. Each opens a new tab (Opt+Enter → split).
  Test: type "new doc" → a row "New Google Doc". Running it opens a tab whose URL starts with https://docs.new.

## 17. Offline bangs
Queue: `[command|new|M]` (no note).
- (a) None. Today, `!yt` works only because DuckDuckGo/Kagi redirect on their server, which costs a round trip and skips space routing (#14487).
- (b) **#14487 "!bangs bypass space routing rules"**. D#13634 "!bangs Support" (7).
- (c) unduck.link (Theo) and Kagi: a local bang table, so `!gh whimsy` jumps straight to GitHub with no search-engine hop. Fast and private.
- (d) Bundle the bang list as JSON (DuckDuckGo's `bang.js`, ~13k entries; trim it to the top ~2k by usage to keep it small) in
  `src/zen/whimsy/bangs/`. In a heuristic URL bar provider, match `^!(\w+)\s+(.*)` or a trailing `foo !w`, then return a URL result with `{{{s}}}`
  replaced by `encodeURIComponent(query)`. Because it's a normal URL load, space routing applies. Users can add their own bangs in a Settings list (`whimsy.bangs.custom`).
  Test: type "!w cats", Enter → loads https://en.wikipedia.org/wiki/Special:Search?search=cats with no request to duckduckgo.com (watch with an http observer).
