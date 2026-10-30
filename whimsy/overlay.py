"""Whimsy's overlay on top of Zen.

Whimsy keeps Zen's files exactly as upstream ships them. Everything Whimsy
adds lives in Whimsy-owned paths (src/zen/whimsy/, whimsy/, prefs/whimsy/,
locales/en-US/.../whimsy*.ftl, src/**/whimsy-*). The few changes Whimsy needs
inside Zen's files are listed here and applied by this script after every
upstream sync. Each one is idempotent and checked, so syncing never needs a
merge:

- HOOKS insert one line next to an anchor in a Zen file.
- OVERRIDES rewrite settings in surfer.json, mozconfig and package.json.
- PREF_OVERRIDES change the default of a pref Zen already declares.
- HOTFIXES patch Zen bugs, only while the buggy code is still there.
- FALLBACK_STRINGS supply strings Zen uses but no longer ships.
- FEATURES name Whimsy features and how to spot Zen shipping the same thing;
  a superseded feature is switched off so Zen's version wins.

  python3 whimsy/overlay.py apply   # after an upstream sync
  python3 whimsy/overlay.py check   # exit 1 if anything is missing
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# (id, file, anchor regex, line to insert, "after" | "before")
HOOKS = [
    ("startup", "src/zen/common/modules/ZenStartup.mjs",
     r"^(\s*)gZenCompactModeManager\.init\(\);\s*$",
     '{indent}ChromeUtils.importESModule("resource:///modules/whimsy/Whimsy.sys.mjs").Whimsy.initWindow(window); // Whimsy hook',
     "after"),
    ("moz-build", "src/zen/moz.build",
     r'^(\s*)"common",\s*$',
     '{indent}"whimsy",  # Whimsy hook',
     "after"),
    ("jar", "src/browser/base/content/zen-assets.jar.inc.mn",
     r"^#include \.\./\.\./\.\./zen/common/jar\.inc\.mn\s*$",
     "#include ../../../zen/whimsy/jar.inc.mn",
     "after"),
    ("browser-strings", "src/browser/base/content/zen-locales.inc.xhtml",
     r"^(\s*)</linkset>\s*$",
     '{indent}<link rel="localization" href="browser/whimsy.ftl"/>',
     "before"),
    ("settings", "src/browser/components/preferences/zen-preferences-links.xhtml",
     r'^<link rel="localization" href="browser/preferences/zen-preferences\.ftl"/>',
     "#include whimsy-preferences-head.inc.xhtml",
     "after"),
]

HOTFIXES = [
    {
        "id": "pinned-tab-null-l10n-arg",
        "file": "src/zen/tabs/ZenPinnedTabManager.mjs",
        "why": "A null isEssential argument makes Fluent drop the whole tab "
               "context menu's labels.",
        "old": "          document.l10n.setArgs(element, { isEssential });",
        "new": "          document.l10n.setArgs(element, {\n"
               "            isEssential: isEssential ? \"true\" : \"false\", // Whimsy hotfix\n"
               "          });",
    },
]

# Prefs Zen declares whose defaults Whimsy changes: {name: value}.
PREF_OVERRIDES = {
    "zen.ctrlTab.show-pending-tabs": True,       # Arc-style Ctrl+Tab
    "zen.updates.show-update-notification": False,  # Whimsy shows its own
    "zen.folders.owned-tabs-in-folder": True,    # new tabs stay in the folder
    "zen.theme.gradient.show-custom-colors": True,  # theme picker's custom colors (hex field)
    # Automatic picture-in-picture when you leave a playing video (Arc);
    # Zen kept it off "until a settings page"; Firefox's Media settings has it.
    "media.videocontrols.picture-in-picture.enable-when-switching-tabs.enabled": True,
}

# Strings Zen's markup uses that its .ftl files no longer define.
FALLBACK_STRINGS = {
    "preferences-web-appearance-footer":
        'preferences-web-appearance-footer = Manage themes in '
        '<a data-l10n-name="themes-link">Extensions & Themes</a>',
}
FALLBACK_FILE = "locales/en-US/browser/browser/preferences/whimsy-fallbacks.ftl"

# Whimsy features, and signs that Zen now ships its own version.
FEATURES = [
    {"id": "ctrl-tab", "title": "Arc-style Ctrl+Tab",
     "detect": [("prefs", r"name:\s*browser\.ctrlTab\.sortByRecentlyUsed")]},
    {"id": "ui-zoom", "title": "Interface zoom",
     "detect": [("src", r"ui-zoom|uiZoom|interface-zoom")]},
    {"id": "app-icon", "title": "App icon picker",
     "detect": [("src", r"setApplicationIcon|applicationIconImage|zen\.app-icon|app-icon-picker")]},
    {"id": "copy", "title": "Copy & share: rich links, selected tabs, Copy Links menu item",
     "detect": [("src/zen", r"context_copyLinks|copySelectedTabsURL|copyTabsURLs|text/html.*copyCurrentURL")]},
    {"id": "cookie-banners", "title": "Reject cookie banners (built-in DuckDuckGo Autoconsent add-on + toggle)",
     "detect": [("src/zen", r"(?i)autoconsent|cookiebanners\.service\.mode"),
                ("prefs", r"name:\s*cookiebanners\.service\.mode")]},
    {"id": "private-indicator", "title": "Private window indicator (violet tint + Incognito badge)",
     "detect": [("src/zen", r"privatebrowsingmode[^\n]*(--zen-main-browser-background|accent)")]},
    {"id": "ai-kill-switch", "title": "AI kill switch (one toggle blocks every Firefox and Whimsy AI feature)",
     "detect": [("src/zen", r"browser\.ai\.control\.default"),
                ("prefs", r"name:\s*browser\.ai\.control\.default")]},
    {"id": "duplicate-shortcut", "title": "Duplicate tab on Cmd+Shift+D; Pin/Unpin on Cmd+D (Arc)",
     "detect": [("src/browser/base/content", r'id="zen-duplicate-tab"[^>]*\bkey=')]},
    {"id": "new-tab-position", "title": "New tabs open below the current tab and stay in its folder (toggles)",
     "detect": [("src/browser/components/preferences", r"browser\.tabs\.insertAfterCurrent|zen\.folders\.owned-tabs-in-folder")]},
    {"id": "dim-sleeping", "title": "Dim sleeping (unloaded) tabs (toggle, off by default)",
     "detect": [("src/zen", r"\[pending\][^{]*\{[^}]*opacity"),
                ("prefs", r"name:\s*zen\.[\w.-]*(dim|fade)[\w.-]*(unloaded|sleeping|pending)")]},
    {"id": "title-lines", "title": "Tab title lines: wrap titles onto 1, 2 or 3 lines (setting)",
     "detect": [("src/zen/tabs", r"tab-label[^{]*\{[^}]*line-clamp"),
                ("prefs", r"name:\s*zen\.[\w.-]*title-lines")]},
    {"id": "newtab-bottom", "title": "New tab button fixed at the bottom of the sidebar (toggle, off by default)",
     "detect": [("prefs", r"name:\s*zen\.[\w.-]*newtab-button-bottom")]},
    {"id": "folder-colors", "title": "Folder colors: pick a color per folder from its context menu",
     "detect": [("src/zen/folders", r"zenFolder\w*Color|folder-color-picker"),
                ("prefs", r"name:\s*zen\.folders\.[\w.-]*colou?r")]},
    {"id": "loading-line", "title": "Loading progress line: Zen's loading pill as a Safari-style progress line (toggle)",
     "detect": [("src/zen/common/sys/ui", r"onProgressChange"),
                ("prefs", r"name:\s*zen\.[\w.-]*loading-(line|progress)")]},
    {"id": "tab-badges", "title": "Notification badges (unread counts) and update dots on pinned tabs and Essentials",
     "detect": [("src/zen", r"unread-?count|zen-unread|notification-badge"),
                ("prefs", r"name:\s*zen\.[\w.-]*(badge|unread)")]},
    {"id": "group-domain", "title": "Group by domain: gather a site's tabs into a folder (tab context menu)",
     "detect": [("src/zen", r"(group|folder)[\w-]*by-?(domain|site)"),
                ("src/zen/folders", r"getBaseDomain")]},
    {"id": "space-icon-drop", "title": "Drop tabs on space icons to move them to that space (Arc)",
     "detect": [("src/zen/drag-and-drop", r"handle_spaceIconDrop\b|spaceIconDrop")]},
    {"id": "space-last-tab", "title": "Return to the most recently used tab in each space, also after a restart",
     "detect": [("src/zen/spaces", r"lastSelectedWorkspaceTabs\[[^\]]+\]\s*=\s*[^;]*lastAccessed")]},
    {"id": "emoji-search", "title": "Emoji search: every word must match, Enter picks the first result, empty state",
     "detect": [("src/zen/common/emojis", r"split\(/\\s\+/\)|no-results|emojis-picker-empty")]},
    {"id": "hide-switcher", "title": "Hide the space switcher (toggle, off by default)",
     "detect": [("prefs", r"name:\s*zen\.[\w.-]*(hide|show)[\w.-]*(workspace|space)[\w.-]*(switcher|icons|button)")]},
    {"id": "open-link-in-space", "title": "Open Link in Space (link context menu, Arc)",
     "detect": [("src/zen/spaces", r"openLinkIn(Workspace|Space)|open-link-in-(workspace|space)")]},
    {"id": "hex-colors", "title": "Hex colors in the theme picker (type or paste #RRGGBB)",
     "detect": [("src/zen/spaces", r"type=\"text\"[^>]*custom|custom-hex|hex-input")]},
    {"id": "transparency", "title": "Transparency slider for the sidebar and toolbars (macOS)",
     "detect": [("prefs", r"name:\s*zen\.(theme|view)\.[\w.-]*(transparency|translucency)")]},
    {"id": "menu-icons", "title": "Menu icons in context menus and the tab menu (macOS 26 style)",
     "detect": [("src/browser/themes/shared/zen-icons", r"#context-copylink|#context-openlinkintab|#context_duplicateTab")]},
    {"id": "ui-font", "title": "Interface font setting (the browser's own text, not web pages)",
     "detect": [("prefs", r"name:\s*zen\.[\w.-]*(ui|interface|chrome)-font")]},
    {"id": "strip-tracking", "title": "Strip tracking parameters from links (query stripping on by default + toggle)",
     "detect": [("prefs", r"name:\s*privacy\.query_stripping\.enabled\s*$")]},
    {"id": "background-mute", "title": "Mute background tabs (Vivaldi's Tab Muting: while the current tab plays, or always; setting)",
     "detect": [("src/zen", r"(?i)mute[_-]?background[_-]?tabs|backgroundTabMute"),
                ("prefs", r"name:\s*zen\.[\w.-]*(background|inactive)[\w.-]*mute")]},
    {"id": "mute-site", "title": "Remember muted sites: Mute Site in the tab menu (Chrome)",
     "detect": [("src/zen", r"(?i)context_\w*MuteSite|mute-?site\b")]},
    {"id": "tab-volume", "title": "Per-tab volume: a slider on the tab's speaker and in the tab menu",
     "detect": [("src/zen", r"(?i)tab-?volume-?(slider|panel)|setTabVolume")]},
    {"id": "pip-snap-back", "title": "PiP snaps back into the page when you return to its tab (Arc), automatic PiP setting",
     "detect": [("src/zen", r"(?i)pip-?snap|snapBackPip")]},
    {"id": "playback-speed", "title": "Playback speed shortcuts (Cmd+Opt+. and ,) and the PiP speed control",
     "detect": [("src/zen/media", r"(?i)zen-media-(speed|rate)|setPlaybackRate|playback-speed"),
                ("prefs", r"name:\s*media\.videocontrols\.picture-in-picture\.playback-speed\.enabled")]},
    {"id": "find-selection", "title": "Cmd+F opens Find with the selected text (Chrome, Safari)",
     "detect": [("prefs", r"name:\s*accessibility\.typeaheadfind\.prefillwithselection")]},
    {"id": "capture", "title": "Capture: Arc's Cmd+Shift+2 for Screenshots, and Copy Full-Page Screenshot in one step",
     "detect": [("src/zen", r"(?i)copy-?full-?page|fullPageScreenshot|capture-full-page")]},
    {"id": "edit-page", "title": "Edit text on page (designMode) from the page menu and command bar",
     "detect": [("src/zen/urlbar", r"(?i)designMode|edit-?page"),
                ("src/zen/boosts", r"designMode\s*=")]},
    {"id": "allow-copy", "title": "Allow copy and paste on sites that block it (per site, command bar)",
     "detect": [("src/zen", r"(?i)allow-?copy|copy-?unblock|enable-?right-?click")]},
    {"id": "wayback", "title": "Internet Archive for dead pages (bar on 404/5xx/DNS errors, command bar)",
     "detect": [("src/zen", r"(?i)wayback|archive\.org/wayback")]},
    {"id": "image-info", "title": "View Image Info on the image context menu",
     "detect": [("prefs", r"name:\s*browser\.menu\.showViewImageInfo")]},
    {"id": "translate-selection", "title": "Translate selection: a shortcut and command bar action for Firefox's panel",
     "detect": [("src/zen", r"SelectTranslationsPanel\.open"),
                ("src/browser/base/content", r"key[^>]*(translate-?selection|translateSelection)")]},
    {"id": "reader-fonts", "title": "Reader View typography: the macOS reading fonts (Charter, Iowan, Athelas...)",
     "detect": [("prefs", r"name:\s*reader\.font_type\.values"),
                ("src/zen", r"reader\.font_type\.values")]},
    {"id": "reading-time", "title": "Reading time next to the Reader View button (setting)",
     "detect": [("src/zen/urlbar", r"(?i)reading-?time"),
                ("src/browser/base/content", r"(?i)id=\"[\w-]*reading-?time")]},
    {"id": "dark-pdf", "title": "Dark PDFs: a Settings toggle for pdf.js page colours (off by default)",
     "detect": [("prefs", r"name:\s*pdfjs\.(forcePageColors|viewerCssTheme)"),
                ("src/browser/components/preferences", r"pdfjs\.forcePageColors")]},
    {"id": "github-reviews", "title": "My Review Requests (GitHub live folders, Zen PR #16183)",
     "detect": [("src/zen/live-folders", r"user-review-requested|myReviewRequests"),
                ("locales/en-US", r"(?i)my review requests")]},
    {"id": "peek-essential-links", "title": "Settings checkbox for Zen's open-essential-external-links Glance pref",
     "detect": [("src/browser/components/preferences", r'preference="zen\.glance\.open-essential-external-links"')]},
    {"id": "glance-split-action", "title": "\"Split Glance\" in the command bar",
     "detect": [("src/zen/urlbar", r"cmd_zenGlanceSplit")]},
    {"id": "external-link-target", "title": "External links (from other apps) open in Glance, a tab, or a quick window",
     # Looks for Zen's own quick-window feature as code (a pref, command or
     # class name), not prose about Arc's "Little Arc" (Zen's Arc-migration
     # tests mention it only to skip it, which isn't Zen shipping one).
     "detect": [("src/zen", r"(?i)zen[\w.-]*quick[\w.-]*window|cmd_zenQuickWindow")]},
    # batch8: tab lifecycle (archive, undo, snooze, tree tabs, fire button, heavy tabs)
    {"id": "auto-archive-tabs", "title": "Auto-archive idle unpinned tabs after a quiet period (Arc)",
     "detect": [("prefs", r"name:\s*zen\.tabs\.(auto-?archive|idle-?close)"),
                ("src/zen", r"(?i)auto-?archive-?tabs|archiveIdleTabs")]},
    {"id": "archive-view", "title": "Archive view: a searchable, by-day list of closed/archived tabs with restore",
     "detect": [("src/zen", r"(?i)zen-?archive-?view|ZenArchiveView")]},
    {"id": "undo-tab-actions", "title": "Cmd+Z undoes the last tab action (close, move, pin), not just closing one tab",
     "detect": [("src/zen", r"(?i)zen-?tab-?undo|ZenTabUndoManager")]},
    {"id": "snooze-tab", "title": "Snooze a tab: closes it now, reopens at a chosen time (SigmaOS, Edge)",
     "detect": [("src/zen", r"(?i)snooze-?tab|ZenSnoozeManager")]},
    {"id": "tree-tabs", "title": "Tree-style tabs with an Islands mode: nest a tab under whichever tab opened it",
     "default": False,  # Build-plan answer: off by default.
     "detect": [("src/zen", r"(?i)zen-?tree-?tabs|ZenTreeTabs|zen-?tab-?islands")]},
    {"id": "fire-button", "title": "Fire button: a one-click data-clearing popover (DuckDuckGo), scoped to site/15 min/space/everything",
     "detect": [("src/zen", r"(?i)fire-?button|ZenFireButton")]},
    {"id": "heavy-tabs", "title": "Find heavy tabs: the tabs using the most memory/CPU, with a close button (Opera GX)",
     "detect": [("src/zen", r"(?i)heavy-?tabs|hot-?tabs-?killer|ZenHeavyTabs")]},
    # batch6: split view extras.
    {"id": "split-link-click", "title": "Shift+click a link opens it in a split (Arc parity, PR#15241)",
     "detect": [("src/zen/split-view", r"(?i)shift.*click.*split|modifier.*click.*split")]},
    {"id": "split-close-other-panes", "title": "\"Close Other Panes\" in the command bar",
     "detect": [("src/zen/split-view", r"cmd_zen[\w]*CloseOther")]},
    {"id": "split-swap-panes", "title": "\"Swap Panes\" in the command bar",
     "detect": [("src/zen/split-view", r"cmd_zen[\w]*SwapPanes|swapPanes\(")]},
    {"id": "split-command-bar", "title": "Split Vertically/Horizontally/Grid in the command bar",
     "detect": [("src/zen/urlbar", r"zen-action-split-(vertically|horizontally|grid)")]},
    {"id": "command-bar-slash", "title": "Typing \"/\" in the URL bar enters Zen's commands mode",
     "detect": [("src/zen/urlbar", r'ZEN_ACTIONS[\s\S]{0,400}["\']/["\']|["\']/["\'][\s\S]{0,200}enableCommandsMode')]},
    {"id": "command-bar-create", "title": "Arc-style \"New ...\" actions (docs.new etc.) in the command bar",
     "detect": [("src/zen/urlbar", r"docs\.new|zen-action-new-doc")]},
    # batch9: spaces
    {"id": "space-manager-settings", "title": "Settings entry point for Zen's existing per-space manager (Library \"Spaces\")",
     "detect": [("src/browser/components/preferences", r"(?i)space\s*manager")]},
    {"id": "atc-settings", "title": "Settings entry point renaming Zen's space-routing rules to Arc's Air Traffic Control",
     "detect": [("src/zen", r"(?i)air traffic control")]},
    {"id": "archive-space", "title": "Hide a space (Arc's archive/shelve): drops out of the switcher without closing its tabs; restore from Settings",
     "detect": [("src/zen/spaces", r"(?i)archiveWorkspace|hideWorkspace|workspace\.hidden\b")]},
    {"id": "space-lock", "title": "Lock a space behind Touch ID/password (OSKeyStore) before switching to it",
     "detect": [("src/zen/spaces", r"(?i)OSKeyStore|lockWorkspace|workspace\.locked\b")]},
    # batch9p: Scratch and private tabs
    {"id": "scratch", "title": "Scratch (temporary private space, Cmd+Shift+N) and private tabs (Cmd+Option+T)",
     "detect": [("src/zen", r"(?i)zen[\w.-]*private[\w.-]*tab|mozprivatebrowsing|zen[\w.-]*scratch")]},
    # batch10: Library sidebar panels.
    {"id": "notes", "title": "Notes: a markdown scratchpad in the Library sidebar, optionally attached to a page",
     "detect": [("src/zen/library", r"(?i)whimsy-library-notes|WhimsyNotesSection")]},
    {"id": "finder-folders", "title": "Finder folders in the sidebar: pin a folder, browse it without leaving the browser",
     "detect": [("src/zen/library", r"(?i)whimsy-library-finder-folders|WhimsyFinderFoldersSection")]},
    {"id": "screenshot-sidebar", "title": "Screenshot to sidebar: captures also land as files in the Library, not just the clipboard",
     "detect": [("src/zen/library", r"(?i)whimsy-library-files|WhimsyFilesSection")]},
    # batch12: links & media windows
    {"id": "quick-window", "title": "Little Arc: a quick window (Cmd+Opt+N; links from other apps, per the setting above) with a \"Move to space\" button",
     "detect": [("src/zen", r"(?i)zen[\w.-]*quick[\w.-]*window|cmd_zenQuickWindow")]},
    {"id": "follower-tabs", "title": "Follower tabs: a 2-pane split where clicked links land in the other pane, the source pane never navigates (Vivaldi)",
     "detect": [("src/zen", r"(?i)follower-?tabs?|follower-?split")]},
    # batch13: page & reading (split favorites, bionic reading, print a clean page, menu bar extra)
    {"id": "split-favorites", "title": "Pin or favorite a split (reopen it with one click)",
     "detect": [("src/zen", r"(?i)favorite[\w.-]*split|split[\w.-]*favorite")]},
    {"id": "bionic-reading", "title": "Bionic (guided) reading in Reader View",
     "detect": [("src/zen", r"(?i)bionic[\w.-]*read")]},
    {"id": "print-clean", "title": "Print a clean page (Reader View, then print, leaving the tab alone)",
     "detect": [("src/zen", r"(?i)print[\w.-]*clean[\w.-]*page")]},
    {"id": "menu-bar-extra", "title": "Menu bar extra (macOS): quick window and recent tabs",
     "detect": [("src/zen", r"(?i)menu[\w.-]*bar[\w.-]*extra|systemstatusbar")]},
    # batch11: live folders (Jira + Push refresh + RSS autodiscovery).
    {"id": "live-folders-jira", "title": "Jira live folder: assigned, unresolved issues as a self-updating folder",
     "detect": [("src/zen/live-folders", r"(?i)jira")]},
    {"id": "live-folders-push", "title": "\"Push\" live-folder refresh option (1-minute conditional checks)",
     "detect": [("src/zen/live-folders", r"(?i)if-none-match|etag")]},
    {"id": "live-folders-rss-autodiscover", "title": "RSS: autodiscover a page's feed when the URL given isn't one",
     "detect": [("src/zen/live-folders", r"(?i)rel=.alternate.*(?:rss|atom)|autodiscover")]},

    # batch7: input, files, nav, dev, URL schemes, delight
    {"id": "seasonal-themes", "title": "Seasonal themes: a gentle accent tint and flourish for Halloween, winter holidays and spring",
     # Firefox's old Colorways never shipped in this engine; this never matches.
     "detect": [("prefs", r"name:\s*browser\.theme\.colorways\.enabled")]},
    {"id": "window-close", "title": "Cmd+W on a lone empty tab closes the window (Arc); Zen already keeps the window open otherwise",
     "detect": [("src/zen", r"(?i)zen-empty-tab[^\n]*cmd_close|cmd_close[^\n]*zen-empty-tab")]},
    {"id": "full-url-click", "title": "A single click on the address bar selects the whole untrimmed URL (Arc, Safari)",
     "detect": [("src/zen", r"(?i)always-full-url|full-?url-?click")]},
    {"id": "hardware-video-decoding", "title": "Settings checkbox for media.hardware-video-decoding.enabled, with a restart prompt",
     "detect": [("src/browser/components/preferences", r"media\.hardware-video-decoding\.enabled")]},
    {"id": "dock-badge", "title": "Dock icon badge (download count) and one bounce when a download finishes in the background",
     # Specifically the macOS Dock tile (not Zen's own unread-downloads
     # badge on the Library toolbar button, zen-library-badge).
     "detect": [("src/zen", r"(?i)dock[\w-]*badge|badge[\w-]*dock|macdocksupport[^\n]*badgeText")]},
    {"id": "quick-look", "title": "Quick Look (Space, or the context menu) on a finished download, via qlmanage",
     "detect": [("src/zen", r"(?i)qlmanage|QLPreviewPanel")]},
    {"id": "drag-downloads", "title": "A panel stays open while you drag a download out of it into a site",
     "detect": [("src/zen", r"(?i)noautohide[^\n]*drag|drag[^\n]*noautohide")]},
    {"id": "sidebar-nav", "title": "Cmd+Opt+Up/Down walks the sidebar's tabs; Focus Sidebar (Cmd+Opt+S) for arrow-key/Enter/Delete/Esc; Space opens a Glance",
     "detect": [("src/zen", r"(?i)focus-?sidebar|whimsy-tab-next")]},
    {"id": "cheatsheet", "title": "Shortcut cheat sheet (Cmd+/): a searchable, centred panel of Whimsy's own shortcuts, with a link to about:keyboard",
     "detect": [("src/zen", r"(?i)cheat-?sheet")]},
    {"id": "inbox-zero", "title": "Inbox-zero balloons: a small celebration when a mail tab's unread count hits 0",
     "detect": [("src/zen", r"(?i)inbox-?zero")]},
    {"id": "site-user-agent", "title": "Per-site user agent (\"Pretend to be...\"): Chrome, Safari (macOS/iPhone) or custom, per site",
     "detect": [("src/zen", r"(?i)pretend to be|site-?user-?agent|per-?site.*user.?agent")]},
    {"id": "cookie-editor", "title": "Cookie editor: list, edit, add, delete and copy-as-JSON a site's cookies",
     "detect": [("src/zen", r"(?i)cookie-?editor")]},
    {"id": "url-schemes", "title": "whimsy://<page> in the address bar jumps to the real page (Arc parity, address-bar half only)",
     "detect": [("src/zen", r"(?i)whimsy://|url-?schemes")]},
    {"id": "upload-clipboard", "title": "Opera's Easy Files: clicking an upload button offers the clipboard image, recent downloads, or the native picker",
     "detect": [("src/zen", r"(?i)mozSetFileArray|easy-?files|upload-?clipboard")]},
    {"id": "dev-mode", "title": "Developer mode tabs (Arc parity): localhost/port tabs get a striped outline and a top bar with Console/Network/Elements",
     "detect": [("src/zen", r"(?i)dev-?mode[\w-]*tab|whimsy-devmode")]},
    # linear: Linear live folder ("My Issues": assigned to you, open states).
    {"id": "live-folders-linear", "title": "Linear live folder: \"My Issues\" assigned to you, open states, with an API-key fallback when there's no signed-in session",
     "detect": [("src/zen/live-folders", r"(?i)linear")]},
    # batch hist: per-visit space metadata and Library filter.
    {"id": "space-history", "title": "Space-aware History: where was the tab, and filter by space",
     "detect": [("src/zen/library", r"(?i)history[^\n]*(?:workspaceId|spaceId)|(?:workspaceId|spaceId)[^\n]*history")]},
]


def path(rel):
    return os.path.join(ROOT, rel)


def read(rel):
    with open(path(rel), encoding="utf-8") as f:
        return f.read()


def write(rel, text):
    with open(path(rel), "w", encoding="utf-8") as f:
        f.write(text)


def is_whimsy_path(rel):
    parts = rel.split("/")
    return (rel.startswith(("whimsy/", "src/zen/whimsy/", "prefs/whimsy/", "configs/branding/"))
            or any(p.startswith("whimsy") for p in parts))


def upstream_files(under):
    out = []
    for base, dirs, files in os.walk(path(under)):
        dirs[:] = [d for d in dirs if d not in ("node_modules", "__pycache__")]
        for name in files:
            rel = os.path.relpath(os.path.join(base, name), ROOT)
            if not is_whimsy_path(rel):
                out.append(rel)
    return out


def detect_superseded():
    superseded = []
    for feature in FEATURES:
        for under, pattern in feature["detect"]:
            rx = re.compile(pattern)
            hit = None
            for rel in upstream_files(under):
                if not rel.endswith((".mjs", ".js", ".ftl", ".yaml", ".xhtml", ".css", ".patch", ".mm", ".idl")):
                    continue
                try:
                    text = read(rel)
                except (UnicodeDecodeError, OSError):
                    continue
                # Lines Whimsy itself put into Zen files don't count.
                text = "\n".join(l for l in text.splitlines() if "Whimsy" not in l)
                if rx.search(text):
                    hit = rel
                    break
            if hit:
                superseded.append({"id": feature["id"], "title": feature["title"], "found_in": hit})
                break
    return superseded


def apply_hooks(report, dry):
    for hook_id, rel, anchor, line, where in HOOKS:
        if not os.path.exists(path(rel)):
            report["problems"].append(f"hook {hook_id}: {rel} no longer exists")
            continue
        lines = read(rel).split("\n")
        wanted = line.replace("{indent}", "").strip()
        if any(l.strip() == wanted for l in lines):
            report["hooks"].append({"id": hook_id, "status": "present"})
            continue
        rx = re.compile(anchor)
        for i, l in enumerate(lines):
            m = rx.match(l)
            if m:
                indent = m.group(1) if m.groups() else ""
                text = line.replace("{indent}", indent)
                lines.insert(i + 1 if where == "after" else i, text)
                if not dry:
                    write(rel, "\n".join(lines))
                report["hooks"].append({"id": hook_id, "status": "applied" if not dry else "missing"})
                break
        else:
            report["problems"].append(f"hook {hook_id}: anchor not found in {rel}")


def apply_hotfixes(report, dry):
    for fix in HOTFIXES:
        text = read(fix["file"]) if os.path.exists(path(fix["file"])) else ""
        if fix["new"] in text:
            report["hotfixes"].append({"id": fix["id"], "status": "present"})
        elif fix["old"] in text:
            if not dry:
                write(fix["file"], text.replace(fix["old"], fix["new"], 1))
            report["hotfixes"].append({"id": fix["id"], "status": "applied" if not dry else "missing"})
        else:
            # Zen changed this code, so presumably fixed it its own way.
            report["hotfixes"].append({"id": fix["id"], "status": "obsolete (Zen changed the code)"})


def apply_json_overrides(report, dry):
    rel = "surfer.json"
    c = json.loads(read(rel))
    before = json.dumps(c, sort_keys=True)
    c["name"], c["vendor"], c["appId"] = "Whimsy", "Whimsy", "whimsy"
    c.pop("updateHostname", None)
    names = {"release": ("Whimsy", "Whimsy", "Whimsy"),
             "twilight": ("Whimsy", "Whimsy Twilight", "Whimsy Twilight")}
    for brand, (shorter, short, full) in names.items():
        b = c.get("brands", {}).get(brand)
        if b:
            b["brandShorterName"], b["brandShortName"], b["brandFullName"] = shorter, short, full
            b.get("release", {}).pop("github", None)
    if json.dumps(c, sort_keys=True) != before:
        if not dry:
            write(rel, json.dumps(c, indent=2) + "\n")
        report["overrides"].append({"file": rel, "status": "applied" if not dry else "missing"})

    rel = "package.json"
    c = json.loads(read(rel))
    s = c["scripts"]
    before = json.dumps(s)
    wanted = {
        "import:strings": "python3 scripts/copy_language_pack.py en-US",
        "postbuild": "sh whimsy/install_app.sh",
        "postbuild:ui": "sh whimsy/install_app.sh",
        "install:app": "sh whimsy/install_app.sh",
        "ship": "python3 whimsy/updater/updater.py ship",
        # Pin the brand like "ci" does (`surfer build` has no --brand), so a
        # fresh clone can't build Nightly.app from surfer's default brand.
        "build": "surfer set brand release && surfer build",
        "build:ui": "surfer set brand release && surfer build --ui",
    }
    if "import:strings" not in s.get("import", ""):
        s["import"] = s["import"] + " && npm run import:strings"
    if "whimsy/engine_prepare.py" not in s["import"]:
        s["import"] = s["import"].replace("surfer import", "python3 whimsy/engine_prepare.py && surfer import", 1)
    if "whimsy/engine_overrides.py" not in s["import"]:
        s["import"] = s["import"] + " && python3 whimsy/engine_overrides.py"
    items = list(s.items())
    for key, value in wanted.items():
        if s.get(key) != value:
            s[key] = value
            items = list(s.items())
    if json.dumps(s) != before:
        c["scripts"] = dict(items)
        if not dry:
            write(rel, json.dumps(c, indent=2) + "\n")
        report["overrides"].append({"file": rel, "status": "applied" if not dry else "missing"})


def apply_update_host(report, dry):
    """Zen's build patch hard-codes Zen's update server. Point it at Whimsy's,
    so Whimsy never offers Zen's own updates."""
    rel = "src/build/moz-build.patch"
    host = json.loads(read("whimsy/publish.json"))["update_host"]
    text = read(rel)
    new = re.sub(r'(\+\s*appini_defines\["MOZ_APPUPDATE_HOST"\] = ")[^"]+(")', r"\g<1>" + host + r"\g<2>", text)
    if host not in new:
        report["problems"].append("update host: Zen's build patch no longer sets MOZ_APPUPDATE_HOST")
        return
    if new != text:
        if not dry:
            write(rel, new)
        report["overrides"].append({"file": rel, "status": "applied" if not dry else "missing"})


