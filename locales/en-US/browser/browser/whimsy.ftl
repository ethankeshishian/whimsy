# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# Whimsy's own strings, linked into the browser window and Settings.

## After an update (sidebar notification; see ZenSidebarNotification.mjs)

whimsy-updated-heading = { -brand-short-name } updated
whimsy-rolled-back-heading = Rolled back to the previous version
whimsy-updated-notes-label = What's new
whimsy-updated-notes-tooltip =
    .title = See what changed
whimsy-updated-rollback-label = Something broke? Roll back
whimsy-updated-rollback-tooltip =
    .title = Open update settings
whimsy-updated-settings-label = Update settings
whimsy-updated-settings-tooltip =
    .title = Open update settings

## Settings → Look and Feel → Updates

whimsy-updates-header = Updates
whimsy-updates-channel = Channel
whimsy-updates-channel-release =
    .label = Release
whimsy-updates-channel-dev =
    .label = Dev
whimsy-updates-channel-release-note = Tested builds, published each night.
whimsy-updates-channel-dev-note = Every change as soon as it's built. Expect rough edges.
whimsy-updates-show-log =
    .label = Show log
whimsy-updates-hide-log =
    .label = Hide log
whimsy-updates-rollback =
    .label = Roll back to { $version }
whimsy-updates-rollback-none =
    .label = Roll back
whimsy-updates-rollback-confirm-title = Roll back?
whimsy-updates-rollback-confirm = { -brand-short-name } will close, switch back to { $version }, and reopen with your tabs. Automatic updates skip the version you're leaving.
whimsy-updates-log-empty = Nothing logged yet.
whimsy-updates-staged = { $version } is ready. It installs the next time you quit { -brand-short-name }.

# Versions are Zen's version plus a Whimsy revision, like 1.24b-w3. Shown
# under the version on Firefox's version line.
whimsy-updates-based-on = Based on Zen { $zen } · Firefox { $firefox }
whimsy-updates-based-on-label = Based on Zen { $zen } ({ $label }) · Firefox { $firefox }

## Settings → Look and Feel → App icon

whimsy-app-icon-header = App icon
whimsy-app-icon-description = Choose how { -brand-short-name } looks in the Dock and app switcher.
whimsy-app-icon-daydream = Daydream
whimsy-app-icon-day-and-night = Day & Night
whimsy-app-icon-cotton-candy = Cotton Candy
whimsy-app-icon-golden-hour = Golden Hour
whimsy-app-icon-lagoon = Lagoon
whimsy-app-icon-berry-jam = Berry Jam
whimsy-app-icon-lemonade = Lemonade
whimsy-app-icon-stargazer = Stargazer
whimsy-app-icon-spearmint = Spearmint
whimsy-app-icon-sugar-rush = Sugar Rush
whimsy-app-icon-party-popper = Party Popper

## GitHub live folder options (pull requests), following Zen's PR #16183.

whimsy-live-folder-github-option-my-review-requests =
    .label = My Review Requests
whimsy-live-folder-github-option-team-review-requests =
    .label = Team Review Requests

## batch11: Jira live folder (assigned, unresolved issues).

whimsy-live-folder-jira-create =
    .label = Jira Issues
whimsy-live-folder-jira-option-site =
    .label = Jira Site
whimsy-live-folder-jira-option-jql =
    .label = JQL Query
whimsy-live-folder-jira-prompt-site = Enter your Jira site (for example your-team.atlassian.net)
whimsy-live-folder-jira-prompt-jql = Enter a JQL query
whimsy-live-folder-jira-no-site =
    .label = Jira site not set
    .tooltiptext = Add your Jira site in the folder's options.
whimsy-live-folder-jira-no-auth =
    .label = Not signed in to Jira
    .tooltiptext = Sign back in to Jira.

## batch11: "Push" live-folder refresh option.

whimsy-live-folder-push-interval =
    .label = Push

## linear: Linear live folder ("My Issues": assigned to you, open states).

whimsy-live-folder-linear-create =
    .label = Linear Issues
whimsy-live-folder-linear-option-team =
    .label = Team
whimsy-live-folder-linear-prompt-team = Enter a team key to filter to (for example ENG), or leave blank for all your assigned issues
whimsy-live-folder-linear-no-auth =
    .label = Not signed in to Linear
    .tooltiptext = Add a personal API key, or sign in to linear.app in this container.
whimsy-live-folder-linear-apikey-title = Linear API Key
whimsy-live-folder-linear-apikey-text = Paste a personal API key from linear.app → Settings → Security & access → Personal API keys.

## Settings → Look and Feel → Interface zoom

whimsy-ui-zoom-header = Interface zoom
whimsy-ui-zoom-description = Make the toolbars, sidebar, menus and panels bigger or smaller. Web pages keep their own zoom.
whimsy-ui-zoom-label = Zoom

