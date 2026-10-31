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

## wave5/lan: Local servers live folder (dev servers running on this machine).

whimsy-live-folder-local-servers-create =
    .label = Local Servers
whimsy-live-folder-local-servers-name = Local Servers

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
whimsy-external-links-glance =
    .label = Glance, over the tab you’re on
whimsy-external-links-tab =
    .label = A new tab
whimsy-external-links-quick-window =
    .label = Mini Whimsy, a small window you can turn into a tab
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
whimsy-action-speed-reset = Reset Video Speed
# $rate (number) - the playback rate, e.g. 1.25
whimsy-speed-toast = Playback speed { NUMBER($rate, maximumFractionDigits: 2) }×
whimsy-speed-none-toast = No video or audio on this page

## Capture (shortcuts and command bar)

whimsy-action-copy-full-page = Capture Full Page
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

whimsy-action-open-archive = Open in Wayback Machine
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
    .label = Shift-click a link to open it in a split

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
    .title = Type or paste a hex color, then press Return. Add two digits for opacity, like #5B8CFF80.
    .aria-label = Hex color
whimsy-hex-add =
    .tooltiptext = Add color
    .aria-label = Add color

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
    .label = Open links to other sites from pinned tabs in Glance
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
    .label = Show closed tabs in History (command bar: “View Archive…”)
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

whimsy-action-show-archive = View Archive…
whimsy-action-fire-button = Forget Site Data…
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
# $site (string) - the current tab's site, like "example.com". The scope is
# the whole site: every subdomain, all of its history and data, and its tabs.
whimsy-fire-site = Everything from { $site }
    .tooltiptext = Deletes { $site }’s history, cookies, site data and cache, including its subdomains, and closes its tabs (pinned tabs stay)
# Shown disabled when the current tab isn't a website (a new tab, about: pages).
whimsy-fire-site-none = This Site
    .tooltiptext = The current tab isn’t a website
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
whimsy-atc-description = Open links that match a rule in the space you choose.
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
whimsy-menu-new-scratch =
    .label = New Scratch Space
whimsy-menu-new-private-tab =
    .label = New Private Tab
whimsy-scratch-keep =
    .label = Keep as Normal Space…
whimsy-scratch-close =
    .label = Close Scratch
whimsy-action-new-private-tab = New Private Tab
whimsy-action-new-scratch = New Scratch Space
whimsy-action-keep-scratch = Keep Scratch as a Normal Space…
whimsy-action-close-scratch = Close Scratch
# fix7/private: the one sentence of the modal dialog shown before Scratch becomes a normal space.
whimsy-scratch-keep-confirm = Its pages reopen as normal tabs, outside private browsing, and it can’t be made private again.
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
    .label = Folders: pin Finder folders in the Library
whimsy-library-screenshot-sidebar-enable =
    .label = Screenshots: keep screenshots in the Library

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

whimsy-library-finder-folders-title = Folders
whimsy-library-finder-folders-empty = No folders pinned yet
whimsy-library-finder-folders-search-placeholder =
    .placeholder = Search folders…
whimsy-library-finder-folders-add =
    .label = Add folder
whimsy-library-finder-folders-remove =
    .label = Remove folder
whimsy-library-finder-folders-picker-title = Choose a folder to pin

whimsy-library-files-title = Screenshots
whimsy-library-files-empty = No screenshots yet
whimsy-library-files-search-placeholder =
    .placeholder = Search screenshots…
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

whimsy-action-print-clean = Print Clean Page

## Pin or favorite a split (command bar)

whimsy-action-favorite-split = Favorite This Split
whimsy-action-open-split-favorites = Open Favorite Split…
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
    .label = Seasonal colors and costumes

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
    .aria-label = Search shortcuts
whimsy-cheatsheet-edit = Edit all shortcuts…
whimsy-cheatsheet-duplicate-tab = Duplicate Tab
whimsy-cheatsheet-pin-tab = Pin/Unpin Tab
whimsy-cheatsheet-tab-next = Next Tab
whimsy-cheatsheet-tab-prev = Previous Tab
whimsy-cheatsheet-focus-sidebar = Focus Sidebar
whimsy-cheatsheet-self = Keyboard Shortcuts

## batch7: inbox-zero balloons

whimsy-inbox-zero-toast = Inbox zero

## batch7: per-site user agent ("Pretend to be...")

whimsy-action-useragent = Change User Agent…
whimsy-useragent-default =
    .label = Default (Whimsy)
whimsy-useragent-chrome =
    .label = Chrome (macOS)
whimsy-useragent-safari-mac =
    .label = Safari (macOS)
whimsy-useragent-safari-iphone =
    .label = Safari (iPhone)

## batch7: cookie editor

whimsy-action-cookie-editor = Edit Cookies for This Site…
whimsy-cookie-editor-add =
    .label = Add Cookie
whimsy-cookie-editor-copy-all =
    .label = Copy All as JSON
whimsy-cookie-editor-delete =
    .label = Delete
    .tooltiptext = Delete this cookie
whimsy-cookie-editor-copied-toast = Cookies copied

## batch7: upload from the clipboard

whimsy-upload-clipboard =
    .label = Clipboard image
# $name (string) - the file name of a file copied in Finder
whimsy-upload-clipboard-file =
    .label = Copied file: { $name }
whimsy-upload-choose-file =
    .label = Choose file…

## batch7: developer mode tabs

whimsy-action-devmode-toggle = Turn Developer Mode On or Off
whimsy-devmode-elements =
    .label = Elements
whimsy-devmode-console =
    .label = Console
whimsy-devmode-network =
    .label = Network

## batch7b: offline game (whimsy://game)

whimsy-action-game = Play Balloon Dash
whimsy-game-title = Balloon Dash
whimsy-game-style-group =
    .aria-label = Look
whimsy-game-style-retro = Retro
whimsy-game-style-gradient = Smooth
whimsy-game-sound = Sound
whimsy-game-score = Score
whimsy-game-best = Best
whimsy-game-start-title = Balloon Dash
whimsy-game-start-hint = Press an arrow key or Space, or click, to start. Grab the sparkles, dodge everything else.
whimsy-game-start-short = Press an arrow key or Space to start
whimsy-game-paused = Paused. Press Space to keep going.
whimsy-game-over-title = Pop!
whimsy-game-death-seed = Caught by a thistle seed.
whimsy-game-death-plane = That paper plane had right of way.
whimsy-game-death-zap = Zapped by a grumpy cloud.
whimsy-game-death-bird = A bird wanted a closer look.
whimsy-game-new-best = New best!
whimsy-game-retry-hint = Space or click to go again
whimsy-game-play-again = Go again
whimsy-game-hint = Arrows, WASD or pointer to steer · Space or click to dash · P pauses

## batch7b: Year in tabs (whimsy://year)
## $year is a plain string (never a formatted number).

whimsy-action-year = Open Year in Tabs
whimsy-year-ready-toast = Your Year in Tabs is ready
whimsy-year-title = Your Year in Tabs
whimsy-year-progress = { $current } of { $total }
whimsy-year-prev =
    .aria-label = Previous
whimsy-year-next =
    .aria-label = Next
whimsy-year-auto = Auto-play
whimsy-year-tap-hint = Tap, Space or → to keep going
whimsy-year-intro-kicker = Psst. It’s ready.
whimsy-year-intro-label = Your year in tabs, so far.
whimsy-year-intro-reveal = Grab a snack. We kept score.
whimsy-year-opened-kicker = First, a little confession.
whimsy-year-opened-label = tabs opened
whimsy-year-opened-reveal = That’s about { $perDay } a day. Who’s counting? (Us. We were.)
whimsy-year-opened-space = Most of them in { $space }.
whimsy-year-topsites-kicker = You had a favorite. You know the one.
whimsy-year-topsites-label = was your number one
whimsy-year-topsites-visits =
    { $count ->
        [one] 1 visit
       *[other] { $count } visits
    }
whimsy-year-topsites-reveal = Close behind:
whimsy-year-busiest-kicker = Everyone has a peak hour. Here’s yours.
whimsy-year-busiest-day = { $day }s
whimsy-year-busiest-hour = around { $hour }
whimsy-year-busiest-reveal = Your tabs were never busier. Coincidence? Probably not.
whimsy-year-space-kicker = One space ruled them all.
whimsy-year-space-label = of your tabs lived in { $space }
whimsy-year-space-reveal = At this point it pays rent.
whimsy-year-longest-kicker = One tab outlasted them all.
whimsy-year-longest-days = { $count ->
        [one] day open
       *[other] days open
    }
whimsy-year-longest-hours = { $count ->
        [one] hour open
       *[other] hours open
    }
whimsy-year-longest-minutes = { $count ->
        [one] minute open
       *[other] minutes open
    }