def apply_mozconfig(report, dry):
    rel = "configs/common/mozconfig"
    text = read(rel)
    new = re.sub(r"--with-app-basename=\S+", "--with-app-basename=Whimsy", text)
    new = re.sub(r"^export MOZ_APP_BASENAME=\S+", "export MOZ_APP_BASENAME=Whimsy", new, flags=re.M)
    sccache = ('\n# Whimsy: cache compiles so weekly Firefox updates rebuild faster.\n'
               'if test -z "$SCCACHE_GHA_ENABLED" -a -x "$HOME/.mozbuild/sccache/sccache"; then\n'
               '  ac_add_options --with-ccache="$HOME/.mozbuild/sccache/sccache"\n'
               'fi\n')
    if "Whimsy: cache compiles" not in new:
        new = new.rstrip("\n") + "\n" + sccache
    if new != text:
        if not dry:
            write(rel, new)
        report["overrides"].append({"file": rel, "status": "applied" if not dry else "missing"})


def apply_pref_overrides(report, dry, superseded_ids):
    """Change Zen-declared pref defaults in place, so each pref is declared once."""
    for name, value in PREF_OVERRIDES.items():
        if name == "zen.ctrlTab.show-pending-tabs" and "ctrl-tab" in superseded_ids:
            continue
        if name == "zen.folders.owned-tabs-in-folder" and "new-tab-position" in superseded_ids:
            continue
        found = False
        for rel in upstream_files("prefs"):
            if not rel.endswith(".yaml"):
                continue
            text = read(rel)
            rx = re.compile(r"(- name: " + re.escape(name) + r"\n\s*value: )([^\n#]*)(.*)")
            m = rx.search(text)
            if not m:
                continue
            found = True
            want = json.dumps(value) if not isinstance(value, bool) else ("true" if value else "false")
            if m.group(2).strip() != want:
                if not dry:
                    write(rel, text[:m.start()] + m.group(1) + want + " # Whimsy override" + text[m.end():])
                report["overrides"].append({"pref": name, "status": "applied" if not dry else "missing"})
        if not found:
            report["problems"].append(f"pref override {name}: Zen no longer declares it")