## Copy & share (WhimsyCopy.sys.mjs): Cmd+Shift+C, Cmd+Opt+Shift+C, tab menu

whimsy-copy-toast =
    { $count ->
        [one] Copied link
       *[other] Copied { $count } links
    }
whimsy-copy-markdown-toast =
    { $count ->
        [one] Copied link as Markdown
       *[other] Copied { $count } links as Markdown
    }
tab-context-whimsy-copy-links =
    .label =
        { $count ->
            [one] Copy Link
           *[other] Copy Links
        }
    .accesskey = k

## Settings → Privacy & Security → Cookie banners

whimsy-cookie-banners-header =
    .label = Cookie banners
whimsy-cookie-banners-toggle =
    .label = Reject cookie banners
    .description = Answers cookie pop-ups for you by choosing “Reject” or the most private option, and hides the banner while it does.

## Settings → Privacy & Security → AI

whimsy-ai-header =
    .label = AI features
whimsy-ai-toggle =
    .label = Turn off all AI features
    .description = Blocks the AI chatbot, link preview summaries, smart tab groups, PDF alt text, speech recognition and any AI that Whimsy adds, and removes their downloaded models. Translations keep working.

## Settings → Privacy & Security → Tracking in links

whimsy-strip-tracking-header =
    .label = Tracking in links
whimsy-strip-tracking-toggle =
    .label = Remove tracking parameters from links
    .description = Strips trackers like utm_source and fbclid from the links you open and copy, so sites can’t follow you from page to page.

## Settings → Tab Management → Tabs

whimsy-tabs-header = Tabs
whimsy-tabs-new-tab-below =
    .label = Open new tabs below the current tab
whimsy-tabs-new-tab-in-folder =
    .label = Keep tabs opened from a folder in that folder
whimsy-tabs-dim-sleeping =
    .label = Dim sleeping tabs (ones that aren’t loaded)
whimsy-tabs-newtab-bottom =
    .label = Keep the new tab button fixed at the bottom of the sidebar
whimsy-tabs-loading-indicator =
    .label = Show a loading indicator above the page while it loads
whimsy-tabs-loading-line =
    .label = As a progress line across the top, like Safari
whimsy-tabs-badges =
    .label = Show unread counts and update dots on pinned tabs and Essentials
whimsy-media-background-mute = Sound in background tabs
whimsy-media-background-mute-prioritize =
    .label = Mute while the current tab plays sound
whimsy-media-background-mute-background =
    .label = Always mute (only the current tab plays)
whimsy-media-background-mute-off =
    .label = Let every tab play
whimsy-media-pip-snap-back =
    .label = Put a picture-in-picture video back in the page when you return to its tab
whimsy-external-links-header = Links from other apps open in
whimsy-external-links-glance =
    .label = Glance
whimsy-external-links-tab =
    .label = A tab
whimsy-external-links-quick-window =
    .label = Mini Whimsy
whimsy-archive-prompt =
    .label = When a page is gone, offer the Internet Archive’s copy
whimsy-tabs-title-lines = Tab titles show up to
whimsy-tabs-title-lines-1 =
    .label = 1 line
whimsy-tabs-title-lines-2 =
    .label = 2 lines
whimsy-tabs-title-lines-3 =
    .label = 3 lines

## Folder colors (folder context menu)

whimsy-folder-color =
    .label = Color
whimsy-folder-color-default =
    .label = Default
whimsy-folder-color-gray =
    .label = Gray
whimsy-folder-color-red =
    .label = Red
whimsy-folder-color-orange =
    .label = Orange
whimsy-folder-color-yellow =
    .label = Yellow
whimsy-folder-color-green =
    .label = Green
whimsy-folder-color-teal =
    .label = Teal
whimsy-folder-color-blue =
    .label = Blue
whimsy-folder-color-purple =
    .label = Purple
whimsy-folder-color-pink =
    .label = Pink

## Group by domain (tab context menu)

# $count (number) - how many tabs, $site (string) - the site, e.g. github.com
tab-context-whimsy-group-domain =
    .label = Group { $count } Tabs from { $site }
    .accesskey = G
# $count (number) - how many tabs, $site (string) - the site
whimsy-group-domain-toast = Grouped { $count } tabs from { $site } into a folder

## Remember muted sites (tab context menu)

# $site (string) - the site, e.g. example.com
tab-context-whimsy-mute-site =
    .label = Mute Site
    .accesskey = i
# $site (string) - the site, e.g. example.com
tab-context-whimsy-unmute-site =
    .label = Unmute Site
    .accesskey = i