whimsy-year-longest-reveal = Still not ready to let go? Same.
whimsy-year-nightowl-kicker = And when the sun went down…
whimsy-year-nightowl-label = of your browsing happened between 10pm and 4am
whimsy-year-nightowl-low = Early to bed. Your tabs got their beauty sleep.
whimsy-year-nightowl-mid = A bit of a night owl. We won’t tell.
whimsy-year-nightowl-high = Certified night owl. The moon knows your name.
whimsy-year-finale-kicker = That’s a wrap.
whimsy-year-finale-label = in tabs
whimsy-year-finale-opened = Tabs opened
whimsy-year-finale-topsite = Top site
whimsy-year-finale-peak = Peak time
whimsy-year-finale-space = Top space
whimsy-year-finale-night = Night owl
whimsy-year-finale-longest = Longest tab
whimsy-year-finale-peak-value = { $day }s, { $hour }
whimsy-year-finale-signoff = Here’s to next year’s tabs.
whimsy-year-replay = Watch again
whimsy-year-empty = Not much to look back on yet. Browse a little, then come back for your recap.
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
whimsy-claude-new-token-note = Token changed. Your connection is ready.
whimsy-claude-token-error = Couldn’t change the token. Try again.
## meeting: Next meeting in the sidebar

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
whimsy-meeting-apple-unsupported = Apple Calendar is unavailable. Update { -brand-short-name } to try again.
whimsy-meeting-source-remove =
    .tooltiptext = Remove calendar
    .aria-label = Remove calendar
whimsy-meeting-google-title = Google Calendar
whimsy-meeting-google-error = Couldn’t load this calendar. Check its address.
whimsy-meeting-google-add = Add Google Calendar
whimsy-meeting-google-placeholder =
    .placeholder = Paste a secret iCal address
whimsy-meeting-google-help = Where do I find it?
whimsy-meeting-google-add-confirm = Add
whimsy-meeting-google-invalid = Paste the secret address. It starts with https://

whimsy-meeting-header =
    .label = Meetings
whimsy-meeting-description = Join upcoming calls from the sidebar or command bar.
whimsy-meeting-enable =
    .label = Enable meetings
whimsy-meeting-apple-enable =
    .label = Connect Apple Calendar
whimsy-meeting-card-enable =
    .label = Show upcoming meetings in the sidebar
# wave2: Mini Whimsy without an available destination.
whimsy-quick-window-no-space =
    .label = Open in…
## ext: per-space extensions

whimsy-space-extensions-header = Per-space extensions
whimsy-space-extensions-toggle =
    .label = Show extensions per space
whimsy-space-extensions-help = Each space can have its own extensions.
whimsy-space-extensions-menu =
    .label = Show in Spaces…
whimsy-space-extensions-all =
    .label = All Spaces
# batch hist: visit-time space in the Library History tab.
whimsy-history-space-filter = Where was the tab?
whimsy-history-all-spaces = All Spaces
whimsy-history-where = { $space }
## home: homepage + changelog (about:whimsy)

whimsy-home-title = Whimsy
whimsy-home-brand = Whimsy
whimsy-home-tab-home = Home
whimsy-home-tab-changelog = Changelog
# The <em> part gets the balloon's gradient.
whimsy-home-hero-title = A browser with <em>a little lift</em>.
whimsy-home-blurb = Arc's flow, built on Zen and Firefox. Spaces, splits and the shortcuts your hands already know.
whimsy-home-hero-hint = Psst: the balloon likes a poke.
whimsy-home-balloon =
    .aria-label = Poke the balloon
whimsy-home-features-title = What makes Whimsy, Whimsy
whimsy-home-feature-spaces-title = A space for everything
whimsy-home-feature-spaces-text = Work, home and side quests each get their own tabs, colors and pinned sites.
whimsy-home-feature-keys-title = Arc's shortcuts, kept
whimsy-home-feature-keys-text = Ctrl+Tab, the command bar and the keys you already reach for.
whimsy-home-feature-split-title = Side by side, or a peek
whimsy-home-feature-split-text = Split the window between pages, or glance at a link without leaving yours.
whimsy-home-feature-quiet-title = Quiet by design
whimsy-home-feature-quiet-text = No accounts and no telemetry. It's your browser, not ours.
whimsy-home-links-title = Get settled in
whimsy-home-link-settings = Settings
whimsy-home-link-settings-text = Themes, tabs and everything else.
whimsy-home-link-shortcuts = Keyboard shortcuts
whimsy-home-link-shortcuts-text = Every shortcut on one page.
whimsy-home-link-import = Import from Arc
whimsy-home-link-import-text = Bring your bookmarks and history along.
whimsy-home-link-feedback = Feedback on GitHub
whimsy-home-link-feedback-text = Found a bug or have an idea? Tell us.
whimsy-home-footer = Whimsy is built on Zen and Firefox, with a little extra air.
whimsy-changelog-blurb = What's new in each build, newest first.
whimsy-changelog-empty = Nothing to show yet.
whimsy-changelog-latest = Latest
whimsy-changelog-new = New
whimsy-changelog-improved = Improved
whimsy-changelog-fixed = Fixed
# $version (String) - a build's version, like 1.24b-w2
whimsy-changelog-anchor =
    .aria-label = Link to { $version }
    .title = Link to this build

## home: Library footer (replaces Zen's donate button; see ZenLibrary.mjs)

whimsy-library-footer-feedback-button =
    .label = Feedback

# home: homepage preference and changelog version heading.
whimsy-home-enabled =
    .label = Use the Whimsy homepage
whimsy-changelog-unreleased = Unreleased
## tierC-vpn: VPN (Firefox's built-in IP Protection). Settings → Privacy &
## Security card, and the command bar actions.

whimsy-vpn-header =
    .label = VPN from Firefox
whimsy-vpn-toggle =
    .label = Turn on VPN
whimsy-vpn-description = Firefox’s free built-in VPN hides your location from the sites you visit, up to 50 GB a month. Sign in with a Mozilla account, then turn it on from the VPN button in the toolbar or the command bar.
whimsy-vpn-manage-button =
    .label = Open VPN panel…
whimsy-vpn-status-off = Off
whimsy-vpn-status-unavailable = Not available yet
whimsy-vpn-status-signed-out = On — open the VPN panel to sign in with a Mozilla account
whimsy-vpn-status-ready = Signed in, not connected — open the VPN panel to connect
whimsy-vpn-status-connecting = Connecting…
whimsy-vpn-status-on = Connected
whimsy-vpn-status-error = Connection error — open the VPN panel for details
whimsy-action-vpn-on = Turn VPN On
whimsy-action-vpn-off = Turn VPN Off
whimsy-action-vpn-setup = Set Up VPN
whimsy-vpn-on-toast = VPN on
whimsy-vpn-off-toast = VPN off

# vpnspace: extend the native Firefox VPN panel and toolbar button.
whimsy-vpn-scope-title = Protect
whimsy-vpn-scope-browser = All spaces
whimsy-vpn-scope-space = This space
whimsy-vpn-scope-help = Protects this space’s tabs, and any other space set up to share it — not tabs elsewhere. Tabs already open switch over once you reload them, and your site exceptions still apply.
whimsy-vpn-scope-no-container = This space isn’t linked to a container yet. Add one in Edit Space to protect just this space — tabs already open will need reopening to pick it up.
whimsy-vpn-scope-covered = Spaces with VPN enabled: { $spaces }
whimsy-vpn-scope-all = VPN enabled for all spaces.
whimsy-vpn-scope-button-off = VPN off
whimsy-vpn-scope-button-connecting = VPN connecting
whimsy-vpn-scope-button-browser = VPN on · Browser
whimsy-vpn-scope-button-space = VPN on · Space
whimsy-vpn-scope-button-elsewhere = VPN off here

## legacy: Firefox/Mozilla leftovers replaced with Whimsy's own.

# A new profile's Bookmarks Menu folder (whimsy/default-bookmarks.html).
whimsy-default-bookmarks-heading = Whimsy
whimsy-default-bookmarks-changelog = Whimsy Changelog
whimsy-default-bookmarks-feedback = Whimsy Feedback on GitHub

# About dialog (overlay.py about-dialog-* hotfixes). "Zen" links to Zen's
# credits page (about:credits); the GitHub link opens Whimsy's issues.
whimsy-about-community = { -brand-short-name } is a personal browser built on <label data-l10n-name="community-creditsLink">Zen</label> and Firefox. Found a bug or have an idea? <label data-l10n-name="community-mozillaLink">Tell us on GitHub</label>.
whimsy-about-community-exp = { -brand-short-name } is a personal browser built on <label data-l10n-name="community-exp-creditsLink">Zen</label> and Firefox.
whimsy-about-no-telemetry = { -brand-short-name } sends no telemetry or crash reports. The Privacy Notice below lists the services it talks to.