def write_generated(report, dry, superseded):
    # Fallback strings Zen doesn't define (any more).
    defined = set()
    for rel in upstream_files("locales/en-US"):
        if rel.endswith(".ftl"):
            defined.update(re.findall(r"^([a-zA-Z][\w-]*)\s*=", read(rel), re.M))
    fallbacks = [text for key, text in FALLBACK_STRINGS.items() if key not in defined]
    content = ("# Generated by whimsy/overlay.py: strings Zen uses but doesn't define.\n\n"
               + "\n".join(fallbacks) + ("\n" if fallbacks else ""))
    gen = {FALLBACK_FILE: content}

    # Feature switches: off for features Zen now ships itself. Prefs that only
    # exist for a feature are declared here too, so a superseded feature
    # leaves Zen's own defaults alone.
    gone = {s["id"]: s for s in superseded}
    prefs = "# Generated by whimsy/overlay.py. Don't edit.\n"
    for feature in FEATURES:
        s = gone.get(feature["id"])
        note = f"  # Zen ships this itself: {s['found_in']}" if s else ""
        # batch8: a FEATURES entry can opt into shipping off by default
        # ("default": False, e.g. tree-tabs) without that meaning "superseded
        # by Zen" (which also writes false, but with a different note).
        on = not s and feature.get("default", True)
        prefs += f"\n- name: whimsy.feature.{feature['id']}\n  value: {'true' if on else 'false'}{note}\n"
    if "ctrl-tab" not in gone:
        prefs += "\n# Arc-style Ctrl+Tab: recently used order.\n- name: browser.ctrlTab.sortByRecentlyUsed\n  value: true\n"
    if "new-tab-position" not in gone:
        prefs += ("\n# New tabs (Cmd+T) open right below the current tab, not at the end of\n"
                  "# the list. Settings → Tab Management → Tabs.\n"
                  "- name: browser.tabs.insertAfterCurrent\n  value: true\n")
    if "strip-tracking" not in gone:
        prefs += ("\n# Strip tracking parameters (utm_*, fbclid...) from links you open, in\n"
                  "# normal and private windows. Copy Clean Link's list already applies to\n"
                  "# copies (privacy.query_stripping.strip_on_share.enabled).\n"
                  "- name: privacy.query_stripping.enabled\n  value: true\n"
                  "\n- name: privacy.query_stripping.enabled.pbmode\n  value: true\n")
    gen["prefs/whimsy/features.yaml"] = prefs

    for rel, text in gen.items():
        current = read(rel) if os.path.exists(path(rel)) else None
        if current != text:
            if not dry:
                os.makedirs(os.path.dirname(path(rel)), exist_ok=True)
                write(rel, text)
            report["generated"].append({"file": rel, "status": "written" if not dry else "stale"})


def run(dry):
    report = {"hooks": [], "hotfixes": [], "overrides": [], "generated": [], "problems": []}
    superseded = detect_superseded()
    report["superseded"] = superseded
    ids = {s["id"] for s in superseded}
    apply_hooks(report, dry)
    apply_hotfixes(report, dry)
    apply_json_overrides(report, dry)
    apply_mozconfig(report, dry)
    apply_update_host(report, dry)
    apply_pref_overrides(report, dry, ids)
    write_generated(report, dry, superseded)
    return report


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "check"
    report = run(dry=(mode != "apply"))
    pending = [x for k in ("hooks", "hotfixes", "overrides", "generated") for x in report[k]
               if x["status"] in ("missing", "stale")]
    for s in report["superseded"]:
        print(f"superseded: {s['title']} (Zen has it: {s['found_in']})")
    for p in report["problems"]:
        print("PROBLEM:", p)
    for p in pending:
        print("NOT APPLIED:", p)
    print(f"overlay {mode}: {len(report['problems'])} problems, {len(pending)} not applied")
    sys.exit(1 if report["problems"] or (mode == "check" and pending) else 0)


if __name__ == "__main__":
    main()