# $site (string) - the site, e.g. example.com
whimsy-mute-site-toast = { $site } will always open muted
# $site (string) - the site, e.g. example.com
whimsy-unmute-site-toast = { $site } can play sound again

## Per-tab volume (tab context menu, and right-click on a tab's speaker)

tab-context-whimsy-volume =
    .label = Volume…
    .accesskey = V
whimsy-volume-panel =
    .aria-label = Tab volume
whimsy-volume-slider =
    .aria-label = Volume
whimsy-volume-mute =
    .tooltiptext = Mute or unmute the tab

## Playback speed (shortcuts and command bar)

whimsy-action-speed-up = Speed Up Video
whimsy-action-slow-down = Slow Down Video
whimsy-action-speed-reset = Normal Video Speed
# $rate (number) - the playback rate, e.g. 1.25
whimsy-speed-toast = Playback speed { NUMBER($rate, maximumFractionDigits: 2) }×
whimsy-speed-none-toast = No video or audio on this page

## Capture (shortcuts and command bar)

whimsy-action-copy-full-page = Copy Full-Page Screenshot
whimsy-capture-copied-toast = Copied a screenshot of the whole page
whimsy-capture-failed-toast = This page can’t be captured

## Edit text on page (page context menu, command bar, address bar pill)

whimsy-action-edit-page = Edit Text on Page
whimsy-context-edit-page =
    .label = Edit Text on Page
    .accesskey = x
whimsy-edit-page-toast = Click any text to edit it. Press Esc to finish.
whimsy-editing-pill =
    .value = Editing · Esc to finish
    .tooltiptext = Stop editing this page

## Allow copy and paste (command bar)

whimsy-action-allow-copy = Allow Copy and Paste on This Site
whimsy-action-disallow-copy = Stop Allowing Copy and Paste on This Site
# $site (string) - the site, e.g. example.com
whimsy-allow-copy-toast = Copy, paste and right-click now work on { $site }
# $site (string) - the site, e.g. example.com
whimsy-disallow-copy-toast = { $site } can block copy and paste again

## Internet Archive (notification bar and command bar)

whimsy-action-open-archive = Open in Internet Archive
whimsy-archive-bar = This page is gone, but the Internet Archive has a copy.
# $date (string) - when the copy was saved, e.g. "Jun 2024"
whimsy-archive-bar-dated = This page is gone, but the Internet Archive has a copy from { $date }.
whimsy-archive-open =
    .label = Open the Archived Copy
    .accesskey = O

## Translate selection (shortcut and command bar)

whimsy-action-translate-selection = Translate Selection

## Glance

whimsy-action-split-glance = Split Glance
whimsy-translate-none-toast = Select some text to translate

## Split view (command bar; batch6)

whimsy-action-close-other-panes = Close Other Panes
whimsy-action-swap-panes = Swap Panes
whimsy-action-split-vertically = Split Vertically
whimsy-action-split-horizontally = Split Horizontally
whimsy-action-split-grid = Split Grid
whimsy-split-shift-click =
    .label = Shift+click a link to open it in a split (replaces "Open in New Window")

## Command bar extras (batch6)

whimsy-action-new-doc = New Google Doc
whimsy-action-new-sheet = New Google Sheet
whimsy-action-new-slides = New Google Slides
whimsy-action-new-form = New Google Form
whimsy-action-new-meet = New Google Meet
whimsy-action-new-event = New Google Calendar Event
whimsy-action-new-notion = New Notion Page
whimsy-action-new-linear = New Linear Issue
whimsy-action-new-figma = New Figma File
whimsy-action-new-figjam = New FigJam File
whimsy-action-new-repo = New GitHub Repo
whimsy-action-new-gist = New GitHub Gist
whimsy-action-new-word = New Word Document
whimsy-action-new-excel = New Excel Workbook
whimsy-action-new-powerpoint = New PowerPoint Presentation
whimsy-action-new-miro = New Miro Board
whimsy-action-new-loom = New Loom Video
whimsy-action-new-canva = New Canva Design
whimsy-action-new-playlist = New Spotify Playlist
whimsy-action-new-note = New Note
whimsy-new-note-target = New Note opens
whimsy-new-note-target-none =
    .label = Nothing (hide New Note)
whimsy-new-note-target-notion =
    .label = Notion
whimsy-new-note-target-google-docs =
    .label = Google Docs
whimsy-new-note-target-word =
    .label = Word

## Reading time (address bar, next to the Reader View button)

# $minutes (number) - estimated minutes to read the article
whimsy-reading-time =
    .value = { $minutes } min
    .tooltiptext = About { $minutes } minutes to read

## Spaces

# $count (number) - how many tabs moved, $space (string) - the space's name
whimsy-space-drop-toast =
    { $count ->
        [one] Moved to { $space }
       *[other] Moved { $count } tabs to { $space }
    }