# about:whimsy?tab=privacy, the About dialog's Privacy Notice. Keep it in
# step with what Whimsy actually contacts (prefs/whimsy/whimsy.yaml).
whimsy-home-tab-privacy = Privacy
whimsy-privacy-blurb = Whimsy has no servers or accounts of its own, and sends no telemetry or crash reports. These are the services it talks to, and why.
whimsy-privacy-mozilla = <strong>Mozilla</strong>: security, blocklist and search updates (Remote Settings), add-on updates, web push notifications, video plugins (Widevine, OpenH264), translation models (translation runs on this Mac), your country for search defaults, and a one-off check after a certificate error that looks like interception.
whimsy-privacy-sync = <strong>Mozilla account and Sync</strong>: only if you sign in. What you sync is end-to-end encrypted.
whimsy-privacy-dns = <strong>Cloudflare</strong>: in some countries, Firefox's DNS over HTTPS turns on by itself and sends lookups to Cloudflare's resolver for Mozilla. Change it in Settings → Privacy & Security.
whimsy-privacy-zen = <strong>Zen</strong>: when you share a space or folder, its tab titles and links go to Zen's share server, and anyone with the link can open it for 30 days. Zen Mods come from Zen's mod store.
whimsy-privacy-apple = <strong>Apple</strong>: captive.apple.com, to check that you're online and to spot Wi-Fi sign-in pages. macOS makes the same check.
whimsy-privacy-google = <strong>Google</strong>: Safe Browsing lists and checks of downloaded apps.
whimsy-privacy-updates = <strong>GitHub</strong>: Whimsy's updates.
whimsy-privacy-search = <strong>Your search engine</strong>: what you search for, as with any browser.

# Settings → Home → Homepage and new windows: the built-in choice, which is
# Whimsy's home (about:whimsy) rather than Firefox Home.
whimsy-home-mode-choice-default =
    .label = Whimsy Home (Default)

## wave3/private: reading RSS live folders.

# $count (Number) - items in the folder that haven't been opened yet
whimsy-live-folder-unread =
    { $count ->
        [one] 1 unread item
       *[other] { $count } unread items
    }
whimsy-live-folder-rss-option-reader =
    .label = Open in Reader View
whimsy-live-folder-option-mark-read =
    .label = Mark All as Read

## wave3/private: floating calls.

whimsy-media-call-pip =
    .label = Float a video call in picture-in-picture when you switch away from its tab

# batch3glance: Glance size (Settings → Tab Management, below the Tabs options).
whimsy-glance-size-label = Glance size
whimsy-glance-size-compact =
    .label = Compact
whimsy-glance-size-standard =
    .label = Standard
whimsy-glance-size-wide =
    .label = Wide

# batch3glance: Cmd+T in a split (Settings → Tab Management, Tabs group).
whimsy-split-new-tab =
    .label = In a split view, a new tab opens in the focused pane

# batch3glance: Arc's split layout actions (command bar).
whimsy-action-add-split-right = Add Right Split
whimsy-action-add-split-left = Add Left Split
whimsy-action-add-split-top = Add Top Split
whimsy-action-add-split-bottom = Add Bottom Split
whimsy-action-split-change-orientation = Change Split View Orientation

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

# wave3/tree: tree tab disclosure buttons
whimsy-tree-collapse =
    .aria-label = Collapse subtree
    .title = Collapse subtree
whimsy-tree-expand =
    .aria-label = Expand subtree
    .title = Expand subtree

# wave3/tree: shortcut cheat sheet lists every keyset shortcut, grouped
whimsy-cheatsheet-group-whimsy = Whimsy
whimsy-cheatsheet-group-other = Other
whimsy-cheatsheet-empty = No matching shortcuts

# batch hover: hover cards (tabs, History, People).
whimsy-hover-header = Hover cards
whimsy-hover-tabs =
    .label = Show a card with the title, address and preview when you hover a tab
whimsy-hover-history =
    .label = Show a preview when you hover a page in History
whimsy-hover-no-preview = No saved preview
whimsy-hover-people =
    .label = Show who it is when you hover a GitHub, LinkedIn or X profile link
whimsy-hover-people-help = Uses your own sign-in after a deliberate hover, up to 20 profiles an hour. LinkedIn and X may still flag an account for repeated visits. Never in private browsing.

## fixB: Whimsy's panels ("sheets", WhimsyPanels.sys.mjs)

whimsy-sheet-close =
    .tooltiptext = Close
    .aria-label = Close
# The accept button of Zen's "Delete Space?" confirmation.
whimsy-delete-space-accept = Delete Space
whimsy-snooze-title = Snooze Tab
whimsy-fire-title = Fire Button
whimsy-fire-subtitle = Clears data, then closes the tabs. Pinned tabs stay.
# $site (string) - the current site's domain, e.g. example.com
whimsy-fire-site-detail = Cookies, cache and history for { $site }, plus its tabs
whimsy-fire-site-none-detail = This page isn't a website
whimsy-fire-last-15-min-detail = Everything from the last 15 minutes
# $space (string) - the current space's name
whimsy-fire-space-detail = Site data and tabs in { $space }
whimsy-fire-space-detail-unnamed = Site data and tabs in this space
whimsy-fire-everything-detail = All browsing data and every unpinned tab
whimsy-heavy-tabs-title = Heavy Tabs
whimsy-heavy-tabs-subtitle = Memory use, updated every few seconds
whimsy-heavy-tabs-measuring = Measuring…
whimsy-heavy-tabs-empty = No tabs to measure right now.
whimsy-split-favorites-title = Favorite Splits
whimsy-split-favorites-empty-state = No favorite splits yet. Open a split, then choose “Favorite This Split” in the command bar.
whimsy-cookie-editor-title = Cookies
whimsy-cookie-editor-search =
    .placeholder = Search cookies
    .aria-label = Search cookies
whimsy-cookie-editor-new-name =
    .placeholder = Name
    .aria-label = New cookie name
whimsy-cookie-editor-new-value =
    .placeholder = Value
    .aria-label = New cookie value
whimsy-cookie-editor-save-new =
    .label = Add
# $name (string) - the cookie's name
whimsy-cookie-editor-value =
    .aria-label = Value of { $name }