# Shown in the space icon picker when no emoji matches.
# $query (string) - what was typed
whimsy-emoji-search-empty =
    .value = No emoji for “{ $query }”

## Settings → Tab Management (spaces)

whimsy-spaces-hide-switcher =
    .label = Hide the space switcher (swipe to change spaces; it shows while you drag a tab)

## Open Link in Space (link context menu)

whimsy-open-link-in-space =
    .label = Open Link in Space
    .accesskey = S

## Theme picker: hex colors

whimsy-hex-input =
    .placeholder = #5B8CFF
    .title = Type or paste a hex color, then press Return
    .aria-label = Hex color

## Settings → Look and Feel → Look

whimsy-look-header = Look
whimsy-look-transparency = Transparency
# $value (number) - percent; 0 means opaque
whimsy-look-transparency-value =
    { $value ->
        [0] Off
       *[other] { $value }%
    }
whimsy-look-menu-icons =
    .label = Show icons in menus
whimsy-look-reading-time =
    .label = Show how long an article takes to read, next to the Reader View button
whimsy-look-dark-pdf =
    .label = Dark pages in PDFs (light text on dark; images keep their colors)
whimsy-look-peek-essential-links =
    .label = Peek: open other-site links from pinned tabs in Glance
whimsy-look-ui-font = Interface font
whimsy-look-ui-font-system =
    .label = System font

## batch8: tab lifecycle — Settings → Tab Management

whimsy-tabs-auto-archive =
    .label = Auto-archive idle tabs
whimsy-tabs-archive-idle-after = After
whimsy-tabs-archive-idle-after-12h =
    .label = 12 hours
whimsy-tabs-archive-idle-after-24h =
    .label = 24 hours
whimsy-tabs-archive-idle-after-7d =
    .label = 7 days
whimsy-tabs-archive-idle-after-30d =
    .label = 30 days
whimsy-tabs-archive-idle-after-never =
    .label = Never
whimsy-tabs-archive-view =
    .label = Archive view (command bar: “Show Archive”)
whimsy-tabs-undo =
    .label = Undo for tab actions (Cmd+Z)
whimsy-tabs-snooze =
    .label = Snooze a tab (tab menu → Snooze…)
whimsy-tabs-fire-button =
    .label = Fire button (command bar: “Fire Button”)
whimsy-tabs-heavy-tabs =
    .label = Find heavy tabs (command bar: “Find Heavy Tabs”)
whimsy-tabs-tree-tabs =
    .label = Tree-style tabs: nest a tab under whichever tab opened it
whimsy-tabs-tree-style-tree =
    .label = Tree (indented, collapsible branches)
whimsy-tabs-tree-style-islands =
    .label = Islands (one level, colored pill)

## batch8: tab lifecycle — command bar

whimsy-action-show-archive = Show Archive
whimsy-action-fire-button = Fire Button
whimsy-action-heavy-tabs = Find Heavy Tabs

## batch8: tab lifecycle — Archive view panel

whimsy-archive-panel =
    .aria-label = Archive
whimsy-archive-search =
    .placeholder = Search the archive
    .aria-label = Search the archive
whimsy-archive-empty =
    .value = Nothing archived yet
whimsy-archive-restore =
    .tooltiptext = Restore, back where it was

## batch8: tab lifecycle — Snooze a tab

tab-context-whimsy-snooze =
    .label = Snooze…
    .accesskey = z
whimsy-snooze-panel =
    .aria-label = Snooze tab
whimsy-snooze-later-today = Later today
whimsy-snooze-tomorrow = Tomorrow morning
whimsy-snooze-next-week = Next week
# $title (string) - the snoozed tab's title
whimsy-snooze-toast = Snoozed “{ $title }”
# $title (string) - the tab's title
whimsy-snooze-wake-toast = “{ $title }” is back

## batch8: tab lifecycle — Fire button

whimsy-fire-panel =
    .aria-label = Fire button
whimsy-fire-site = This Site
whimsy-fire-last-15-min = Last 15 Minutes
whimsy-fire-space = This Space
whimsy-fire-everything = Everything

## batch8: tab lifecycle — Find heavy tabs

whimsy-heavy-tabs-panel =
    .aria-label = Heavy tabs
whimsy-heavy-tabs-close-tab =
    .tooltiptext = Close this tab
## Settings → Tab Management → Spaces — batch9: spaces

whimsy-spaces-header = Spaces

whimsy-spaces-manager-label = Space manager
whimsy-spaces-manager-description = Reorder, rename, recolor or delete any space from one list (Library → Spaces).
whimsy-spaces-manager-button =
    .label = Open Space Manager…

whimsy-atc-label = Air Traffic Control
whimsy-atc-description = Send links to a space automatically when they match a rule, like Arc.
whimsy-atc-button =
    .label = Manage rules…

whimsy-hidden-spaces-header = Hidden spaces
whimsy-hidden-spaces-empty = No spaces are hidden. Hide one from its context menu in the space switcher.
whimsy-restore-space-button =
    .label = Restore

## Archive (hide) a space — batch9: spaces

whimsy-hide-space =
    .label = Hide This Space
# $space (string) - the space's name
whimsy-hide-space-toast = Hid “{ $space }” — restore it from Settings → Tab Management
whimsy-hide-space-last-toast = Can’t hide your only space
# $space (string) - the space's name
whimsy-restore-space-toast = Restored “{ $space }”

## Lock a space — batch9: spaces

whimsy-lock-space =
    .label = Lock This Space
whimsy-unlock-space =
    .label = Unlock This Space
# $space (string) - the space's name
whimsy-lock-space-toast = Locked “{ $space }” — switching there will ask for Touch ID or your password
# $space (string) - the space's name
whimsy-unlock-space-toast = Unlocked “{ $space }”
## batch9p: Scratch (a temporary private space) and private tabs

whimsy-scratch-name = Scratch
# What Scratch is called once kept as a normal space.
whimsy-scratch-kept-name = Space
whimsy-menu-new-scratch =
    .label = New Scratch Space
whimsy-menu-new-private-tab =
    .label = New Private Tab
whimsy-scratch-keep =
    .label = Keep as Space
whimsy-scratch-close =
    .label = Close Scratch
whimsy-action-new-private-tab = New Private Tab
whimsy-action-new-scratch = New Scratch Space
whimsy-action-keep-scratch = Keep Scratch as a Space
whimsy-action-close-scratch = Close Scratch
whimsy-private-tab-no-pin = Private tabs can’t be pinned
whimsy-scratch-kept-toast =
    { $count ->
        [0] Scratch is now a space
       *[other] Scratch is now a space. Its pages reopened outside private browsing.
    }
whimsy-private-header =
    .label = Private browsing
whimsy-private-in-window =
    .label = Browse privately inside this window
    .description = { -brand-short-name } opens Scratch, a temporary private space, with ⌘⇧N, and a private tab in the current space with ⌥⌘T. Private tabs keep no history and forget their cookies when the last one closes. Turn this off to use private windows instead.
## batch10: Library sidebar panels

whimsy-library-notes-enable =
    .label = Notes: a markdown scratchpad in the sidebar
whimsy-library-finder-folders-enable =
    .label = Finder folders in the sidebar
whimsy-library-screenshot-sidebar-enable =
    .label = Screenshot to sidebar

whimsy-library-notes-title = Notes
whimsy-library-notes-empty = No notes yet
whimsy-library-notes-search-placeholder =
    .placeholder = Search notes…
whimsy-library-notes-add =
    .label = New note
whimsy-library-notes-delete =
    .label = Delete note
whimsy-library-notes-title-placeholder =
    .placeholder = Title
whimsy-library-notes-attach = Attach to this page

whimsy-library-finder-folders-title = Files
whimsy-library-finder-folders-empty = No folders pinned yet
whimsy-library-finder-folders-search-placeholder =
    .placeholder = Search files…
whimsy-library-finder-folders-add =
    .label = Add folder
whimsy-library-finder-folders-remove =
    .label = Remove folder
whimsy-library-finder-folders-picker-title = Choose a folder to pin

whimsy-library-files-title = Captures
whimsy-library-files-empty = No screenshots captured yet
whimsy-library-files-search-placeholder =
    .placeholder = Search captures…
whimsy-library-files-delete =
    .label = Delete
## batch12: links & media windows (Mini Whimsy, Arc's "Little Arc")

whimsy-action-quick-window = New Mini Whimsy
whimsy-quick-window-move-to-space =
    .label = Open in { $space }
    .tooltiptext = Open in { $space } (Cmd+O)
whimsy-quick-window-choose-space =
    .tooltiptext = Choose a different space (Cmd+Shift+O)

## Follower tabs (tab context menu, on a tab already in a 2-pane split)

tab-context-whimsy-follow =
    .label = Make This a Follower Split
    .accesskey = F
tab-context-whimsy-unfollow =
    .label = Stop Following
    .accesskey = F
## batch13: page & reading

## Print a clean page (command bar)

whimsy-action-print-clean = Print a Clean Page

## Pin or favorite a split (command bar)

whimsy-action-favorite-split = Favorite This Split
whimsy-action-open-split-favorites = Open a Favorite Split…
whimsy-split-favorite-name-title = Favorite This Split
whimsy-split-favorite-name-prompt = Name this split, so it's easy to find later:
whimsy-split-favorite-saved-toast = Split saved to your favorites
whimsy-split-favorites-empty =
    .value = No favorite splits yet. Favorite one from the command bar.