# $site (string) - the site's domain
whimsy-cookie-editor-empty = No cookies for { $site }
whimsy-cookie-editor-no-match = No cookies match your search
whimsy-cookie-editor-flag-secure = Secure
whimsy-cookie-editor-flag-httponly = HttpOnly
whimsy-cookie-editor-flag-session = Session
whimsy-useragent-title = Pretend to Be
# $site (string) - the current site's host
whimsy-useragent-subtitle = On { $site }; the page reloads
whimsy-useragent-option-default = Whimsy
whimsy-useragent-option-default-detail = No disguise (Firefox's own)
whimsy-useragent-option-chrome = Chrome
whimsy-useragent-option-chrome-detail = For sites that only work in Chrome
whimsy-useragent-option-safari-mac = Safari
whimsy-useragent-option-safari-mac-detail = Safari on a Mac
whimsy-useragent-option-safari-iphone = iPhone
whimsy-useragent-option-safari-iphone-detail = Safari on iPhone, for a site's mobile layout
whimsy-useragent-option-custom = Custom…
whimsy-useragent-option-custom-detail = Any user agent string
whimsy-useragent-custom-field =
    .placeholder = Mozilla/5.0 …
    .aria-label = Custom user agent
whimsy-useragent-custom-apply =
    .label = Apply
whimsy-cheatsheet-title = Keyboard Shortcuts
whimsy-cheatsheet-no-match = No shortcut matches.
whimsy-cheatsheet-edit-button =
    .label = Edit Shortcuts…
whimsy-cheatsheet-group-tabs = Tabs
whimsy-cheatsheet-group-sidebar = Sidebar and Spaces
whimsy-cheatsheet-group-split = Split View
whimsy-cheatsheet-group-page = Page
whimsy-cheatsheet-group-windows = Windows
whimsy-cheatsheet-new-tab = New Tab
whimsy-cheatsheet-close-tab = Close Tab
whimsy-cheatsheet-reopen-tab = Restore Last Closed Tab
whimsy-cheatsheet-copy-url = Copy URL
whimsy-cheatsheet-private-tab = New Private Tab
whimsy-cheatsheet-address-bar = Address Bar
whimsy-cheatsheet-toggle-sidebar = Show or Hide Sidebar
whimsy-cheatsheet-compact-mode = Hide or Show Sidebar
whimsy-cheatsheet-next-space = Next Space
whimsy-cheatsheet-prev-space = Previous Space
whimsy-cheatsheet-library = Open Library…
whimsy-cheatsheet-split-vertical = Split Side by Side
whimsy-cheatsheet-split-horizontal = Split Top and Bottom
whimsy-cheatsheet-split-grid = Split in a Grid
whimsy-cheatsheet-unsplit = Unsplit
whimsy-cheatsheet-swap-panes = Swap Panes
whimsy-cheatsheet-close-other-panes = Close Other Panes
whimsy-cheatsheet-find = Find in Page
whimsy-cheatsheet-reader = Reader View
whimsy-cheatsheet-copy-full-page = Capture Full Page
whimsy-cheatsheet-capture = Capture…
whimsy-cheatsheet-translate = Translate Selection
whimsy-cheatsheet-speed-up = Play Faster
whimsy-cheatsheet-slow-down = Play Slower
whimsy-cheatsheet-new-window = New Window
whimsy-cheatsheet-quick-window = Mini Whimsy
whimsy-cheatsheet-private-window = New Private Window

## fixB: the Archive, now History's Closed filter in the Library

whimsy-library-archive-intro = Click a tab to restore it.
# $after - how long a tab sits unused before it archives itself
whimsy-library-archive-intro-idle =
    { $after ->
        [h24] Unused tabs archive after 24 hours.
        [d7] Unused tabs archive after 7 days.
        [d30] Unused tabs archive after 30 days.
       *[h12] Unused tabs archive after 12 hours.
    }
whimsy-library-archive-intro-manual = Auto-archive is off.
whimsy-library-archive-empty = No closed tabs yet.
whimsy-library-archive-no-match = No closed tabs match.
whimsy-library-archive-today = Today
whimsy-library-archive-yesterday = Yesterday
whimsy-library-archive-filter-reason = Why it left
whimsy-library-archive-reason-idle = Unused
whimsy-library-archive-reason-closed = Closed
whimsy-library-archive-reason-tree = Closed with its branch
whimsy-library-archive-reason-snooze = Snoozed
whimsy-library-archive-reason-fire = Burned
# $space (string) - the name of the space the tab goes back to
whimsy-library-archive-in-space = { $space }
whimsy-library-archive-restore =
    .tooltiptext = Restore to its space
    .aria-label = Restore to its space
whimsy-library-archive-forget =
    .tooltiptext = Remove from History
    .aria-label = Remove from History

## fixC: onboarding look pages (Zen's first-run flow, after space colors)

whimsy-welcome-transparency-title = Let your desktop shine through?
whimsy-welcome-transparency-description = { -brand-short-name } can let your wallpaper glow softly through the sidebar. Pick one to try it. You can always change it later!
whimsy-welcome-transparency-solid = <strong>NO</strong>, keep it solid.
whimsy-welcome-transparency-subtle = <strong>A LITTLE</strong>, just a hint of my wallpaper.
whimsy-welcome-transparency-glassy = <strong>A LOT</strong>, make it glassy.
whimsy-welcome-font-title = Pick your interface font.
whimsy-welcome-font-description = Tabs, menus and the address bar use it. Websites keep their own fonts. You can always change it later!
whimsy-welcome-font-system = System font

## wave3/icons: skin tone button beside the emoji search in the icon picker

whimsy-emoji-skin-tone-button = Skin tone
whimsy-emoji-skin-tone-0 =
    .label = ✋ Default
whimsy-emoji-skin-tone-1 =
    .label = ✋🏻 Light
whimsy-emoji-skin-tone-2 =
    .label = ✋🏼 Medium-light
whimsy-emoji-skin-tone-3 =
    .label = ✋🏽 Medium
whimsy-emoji-skin-tone-4 =
    .label = ✋🏾 Medium-dark
whimsy-emoji-skin-tone-5 =
    .label = ✋🏿 Dark
## wave3/speed: speed control shown over a hovered video

# $rate (string) - the current speed, already formatted, like "1.5×"
whimsy-video-speed-value =
    .aria-label = Playback speed { $rate }. Click to type a speed
    .title = Click to type a speed (0.25 to 4)
whimsy-video-speed-input =
    .aria-label = Playback speed
whimsy-video-speed-presets =
    .aria-label = Speeds
whimsy-media-video-speed =
    .label = Show a speed control when you point at a video, and remember each site’s speed

## wave3/glass: Liquid Glass (Settings → Look and Feel, macOS 26 and later)

whimsy-look-liquid-glass =
    .label = Liquid Glass
whimsy-look-liquid-glass-description = Put the sidebar and toolbars on macOS’s glass material. Uses your Transparency level, or a light one when Transparency is off.

## wave3: email-aliases (WhimsyEmailAliases*.sys.mjs; Settings -> Privacy & Security)

whimsy-email-aliases-header =
    .label = Email aliases
whimsy-email-aliases-button =
    .label = Offer a private email address in email fields
    .description = A button in email fields creates an iCloud Hide My Email address (with your iCloud.com sign-in) or a Firefox Relay mask, and fills it in.
whimsy-email-aliases-icloud-checking =
    .label = Hide My Email (checking iCloud…)
whimsy-email-aliases-icloud =
    .label = Hide My Email
whimsy-email-aliases-icloud-sign-in =
    .label = Sign in to iCloud to use Hide My Email
whimsy-email-aliases-icloud-unavailable =
    .label = Hide My Email needs iCloud+
whimsy-email-aliases-icloud-error =
    .label = Can’t reach iCloud. Sign in again…
whimsy-email-aliases-relay =
    .label = Use a Firefox Relay mask
whimsy-email-aliases-toast-creating = Creating a Hide My Email address…
whimsy-email-aliases-toast-filled = Filled in { $address }
whimsy-email-aliases-toast-copied = Copied { $address }
whimsy-email-aliases-toast-signed-out = Sign in to iCloud to use Hide My Email
whimsy-email-aliases-toast-unavailable = Hide My Email needs iCloud+
whimsy-email-aliases-toast-network = Couldn’t reach iCloud. Try again in a moment.
whimsy-email-aliases-toast-icloud-failed = iCloud couldn’t create an address. Try again in a moment.
whimsy-email-aliases-toast-relay-off = Firefox Relay is turned off in Settings
whimsy-email-aliases-toast-relay-failed = Firefox Relay couldn’t create a mask

## wave3: Handoff (Settings -> Privacy & Security)

whimsy-handoff-header =
    .label = Handoff
whimsy-handoff-send =
    .label = Continue pages on your iPhone, iPad and other Macs
    .description = Hand off the page you're on through macOS Handoff. Only its address is shared; private tabs and Scratch are never offered.

## wave3: playlist (WhimsyPlaylist.sys.mjs, Library -> Playlist)

whimsy-library-playlist-title = Playlist
whimsy-library-playlist-search =
    .placeholder = Search playlist…
whimsy-playlist-empty = Nothing saved yet. Right-click a video or audio file and choose Save to Playlist.
whimsy-playlist-no-results = No matches
whimsy-context-playlist-add =
    .label = Save to Playlist
    .accesskey = y
whimsy-action-playlist-save = Save Video to Playlist
whimsy-playlist-offline-setting =
    .label = Download Playlist videos and audio to play offline
whimsy-playlist-added-toast = Saved to Playlist
whimsy-playlist-exists-toast = Already in your Playlist
whimsy-playlist-private-toast = Playlist doesn’t save from private browsing
whimsy-playlist-unsupported-toast = This media can’t be saved (only direct files can)
whimsy-playlist-no-media-toast = No video or audio file on this page to save
whimsy-playlist-streamed-toast = This site streams its video in a way that can’t be saved. Playlist saves direct video and audio files.
whimsy-playlist-state-link = Saved link
# $progress (number) - percent downloaded
whimsy-playlist-state-downloading = Downloading { $progress }%
whimsy-playlist-state-offline = Available offline
whimsy-playlist-state-failed = Download failed (link kept)
whimsy-playlist-download =
    .title = Download to play offline
whimsy-playlist-open-page =
    .title = Open the page it came from
whimsy-playlist-remove =
    .title = Remove from Playlist

## wave3/ai: Settings → Privacy & Security → AI provider

whimsy-ai-provider-header =
    .label = AI provider
whimsy-ai-provider-description = Tidy Tabs, tab titles, Ask on Page, link previews and page watches use the provider you pick here, and only that one.
whimsy-ai-provider-label =
    .value = Provider
whimsy-ai-provider-apple =
    .label = Apple Intelligence (on this Mac)
whimsy-ai-provider-claude =
    .label = Claude (your API key)
whimsy-ai-provider-ollama =
    .label = Ollama (on this Mac)
whimsy-ai-apple-check =
    .label = Check Again
whimsy-ai-apple-set-up =
    .label = Set Up
whimsy-ai-apple-status-not-set-up = Click Set Up to connect Whimsy to Apple Intelligence. It takes a minute the first time.
whimsy-ai-apple-status-checking = Checking Apple Intelligence…
whimsy-ai-apple-status-available = Ready. Nothing leaves this Mac.
whimsy-ai-apple-status-unavailable = Apple Intelligence isn’t available on this Mac.
whimsy-ai-apple-status-apple-needs-tools = Whimsy couldn’t find Swift (swiftc) from Apple’s command line tools or Xcode. Install the tools with “xcode-select --install” in Terminal, then check again.
whimsy-ai-apple-status-apple-tools-outdated = Your command line tools don’t include the macOS 26 SDK that Apple Intelligence needs. Update them in System Settings → General → Software Update (or update Xcode), then check again.
whimsy-ai-apple-status-apple-needs-license = Xcode’s license hasn’t been accepted yet. Run “sudo xcodebuild -license accept” in Terminal, then check again.
whimsy-ai-apple-status-apple-build-failed = Whimsy found Apple’s tools but couldn’t build its Apple Intelligence helper. The details are in the Browser Console.
whimsy-ai-apple-status-apple-intelligence-off = Turn on Apple Intelligence in System Settings, then check again.
whimsy-ai-apple-status-apple-not-ready = Apple Intelligence is still getting ready. Try again in a few minutes.
whimsy-ai-claude-key-label =
    .value = API key
whimsy-ai-claude-key-save =
    .label = Save
whimsy-ai-claude-key-remove =
    .label = Remove
whimsy-ai-claude-key-saved = Your key is saved securely on this Mac. Page text and tab titles you use AI on are sent to Anthropic.
whimsy-ai-claude-key-missing = No key yet. Create one at console.anthropic.com.
whimsy-ai-claude-key-error = Couldn’t save the key.
whimsy-ai-ollama-endpoint-label =
    .value = Server
whimsy-ai-ollama-model-label =
    .value = Model
whimsy-ai-ollama-refresh =
    .label = Refresh
whimsy-ai-ollama-status-ready =
    { $count ->
        [one] Connected. 1 model installed.
       *[other] Connected. { $count } models installed.
    }
whimsy-ai-ollama-status-offline = Ollama isn’t running at this address, or has no models yet.

## wave3/ai: AI errors (toasts)

whimsy-ai-error-blocked = AI features are turned off in Settings
whimsy-ai-error-no-key = Add your Claude API key in Settings → Privacy & Security
whimsy-ai-error-bad-key = Claude didn’t accept your API key
whimsy-ai-error-rate-limited = Claude is busy. Try again in a moment.
whimsy-ai-error-network = Couldn’t reach Claude
whimsy-ai-error-unavailable = Your AI provider isn’t available right now
whimsy-ai-error-no-model = Pick an Ollama model in Settings → Privacy & Security
whimsy-ai-error-apple-needs-tools = Apple Intelligence needs Apple’s command line tools. See Settings → Privacy & Security.
whimsy-ai-error-apple-tools-outdated = Apple Intelligence needs newer command line tools. See Settings → Privacy & Security.
whimsy-ai-error-apple-needs-license = Accept Xcode’s license to use Apple Intelligence. See Settings → Privacy & Security.
whimsy-ai-error-apple-build-failed = Couldn’t set up Apple Intelligence. See Settings → Privacy & Security.
whimsy-ai-error-apple-intelligence-off = Turn on Apple Intelligence in System Settings
whimsy-ai-error-apple-not-ready = Apple Intelligence is still getting ready
whimsy-ai-error-apple-not-set-up = Set up Apple Intelligence in Settings → Privacy & Security → AI provider
whimsy-ai-error-refused = The AI declined this one
whimsy-ai-error-bad-response = The AI’s answer didn’t make sense. Try again.
whimsy-ai-error-timeout = The AI took too long
whimsy-ai-error-failed = Something went wrong with the AI

## wave3/ai: Tidy Tabs and tidy tab titles (Arc Max)

whimsy-ai-feature-tidy-tabs =
    .label = Tidy Tabs
    .description = With more than six Today tabs, a broom on the line above them sorts them into sections.
whimsy-ai-feature-tidy-titles =
    .label = Tidy tab titles
    .description = Pinning a tab gives it a short name. Names you type are never changed.
whimsy-tidy-broom =
    .tooltiptext = Tidy Tabs
    .label = Tidy Tabs
whimsy-tidy-header-folder =
    .tooltiptext = Move to Folder
    .label = Move to Folder
whimsy-tidy-header-close =
    .tooltiptext = Close Tabs
    .label = Close Tabs
whimsy-tidy-menu-remove-header =
    .label = Remove Header
whimsy-tidy-menu-folder =
    .label = Move to Folder
whimsy-tidy-menu-close =
    .label = Close Tabs
whimsy-tidy-too-few = Tidy Tabs needs at least { $count } Today tabs
whimsy-tidy-done =
    { $sections ->
        [one] Tidied { $tabs } tabs into 1 section
       *[other] Tidied { $tabs } tabs into { $sections } sections
    }

## wave3/ai: Ask on Page and 5-second previews (Arc Max)

whimsy-ai-feature-ask-on-page =
    .label = Ask on Page
    .description = When Find on Page (⌘F) finds nothing, ask a question about the page instead.
whimsy-ai-feature-link-previews =
    .label = 5-second previews
    .description = Hold Shift on a link to see a summary of the page behind it. On search results, X, Threads and Hacker News, just rest on a link. Pages are read with your own sign-ins, never in private windows.
whimsy-ask-button =
    .label = Ask
    .tooltiptext = Ask about this page
whimsy-ask-reading = Reading this page…
whimsy-ask-no-text = This page has no text to answer from.
whimsy-ask-find-on-page = Find on Page
whimsy-preview-unreadable = Couldn’t read this page.
whimsy-preview-not-ready = Set up an AI provider in Settings → Privacy & Security to see previews.

## wave3/ai: Watch a page (like Safari's Notify Me)

whimsy-ai-feature-page-watch =
    .label = Watch pages
    .description = Right-click a tab → Watch This Page… and say what to look for. Whimsy checks with your sign-ins while it’s open and alerts you until you dismiss it.
whimsy-ai-watch-row = { $page } · checked { $minutes ->
        [15] every 15 minutes
        [60] every hour
        [360] every 6 hours
       *[other] every day
    }
whimsy-ai-watch-row-met = { $page } · found, alerting until dismissed
whimsy-ai-watch-row-error = { $page } · couldn’t check last time
whimsy-ai-watch-stop =
    .label = Stop Watching
whimsy-watch-menu =
    .label = Watch This Page…
whimsy-watch-menu-stop =
    .label = Stop Watching This Page
whimsy-action-watch-page = Watch This Page
whimsy-watch-heading = Watch this page
whimsy-watch-page = { $page }
whimsy-watch-condition-label = Tell me when…
whimsy-watch-condition =
    .placeholder = the price drops below $100
whimsy-watch-interval-label = Check
whimsy-watch-interval =
    { $minutes ->
        [15] Every 15 minutes
        [60] Every hour
        [360] Every 6 hours
       *[other] Every day
    }
whimsy-watch-note = Only while Whimsy is open, with your sign-ins. The page’s text goes to your AI provider.
whimsy-watch-cancel = Cancel
whimsy-watch-done = Watch
whimsy-watch-too-many = You’re watching as many pages as Whimsy allows. Stop one in Settings first.
whimsy-watch-started = Watching this page
whimsy-watch-stopped = Stopped watching this page
whimsy-watch-alert = { $page }: “{ $condition }” { $detail }
whimsy-watch-alert-open =
    .label = Open Page
whimsy-watch-alert-stop =
    .label = Stop Watching
whimsy-watch-notification-title = Found on { $page }


## wave4: calendar Settings and the command bar
whimsy-action-join-meeting = Join { $meeting }
whimsy-meeting-disconnect = Disconnect
whimsy-meeting-google-address = Secret iCal address
whimsy-meeting-connect-empty = Connect a calendar to see upcoming calls.
whimsy-meeting-empty = No upcoming meetings.
whimsy-meeting-ready = Your next call will appear when it’s close.
whimsy-meeting-paused = Meetings are off.
whimsy-meeting-connected = Connected
whimsy-meeting-apple-detail = Connect all accounts in Apple Calendar.
whimsy-meeting-untitled = Meeting

# wave4: extension space picker in about:addons
whimsy-space-extensions-picker = Show in Spaces
whimsy-space-extensions-all-text = All Spaces

# wave4: Mini Whimsy's bar (Arc's Little Arc layout). $title is the page
# title, $url its address.
whimsy-quick-window-bar =
    .aria-label = Mini Whimsy
whimsy-quick-window-back =
    .tooltiptext = Back (Cmd+[)
    .aria-label = Back
whimsy-quick-window-address =
    .title = Search or Enter URL (Cmd+L)
    .aria-label = Search or Enter URL
whimsy-quick-window-address-page =
    .title = { $title } — { $url }
    .aria-label = Edit address: { $url }
whimsy-quick-window-address-placeholder = Search or Enter URL…
whimsy-quick-window-copy-link =
    .tooltiptext = Copy URL (Cmd+Shift+C)
    .aria-label = Copy URL

whimsy-quick-window-profile = ☺ Default
whimsy-history-unknown-space = Unknown space

## wave5: seasonal Balloon Dash (the seed hazard wears the season's costume)

whimsy-game-death-seed-autumn = Caught by a falling leaf.
whimsy-game-death-seed-winter = Caught by a snowflake.
whimsy-game-death-seed-spring = Buzzed by a bumblebee.

## wave5: live blocks in Notes (Arc Easels' Live Captures)

whimsy-note-blocks-enable =
    .label = Live blocks in notes: type /embed or drop a tab to keep part of a page live
whimsy-note-block-hint = Type /embed or drop a tab here to add a live block
whimsy-note-block-crop =
    .title = Choose the part to show
    .aria-label = Choose the part to show
whimsy-note-block-reload =
    .title = Reload
    .aria-label = Reload
whimsy-note-block-open =
    .title = Open page
    .aria-label = Open page
whimsy-note-block-remove =
    .title = Remove block
    .aria-label = Remove block
whimsy-note-block-picker =
    .aria-label = Drag over the part of the page to keep. A small click shows the whole page; Escape cancels.
whimsy-note-block-private = Private tabs can't be embedded
whimsy-note-block-unsupported = Only web pages can be embedded
whimsy-note-block-paused-private = Live blocks are paused in private windows

## wave5/captions: translated captions (CC in the video speed control)

whimsy-video-captions-button =
    .aria-label = Translated captions
whimsy-video-captions-region =
    .aria-label = Translated captions
    .title = Drag to move. Double-click to put back
whimsy-video-captions-none = This video has no captions to translate
whimsy-video-captions-failed = Couldn’t translate these captions, so they’re shown as they are
whimsy-media-video-captions =
    .label = Add CC to the speed control: captions translated into your language, on your Mac

## wave5/safety: the Claude space's prompt-injection shield

# $host (String) - the site, e.g. example.com
whimsy-claude-shield-bar = This page tried to give Claude instructions. Claude is paused on { $host }.
whimsy-claude-shield-continue =
    .label = Continue
    .accesskey = C
whimsy-claude-shield-stop =
    .label = Stop Claude
    .accesskey = S
# $host (String) - the site, e.g. example.com
whimsy-claude-shield-toast = Claude is paused: { $host } tried to give it instructions

## wave5/safety: Claude runs (agent replay, whimsy://replay)

whimsy-claude-replay =
    .label = Keep a replay of what Claude does
    .description = Each run’s steps and small page snapshots stay on this device. Private tabs and Scratch are never recorded; clearing history clears it.
whimsy-claude-show-runs =
    .label = Show Claude’s Runs
whimsy-replay-title = Claude runs
whimsy-replay-heading = Claude runs
whimsy-replay-intro = Every step Claude took in { -brand-short-name }, with a snapshot of the page. Kept only on this device.
whimsy-replay-clear = Clear All
whimsy-replay-empty-title = No runs yet
whimsy-replay-empty = When Claude uses tabs in the Claude space, each run shows up here, step by step.
whimsy-replay-off = Replay is off. Turn it on in Settings → Privacy & Security → Claude.
whimsy-replay-runs-label =
    .aria-label = Runs
# $count (Number) - steps in a run
whimsy-replay-steps =
    { $count ->
        [one] 1 step
       *[other] { $count } steps
    }
# $count (Number) - failed steps in a run
whimsy-replay-failed = { $count } failed
# $step (Number) - the step shown; $count (Number) - steps in the run
whimsy-replay-step-of = Step { $step } of { $count }
whimsy-replay-scrub =
    .aria-label = Steps
whimsy-replay-open = Open Page
whimsy-replay-copy = Copy Log
whimsy-replay-copied = Log copied
whimsy-replay-delete = Delete Run
whimsy-replay-no-thumb = No snapshot for this step
whimsy-replay-trimmed = This run was long, so its oldest steps were dropped.
# $error (String) - why the step failed
whimsy-replay-step-failed = Failed: { $error }
# $tool (String) - the Claude tool the step used
whimsy-replay-tool =
    { $tool ->
        [tabs_list] Listed tabs
        [tabs_create] Opened a tab
        [tabs_close] Closed a tab
        [navigate] Went to a page
        [read_page] Read the page
        [get_page_text] Read the page’s text
        [find] Searched the page
        [click] Clicked
        [type] Typed
        [key] Pressed keys
        [form_input] Filled in a field
        [scroll] Scrolled
        [screenshot] Took a screenshot
        [shield] Shield paused Claude
       *[other] { $tool }
    }

## wave5/quick: QR code for any page (Firefox's QR dialog)

whimsy-context-qrcode =
    .label = QR Code for Page
    .accesskey = Q
whimsy-action-qrcode = Show QR Code for Page

## wave5/quick: Copy page as Markdown (Zen's "Copy current URL as Markdown" stays as is)

whimsy-context-copy-page-markdown =
    .label = Copy Page as Markdown
    .accesskey = M
whimsy-context-copy-selection-markdown =
    .label = Copy Selection as Markdown
    .accesskey = M
whimsy-action-copy-page-markdown = Copy Page as Markdown
whimsy-copy-page-markdown-toast = Copied page as Markdown
whimsy-copy-selection-markdown-toast = Copied selection as Markdown
whimsy-copy-markdown-empty-toast = Nothing to copy as Markdown here

## wave5/quick: Markdown and CSV viewer (opened .md, .csv and .tsv files)

whimsy-doc-viewer-source = Source
whimsy-doc-viewer-preview = Preview
whimsy-doc-viewer-table = Table
whimsy-doc-viewer-contents = Contents
whimsy-doc-viewer-empty = This file is empty.
whimsy-doc-viewer-truncated = Showing the first 20,000 rows. Open the file in a spreadsheet app to see the rest.
whimsy-doc-viewer-too-large = This file is too large to preview, so here is its source.
# $words (Number) - words in the file
whimsy-doc-viewer-meta-markdown =
    { $words ->
        [one] Markdown · { $words } word
       *[other] Markdown · { $words } words
    }
# $kind (String) - CSV or TSV; $rows (Number) - data rows, without the header
whimsy-doc-viewer-meta-table =
    { $rows ->
        [one] { $kind } · { $rows } row
       *[other] { $kind } · { $rows } rows
    }

## wave5/quick: link lasso (Option-drag over links makes a folder)

# The live count beside the pointer while lassoing.
whimsy-link-lasso-count =
    { $count ->
        [0] No links
        [one] 1 link
       *[other] { $count } links
    }
# $name (String) - the new folder's name (the page's title)
whimsy-link-lasso-toast =
    { $count ->
        [one] Saved 1 link to “{ $name }”
       *[other] Saved { $count } links to “{ $name }”
    }
whimsy-link-lasso-private-toast = Link lasso doesn’t save links from private tabs

## wave5/quick: new season toast (once per season, with the costumed balloon)

whimsy-season-toast-autumn = Autumn is here
whimsy-season-toast-autumn-description = The balloon found a pumpkin
whimsy-season-toast-winter = Winter is here
whimsy-season-toast-winter-description = The balloon wrapped up warm
whimsy-season-toast-spring = Spring is here
whimsy-season-toast-spring-description = The balloon is wearing flowers
whimsy-season-toast-summer = Summer is here
whimsy-season-toast-summer-description = The balloon brought sunglasses

## wave5/verbs: do-with-selection verbs (Cmd+K)

whimsy-action-selection-verbs = Actions for Selection
# The command bar's group label above the verbs: the selected text (cut short).
whimsy-verbs-row-selection = “{ $text }”
# The same label when nothing is selected: the page's title.
whimsy-verbs-row-page = { $text }
whimsy-verb-translate = Translate
whimsy-verb-translate-page = Translate Page
# $engine (String) - the default search engine, e.g. Google
# $text (String) - the start of the selected text
whimsy-verb-search = Search { $engine } for “{ $text }”
# $text (String) - the start of the selected text
whimsy-verb-search-web = Search the Web for “{ $text }”
whimsy-verb-map = Show in Maps
whimsy-verb-email = Email
whimsy-verb-copy-markdown = Copy as Markdown
whimsy-verb-note = Add to Note
whimsy-verb-calendar = Add to Calendar
whimsy-verb-linear-new = New Linear Issue
whimsy-verb-linear-search = Search Linear
whimsy-verb-copied-toast = Copied as Markdown
whimsy-verb-note-toast = Added to Notes

## wave5/look: a look per space (font, density, tab titles, a Zen Mod)

whimsy-space-look-menu =
    .label = Look and Feel…
whimsy-space-look-form-button =
    .label = Look and Feel…
whimsy-space-look-title = Look and Feel
# $space (string) - the space's name
whimsy-space-look-subtitle = Just for “{ $space }”
whimsy-space-look-font = Interface font
whimsy-space-look-density = Density
whimsy-space-look-lines = Tab titles
whimsy-space-look-mod = Zen Mod
# $value (string) - what Settings uses, like "Normal" or "2 lines"
whimsy-space-look-follows = Settings: { $value }
whimsy-space-look-default = Default
    .title = Follow Settings → Look and Feel
whimsy-space-look-density-compact = Compact
whimsy-space-look-density-normal = Normal
whimsy-space-look-density-roomy = Roomy
# $lines (number) - how many lines a tab title may take
whimsy-space-look-lines-count =
    { $lines ->
        [one] 1 line
       *[other] { $lines } lines
    }
# $font (string) - the font chosen in Settings
whimsy-space-look-font-default =
    .label = Default ({ $font })
whimsy-space-look-font-default-system =
    .label = Default (System font)
whimsy-space-look-font-system =
    .label = System font
whimsy-space-look-mod-none =
    .label = None
whimsy-space-look-mod-hint = Mods you turn off in Zen Mods can be turned on here, just for this space.
whimsy-space-look-note = Default follows Settings → Look and Feel, so changing it there changes this space too.
whimsy-space-look-reset =
    .label = Reset to Default
whimsy-space-look-done =
    .label = Done
whimsy-look-density = Density
whimsy-look-density-compact =
    .label = Compact
whimsy-look-density-normal =
    .label = Normal
whimsy-look-density-roomy =
    .label = Roomy
whimsy-welcome-font-per-space = Want a different look for work and play? Any space can have its own font and density later: right-click it and choose Look and Feel.

## wave5: command registry. Every Whimsy command has one name, used in the
## command bar, in Settings → Keyboard Shortcuts (under "Whimsy") and in
## the shortcut cheat sheet. State-aware commands have a neutral name for
## their shortcut and a name per state in the command bar.

whimsy-action-capture = Capture…
whimsy-action-tab-next = Next Tab
whimsy-action-tab-prev = Previous Tab
whimsy-action-focus-sidebar = Focus Sidebar
whimsy-action-devmode-on = Turn On Developer Mode for This Site
whimsy-action-devmode-off = Turn Off Developer Mode for This Site
whimsy-action-vpn-toggle = Turn VPN On or Off
whimsy-action-allow-copy-toggle = Allow or Stop Allowing Copy and Paste
whimsy-action-join-next-meeting = Join Next Meeting
whimsy-action-snooze-tab = Snooze Tab…
whimsy-action-group-by-site = Group Tabs by Site
whimsy-action-mute-site-toggle = Mute or Unmute Site
whimsy-action-mute-site = Mute Site
whimsy-action-unmute-site = Unmute Site
whimsy-action-lock-space-toggle = Lock or Unlock This Space
whimsy-action-lock-space = Lock This Space
whimsy-action-unlock-space = Unlock This Space
whimsy-action-hide-space = Hide This Space
whimsy-action-tidy-tabs = Tidy Tabs
whimsy-action-follower-toggle = Turn Follower Split On or Off
whimsy-action-follow = Make This a Follower Split
whimsy-action-unfollow = Stop Following
whimsy-action-tab-volume = Tab Volume…

# wave5/uxfix: Settings → General heading for calendar connections.
whimsy-meeting-group-header = Meetings

# wave5/uxfix: Settings → Tab Management, the collapsed list of switches for
# features you start from the command bar or the tab menu.
whimsy-settings-features-summary = On-demand features

# wave5/uxfix: Fire Button. Rows pick what to forget; this button does it.
whimsy-fire-scopes = What to forget
# $site (string) - the current site's domain, e.g. example.com
whimsy-fire-forget-site =
    .label = Forget { $site }
whimsy-fire-forget-recent =
    .label = Forget Last 15 Minutes
whimsy-fire-forget-space =
    .label = Forget This Space
whimsy-fire-forget-everything =
    .label = Forget Everything
# Result toasts. $count (number) - tabs closed; $site (string) - the domain.
whimsy-fire-done-site = { $count ->
    [0] Forgot { $site }
    [one] Forgot { $site } · closed 1 tab
   *[other] Forgot { $site } · closed { $count } tabs
}
whimsy-fire-done-recent = { $count ->
    [0] Forgot the last 15 minutes
    [one] Forgot the last 15 minutes · closed 1 tab
   *[other] Forgot the last 15 minutes · closed { $count } tabs
}
whimsy-fire-done-space = { $count ->
    [0] Forgot this space’s site data
    [one] Forgot this space’s site data · closed 1 tab
   *[other] Forgot this space’s site data · closed { $count } tabs
}
whimsy-fire-done-everything = { $count ->
    [0] Forgot all browsing data
    [one] Forgot all browsing data · closed 1 tab
   *[other] Forgot all browsing data · closed { $count } tabs
}
whimsy-fire-failed-toast = Couldn’t clear everything. Try again.

# wave5/uxfix: read out with a pinned tab's unread badge.
# $count (number) - unread items the site reports
whimsy-tab-unread-description = { $count } unread

# wave5/uxfix: keeping Scratch asks in the window's sheet (it can't be undone).
whimsy-scratch-keep-confirm-title = Keep as a Normal Space?
whimsy-scratch-keep-confirm-accept = Keep Space

# wave5/uxfix: the Undo button on a result toast (Snooze, Hide Space).
whimsy-undo-toast-button =
    .label = Undo

## system: History's Show filter (All, Closed, Snoozed) in the Library

whimsy-history-show-filter = Show
whimsy-history-show-all = All
whimsy-history-show-closed = Closed
whimsy-history-show-snoozed = Snoozed
whimsy-history-closed-when = When did it close?
whimsy-history-search-closed =
    .placeholder = Search closed tabs
whimsy-history-search-snoozed =
    .placeholder = Search snoozed tabs
# $when - "today", "tomorrow" or "later"; $time (string) - like 6:40 PM;
# $day (string) - like Thursday, October 30
whimsy-history-snoozed-wakes =
    { $when ->
        [today] Wakes today at { $time }
        [tomorrow] Wakes tomorrow at { $time }
       *[later] Wakes { $day } at { $time }
    }
whimsy-history-snoozed-wake =
    .tooltiptext = Wake now
    .aria-label = Wake now
whimsy-history-snoozed-cancel =
    .tooltiptext = Cancel snooze
    .aria-label = Cancel snooze
whimsy-history-snoozed-empty = No snoozed tabs. To hide a tab until later, right-click it and choose Snooze.
whimsy-history-snoozed-no-match = No snoozed tabs match.
whimsy-action-view-snoozed = View Snoozed Tabs…
# $title (string) - the tab's title
whimsy-snooze-cancel-toast = “{ $title }” won’t come back on its own. It’s in History → Closed.

## system: Settings → Links, one pane for where links open

whimsy-pane-links-title = Links
whimsy-links-title = Links
whimsy-links-apps-header = Links from other apps
whimsy-links-apps-description = When you click a link in another app, open it in:
whimsy-links-glance-header = Glance
whimsy-links-split-header = Split view
whimsy-links-follower =
    .label = Follower splits: links in one pane open in the other
whimsy-links-follower-help = To start one, right-click a tab in a split and choose Make This a Follower Split.
whimsy-links-spaces-header = Spaces

## wave6/zap: Zap (erase page elements; Zen's zap mode as a command)

whimsy-action-zap = Zap Elements
whimsy-site-zap =
    .label = Zap Elements…
whimsy-site-zap-count =
    .label = { $count ->
        [one] Zap Elements… (1 zapped)
       *[other] Zap Elements… ({ $count } zapped)
    }
whimsy-year-finale-zapped = Things zapped

## wave6/zap: Link hints (keyboard-only clicking)

whimsy-action-link-hints = Link Hints
# The pill at the bottom of the page while hints show.
whimsy-link-hints-help = Type a hint to click · Shift opens in a new tab · Esc cancels
# Read by screen readers when hints appear.
whimsy-link-hints-open = { $count ->
    [one] 1 link hint. Type its letters to click it, add Shift to open a new tab, or press Escape to cancel.
   *[other] { $count } link hints. Type a hint’s letters to click it, add Shift to open a new tab, or press Escape to cancel.
}
whimsy-link-hints-closed = Link hints closed
whimsy-link-hints-none = No links to hint on this page

## wave6/search: Instant result (Shift+Enter in the command bar) and the
## Search Deck (flip through results in a Glance)

whimsy-instant-finding = Opening the top result…
whimsy-instant-none = No top result, so here’s the search
whimsy-search-deck-none = No results to flip through
whimsy-action-search-deck = Flip Through Results
whimsy-search-deck-bar =
    .aria-label = Search results
whimsy-search-deck-prev =
    .title = Previous result (⌥⌘←)
    .aria-label = Previous result
whimsy-search-deck-next =
    .title = Next result (⌥⌘→)
    .aria-label = Next result
# $index (number) - the result's place in the list; $title (string) - its title
whimsy-search-deck-dot =
    .title = { $title }
    .aria-label = Result { $index }: { $title }
# $index (number), $count (number), $site (string) - e.g. "2 of 8 · example.com"
whimsy-search-deck-position = { $index } of { $count } · { $site }
whimsy-search-header = Instant Results
whimsy-search-instant =
    .label = Shift+Enter on a search opens the top result
whimsy-search-deck =
    .label = Show it in a deck you can flip through
whimsy-search-deck-help = ⌥⌘→ and ⌥⌘← or a two-finger swipe over the card move between results. ⌘Enter keeps the card as a tab; Esc goes back to the results page. Results you flip past aren’t saved to history.

## wave6: Already open (Arc). Shown after Return on a typed address took you
## to the tab that already had it, in another space or window.
## $space - the space's name

whimsy-already-open-toast = Already open in { $space }
whimsy-already-open-toast-window = Already open in another window
whimsy-already-open-setting =
    .label = Go to a page that’s already open instead of opening it again

## wave6: Trails. Rows in the Back/Forward menu (long-press or right-click
## Back): pages a new click cut from Forward, and where the tab came from.
## $title - the page's title

whimsy-trail-origin =
    .label = Opened from { $title }
whimsy-trail-branch-tooltip = A page you left by going back. Click to open it again.
whimsy-trails-setting =
    .label = Keep pages you went back from in the Back and Forward menus

## wave6: Page actions. A pill in the address bar when the page describes one
## event, place, recipe, product or parcel (schema.org data).
## $name - what the page describes (event, place, recipe...), as the page names it
## $state - open, closed or unknown (the place's listed hours, now)

whimsy-page-action-event = Add to Calendar
whimsy-page-action-event-tooltip =
    .tooltiptext = Add “{ $name }” to Calendar
whimsy-page-action-place =
    { $state ->
        [open] Maps · Open now
        [closed] Maps · Closed
       *[unknown] Open in Maps
    }
whimsy-page-action-place-tooltip =
    .tooltiptext = Show { $name } in Maps
whimsy-page-action-recipe = Cook mode
whimsy-page-action-recipe-tooltip =
    .tooltiptext = Show the ingredients and steps for { $name }, large, and keep the screen on
whimsy-page-action-product = Watch price
whimsy-page-action-product-tooltip =
    .tooltiptext = Get an alert when the price of { $name } drops
whimsy-page-action-parcel = Track
whimsy-page-action-parcel-tooltip =
    .tooltiptext = Open the carrier’s tracking page
whimsy-page-action-calendar-toast = Opening the event in Calendar
## $price - the price shown on the page, formatted
whimsy-page-action-price-condition = The price drops below { $price }
whimsy-page-action-price-condition-any = The price drops
whimsy-cook-ingredients = Ingredients
whimsy-cook-steps = Steps
whimsy-cook-awake = Your screen stays on while this is open.
whimsy-page-actions-setting =
    .label = Show page actions in the address bar (add events to Calendar, open places in Maps, cook mode for recipes)

## wave6/parity: the Archive keeps every tab until Clear Archive (Arc's
## Archive menu is its History menu, so both items go there).

whimsy-action-clear-archive = Clear Archive
whimsy-menu-view-archive =
    .label = View Archive…
whimsy-menu-clear-archive =
    .label = Clear Archive
whimsy-archive-clear-title = Clear the Archive?
whimsy-archive-clear-message = Every archived tab is removed for good, along with Reopen Closed Tab’s list. Your history stays.
whimsy-archive-clear-button = Clear Archive
whimsy-archive-cleared-toast = Archive cleared

## wave6/parity: Arc's Split View commands (View menu) and keys.

whimsy-action-add-split-view = Add Split View
whimsy-action-close-split-pane = Close this Split Pane
whimsy-action-separate-page = Separate Page from Split View
whimsy-action-expand-split = Expand Current Split
whimsy-action-focus-pane-1 = Focus First Split Pane
whimsy-action-focus-pane-2 = Focus Second Split Pane
whimsy-action-focus-pane-3 = Focus Third Split Pane
whimsy-action-focus-pane-4 = Focus Fourth Split Pane
whimsy-action-prev-pane = Previous Split Pane
whimsy-action-next-pane = Next Split Pane
whimsy-menu-add-split-view =
    .label = Add Split View
whimsy-menu-close-split-pane =
    .label = Close this Split Pane
whimsy-menu-separate-page =
    .label = Separate Page from Split View
whimsy-menu-expand-split =
    .label = Expand Current Split

## wave6/parity: Arc's Edit menu (Copy URL variants, Paste and Match Style).

whimsy-action-copy-url-quote = Copy URL as Quote
whimsy-copy-quote-toast = Copied as a quote
whimsy-menu-copy-url =
    .label = Copy URL
whimsy-menu-copy-url-markdown =
    .label = Copy URL as Markdown
whimsy-menu-copy-url-quote =
    .label = Copy URL as Quote
whimsy-menu-paste-match-style =
    .label = Paste and Match Style

## wave6: Cmd+N makes a new space (BUILD-PLAN); New Window moves to Cmd+Opt+Shift+N.

whimsy-action-new-space = New Space…

## wave6/parity: Arc's menu bar names (WhimsyArcMenus) and missing items.

whimsy-action-capture-portrait = Capture in Portrait Mode
whimsy-action-toggle-toolbar = Show or Hide Toolbar
whimsy-action-show-toolbar = Show Toolbar
whimsy-action-hide-toolbar = Hide Toolbar
whimsy-action-reveal-tab = Reveal Tab in Sidebar
whimsy-menu-blank-window =
    .label = Blank Window
whimsy-menu-capture =
    .label = Capture…
whimsy-menu-capture-full-page =
    .label = Capture Full Page
whimsy-menu-capture-portrait =
    .label = Capture in Portrait Mode
# $action (string) - what Cmd+Z will undo: archive, pin, unpin, move or other
whimsy-menu-undo-action =
    .label =
        { $action ->
            [archive] Undo Archive Tab
            [pin] Undo Pin Tab
            [unpin] Undo Unpin Tab
            [move] Undo Move Tab
           *[other] Undo
        }
    .accesskey = U
whimsy-menu-hide-sidebar =
    .label = Hide Sidebar
whimsy-menu-show-sidebar =
    .label = Show Sidebar
whimsy-menu-show-toolbar =
    .label = Show Toolbar
whimsy-menu-hide-toolbar =
    .label = Hide Toolbar
whimsy-menu-new-space =
    .label = New Space…
whimsy-menu-edit-theme =
    .label = Edit Theme…
whimsy-menu-rename-space =
    .label = Rename Space
whimsy-menu-tabs =
    .label = Tabs
whimsy-menu-new-tab =
    .label = New Tab…
whimsy-menu-pin-tab =
    .label = Pin Tab
whimsy-menu-unpin-tab =
    .label = Unpin Tab
whimsy-menu-new-folder =
    .label = New Folder…
whimsy-menu-next-tab =
    .label = Next Tab
whimsy-menu-prev-tab =
    .label = Previous Tab
whimsy-menu-reveal-tab =
    .label = Reveal Tab in Sidebar
whimsy-menu-clear-today =
    .label = Clear Today
whimsy-menu-open-library =
    .label = Open Library…
whimsy-menu-view-downloads =
    .label = View Downloads…
whimsy-menu-essential-shortcuts =
    .label = Essential Keyboard Shortcuts
whimsy-cheatsheet-new-scratch = New Scratch Space
whimsy-cheatsheet-new-space = New Space…
whimsy-action-reset-space-tabs = Reset All Tabs in This Space
whimsy-action-view-media = View Media…
whimsy-action-view-boosts = View Boosts…
whimsy-menu-reset-space-tabs =
    .label = Reset All Tabs in This Space
whimsy-menu-view-media =
    .label = View Media…
whimsy-menu-view-boosts =
    .label = View Boosts…

## fix7/game: the offline error page game

whimsy-game-hint-embedded = Arrows, WASD or pointer to steer · Space or click to dash · Esc goes back to the error page

## fix7: Mini Whimsy space dropdown (caret, Cmd+Shift+O)
whimsy-quick-window-picker-caption =
    .label = Open in

# fix7/tabs: People card actions.
whimsy-person-open = Open Profile
whimsy-person-copy = Copy Link
whimsy-person-copied = Copied

## fix7/folders: Statuses submenu on the Linear and Jira live folders.

whimsy-live-folder-option-statuses =
    .label = Statuses
whimsy-live-folder-linear-state-triage =
    .label = Triage
whimsy-live-folder-linear-state-backlog =
    .label = Backlog
whimsy-live-folder-linear-state-unstarted =
    .label = Todo
whimsy-live-folder-linear-state-started =
    .label = In Progress
whimsy-live-folder-linear-state-completed =
    .label = Done
whimsy-live-folder-linear-state-canceled =
    .label = Canceled
whimsy-live-folder-linear-state-duplicate =
    .label = Duplicate
whimsy-live-folder-jira-category-new =
    .label = To Do
whimsy-live-folder-jira-category-indeterminate =
    .label = In Progress
whimsy-live-folder-jira-category-done =
    .label = Done
whimsy-live-folder-jira-category-undefined =
    .label = No Category

## wave5/audioicon: the tab speaker's name (always shown, so always named)

whimsy-tab-audio-mute = Mute tab
whimsy-tab-audio-unmute = Unmute tab

# fix7 settings: command bar actions for History, Liquid Glass and Glance size.
whimsy-action-view-history = View History
whimsy-action-liquid-glass-on = Turn Liquid Glass On
whimsy-action-liquid-glass-off = Turn Liquid Glass Off
whimsy-action-glance-size-compact = Glance Size: Compact
whimsy-action-glance-size-standard = Glance Size: Standard
whimsy-action-glance-size-wide = Glance Size: Wide

# fix/panes: breadcrumbs on Firefox's sub-pages (Containers, Browser icon),
# whose parent pane is now Zen's.
whimsy-pane-looks-crumb =
    .label = Look and Feel
whimsy-pane-tabs-crumb =
    .label = Tab Management

## wave7/native1: Add to Calendar saves straight into macOS Calendar

whimsy-verb-calendar-added-toast = Added to Calendar