whimsy-split-favorite-remove =
    .label = Remove
    .tooltiptext = Remove this favorite

## Bionic reading (Reader View toolbar button)

whimsy-bionic-reading-toggle =
    .title = Bionic reading: bolds the start of each word

## Menu bar extra (macOS status bar icon)

whimsy-menu-bar-extra-quick-window = New Mini Whimsy
whimsy-menu-bar-extra-no-recent-tabs =
    .label = No Recently Closed Tabs

## Settings → Look and Feel → Look: menu bar extra

whimsy-look-menu-bar-extra =
    .label = Show a menu bar icon for Mini Whimsy and recent tabs
## batch7: Settings → Look and Feel → Look

whimsy-look-seasonal-themes =
    .label = Seasonal themes (a small accent and flourish for Halloween, winter and spring)

## batch7: Settings → Tab Management

whimsy-tabs-close-window-with-last-tab =
    .label = Close the window when the last tab closes

whimsy-look-always-full-url =
    .label = Always show the full address, not just the domain

## batch7: Settings → General → Performance

whimsy-performance-header = Performance
whimsy-performance-hw-decode =
    .label = Hardware video decoding
whimsy-performance-restart-note = Restart Whimsy to apply this change.
whimsy-performance-restart-button =
    .label = Restart Whimsy

## batch7: Settings → Tab Management (downloads)

whimsy-downloads-dock-badge =
    .label = Show a badge with the number of downloads in progress on the Dock icon
whimsy-downloads-quicklook =
    .label = Quick Look finished downloads (Space, or from the context menu)

## batch7: Quick Look

whimsy-quicklook-menuitem =
    .label = Quick Look
whimsy-quicklook-missing-toast = Item removed

## batch7: shortcut cheat sheet (Cmd+/)

whimsy-action-cheatsheet = Keyboard Shortcuts
whimsy-cheatsheet-search =
    .placeholder = Search shortcuts
whimsy-cheatsheet-edit = Edit all shortcuts…
whimsy-cheatsheet-duplicate-tab = Duplicate Tab
whimsy-cheatsheet-pin-tab = Pin/Unpin Tab
whimsy-cheatsheet-tab-next = Next Tab in Sidebar
whimsy-cheatsheet-tab-prev = Previous Tab in Sidebar
whimsy-cheatsheet-focus-sidebar = Focus Sidebar
whimsy-cheatsheet-self = Shortcut Cheat Sheet

## batch7: inbox-zero balloons

whimsy-inbox-zero-toast = Inbox zero

## batch7: per-site user agent ("Pretend to be...")

whimsy-action-useragent = Pretend to be…
whimsy-useragent-default =
    .label = Default (Whimsy)
whimsy-useragent-chrome =
    .label = Chrome (macOS)
whimsy-useragent-safari-mac =
    .label = Safari (macOS)
whimsy-useragent-safari-iphone =
    .label = Safari (iPhone)

## batch7: cookie editor

whimsy-action-cookie-editor = Cookies
whimsy-cookie-editor-add =
    .label = Add
whimsy-cookie-editor-copy-all =
    .label = Copy All as JSON
whimsy-cookie-editor-delete =
    .label = Delete
whimsy-cookie-editor-copied-toast = Cookies copied

## batch7: upload from the clipboard

whimsy-upload-clipboard =
    .label = Clipboard image
whimsy-upload-choose-file =
    .label = Choose file…

## batch7: developer mode tabs

whimsy-action-devmode-toggle = Turn on/off Developer Mode for this site
whimsy-devmode-elements =
    .label = Elements
whimsy-devmode-console =
    .label = Console
whimsy-devmode-network =
    .label = Network

## batch7b: offline game (whimsy://game)

whimsy-action-game = Play Balloon Drift
whimsy-game-title = Balloon Drift
whimsy-game-style-retro = Retro
whimsy-game-style-gradient = Gradient
whimsy-game-score = Score
whimsy-game-best = Best
whimsy-game-paused = Paused
whimsy-game-game-over = Game over
whimsy-game-hint = Space, Up, or click to flap. Arrows steer. P pauses.
whimsy-game-play-again = Play again

## batch7b: Year in tabs (whimsy://year)

whimsy-action-year = Year in Tabs
whimsy-year-ready-toast = Your Year in Tabs is ready
whimsy-year-title = Your Year in Tabs
whimsy-year-progress = { $current } of { $total }
whimsy-year-welcome-title = { $year }, so far
whimsy-year-welcome-body = All on this device. Nothing here is sent anywhere.
whimsy-year-opened-title = Tabs opened
whimsy-year-opened-body = You opened { $count } tabs.
whimsy-year-opened-space = Busiest in { $space }.
whimsy-year-topsites-title = Top sites
whimsy-year-busiest-title = Busiest day & hour
whimsy-year-busiest-body = { $day }s around { $hour }.
whimsy-year-space-title = Most-used space
whimsy-year-space-body = { $space } — { $percent }% of your tabs.
whimsy-year-longest-title = Longest-open tab
whimsy-year-longest-body = { $title } — open for { $duration }.
whimsy-year-nightowl-title = Night owl score
whimsy-year-nightowl-body = { $percent }% of your visits were between 10pm and 4am.
whimsy-year-nightowl-low = Early to bed.
whimsy-year-nightowl-mid = A bit of a night owl.
whimsy-year-nightowl-high = Certified night owl.
whimsy-year-empty = Not enough data yet — come back after browsing a bit more.
whimsy-year-copy-card = Copy card
whimsy-year-copied-toast = Card copied
whimsy-year-done = Done
## tierC-claude: the Claude space

whimsy-claude-space-name = Claude
whimsy-claude-bar = Claude is using this tab.
whimsy-claude-stop =
    .label = Stop Claude
    .accesskey = S
whimsy-claude-stopped-toast = Claude stopped. Turn it back on in Settings.
whimsy-claude-confirm-title = Allow Claude on this site?
# $host (String) - the site, e.g. example.com
# $action (String) - the tool Claude wants to use
whimsy-claude-confirm-text =
    { $action ->
        [click] Claude wants to click on { $host }.
        [type] Claude wants to type on { $host }.
        [key] Claude wants to press keys on { $host }.
        [form_input] Claude wants to fill in a form on { $host }.
        [read_page] Claude wants to read { $host }, which is outside the Claude space.
        [get_page_text] Claude wants to read { $host }, which is outside the Claude space.
        [find] Claude wants to read { $host }, which is outside the Claude space.
        [screenshot] Claude wants to take a screenshot of { $host }, which is outside the Claude space.
        [navigate] Claude wants to load a new page in your { $host } tab, which is outside the Claude space.
        [tabs_close] Claude wants to close your { $host } tab, which is outside the Claude space.
       *[other] Claude wants to use { $host }.
    }
whimsy-claude-confirm-once = Allow once
whimsy-claude-confirm-always = Always allow on this site
whimsy-claude-confirm-deny = Don’t allow

## tierC-claude: Settings → Privacy & Security → Claude

whimsy-claude-header =
    .label = Claude
whimsy-claude-enable =
    .label = Let Claude use { -brand-short-name }
    .description = Claude Code can open, read and use tabs in the Claude space, like Claude in Chrome. Tabs Claude is using glow and show a Stop button. Only apps on this Mac with the token below can connect.
whimsy-claude-whole-browser =
    .label = Let Claude use any tab, not just the Claude space
    .description = Private tabs and Scratch are always off-limits, and so are passwords.
whimsy-claude-ask =
    .label = Ask before Claude clicks, types or fills in forms on a new site
whimsy-claude-ai-blocked = Claude is unavailable while all AI features are turned off.
whimsy-claude-connect-heading = Connect Claude Code
whimsy-claude-connect-intro = Run this in Terminal once:
whimsy-claude-connect-json-intro = Or add this to an MCP config file (.mcp.json):
whimsy-claude-copy-command =
    .label = Copy Command
whimsy-claude-copy-json =
    .label = Copy JSON
whimsy-claude-new-token =
    .label = New Token
whimsy-claude-forget-sites =
    .label = Forget Allowed Sites
whimsy-claude-copied = Copied
whimsy-claude-new-token-note = The old token no longer works. Run the new command to reconnect.
## meeting: Next meeting in the sidebar

whimsy-library-meetings-title = Meetings
whimsy-library-meetings-search-placeholder =
    .placeholder = Search meetings…
whimsy-library-meetings-empty = No more meetings in the next 24 hours
whimsy-library-meetings-connect = Connect a calendar to see your next meeting here, with a button to join it.
whimsy-meeting-now = Now
whimsy-meeting-join = Join
whimsy-meeting-card =
    .aria-label = Next meeting
whimsy-meeting-card-dismiss =
    .title = Hide until the next meeting
    .aria-label = Hide until the next meeting
whimsy-meeting-calendars = Calendars
whimsy-meeting-apple-title = Apple Calendar
whimsy-meeting-apple-connect = Connect
whimsy-meeting-apple-allow = Allow access
whimsy-meeting-apple-open-settings = Open System Settings
whimsy-meeting-apple-denied = { -brand-short-name } can’t read your calendars. Turn it on in System Settings → Privacy & Security → Calendars.
whimsy-meeting-apple-unsupported = This copy of { -brand-short-name } can’t ask for calendar access. Install the latest build.
whimsy-meeting-source-remove =
    .tooltiptext = Remove calendar
    .aria-label = Remove calendar
whimsy-meeting-google-title = Google Calendar
whimsy-meeting-google-error = Couldn’t load this calendar. Check its address.
whimsy-meeting-google-add = Add Google Calendar
whimsy-meeting-google-placeholder =
    .placeholder = Paste the secret address in iCal format
whimsy-meeting-google-help = Where do I find it?
whimsy-meeting-google-add-confirm = Add
whimsy-meeting-google-invalid = Paste the secret address. It starts with https://

whimsy-meeting-header = Next meeting
whimsy-meeting-description = Your next meeting in the sidebar, with a button to join its Meet, Zoom or Teams call. Add Google Calendar accounts in Library → Meetings.
whimsy-meeting-enable =
    .label = Show the Meetings tab in the Library
whimsy-meeting-apple-enable =
    .label = Read Apple Calendar (every account in macOS Calendar)
whimsy-meeting-card-enable =
    .label = Show a card at the top of the sidebar 15 minutes before a meeting
# wave2: Mini Whimsy without an available destination.
whimsy-quick-window-no-space =
    .label = Open in…
## ext: per-space extensions

whimsy-space-extensions-header = Per-space extensions
whimsy-space-extensions-toggle =
    .label = Show extensions per space
whimsy-space-extensions-help = Each extension gets a "Show in Spaces…" choice on its gear menu in the extensions panel, so you can keep one hidden outside the spaces it belongs to. Hiding it only hides its toolbar button and panel entry — it keeps running in the background and sharing storage like any other enabled extension; nothing short of a separate Firefox profile per space truly isolates it. When a space has its own container, Whimsy also stops the extension's tabs/webNavigation/webRequest/proxy access to that container's tabs, but not its content scripts.
whimsy-space-extensions-menu =
    .label = Show in Spaces…
whimsy-space-extensions-all =
    .label = All Spaces
# batch hist: visit-time space in the Library History tab.
whimsy-history-space-filter =
    .aria-label = Space
whimsy-history-all-spaces = All Spaces
whimsy-history-unknown-space = Unknown space
whimsy-history-where = { $space }
## home: homepage + changelog (about:whimsy)

whimsy-home-title = Whimsy
whimsy-home-brand = Whimsy
whimsy-home-tab-home = Home
whimsy-home-tab-changelog = Changelog
whimsy-home-blurb =
    Whimsy is an Arc-shaped browser built on Zen and Firefox: spaces,
    folders and splits from Zen, with Arc's shortcuts and flow layered on
    top.
whimsy-home-link-settings = Settings
whimsy-home-link-shortcuts = Keyboard shortcuts
whimsy-home-link-import = Import from Arc
whimsy-home-link-feedback = Feedback on GitHub
whimsy-changelog-blurb = What's changed in each build.
whimsy-changelog-empty = Nothing to show yet.

## home: Library footer (replaces Zen's donate button; see ZenLibrary.mjs)

whimsy-library-footer-feedback-button =
    .label = Feedback

# home: homepage preference and changelog version heading.
whimsy-home-enabled =
    .label = Use the Whimsy homepage
whimsy-changelog-unreleased = Unreleased

# wave3/cmdbar: recent tabs in the empty command bar (Arc).
whimsy-command-recent-tabs = Recent Tabs
whimsy-command-switch-tab = Switch to Tab
whimsy-command-recent-tabs-toggle =
    .label = Show recent tabs when the command bar opens empty

# wave3/cmdbar: offline bangs (Settings -> Search).
whimsy-bangs-header = Bang Shortcuts
whimsy-bangs-enabled =
    .label = Use bang shortcuts in the address bar
whimsy-bangs-help = Type !w black holes or black holes !w to search a site directly with any search engine. Bangs are resolved on this device, so no search engine sees the query first. One shortcut per line: !shortcut followed by a search URL, with { "{{{s}}}" } where the query goes.
whimsy-bangs-list = Shortcuts
whimsy-bangs-save =
    .label = Save
whimsy-bangs-reset =
    .label = Restore Defaults
whimsy-bangs-saved = Shortcuts saved.
whimsy-bangs-restored = Default shortcuts restored.
# $line (Number) - The first line that couldn't be saved.
whimsy-bangs-invalid = Line { $line } isn't a valid shortcut. Use !shortcut and an http or https URL with { "{{{s}}}" } once, and don't repeat a shortcut. Nothing was saved.
whimsy-bangs-too-long = The list is too long. Nothing was saved.
