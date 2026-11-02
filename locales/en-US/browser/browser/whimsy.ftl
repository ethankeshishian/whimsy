# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# Whimsy's own strings, linked into the browser window and Settings.

## After an update (sidebar notification; see ZenSidebarNotification.mjs)

whimsy-updated-heading = { -brand-short-name } updated
whimsy-rolled-back-heading = Rolled back to the previous version
whimsy-updated-notes-label = What’s new
whimsy-updated-rollback-label = Something broke? Roll back
# Built from the link ids by Zen's sidebar notification (<id>-label, <id>-tooltip).
whimsy-updated-notes-tooltip =
    .title = See what changed
whimsy-updated-settings-label = Update settings
whimsy-updated-settings-tooltip =
    .title = Open update settings

## Settings → Look and Feel → Updates

whimsy-updates-channel = Channel
whimsy-updates-channel-release =
    .label = Release
whimsy-updates-channel-dev =
    .label = Dev
whimsy-updates-channel-release-note = Tested builds, published each night.
whimsy-updates-channel-dev-note = Every change as soon as it’s built. Expect rough edges.
whimsy-updates-show-log =
    .label = Show log
whimsy-updates-hide-log =
    .label = Hide log
whimsy-updates-rollback =
    .label = Roll back to { $version }
whimsy-updates-rollback-none =
    .label = Roll back
whimsy-updates-rollback-confirm-title = Roll back?
whimsy-updates-rollback-confirm = { -brand-short-name } will close, switch back to { $version }, and reopen with your tabs. Automatic updates skip the version you’re leaving.
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
    .tooltiptext = Add your Jira site in the folder’s options.
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
    .tooltiptext = Add a personal API key, or sign in to linear.app in this space’s profile.
    .label = Linear API key not accepted
    .tooltiptext = Paste a new personal API key, or remove the key from this folder’s menu and sign in to linear.app instead.
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

# $stripped is "yes" only when Copy Clean Link's list actually removed
# tracking parameters from at least one copied link. W10-33: Arc's wording
# ("Copied Current URL"); Arc doesn't strip trackers, so "without Trackers"
# is Whimsy's, said only when something was removed.
# $count (number) - how many links were copied
whimsy-copy-toast =
    { $stripped ->
        [yes]
            { $count ->
                [one] Copied Current URL without Trackers
               *[other] Copied Current URLs without Trackers
            }
       *[no]
            { $count ->
                [one] Copied Current URL
               *[other] Copied Current URLs
            }
    }
whimsy-copy-markdown-toast =
    { $stripped ->
        [yes]
            { $count ->
                [one] Copied Current URL as Markdown without Trackers
               *[other] Copied Current URLs as Markdown without Trackers
            }
       *[no]
            { $count ->
                [one] Copied Current URL as Markdown
               *[other] Copied Current URLs as Markdown
            }
    }
# The same, when the tab menu copied a tab that isn't the current one.
whimsy-copy-other-toast =
    { $stripped ->
        [yes]
            { $count ->
                [one] Copied URL without Trackers
               *[other] Copied URLs without Trackers
            }
       *[no]
            { $count ->
                [one] Copied URL
               *[other] Copied URLs
            }
    }
whimsy-copy-markdown-other-toast =
    { $stripped ->
        [yes]
            { $count ->
                [one] Copied URL as Markdown without Trackers
               *[other] Copied URLs as Markdown without Trackers
            }
       *[no]
            { $count ->
                [one] Copied URL as Markdown
               *[other] Copied URLs as Markdown
            }
    }
# W10-63 (Arc): the Copy URL toast's offer when text is selected on the
# page; it copies a Link to Highlight (a link to the selected text).
whimsy-copy-highlight-offer = Share a link directly to this text instead?
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

## W10-28: Settings → AI (its own pane, like Arc's Max tab). Enable AI
## replaced "Turn off all AI features" (its meaning flipped, so the old
## string id is retired).

whimsy-pane-ai-title = AI
whimsy-ai-enable =
    .label = Enable AI
    .description = Whimsy’s AI features and Firefox’s. Turn off to block them all and remove downloaded models. Translations keep working.
whimsy-ai-off-note = AI is off. Turn on Enable AI to use anything below.
whimsy-ai-locked-note = Your organization manages this setting.
whimsy-ai-provider-heading = Provider
whimsy-ai-features-heading = Features
whimsy-ai-claude-heading = Claude in Whimsy
whimsy-ai-provider-apple-title = Apple Intelligence
whimsy-ai-provider-claude-title = Claude
whimsy-ai-provider-ollama-title = Ollama
whimsy-ai-provider-local = On this Mac
whimsy-ai-provider-key = Your API key
whimsy-ai-field-status = Status
whimsy-ai-apple-open-settings =
    .label = Open System Settings
whimsy-ai-firefox-chatbot =
    .value = Firefox chatbot
whimsy-ai-firefox-chatbot-off =
    .label = Off
whimsy-ai-firefox-link-previews =
    .label = Firefox link previews
whimsy-ai-firefox-tab-groups =
    .label = Suggest tab groups
whimsy-claude-fieldset =
    .aria-label = Claude in Whimsy

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

## Per-tab volume (right-click on a tab's speaker, or the command bar)

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
# W10-41: shown when a page that blocks copying also cancels the right-click menu.
whimsy-allow-copy-offer-toast = This site blocks right-click and copying
whimsy-allow-copy-offer-action = Allow Copy and Paste

## Internet Archive (notification bar and command bar)

whimsy-action-open-archive = Open in Wayback Machine
# wave9/secfix: the offer comes first; nothing goes to archive.org until "Find Copy".
# W10-15: a toast in the top corner, owned by the tab. Its second line is
# short enough to read in full. The Wayback Machine is the Internet
# Archive's name for its saved web pages.
whimsy-archive-toast = Page didn’t load
whimsy-archive-toast-detail = Try a saved copy from the Wayback Machine
whimsy-archive-look = Find Copy
whimsy-archive-looking = Asking the Wayback Machine…
whimsy-archive-looking-button = Finding
whimsy-archive-found = Showing a saved copy
# $date (string) - e.g. "March 12, 2024"
whimsy-archive-found-date = From the Wayback Machine, { $date }
whimsy-archive-none-toast = The Wayback Machine has no copy of this page
whimsy-archive-error = Couldn’t reach the Wayback Machine
whimsy-archive-error-detail = Check your connection and try again.
whimsy-archive-retry = Try Again

## Translate selection (shortcut and command bar)

whimsy-action-translate-selection = Translate Selection

## Glance

whimsy-action-split-glance = Split Glance
whimsy-translate-none-toast = Select some text to translate

## Split view (command bar; batch6)

whimsy-action-close-other-panes = Expand Current Split
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
# wave9/designfix (L5): New Notion Page, New Google Doc and New Word
# Document also match this when typed in the command bar.
whimsy-action-new-document-keyword = New Document

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
    .title = Type or paste a hex color; the space changes as you type. Add two digits for opacity, like #5B8CFF80. Esc undoes.
    .aria-label = Hex color
whimsy-hex-well =
    .title = Pick a color
    .aria-label = Pick a color
whimsy-hex-add =
    .tooltiptext = New color (Return)
    .aria-label = New color
whimsy-hex-copy =
    .tooltiptext = Copy hex
    .aria-label = Copy hex color
# $hex (String) - a hex color, like #5B8CFF
whimsy-hex-copied = Copied { $hex }
# $hex (String) - a hex color, like #5B8CFF
whimsy-hex-edit-color =
    .title = Edit { $hex }
    .aria-label = Edit color { $hex }
# $hex (String) - a hex color, like #5B8CFF
whimsy-hex-remove-color =
    .tooltiptext = Remove { $hex }
    .aria-label = Remove color { $hex }

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
    .label = Show icons in right-click menus, like macOS 26
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
    .label = Keep closed tabs in the Archive (History → Archive, or “View Archive…”)
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
whimsy-action-fire-button = Fire Button…
# wave7/fire: per-site forgetting, moved out of the Fire Button sheet.
whimsy-action-forget-site = Forget About This Site…
whimsy-action-heavy-tabs = Find Heavy Tabs

## batch8: tab lifecycle — Archive view panel


## batch8: tab lifecycle — Snooze a tab

tab-context-whimsy-snooze =
    .label = Snooze…
    .accesskey = z
whimsy-snooze-panel =
    .aria-label = Snooze tab
whimsy-snooze-later-today = Later Today
whimsy-snooze-tonight = Tonight
whimsy-snooze-tomorrow = Tomorrow
# $next (string) - "true" on a Saturday or Sunday, when it means the next one
whimsy-snooze-weekend =
    { $next ->
        [true] Next Weekend
       *[other] This Weekend
    }
whimsy-snooze-next-week = Next Week
# $title (string) - the tab's title
whimsy-snooze-wake-toast = “{ $title }” is back

## batch8: tab lifecycle — Fire button

whimsy-fire-panel =
    .aria-label = Fire button
# wave7/fire: two rows, in the user's words; the line under each says
# exactly what's removed.
whimsy-fire-profile = Fire in This Profile
whimsy-fire-everything = Fire Everywhere

## batch8: tab lifecycle — Find heavy tabs

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

# W11-15: Settings → Tab Management, one row that opens the Hidden Spaces panel.
# $count (number) - how many spaces are hidden
whimsy-hidden-spaces-count = Hidden spaces · { $count }
whimsy-hidden-spaces-description = Spaces you hid stay out of the switcher with their tabs kept.
whimsy-hidden-spaces-button =
    .label = Show…

## Archive (hide) a space — batch9: spaces

whimsy-hide-space =
    .label = Hide This Space
# $space (string) - the space's name
whimsy-hide-space-toast = “{ $space }” is hidden
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
## batch9p: the Private Space (a temporary private space; "Scratch" in code) and private tabs

whimsy-scratch-name = Private Space
whimsy-menu-new-scratch =
    .label = New Private Space
whimsy-menu-new-private-tab =
    .label = New Private Tab
whimsy-scratch-save =
    .label = Save as a Normal Space…
whimsy-scratch-close =
    .label = Close Private Space
whimsy-action-new-private-tab = New Private Tab
whimsy-action-new-scratch = New Private Space
whimsy-action-save-scratch = Save Private Space as a Normal Space…
whimsy-action-close-scratch = Close Private Space
# fix7/private: the one sentence of the modal dialog shown before the Private Space becomes a normal space.
whimsy-scratch-save-confirm = Its pages reopen as normal tabs, outside private browsing, and it can’t be made private again.
whimsy-private-tab-no-pin = Private tabs can’t be pinned
whimsy-scratch-kept-toast =
    { $count ->
        [0] Private Space is now a normal space
       *[other] Private Space is now a normal space. Its pages reopened outside private browsing.
    }
whimsy-private-header =
    .label = Private browsing
whimsy-private-in-window =
    .label = Browse privately inside this window
    .description = { -brand-short-name } opens a Private Space, a temporary space that’s never saved, with ⌘⇧N, and a private tab in the current space with ⌥⌘T. Private tabs keep no history and forget their cookies when the last one closes. Turn this off to use private windows instead.
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
    .tooltiptext = Delete
# W10-24: the empty state's hint. $key (string) - Capture's shortcut, like ⇧⌘2
whimsy-library-files-empty-hint = Press { $key } to capture part of a page.
whimsy-library-shot-size =
    .aria-label = Thumbnail size
## batch12: links & media windows (Mini Whimsy, Arc's "Little Arc")

whimsy-action-quick-window = New Mini Whimsy
# wave10/mini W10-13: $count is how many pages Mini holds (all of them move).
whimsy-quick-window-move-to-space =
    .label =
        { $count ->
            [one] Open in { $space }
           *[other] Open { $count } Tabs in { $space }
        }
    .tooltiptext =
        { $count ->
            [one] Open in { $space } (Cmd+O)
           *[other] Open all { $count } tabs in { $space } (Cmd+O)
        }
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
whimsy-split-favorite-name-prompt = Name this split, so it’s easy to find later:
whimsy-split-favorite-saved-toast = Split saved to your favorites
whimsy-split-favorites-empty =
    .value = No favorite splits yet. Favorite one from a pane’s ⋯ menu.
whimsy-split-favorite-remove =
    .label = Remove
    .tooltiptext = Remove this favorite

## Bionic reading (Reader View toolbar button)

whimsy-bionic-reading-toggle =
    .title = Bionic reading: bolds the start of each word

## Menu bar extra (macOS status bar icon)

whimsy-menu-bar-extra-quick-window =
    .label = New Mini Whimsy
whimsy-menu-bar-extra-no-recent-tabs =
    .label = No Recently Closed Tabs

## Settings → Look and Feel → Look: menu bar extra

whimsy-look-menu-bar-extra =
    .label = Show a menu bar icon for Mini Whimsy and recent tabs
## batch7: Settings → Look and Feel → Look

whimsy-look-seasonal-themes =
    .label = Seasonal touches
whimsy-look-seasonal-themes-description = The balloon dresses for the season, and the new tab bar, Balloon Dash, the changelog and loading bar get seasonal art (Halloween and the winter holidays too).

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
    .placeholder = Search shortcuts or keys, like “⇧⌘D”
    .aria-label = Search shortcuts
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
    .description = Claude Code can open, read and use tabs in the Claude space. Tabs it uses glow and show a Stop button. Only apps on this Mac with the token below can connect.
whimsy-claude-whole-browser =
    .label = Let Claude use any tab, not just the Claude space
    .description = Private tabs and the Private Space are always off-limits, and so are passwords.
whimsy-claude-ask =
    .label = Ask before Claude clicks, types or fills in forms on a new site
whimsy-claude-ai-blocked = Claude is unavailable while AI is off.
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
whimsy-meeting-apple-title = Apple Calendar
whimsy-meeting-apple-connect = Connect
whimsy-meeting-apple-allow = Allow access
whimsy-meeting-apple-open-settings = Open System Settings
whimsy-meeting-apple-denied = { -brand-short-name } can’t read your calendars. Turn it on in System Settings → Privacy & Security → Calendars.
whimsy-meeting-apple-unsupported = Apple Calendar is unavailable. Update { -brand-short-name } to try again.
whimsy-meeting-google-title = Google Calendar
whimsy-meeting-google-error = Couldn’t load this calendar. Check its address.
whimsy-meeting-google-placeholder =
    .placeholder = Paste a secret iCal address
whimsy-meeting-google-help = Where do I find it?
whimsy-meeting-google-add-confirm = Add
whimsy-meeting-google-invalid = Paste the secret address. It starts with https://

whimsy-meeting-description = Join upcoming calls from the sidebar or command bar.
whimsy-meeting-enable =
    .label = Enable meetings
whimsy-meeting-card-enable =
    .label = Show upcoming meetings in the sidebar
# wave2: Mini Whimsy without an available destination.
whimsy-quick-window-no-space =
    .label = Open in…
## ext: per-space extensions

whimsy-space-extensions-header = Extensions per profile
whimsy-space-extensions-toggle =
    .label = Run extensions only in the profiles you choose
whimsy-space-extensions-help = Choose with Run in Profiles on an extension’s menu. Outside those profiles it can’t see your tabs or run on pages. It’s still installed once, so its settings and saved data are shared by every profile.
whimsy-space-extensions-menu =
    .label = Run in Profiles
whimsy-space-extensions-all =
    .label = All Profiles
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
whimsy-home-blurb = Arc’s flow, built on Zen and Firefox. Spaces, splits and the shortcuts your hands already know.
whimsy-home-hero-hint = Psst: the balloon likes a poke.
whimsy-home-balloon =
    .aria-label = Poke the balloon
whimsy-home-features-title = What makes Whimsy, Whimsy
whimsy-home-feature-spaces-title = A space for everything
whimsy-home-feature-spaces-text = Work, home and side quests each get their own tabs, colors and pinned sites.
whimsy-home-feature-keys-title = Arc’s shortcuts, kept
whimsy-home-feature-keys-text = Ctrl+Tab, the command bar and the keys you already reach for.
whimsy-home-feature-split-title = Side by side, or a peek
whimsy-home-feature-split-text = Split the window between pages, or glance at a link without leaving yours.
whimsy-home-feature-quiet-title = Quiet by design
whimsy-home-feature-quiet-text = No accounts and no telemetry. It’s your browser, not ours.
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
whimsy-changelog-blurb = What’s new in each build, newest first.
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

# home: changelog version heading. (W11-07: the homepage switch that sat
# here is gone; Settings → Home and startup has the one control.)
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
whimsy-vpn-status-unavailable = Not available — Firefox isn’t offering its built-in VPN to this browser right now
whimsy-vpn-status-starting = Starting…
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
# W10-50: the VPN panel can't open yet, or "Get started" didn't finish.
whimsy-vpn-off-hint = Turn on VPN in Settings first
whimsy-vpn-unavailable-toast = Firefox’s built-in VPN isn’t available to this browser right now
whimsy-vpn-starting-toast = The VPN is still starting. Try again in a moment.
whimsy-vpn-enroll-region = Firefox’s built-in VPN isn’t offered in your country or region yet
whimsy-vpn-enroll-account = Your Mozilla account can’t use Firefox’s built-in VPN yet
whimsy-vpn-enroll-network = Couldn’t reach Mozilla’s VPN service. Check your connection and try again.
whimsy-vpn-enroll-failed = Couldn’t finish setting up Firefox’s built-in VPN. Try again from the VPN panel.

# vpnspace: extend the native Firefox VPN panel and toolbar button.
whimsy-vpn-scope-title = Protect
whimsy-vpn-scope-browser = All spaces
whimsy-vpn-scope-space = This space
whimsy-vpn-scope-help = Protects this space’s tabs, and any other space set up to share it — not tabs elsewhere. Tabs already open switch over once you reload them, and your site exceptions still apply.
whimsy-vpn-scope-no-container = This space uses the Default profile, so it can’t be protected on its own. Give it another profile with Set Profile on the space’s menu to protect just this space.
whimsy-vpn-scope-covered = Spaces with VPN enabled: { $spaces }
whimsy-vpn-scope-all = VPN enabled for all spaces.
whimsy-vpn-scope-button-off = VPN off
whimsy-vpn-scope-button-connecting = VPN connecting
whimsy-vpn-scope-button-browser = VPN on · All spaces
whimsy-vpn-scope-button-space = VPN on · This space
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
whimsy-privacy-dns = <strong>Cloudflare</strong>: in some countries, Firefox’s DNS over HTTPS turns on by itself and sends lookups to Cloudflare’s resolver for Mozilla. Change it in Settings → Privacy & Security.
whimsy-privacy-zen = <strong>Zen</strong>: when you share a space or folder, its tab titles and links go to Zen’s share server, and anyone with the link can open it for 30 days. Zen Mods come from Zen’s mod store.
whimsy-privacy-apple = <strong>Apple</strong>: captive.apple.com, to check that you’re online and to spot Wi-Fi sign-in pages. macOS makes the same check.
whimsy-privacy-google = <strong>Google</strong>: Safe Browsing lists and checks of downloaded apps.
whimsy-privacy-updates = <strong>GitHub</strong>: Whimsy’s updates.
whimsy-privacy-search = <strong>Your search engine</strong>: what you search for, as with any browser.

# Settings → Home → Homepage and new windows: the built-in choice, which is
# Whimsy's home (about:whimsy) rather than Firefox Home.
whimsy-home-mode-choice-default =
    .label = Whimsy Home (Default)
# W11-07: Firefox's new tab page, still a choice for new windows and new
# tabs. It's Firefox's, so it keeps Firefox's name.
whimsy-home-mode-choice-firefox =
    .label = Firefox Home
# W11-07: Whimsy Home as a choice for new tabs, where Firefox Home stays the
# default (Firefox's own "Firefox Home (Default)").
whimsy-home-mode-choice-whimsy =
    .label = { -brand-short-name } Home
# W11-07: the choices as the command bar names them ("New Tab Page: Firefox Home").
whimsy-home-choice-whimsy = { -brand-short-name } Home
whimsy-home-choice-firefox = Firefox Home
whimsy-home-choice-blank = Blank Page

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
whimsy-bangs-invalid = Line { $line } isn’t a valid shortcut. Use !shortcut and an http or https URL with { "{{{s}}}" } once, and don’t repeat a shortcut. Nothing was saved.
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
# $query (string) - what was typed
whimsy-cheatsheet-empty = No shortcuts match “{ $query }”.
whimsy-cheatsheet-empty-hint = Search by name, menu, or keys like “cmd shift d”.

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
whimsy-heavy-tabs-title = Heavy Tabs
whimsy-heavy-tabs-subtitle = Memory use, updated every few seconds
whimsy-heavy-tabs-measuring = Measuring…
whimsy-heavy-tabs-empty = No tabs to measure right now.
whimsy-split-favorites-title = Favorite Splits
whimsy-split-favorites-empty-state = No favorite splits yet. Open a split, then choose “Favorite This Split…” from a pane’s ⋯ menu.
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
whimsy-useragent-custom-field =
    .placeholder = Mozilla/5.0 …
    .aria-label = Custom user agent
whimsy-useragent-custom-apply =
    .label = Apply
whimsy-cheatsheet-title = Keyboard Shortcuts
whimsy-cheatsheet-edit-button =
    .label = Edit Shortcuts…
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
whimsy-cheatsheet-unsplit = Separate All Tabs
whimsy-cheatsheet-swap-panes = Swap Panes
whimsy-cheatsheet-close-other-panes = Expand Current Split
whimsy-cheatsheet-find = Find in Page
whimsy-cheatsheet-reader = Reader View
whimsy-cheatsheet-copy-full-page = Capture Full Page
whimsy-cheatsheet-capture = Capture…
whimsy-cheatsheet-translate = Translate Selection
whimsy-cheatsheet-speed-up = Play Faster
whimsy-cheatsheet-slow-down = Play Slower
whimsy-cheatsheet-new-window = New Window
whimsy-cheatsheet-quick-window = Mini Whimsy

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
whimsy-welcome-transparency-description = { -brand-short-name } can let your wallpaper glow softly through the sidebar. Pick one to try it. You can always change it later.
whimsy-welcome-transparency-solid = <strong>NO</strong>, keep it solid.
whimsy-welcome-transparency-subtle = <strong>A LITTLE</strong>, just a hint of my wallpaper.
whimsy-welcome-transparency-glassy = <strong>A LOT</strong>, make it glassy.
whimsy-welcome-font-title = Pick your interface font.
whimsy-welcome-font-description = Tabs, menus and the address bar use it. Websites keep their own fonts. You can always change it later.
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
    .description = Hand off the page you’re on through macOS Handoff. Only its address is shared; private tabs and the Private Space are never offered.

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
whimsy-ai-apple-status-apple-needs-tools = Whimsy couldn’t find Swift (swiftc) in { $detail }. Install Apple’s command line tools with “xcode-select --install” in Terminal, then check again.
whimsy-ai-apple-status-apple-tools-outdated = Your command line tools don’t include the macOS 26 SDK that Apple Intelligence needs. Update them in System Settings → General → Software Update (or update Xcode), then check again.
whimsy-ai-apple-status-apple-needs-license = Xcode’s license hasn’t been accepted yet. Run “sudo xcodebuild -license accept” in Terminal, then check again.
whimsy-ai-apple-status-apple-tools-path-invalid = Developer tools path is invalid. Run “sudo xcode-select --reset” in Terminal, then check again.
whimsy-ai-apple-status-apple-helper-blocked = macOS didn’t let the Apple Intelligence helper start. Click Check Again; if it keeps happening, allow it in System Settings → Privacy & Security.
whimsy-ai-apple-status-apple-build-failed = Couldn’t build the Apple Intelligence helper with the Swift tools on this Mac. The compiler’s message is below. Updating the command line tools (System Settings → General → Software Update) or Xcode usually fixes it.
whimsy-ai-apple-status-apple-tools-mismatch = Your Swift compiler is older than the macOS SDK beside it: an update changed one but not the other. Update the command line tools in System Settings → General → Software Update (or update Xcode), then check again.
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
whimsy-ai-error-apple-tools-path-invalid = Reset developer tools path with “sudo xcode-select --reset”.
whimsy-ai-error-apple-needs-license = Accept Xcode’s license to use Apple Intelligence. See Settings → Privacy & Security.
whimsy-ai-error-apple-build-failed = Couldn’t build the Apple Intelligence helper. See Settings → Privacy & Security.
whimsy-ai-error-apple-helper-blocked = macOS didn’t let the Apple Intelligence helper start. See Settings → Privacy & Security.
whimsy-ai-error-apple-tools-mismatch = Apple Intelligence needs matching Swift tools. See Settings → Privacy & Security.
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
whimsy-preview-not-ready = Set up an AI provider in Settings → AI to see previews.

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
# wave9/menus (design-full-4 L4): named like the tab menu's row.
whimsy-action-watch-page = Watch This Page…
whimsy-action-stop-watching-page = Stop Watching This Page
whimsy-action-watch-page-toggle = Watch or Stop Watching This Page
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
whimsy-space-extensions-picker = Run in Profiles
whimsy-space-extensions-all-text = All Profiles
whimsy-space-extensions-shared-note = Installed once: its settings and saved data are shared by every profile, and it can still read history and downloads from all of them.

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
whimsy-quick-window-copy-link =
    .tooltiptext = Copy URL (Cmd+Shift+C)
    .aria-label = Copy URL

whimsy-quick-window-profile = ☺ Default
whimsy-quick-window-profile-button = { $profile }
    .aria-label = Profile: { $profile }
    .title = Profile: { $profile }. Choose another profile for this page.
whimsy-history-unknown-space = Unknown space

## wave5: seasonal Balloon Dash (the seed hazard wears the season's costume)

whimsy-game-death-seed-autumn = Caught by a falling leaf.
whimsy-game-death-seed-winter = Caught by a snowflake.
whimsy-game-death-seed-spring = Buzzed by a bumblebee.

## wave7/season: Balloon Dash at Halloween (bats fly where birds do)

whimsy-game-death-bird-halloween = A bat wanted a closer look.

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
whimsy-note-block-private = Private tabs can’t be embedded
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
    .description = Each run’s steps and small page snapshots stay on this device. Private tabs and the Private Space are never recorded; clearing history clears it.
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
    .label = Copy as Markdown
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

## wave5: Redact, a toggle in the screenshot panel beside Visible and Full Page

whimsy-redact-button = Redact
    .title = Hide text in the screenshot. Emails, phone numbers, keys and card numbers are hidden for you; click any text to hide or show it.
# W10-57: the row under the bar while Redact is on.
whimsy-redact-hint = Click text to hide or show it
whimsy-redact-style =
    .aria-label = How hidden text looks
whimsy-redact-style-black = Black Out
whimsy-redact-style-blur = Blur
# W10-57: the command (command bar, Settings → Keyboard Shortcuts).
whimsy-action-capture-redact = Capture and Redact…
# W10-59: a tile beside Visible and Full Page; the page as a phone shows it.
whimsy-portrait-button = Portrait
    .title = Capture the page as a phone shows it

## wave5/look: a look per space (font, density, tab titles, a Zen Mod)

# wave9/designfix (L4): the space menu row's name, shared by every string
# that tells you to use it, so they can't drift apart.
-whimsy-edit-look = Edit Look…
whimsy-space-look-menu =
    .label = { -whimsy-edit-look }
    .label = Edit Space Look…
whimsy-space-look-form-button =
    .label = { -whimsy-edit-look }
# The command bar's name for opening the current space's look editor.
whimsy-action-space-look = Edit Space Look…
# W8-36: the look editor, an overlay like Zen's theme picker.
# $space (string) - the space's name
whimsy-space-look-title = Look for “{ $space }”
whimsy-space-look-title-unnamed = Look
# A type specimen drawn in the chosen font.
whimsy-space-look-specimen = Aa
whimsy-space-look-specimen-sample = The quick brown fox jumps over the lazy dog
whimsy-space-look-font = Font
whimsy-space-look-font-search =
    .placeholder = Search fonts
    .aria-label = Search fonts
whimsy-space-look-font-system = System font
whimsy-space-look-font-empty = No fonts match
whimsy-space-look-density = Density
whimsy-space-look-lines = Tab titles
whimsy-space-look-mod = Zen Mod
# Beside a control that follows Settings → Look and Feel.
whimsy-space-look-default-tag = Browser default
whimsy-space-look-use-default = Use browser default
    .title = Follow Settings → Look and Feel again
whimsy-space-look-density-compact = Compact
whimsy-space-look-density-normal = Normal
whimsy-space-look-density-roomy = Roomy
# $lines (number) - how many lines a tab title may take
whimsy-space-look-lines-count =
    { $lines ->
        [one] 1 line
       *[other] { $lines } lines
    }
whimsy-space-look-mod-none = None
whimsy-space-look-mod-hint = Mods you turn off in Zen Mods can be turned on here, just for this space.
whimsy-space-look-reset =
    .label = Reset
    .tooltiptext = Use the browser default for everything
whimsy-space-look-cancel =
    .label = Cancel
whimsy-space-look-done =
    .label = Done
whimsy-look-density = Density
whimsy-look-density-compact =
    .label = Compact
whimsy-look-density-normal =
    .label = Normal
whimsy-look-density-roomy =
    .label = Roomy
whimsy-welcome-font-per-space = Want a different look for work and play? Any space can have its own font and density later: right-click it and choose { -whimsy-edit-look }

## wave5: Easel (Arc's Easels)

whimsy-easel-enable =
    .label = Easels: a canvas for notes, drawings, images and live captures
whimsy-action-new-easel = New Easel
whimsy-easel-capture-button = Add to Easel
    .title = Add this capture to an easel
# W10-24: the Add to Easel picker (a surface with thumbnails).
whimsy-easel-picker-heading = Add to Easel
whimsy-easel-picker-live = Live capture
whimsy-easel-picker-still = Screenshot
# $width, $height (number) - the capture's size in pixels
whimsy-easel-picker-size-live = { $width } × { $height } · updates when you refresh the easel
whimsy-easel-picker-size-still = { $width } × { $height }
whimsy-easel-picker-new-tile = New Easel
whimsy-easel-picker-first = Easels are boards for captures, notes and drawings. Your first one will start with this capture.
# $when (string) - "2 hours ago", "yesterday", "Oct 12"
whimsy-easel-edited = Edited { $when }
whimsy-easel-open = Open
# $title (String) - the easel's name
whimsy-easel-capture-added = Added to { $title }
whimsy-easel-capture-private = Captures from private tabs can't be added to an easel
whimsy-easel-new-private = Easels can't be made in private browsing
whimsy-easel-untitled = Untitled Easel
whimsy-easel-heading = Easel
whimsy-easel-text-placeholder = Type something
whimsy-easel-keyboard-help = Tools: V select, T text, P pen, H highlighter, R rectangle, O ellipse, L line, A arrow, I image. Enter adds text or a shape at the center, or opens the selected item. Tab moves between items, arrow keys move them, Option with arrows resizes them, Shift with arrows goes further. Delete removes. Command Z undoes, Command Shift Z redoes. Command R refreshes live captures.

whimsy-easel-title-input =
    .placeholder = Untitled Easel
    .aria-label = Easel name
whimsy-easel-history-group =
    .aria-label = History
whimsy-easel-undo =
    .title = Undo (⌘Z)
    .aria-label = Undo
whimsy-easel-redo =
    .title = Redo (⇧⌘Z)
    .aria-label = Redo
whimsy-easel-zoom-group =
    .aria-label = Zoom
whimsy-easel-zoom-out =
    .title = Zoom out (⌘−)
    .aria-label = Zoom out
whimsy-easel-zoom-in =
    .title = Zoom in (⌘=)
    .aria-label = Zoom in
# $percent (Number) - the current zoom
whimsy-easel-zoom-reset =
    .title = Reset zoom to 100% (⌘0)
    .aria-label = { $percent }%, reset zoom
whimsy-easel-share = Export
    .title = Export or copy this easel
whimsy-easel-share-menu =
    .aria-label = Export
whimsy-easel-export-copy = Copy as Image
whimsy-easel-export-png-light = Save as PNG (Light)
whimsy-easel-export-png-dark = Save as PNG (Dark)
whimsy-easel-export-pdf = Save as PDF…
whimsy-easel-export-note = Copy Link opens this easel on your devices that sync with Whimsy (images stay on this Mac). To share with anyone else, send the image or PDF.
whimsy-easel-export-picker-title = Save Easel as PNG

whimsy-easel-toolbar =
    .aria-label = Easel tools
whimsy-easel-tools-group =
    .aria-label = Tools
whimsy-easel-tool-select =
    .title = Select (V)
    .aria-label = Select
whimsy-easel-tool-text =
    .title = Text (T)
    .aria-label = Text
whimsy-easel-tool-pen =
    .title = Pen (P)
    .aria-label = Pen
whimsy-easel-tool-highlighter =
    .title = Highlighter (H)
    .aria-label = Highlighter
whimsy-easel-tool-rect =
    .title = Rectangle (R)
    .aria-label = Rectangle
whimsy-easel-tool-ellipse =
    .title = Ellipse (O)
    .aria-label = Ellipse
whimsy-easel-tool-line =
    .title = Line (L)
    .aria-label = Line
whimsy-easel-tool-arrow =
    .title = Arrow (A)
    .aria-label = Arrow
whimsy-easel-tool-image =
    .title = Add an image (I)
    .aria-label = Add an image
whimsy-easel-color-group =
    .aria-label = Color
whimsy-easel-color-ink =
    .title = Ink
    .aria-label = Ink
whimsy-easel-color-gray =
    .title = Gray
    .aria-label = Gray
whimsy-easel-color-red =
    .title = Red
    .aria-label = Red
whimsy-easel-color-orange =
    .title = Orange
    .aria-label = Orange
whimsy-easel-color-yellow =
    .title = Yellow
    .aria-label = Yellow
whimsy-easel-color-green =
    .title = Green
    .aria-label = Green
whimsy-easel-color-blue =
    .title = Blue
    .aria-label = Blue
whimsy-easel-color-purple =
    .title = Purple
    .aria-label = Purple
whimsy-easel-color-pink =
    .title = Pink
    .aria-label = Pink
whimsy-easel-size-group =
    .aria-label = Size
whimsy-easel-size-small =
    .title = Small
    .aria-label = Small
whimsy-easel-size-medium =
    .title = Medium
    .aria-label = Medium
whimsy-easel-size-large =
    .title = Large
    .aria-label = Large

whimsy-easel-contextbar =
    .aria-label = Selection
whimsy-easel-font-group =
    .aria-label = Font
whimsy-easel-font-sans = Sans
    .title = Sans
whimsy-easel-font-serif = Serif
    .title = Serif
whimsy-easel-font-mono = Mono
    .title = Monospace
whimsy-easel-font-rounded = Round
    .title = Rounded
whimsy-easel-fill =
    .title = Fill
    .aria-label = Fill
whimsy-easel-live-play =
    .title = Play: show the live page
    .aria-label = Play live capture
whimsy-easel-live-pause =
    .title = Pause: go back to the capture
    .aria-label = Pause live capture
whimsy-easel-open-source =
    .title = Open the page
    .aria-label = Open the page
whimsy-easel-bring-front =
    .title = Bring to front (⇧⌘])
    .aria-label = Bring to front
whimsy-easel-send-back =
    .title = Send to back (⇧⌘[)
    .aria-label = Send to back
whimsy-easel-duplicate =
    .title = Duplicate (⌘D)
    .aria-label = Duplicate
whimsy-easel-delete =
    .title = Delete (⌫)
    .aria-label = Delete

whimsy-easel-empty-title = A blank easel
whimsy-easel-empty-body = Collect what you find on the web, then write and draw around it.
whimsy-easel-empty-text = Write text
whimsy-easel-empty-draw = Draw
whimsy-easel-empty-paste = Paste an image or link
whimsy-easel-empty-capture = Capture part of any page

whimsy-easel-live-private = Live captures are paused in private windows
whimsy-easel-live-stopped = The live page stopped. Press ⌘R to try again.
whimsy-easel-off-title = Easels are turned off
whimsy-easel-off-body = Turn them on in Settings, under Whimsy.
whimsy-easel-missing-title = This easel was deleted
whimsy-easel-missing-body = Find your other easels in the Library.
whimsy-easel-private-title = Easels aren't kept in private browsing
whimsy-easel-private-body = Open your easels from a normal space.
whimsy-easel-other-profile-title = This easel belongs to another profile
whimsy-easel-other-profile-body = Switch to a space of that profile to open it.
whimsy-easel-status-other-profile = Those items are from another profile's easel

# $count (Number) - how many items
whimsy-easel-status-selected = { $count ->
    [one] 1 item selected
   *[other] { $count } items selected
}
whimsy-easel-status-added = { $count ->
    [one] Added 1 item
   *[other] Added { $count } items
}
whimsy-easel-status-deleted = { $count ->
    [one] Deleted 1 item. Press Command Z to undo.
   *[other] Deleted { $count } items. Press Command Z to undo.
}
whimsy-easel-status-copied = { $count ->
    [one] Copied 1 item
   *[other] Copied { $count } items
}
whimsy-easel-status-refreshed = { $count ->
    [0] No live captures to refresh
    [one] Refreshed 1 live capture
   *[other] Refreshed { $count } live captures
}
whimsy-easel-status-undo = Undone
whimsy-easel-status-redo = Redone
whimsy-easel-status-live-on = Live capture on
whimsy-easel-status-live-off = Live capture paused
whimsy-easel-status-live-stopped = The live page stopped. Showing the capture.
whimsy-easel-status-copied-image = Copied the easel as an image
whimsy-easel-status-saved-png = Saved the easel as a PNG
whimsy-easel-status-export-failed = Couldn't export the easel. Try again, or export a smaller part.
whimsy-easel-status-image-failed = Couldn't add that image. Try a PNG, JPEG, GIF or WebP file.

whimsy-library-easels-title = Easels
whimsy-library-easels-empty = No easels yet
whimsy-library-easels-private = Easels aren't kept in private browsing
whimsy-library-easels-new = New Easel
whimsy-library-easels-search-placeholder =
    .placeholder = Search easels…
whimsy-library-easels-delete =
    .label = Delete
    .tooltiptext = Delete easel
# $count (Number) - items on the easel
whimsy-library-easels-items = { $count ->
    [0] Empty
    [one] 1 item
   *[other] { $count } items
}
# $title (String) - the easel's name
whimsy-library-easels-deleted = Deleted { $title }
whimsy-library-easels-undo-button = Undo

## wave5: command registry. Every Whimsy command has one name, used in the
## command bar, in Settings → Keyboard Shortcuts (under "Whimsy") and in
## the shortcut cheat sheet. State-aware commands have a neutral name for
## their shortcut and a name per state in the command bar.

whimsy-action-capture = Capture…
whimsy-action-tab-next = Next Tab
whimsy-action-tab-prev = Previous Tab
whimsy-action-focus-sidebar = Focus Sidebar
whimsy-action-devmode-on = Turn Developer Mode On for This Site
whimsy-action-devmode-off = Turn Developer Mode Off for This Site
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

# W10-58: shown at once while Fire clears; the result replaces it.
whimsy-fire-working-profile = Clearing this profile’s last hour…
whimsy-fire-working-everything = Clearing everything…
# $site (string) - the site being forgotten, e.g. example.com
whimsy-fire-working-site = Forgetting { $site }…

# W10-62 (Arc): an Essential's context menu (a checkbox) and its command.
tab-context-whimsy-unread-badge =
    .label = Show Unread Badge
    .accesskey = U
whimsy-action-toggle-unread-badge = Show or Hide Unread Badge
whimsy-action-show-unread-badge = Show Unread Badge
whimsy-action-hide-unread-badge = Hide Unread Badge

# wave5/uxfix: read out with a pinned tab's unread badge.
# $count (number) - unread items the site reports
whimsy-tab-unread-description = { $count } unread

# wave5/uxfix: keeping the Private Space asks in the window's sheet (it can't be undone).
whimsy-scratch-save-confirm-title = Save Private Space as a Normal Space?
whimsy-scratch-save-confirm-accept = Save Space


## system: History's Show filter (All, Archive, Snoozed) in the Library

whimsy-history-show-filter = Show
whimsy-history-show-all = All
whimsy-history-show-closed = Archive
whimsy-history-show-snoozed = Snoozed
whimsy-history-closed-when = When did it close?
whimsy-history-search-closed =
    .placeholder = Search the Archive
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
whimsy-snooze-cancel-toast = “{ $title }” won’t come back on its own. It’s in the Archive.

## system: Settings → Links, one pane for where links open

whimsy-pane-links-title = Links
whimsy-links-title = Links
whimsy-links-apps-header = Links from other apps
whimsy-links-apps-description = When you click a link in another app, open it in:
whimsy-links-glance-header = Glance
whimsy-links-split-header = Split view
whimsy-links-follower =
    .label = Follower splits: links in one pane open in the other
whimsy-links-follower-help = To start one, open the command bar in a split and choose Make This a Follower Split.
whimsy-links-spaces-header = Spaces

## wave5/profiles: profiles (Arc's profiles, on containers)

whimsy-profile-default-name = Default
whimsy-profile-name-label = Profile Name
whimsy-profile-name-empty = Enter a name for the profile.
whimsy-profile-name-taken = A Profile with that name already exists. Choose another name.
whimsy-profile-name-failed = Unable to save the profile. Try again.
whimsy-profile-default-fixed = The Default profile can’t be renamed.
whimsy-profile-create-title = New Profile
whimsy-profile-rename-title = Rename Profile
whimsy-profile-cancel =
    .label = Cancel
whimsy-profile-create-button =
    .label = Create Profile
whimsy-profile-rename-button =
    .label = Rename Profile
whimsy-profile-cancel-text = Cancel
whimsy-profile-create-button-text = Create Profile
whimsy-profile-rename-button-text = Rename Profile
whimsy-profile-create-menuitem =
    .label = Create a New Profile…
whimsy-profiles-header = Profiles
whimsy-profiles-description = Each space belongs to a profile, like in Arc. A profile keeps its own sign-ins, history, passwords, Essentials and extensions.
whimsy-profiles-delete-rule = Only profiles that no space uses can be deleted.
whimsy-profiles-spaces =
    { $count ->
        [0] Not used by any space
        [one] Used by 1 space
       *[other] Used by { $count } spaces
    }
whimsy-profiles-spaces-default =
    { $count ->
        [0] Not used by any space · Keeps everything from before profiles
        [one] Used by 1 space · Keeps everything from before profiles
       *[other] Used by { $count } spaces · Keeps everything from before profiles
    }
whimsy-profiles-rename =
    .label = Rename…
    .aria-label = Rename “{ $name }”…
whimsy-profiles-delete =
    .label = Delete Profile…
    .aria-label = Delete Profile “{ $name }”…
whimsy-profiles-create =
    .label = Create a New Profile…
whimsy-profiles-delete-unused =
    .label = Delete Unused Profiles…
whimsy-profiles-delete-confirm-title = Delete the “{ $name }” profile?
whimsy-profiles-delete-confirm-body = Its cookies, site data and saved passwords are deleted, and the profile is removed on every device you sync with. This can’t be undone.
whimsy-profiles-delete-confirm-accept = Delete Profile
whimsy-profiles-delete-unused-confirm-title =
    { $count ->
        [one] Delete 1 unused profile?
       *[other] Delete { $count } unused profiles?
    }
whimsy-profiles-delete-unused-confirm-body = Not used by any space: { $names }. Their cookies, site data and saved passwords are deleted, and the profiles are removed on every device you sync with. This can’t be undone.
whimsy-profiles-delete-unused-confirm-accept =
    { $count ->
        [one] Delete Profile
       *[other] Delete Profiles
    }
whimsy-history-profile-filter = Profile
whimsy-history-this-profile = This Profile
whimsy-history-all-profiles = All Profiles
whimsy-profiles-default-settings = Uses your Search and Downloads settings.
whimsy-profiles-search-engine =
    .value = Search Engine
whimsy-profiles-same-as-default =
    .label = Same as Default
whimsy-profiles-same-as-default-text = Same as Default
whimsy-profiles-download-dir =
    .value = Default Download Location
whimsy-profiles-download-choose =
    .label = Choose…
whimsy-profiles-download-reset =
    .label = Use Default
whimsy-profiles-download-picker-title = Choose a Download Location for This Profile
# W10-23: each profile's row (a summary and Edit) and its editor.
whimsy-profiles-edit =
    .label = Edit
    .aria-label = Edit “{ $name }”
whimsy-profiles-done =
    .label = Done
whimsy-profiles-meta = { whimsy-profiles-spaces } · { $engine } · { $downloads }
whimsy-profiles-meta-engine = { whimsy-profiles-spaces } · { $engine }
whimsy-profiles-meta-downloads = { whimsy-profiles-spaces } · { $downloads }
whimsy-profiles-meta-same = { whimsy-profiles-spaces } · Default’s search engine and downloads
whimsy-profiles-default-meta = { whimsy-profiles-spaces } · Uses your Search and Downloads settings
whimsy-profiles-field-name = Name
whimsy-profiles-field-engine =
    .value = Search engine
whimsy-profiles-field-downloads = Downloads
whimsy-profile-move-space-title = Move “{ $space }” to the “{ $profile }” profile?
whimsy-profile-move-space-body = Each Profile has different browser data, so you might get logged out of some websites, see different Favorites up top, or need to re-install extensions.
whimsy-profile-move-space-accept = Move Space
whimsy-profile-moved-space-toast = “{ $space }” now uses the “{ $profile }” profile
whimsy-profile-move-tab-title =
    { $count ->
        [one] Move this tab to “{ $space }”?
       *[other] Move { $count } tabs to “{ $space }”?
    }
whimsy-profile-move-tab-body =
    { $count ->
        [one] It reopens in the “{ $profile }” profile, so this webpage might look a little different.
       *[other] They reopen in the “{ $profile }” profile, so these webpages might look a little different.
    }
whimsy-profile-move-tab-accept =
    { $count ->
        [one] Move Tab
       *[other] Move Tabs
    }
whimsy-profile-reverted-toast = Whimsy has reverted to using your Default profile for { $spaces }

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
# W11-08: opens the page of the tab you're on again, fresh, in a new tab
# (what picking that tab's own row in the Cmd+T command bar does). Command
# bar and Settings → Keyboard Shortcuts, no default shortcut.
whimsy-action-open-again-in-new-tab = Open Again in New Tab
whimsy-already-open-setting =
    .label = Go to a page that’s already open instead of opening it again

## wave6: Trails. Rows in the Back/Forward menu (long-press or right-click
## Back): pages a new click cut from Forward, and where the tab came from.
## $title - the page's title

whimsy-trail-origin =
    .label = Opened from { $title }
whimsy-trail-branch-tooltip = A page you left by going back. Click to open it again.
# W10-54: the drawn trail (long-press or right-click Back or Forward).
whimsy-trail-heading = This tab’s trail
whimsy-trail-here = You’re here
whimsy-trail-branch-caption = You went back from
# $count (number) - steps from the current page
whimsy-trail-steps-back = { $count } back
whimsy-trail-steps-ahead = { $count } ahead
# $title (string) - the page that opened this tab
whimsy-trail-origin-text = Opened from { $title }
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
## $host - the tracking page's site, e.g. www.ups.com
whimsy-page-action-parcel-tooltip =
    .tooltiptext = Open the tracking page on { $host }
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
whimsy-archive-clear-message = Every archived tab is removed for good, along with Restore Last Closed Tab’s list. Your history stays.
whimsy-archive-clear-button = Clear Archive
whimsy-archive-cleared-toast = Archive cleared

## wave6/parity: Arc's Split View commands (View menu) and keys.

whimsy-action-add-split-view = Add Split View
whimsy-action-close-split-pane = Close this Split Pane
whimsy-action-separate-page = Separate Page from Split View
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

## W10-61: press again (Arc). The page used a browser shortcut itself, so it
## got this press; pressing it again runs the browser's command.
## $shortcut (string) - the shortcut, e.g. "⌘S"
## $action (string) - the command's name, e.g. "Hide Sidebar"

whimsy-press-again-toast = Press { $shortcut } again for { $action }

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
# $action (string) - what Cmd+Z will undo: archive, pin, unpin, move,
# snooze, hide-space or other
whimsy-menu-undo-action =
    .label =
        { $action ->
            [archive] Undo Archive Tab
            [pin] Undo Pin Tab
            [unpin] Undo Unpin Tab
            [move] Undo Move Tab
            [snooze] Undo Snooze Tab
            [hide-space] Undo Hide Space
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
whimsy-cheatsheet-new-scratch = New Private Space
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
# W10-29: ⌘⇧O turns Mini's address strip into a search field over its
# spaces (a flat list; each row names its profile when there are several).
whimsy-mini-picker-search =
    .placeholder = Search spaces and profiles
    .aria-label = Search spaces and profiles
whimsy-mini-picker-search-spaces =
    .placeholder = Search spaces
    .aria-label = Search spaces
whimsy-mini-picker-list =
    .aria-label = Spaces
whimsy-mini-picker-empty = No space or profile matches “{ $query }”.
whimsy-mini-picker-status =
    { $count ->
        [one] 1 space
       *[other] { $count } spaces
    }

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

## wave7/ux: link hover cards (WhimsyLinkHover)

whimsy-hover-links =
    .label = Show where a link goes when you Shift-hover it
# Above the AI summary card, under the link or People card.
whimsy-link-hover-ai-label = Summary

# fix7 settings: command bar actions for History, Liquid Glass and Glance size.
whimsy-action-view-history = View History
whimsy-action-liquid-glass = Liquid Glass
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

# wave7/menus2: Arc's words for closing tabs, which go to the Archive.
# $tabCount (number) - how many tabs the row archives
whimsy-tab-context-archive-tabs =
    .label =
        { $tabCount ->
            [1] Archive Tab
           *[other] Archive Tabs
        }
whimsy-tab-context-archive-tabs-below =
    .label = Archive Tabs Below
# Shown instead when closed tabs aren't archived (a private tab, or the Archive is off).
whimsy-tab-context-close-tabs-below =
    .label = Close Tabs Below
# $tabCount (number) - how many tabs the last close took (Shift+Cmd+T brings them back)
whimsy-tab-context-restore-closed-tabs =
    .label =
        { $tabCount ->
            [1] Restore Last Closed Tab
           *[other] Restore Last Closed Tabs
        }
# File menu, Cmd+W. $tabCount (number) - selected tabs
whimsy-menu-archive-tab =
    .label =
        { $tabCount ->
            [1] Archive Tab
           *[other] Archive Tabs
        }
## wave7/keys: commands for features that only had Settings, a sidebar
## control or a context menu (command bar and about:keyboard names).

whimsy-action-tree-toggle = Collapse or Expand Tab Children
whimsy-action-tree-collapse = Collapse Tab Children
whimsy-action-tree-expand = Expand Tab Children
whimsy-action-show-hidden-spaces = Show Hidden Spaces…
whimsy-action-space-switcher-toggle = Show or Hide Space Switcher
whimsy-action-space-switcher-show = Show Space Switcher
whimsy-action-space-switcher-hide = Hide Space Switcher
whimsy-action-ui-zoom-in = Zoom Interface In
whimsy-action-ui-zoom-out = Zoom Interface Out
whimsy-action-ui-zoom-reset = Reset Interface Zoom
whimsy-action-background-mute-toggle = Mute or Unmute Background Tabs
whimsy-action-background-mute-on = Mute Background Tabs
whimsy-action-background-mute-off = Unmute Background Tabs
whimsy-action-bionic-toggle = Turn Bionic Reading On or Off
whimsy-action-bionic-on = Turn Bionic Reading On
whimsy-action-bionic-off = Turn Bionic Reading Off
whimsy-action-dark-pdf-toggle = Turn Dark PDFs On or Off
whimsy-action-dark-pdf-on = Turn Dark PDFs On
whimsy-action-dark-pdf-off = Turn Dark PDFs Off
whimsy-action-new-live-folder = New Live Folder…
whimsy-action-new-folder = New Folder…
whimsy-action-manage-spaces = Manage Spaces…
whimsy-action-air-traffic-control = Air Traffic Control…
whimsy-action-add-finder-folder = Add Finder Folder…
whimsy-action-open-claude-space = Open Claude Space
whimsy-action-whats-new = What’s New
## wave7/focus: Do Not Disturb (pauses site notifications until you turn
## it off or quit; macOS Focus already silences them on its own)

whimsy-action-dnd-toggle = Turn Do Not Disturb On or Off
whimsy-action-dnd-on = Turn Do Not Disturb On
whimsy-action-dnd-off = Turn Do Not Disturb Off
whimsy-dnd-on-toast = Do Not Disturb on
whimsy-dnd-on-toast-description = Site notifications are paused until you turn it off or quit
whimsy-dnd-off-toast = Do Not Disturb off

## wave7/focus: paste guard (asks before pasting something that looks
## like a secret into a web page)

whimsy-action-paste-guard-toggle = Turn Paste Guard On or Off
whimsy-action-paste-guard-on = Turn Paste Guard On
whimsy-action-paste-guard-off = Turn Paste Guard Off
whimsy-paste-guard-on-toast = Paste guard on
whimsy-paste-guard-on-toast-description = Whimsy asks before you paste a key or card number into a page
whimsy-paste-guard-off-toast = Paste guard off
# $kind (string) - what the clipboard looks like: openai, anthropic, github,
# aws, slack, stripe, google, private-key, jwt, card.
whimsy-paste-guard-title =
    { $kind ->
        [openai] This looks like an OpenAI API key
        [anthropic] This looks like an Anthropic API key
        [github] This looks like a GitHub token
        [aws] This looks like an AWS access key
        [slack] This looks like a Slack token
        [stripe] This looks like a Stripe secret key
        [google] This looks like a Google API key
        [private-key] This looks like a private key
        [jwt] This looks like a sign-in token
        [card] This looks like a card number
       *[other] This looks like a secret
    }
# W10-14: the line under the title. $host (string) - the site the paste
# would go to, like "example.com" (long ones are cropped in the middle).
whimsy-paste-guard-where = Paste it into <b>{ $host }</b>?
whimsy-paste-guard-where-page = Paste it into this page?
whimsy-paste-guard-note = Pages can read anything you paste. Only paste a key into a site you trust with it.
whimsy-paste-guard-privacy =
    .tooltiptext = Whimsy checked this on your Mac and kept nothing.
whimsy-paste-guard-paste =
    .label = Paste Anyway
whimsy-paste-guard-cancel =
    .label = Don’t Paste
## wave7/teach: Teach once (WhimsyTeach.sys.mjs). One small hint beside what
## the person just did, shown once. { $key } is the shortcut as it's bound
## right now (e.g. ⇧⌘C), shown as a key cap.

whimsy-teach-mini = Keep this page with <kbd>{ $key }</kbd>: it moves into your space. <kbd>Esc</kbd> lets it go.
# $key is the Glance modifier (⌥ by default).
whimsy-teach-glance = Just looking? <kbd>{ $key }</kbd>-click a link to Glance at it without opening a tab.
whimsy-teach-verbs = Next time, select text and press <kbd>{ $key }</kbd> to translate, map, search or save it.
whimsy-teach-split = <kbd>{ $key }</kbd> puts the selected tabs side by side.
whimsy-teach-archive = Tabs you hadn’t used in a while moved to the Archive. <kbd>{ $key }</kbd> opens the Library, where they wait.
whimsy-teach-pin = <kbd>{ $key }</kbd> pins or unpins the tab you’re on.
whimsy-teach-copy-url = <kbd>{ $key }</kbd> copies this page’s link from anywhere.
whimsy-teach-next-space = <kbd>{ $key }</kbd> goes to the next space. A two-finger swipe does too.
# W10-58: the command bar, opened with the mouse.
whimsy-teach-new-tab = <kbd>{ $key }</kbd> opens the command bar from anywhere: search, go to a site or run a command.
whimsy-teach-address = <kbd>{ $key }</kbd> jumps to the address bar from anywhere.
whimsy-action-teach-reset = Reset Tips
whimsy-teach-reset-toast = Tips will show again
whimsy-teach-header = Tips
whimsy-teach-enabled =
    .label = Show tips the first time a shortcut could help
whimsy-teach-enabled-help = Each tip shows once. To see them all again, run Reset Tips from the command bar.
# wave7/scratch: saving the Private Space uses Zen's New Space form with these words;
# the "Save as a Space?" dialog comes after its button.
whimsy-scratch-save-header = Save Private Space as a Normal Space
whimsy-scratch-save-label = Name it and pick its look. Its tabs come with it.
whimsy-scratch-save-button =
    .label = Save Space
## wave7/linear: the Linear live folder uses your linear.app sign-in; no API key needed.

whimsy-live-folder-linear-signed-out =
    .label = Sign in to Linear
    .tooltiptext = Opens linear.app in this space’s profile. The folder fills in once you’re signed in.
whimsy-live-folder-linear-rate-limited =
    .label = Linear asked to slow down
    .tooltiptext = Linear is rate limiting requests. The folder keeps its tabs and refreshes again on its own.
whimsy-live-folder-linear-option-workspace =
    .label = Workspace
whimsy-live-folder-linear-workspace-all =
    .label = All Workspaces
whimsy-live-folder-linear-workspace =
    .label = { $name }
whimsy-live-folder-linear-option-use-api-key =
    .label = Use an API Key Instead…
whimsy-live-folder-linear-option-remove-api-key =
    .label = Remove API Key
## wave7/split: a split pane's ⋯ menu (on the pane's hover header).
## Arc's names: Separate Page from Split View, Close this Split Pane,
## Expand Current Split (keep this pane, close the others; View menu and
## command bar), Separate All Tabs (every pane its own tab; tab menu).

whimsy-split-pane-menu-button =
    .tooltiptext = Pane Actions
    .aria-label = Pane Actions
whimsy-split-pane-drag =
    .tooltiptext = Drag to Rearrange Panes
whimsy-action-split-pane-menu = Split Pane Actions…

## wave7/split2: Arc's split menus, copied exactly (arc-ref menus-context.txt).
## The sidebar row's right-click menu, then each pane's submenu (the same
## items as the pane header's ⋯ menu).

whimsy-split-row-share =
    .label = Share Split View…
whimsy-split-row-separate-all =
    .label = Separate All Tabs
whimsy-split-row-add-tab =
    .label = Add Tab…
# Arc's names: side-by-side panes are a horizontal split, stacked panes a
# vertical one.
whimsy-split-row-convert-vertical =
    .label = Convert to Vertical Split View
whimsy-split-row-convert-horizontal =
    .label = Convert to Horizontal Split View
whimsy-split-row-tab-options =
    .label = Tab Options
whimsy-split-row-change-icon =
    .label = Change Icon…
whimsy-split-row-rename =
    .label = Rename…
whimsy-split-row-duplicate =
    .label = Duplicate
whimsy-split-row-move-to =
    .label = Move to
whimsy-split-row-new-space =
    .label = New Space…
whimsy-split-row-archive =
    .label = Archive Item
whimsy-split-row-archive-below =
    .label = Archive Tabs Below
whimsy-split-pane-separate =
    .label = Separate from Split View
whimsy-split-pane-mute =
    .label = Mute
whimsy-split-pane-unmute =
    .label = Unmute
whimsy-split-pane-copy-link =
    .label = Copy Link
whimsy-split-pane-copy-markdown =
    .label = Copy link as Markdown
whimsy-split-pane-archive =
    .label = Archive Item
whimsy-split-pane-back =
    .tooltiptext = Back
    .aria-label = Back
whimsy-split-pane-forward =
    .tooltiptext = Forward
    .aria-label = Forward
whimsy-split-pane-reload =
    .tooltiptext = Reload
    .aria-label = Reload
whimsy-split-always-show-headers =
    .label = Always show split pane headers
whimsy-split-always-show-headers-help = Each pane keeps a bar at its top with back, forward, reload, the site’s address and the pane’s menu, like Arc. Off, the bar shows only while you point at a pane.

## wave7/menuprefs: Settings → Menus. Which items each right-click menu
## shows. Item names match the menus' own wording.

whimsy-pane-menus-title = Menus
whimsy-menus-title = Menus
whimsy-menus-intro = Choose what shows when you right-click. Changes apply the next time you open that menu.
whimsy-menus-restore =
    .label = Restore Defaults
whimsy-menus-all-off = Every row is off, so right-clicking here opens no menu.
# W10-21: the pane's menu list (grouped by where you right-click), each
# menu's count of rows that show, and the narrow-window picker.
whimsy-menus-nav =
    .aria-label = Menus
whimsy-menus-nav-sidebar = In the sidebar
whimsy-menus-nav-page = On a page
whimsy-menus-nav-count = { $shown }/{ $total }
whimsy-menus-nav-off = Off
whimsy-menus-count = { $shown } of { $total } rows show

whimsy-menus-tab = Tab
whimsy-menus-tab-description = When you right-click a tab in the sidebar.
whimsy-menus-essential = Essential
whimsy-menus-essential-description = When you right-click an Essential. It has its own copy of the tab menu’s rows.
whimsy-menus-link = Link
whimsy-menus-link-description = When you right-click a link on a page.
whimsy-menus-page = Page
whimsy-menus-page-description = When you right-click an empty part of a page.
whimsy-menus-selection = Selected Text
whimsy-menus-selection-description = When you right-click text you’ve selected on a page.
whimsy-menus-image = Image
whimsy-menus-image-description = When you right-click an image on a page. Link rows show when the image is a link.
whimsy-menus-space = Space
whimsy-menus-space-description = When you right-click a space’s icon, or click its ⋯ button.
whimsy-menus-sidebar = Sidebar
whimsy-menus-sidebar-description = When you right-click an empty part of the sidebar.
whimsy-menus-folder = Folder
whimsy-menus-folder-description = When you right-click a folder in the sidebar.
whimsy-menus-split-row = Split View
whimsy-menus-split-row-description = When you right-click a split view in the sidebar.
whimsy-menus-split-pane = Split View Pane
whimsy-menus-split-pane-description = When you click ⋯ on a split view pane, or open a pane under Tab Options.

# Shared by several menus.
whimsy-menus-inspect =
    .label = Inspect
whimsy-menus-element-info =
    .label = Element Info
whimsy-menus-inspect-a11y =
    .label = Inspect Accessibility Properties
whimsy-menus-select-all =
    .label = Select All

whimsy-menus-tab-new-tab =
    .label = New Tab
whimsy-menus-tab-move-to-folder =
    .label = Move to Folder
whimsy-menus-tab-group-by-site =
    .label = Group Tabs from Site
whimsy-menus-tab-split =
    .label = Add Split View / Split Out Tab
whimsy-menus-tab-share-split =
    .label = Share Split View
    .description = On a tab in a split view
whimsy-menus-tab-reload =
    .label = Reload Tab
whimsy-menus-tab-play =
    .label = Play Tab
    .description = When a tab is waiting to play
whimsy-menus-tab-mute =
    .label = Mute Tab
whimsy-menus-tab-mute-site =
    .label = Mute Site
whimsy-menus-tab-snooze =
    .label = Snooze…
whimsy-menus-tab-essentials =
    .label = Add to Essentials / Remove from Essentials
whimsy-menus-tab-unread-badge =
    .label = Show Unread Badge
    .description = On Essentials
whimsy-menus-tab-rename =
    .label = Rename…
whimsy-menus-tab-change-icon =
    .label = Change Icon…
whimsy-menus-tab-pin =
    .label = Pin Tab / Unpin Tab
whimsy-menus-tab-unload =
    .label = Unload Tab
whimsy-menus-tab-duplicate =
    .label = Duplicate Tab
whimsy-menus-tab-copy-links =
    .label = Copy Link
whimsy-menus-tab-ask-chat =
    .label = Ask an AI Chatbot
    .description = When the AI chatbot is on
whimsy-menus-tab-bookmark =
    .label = Bookmark Tab
whimsy-menus-tab-watch =
    .label = Watch This Page…
whimsy-menus-tab-move-tab =
    .label = Move Tab
whimsy-menus-tab-select-all =
    .label = Select All Tabs
whimsy-menus-tab-share =
    .label = Share
whimsy-menus-tab-send-to-device =
    .label = Send Tab to Device
whimsy-menus-tab-close =
    .label = Archive Tab
whimsy-menus-tab-archive-below =
    .label = Archive Tabs Below
whimsy-menus-tab-close-duplicates =
    .label = Close Duplicate Tabs
whimsy-menus-tab-close-multiple =
    .label = Close Multiple Tabs
whimsy-menus-tab-reopen =
    .label = Restore Last Closed Tab
whimsy-menus-tab-space-routing =
    .label = Add Site to Space Routing
whimsy-menus-tab-edit-pinned =
    .label = Edit Pinned Page
    .description = On pinned tabs and Essentials
whimsy-menus-tab-reset-pinned =
    .label = Reset Pinned Tab
    .description = On pinned tabs and Essentials
whimsy-menus-tab-follower =
    .label = Make This a Follower Split
    .description = On a tab in a split view

whimsy-menus-link-open-in-tab =
    .label = Open Link in New Tab
whimsy-menus-link-open-in-space =
    .label = Open Link in Space
whimsy-menus-link-open-in-window =
    .label = Open Link in New Window
whimsy-menus-link-open-in-private =
    .label = Open Link in New Private Window
whimsy-menus-link-preview =
    .label = Preview Link
whimsy-menus-link-split =
    .label = Split Link to New Tab
whimsy-menus-link-glance =
    .label = Open Link in Glance
whimsy-menus-link-bookmark =
    .label = Bookmark Link
whimsy-menus-link-save =
    .label = Save Link As…
whimsy-menus-link-copy-email =
    .label = Copy Email Address / Phone Number
whimsy-menus-link-copy =
    .label = Copy Link
whimsy-menus-link-copy-clean =
    .label = Copy Clean Link
    .description = When the link has tracking parameters
whimsy-menus-link-send-to-device =
    .label = Send Link to Device

whimsy-menus-page-back =
    .label = Back
whimsy-menus-page-forward =
    .label = Forward
whimsy-menus-page-reload =
    .label = Reload
whimsy-menus-page-bookmark =
    .label = Bookmark Page
whimsy-menus-page-save =
    .label = Save Page As…
whimsy-menus-page-qr-code =
    .label = QR Code for Page
whimsy-menus-page-copy-markdown =
    .label = Copy Page as Markdown
whimsy-menus-page-new-note =
    .label = New Note
whimsy-menus-page-screenshot =
    .label = Take Screenshot
whimsy-menus-page-edit-text =
    .label = Edit Text on Page
whimsy-menus-page-send-to-device =
    .label = Send Page to Device
whimsy-menus-page-view-source =
    .label = View Page Source

whimsy-menus-selection-search =
    .label = Search for the Selection
whimsy-menus-selection-search-private =
    .label = Search in a Private Window
whimsy-menus-selection-translate =
    .label = Translate Selection
whimsy-menus-selection-copy =
    .label = Copy
whimsy-menus-selection-copy-markdown =
    .label = Copy as Markdown
whimsy-menus-selection-map =
    .label = Show in Maps
whimsy-menus-selection-email =
    .label = Email with { $app }
whimsy-menus-selection-note =
    .label = Add to Note
whimsy-menus-selection-calendar =
    .label = Add to Calendar
whimsy-menus-selection-linear-new =
    .label = New Linear Issue
whimsy-menus-selection-linear-search =
    .label = Search Linear
# W10-20: the Quick Actions ▸ submenu and when its rows show.
whimsy-menus-selection-quick-actions =
    .label = Quick Actions ▸
whimsy-menus-hint-translate = When it’s another language
whimsy-menus-hint-date = When it has a date
whimsy-menus-hint-linear = Once Linear is connected
whimsy-menus-selection-print =
    .label = Print Selection…
whimsy-menus-selection-copy-highlight =
    .label = Copy Link to Highlight
whimsy-menus-selection-view-source =
    .label = View Selection Source

whimsy-menus-image-view =
    .label = Open Image in New Tab
whimsy-menus-image-save =
    .label = Save Image As…
whimsy-menus-image-copy =
    .label = Copy Image
whimsy-menus-image-copy-link =
    .label = Copy Image Link
whimsy-menus-image-email =
    .label = Email Image…
whimsy-menus-image-copy-text =
    .label = Copy Text from Image
whimsy-menus-image-desktop-background =
    .label = Set Image as Desktop Background…

whimsy-menus-space-rename =
    .label = Rename Space…
whimsy-menus-space-change-icon =
    .label = Change Icon…
whimsy-menus-space-edit-theme =
    .label = Edit Theme…
whimsy-menus-space-look =
    .label = { -whimsy-edit-look }
    .label = Edit Space Look…
whimsy-menus-space-profile =
    .label = Set Profile
whimsy-menus-space-new =
    .label = New Space…
whimsy-menus-space-manage =
    .label = Manage Spaces…
whimsy-menus-space-routing =
    .label = Space Routing Settings
whimsy-menus-space-unload =
    .label = Unload Space
whimsy-menus-space-unload-others =
    .label = Unload Other Spaces
whimsy-menus-space-share =
    .label = Share Space…
whimsy-menus-space-lock =
    .label = Lock This Space
whimsy-menus-space-hide =
    .label = Hide This Space
whimsy-menus-space-delete =
    .label = Delete Space
whimsy-menus-space-scratch-keep =
    .label = Keep…
    .description = In the Private Space
whimsy-menus-space-scratch-close =
    .label = Close
    .description = In the Private Space

whimsy-menus-sidebar-new-folder =
    .label = New Folder
whimsy-menus-sidebar-new-live-folder =
    .label = New Live Folder
whimsy-menus-sidebar-live-github-prs =
    .label = New Live Folder: GitHub Pull Requests
whimsy-menus-sidebar-live-github-issues =
    .label = New Live Folder: GitHub Issues
whimsy-menus-sidebar-live-rss =
    .label = New Live Folder: RSS
whimsy-menus-sidebar-live-jira =
    .label = New Live Folder: Jira Issues
whimsy-menus-sidebar-live-linear =
    .label = New Live Folder: Linear Issues
whimsy-menus-sidebar-live-local-servers =
    .label = New Live Folder: Local Servers

whimsy-menus-folder-live-options =
    .label = Live Options
    .description = On live folders
whimsy-menus-folder-rename =
    .label = Rename…
whimsy-menus-folder-change-icon =
    .label = Change Icon…
whimsy-menus-folder-color =
    .label = Color
whimsy-menus-folder-unload =
    .label = Unload All
whimsy-menus-folder-new-subfolder =
    .label = New Subfolder
whimsy-menus-folder-move-to-space =
    .label = Move to Space
whimsy-menus-folder-convert-to-space =
    .label = Convert to Space
whimsy-menus-folder-share =
    .label = Share
whimsy-menus-folder-unpack =
    .label = Unpack
whimsy-menus-folder-delete =
    .label = Delete

# Split view (row menu and pane menu share a few).
whimsy-menus-split-share =
    .label = Share Split View…
whimsy-menus-split-archive =
    .label = Archive Item
whimsy-menus-split-row-separate-all =
    .label = Separate All Tabs
whimsy-menus-split-row-add-tab =
    .label = Add Tab…
whimsy-menus-split-row-convert =
    .label = Convert to Vertical / Horizontal Split View
whimsy-menus-split-row-tab-options =
    .label = Tab Options
whimsy-menus-split-row-change-icon =
    .label = Change Icon…
whimsy-menus-split-row-rename =
    .label = Rename…
whimsy-menus-split-row-duplicate =
    .label = Duplicate
whimsy-menus-split-row-move-to =
    .label = Move to
whimsy-menus-split-pane-separate =
    .label = Separate from Split View
whimsy-menus-split-pane-share =
    .label = Share
whimsy-menus-split-pane-copy-link =
    .label = Copy Link
whimsy-menus-split-pane-mute =
    .label = Mute
whimsy-menus-split-pane-copy-markdown =
    .label = Copy link as Markdown
## wave7/native1: Add to Calendar saves straight into macOS Calendar

whimsy-verb-calendar-added-toast = Added to Calendar
## w7native: live captions from a video's speech (CC on a video without
## captions), recognized on this Mac by macOS, then translated.

whimsy-media-video-speech-captions =
    .label = When a video has no captions, CC makes them from its speech, on your Mac
whimsy-video-captions-listening = Listening to the video for live captions…
whimsy-video-captions-speech-denied = Allow Speech Recognition in System Settings → Privacy & Security to get live captions
whimsy-video-captions-speech-unavailable = Live captions need an on-device Dictation language in System Settings → Keyboard
whimsy-video-captions-speech-protected = This video is protected, so it can’t be captioned
whimsy-video-captions-speech-no-audio = This video has no sound to caption
## wave7/small: Cast to AirPlay (Arc's View > Cast...).

whimsy-action-cast = Cast to AirPlay…
whimsy-action-cast-stop = Stop Casting
whimsy-menu-cast =
    .label = Cast…
whimsy-menu-cast-stop =
    .label = Stop Casting
whimsy-cast-connected-toast = Playing on your AirPlay device
whimsy-cast-stop-button = Stop
whimsy-cast-stopped-toast = Casting stopped
whimsy-cast-failed-toast = The AirPlay device couldn’t play this video
whimsy-cast-no-video-toast = There’s no video on this page to cast
whimsy-cast-unavailable-toast = AirPlay isn’t available in this build
whimsy-cast-mirror-toast = This video can’t be sent on its own. Mirror your screen instead.
whimsy-cast-mirror-button = Screen Mirroring

## wave7/small: Create Email Alias (command bar).

whimsy-action-create-email-alias = Create Email Alias
whimsy-email-aliases-toast-no-field = Click into an email field first, then create an alias for it

## wave7/small: Move to > New Space... (Arc).

whimsy-action-move-to-new-space = Move to New Space…
whimsy-menu-move-to-new-space =
    .label = New Space…

## wave7/small: Teach once hints for Link hints and Instant result
## (WhimsyTeachHints; shown only in builds with WhimsyTeach).
## $key (string) - the hint's current shortcut

whimsy-teach-link-hints = <kbd>{ $key }</kbd> puts a letter on every link. Type it to click, no mouse needed.
whimsy-teach-instant = <kbd>{ $key }</kbd> on a search skips the results page and opens the top result.

## wave7/small: the changelog names dev builds by ID only on the Dev channel;
## on Release an untitled dev build is headed by this.

whimsy-changelog-dev-build = Update

## wave7/small: Search Linear before Whimsy knows the Linear workspace.

whimsy-verb-linear-copied-toast = Copied your search. Press / in Linear to paste it.

## wave7/small: the idle archive sweep's toast (with Undo).
## $count (number) - how many tabs were archived

whimsy-archive-swept-toast =
    { $count ->
        [one] Archived a tab you hadn’t used in a while
       *[other] Archived { $count } tabs you hadn’t used in a while
    }

## wave8/isolation: a tab never lives in a space of another profile.
## $count (number) - how many tabs

whimsy-isolation-sorted-toast =
    { $count ->
        [one] A tab moved to a space of its own profile, so its sign-ins stay private
       *[other] { $count } tabs moved to spaces of their own profiles, so their sign-ins stay private
    }
whimsy-isolation-scratch-toast =
    { $count ->
        [one] Only private tabs go in the Private Space. The tab stayed where it was.
       *[other] Only private tabs go in the Private Space. The tabs stayed where they were.
    }
whimsy-isolation-reopened-toast =
    { $count ->
        [one] A tab reopened in this space’s profile, without its old sign-ins
       *[other] { $count } tabs reopened in their space’s profile, without their old sign-ins
    }
whimsy-snooze-private-toast = Private tabs can’t be snoozed: a snoozed tab is saved and comes back as a normal tab
## wave8/cheatsheet: the redesigned Cmd+/ sheet. A shortcut the person
## changed in about:keyboard is marked "Custom".
## $title (string) - the command's name
## $shortcut (string) - its current shortcut, e.g. ⇧⌘D
## $default (string) - the shortcut it had before it was changed
## $count (number) - how many shortcuts a search leaves

# W10-19: a changed shortcut has an accent dot; the footer explains it.
whimsy-cheatsheet-legend = Changed by you
# Words a search for changed shortcuts can use.
whimsy-cheatsheet-custom-word = custom changed
whimsy-cheatsheet-custom-tooltip = Changed from { $shortcut }
whimsy-cheatsheet-custom-tooltip-none = Added by you
whimsy-cheatsheet-row = { $title }, { $shortcut }
whimsy-cheatsheet-row-custom = { $title }, { $shortcut }, custom shortcut (was { $default })
whimsy-cheatsheet-row-added = { $title }, { $shortcut }, custom shortcut
whimsy-cheatsheet-results =
    { $count ->
        [one] 1 shortcut
       *[other] { $count } shortcuts
    }
## W8-17/18: the private command bar (Cmd+Option+T)

# A small badge at the end of the command bar while it's for a private tab.
# It is also read out as the address field's description.
whimsy-urlbar-private-badge = Private
## wave8/snooze (W8-37): the Snooze picker and the Undo toast

# The picker's field: people type when the tab should come back.
whimsy-snooze-field =
    .placeholder = Type a time: “fri 2pm”, “in 3 hours”…
    .aria-label = When should this tab come back?
# Where a snooze lands. $when is "today", "tomorrow", "week" (within six
# days) or "later"; $time (string) - like 9:00 AM; $day (string) - like
# Saturday, or Mon, Nov 9.
whimsy-snooze-when =
    { $when ->
        [today] Today, { $time }
        [tomorrow] Tomorrow, { $time }
        [week] { $day }, { $time }
       *[later] { $day }, { $time }
    }
# A preset that no longer makes sense today (Tonight at 9 PM).
whimsy-snooze-unavailable = Too late today
whimsy-snooze-past = That time has already passed
whimsy-snooze-no-match = Try “tomorrow 3pm”, “fri”, “in 2 hours” or “nov 12”.
whimsy-snooze-pick = Pick Date & Time…
whimsy-snooze-date =
    .aria-label = Date
whimsy-snooze-time =
    .aria-label = Time
# $when, $time, $day - as for whimsy-snooze-when
whimsy-snooze-custom-summary =
    { $when ->
        [today] Comes back today at { $time }
        [tomorrow] Comes back tomorrow at { $time }
       *[other] Comes back { $day } at { $time }
    }
whimsy-snooze-custom-incomplete = Choose a date and a time
whimsy-snooze-custom-button =
    .label = Snooze
# $count (number) - tabs waiting to come back
whimsy-snooze-view-snoozed =
    .label = Snoozed Tabs ({ $count })
# The Undo toast after snoozing. $when, $time, $day - as for whimsy-snooze-when
whimsy-snooze-undo-toast =
    { $when ->
        [today] Snoozed until { $time }
        [tomorrow] Snoozed until tomorrow, { $time }
       *[other] Snoozed until { $day }, { $time }
    }
# The button on every Whimsy toast whose action can be undone (Snooze,
# Hide Space, the archive sweep). The shortcut is shown beside it.
whimsy-undo-toast-action = Undo
whimsy-action-undo-tab-action = Undo Last Tab Action
whimsy-action-redo-tab-action = Redo Last Tab Action
whimsy-action-snooze-later-today = Snooze Tab Until Later Today
whimsy-action-snooze-tonight = Snooze Tab Until Tonight
whimsy-action-snooze-tomorrow = Snooze Tab Until Tomorrow
whimsy-action-snooze-weekend = Snooze Tab Until the Weekend
whimsy-action-snooze-next-week = Snooze Tab Until Next Week
## wave8/folders: History space filter: Deleted spaces option (W8-38).

whimsy-history-deleted-spaces = Deleted spaces

## wave8/folders: Live folders: Resync option (W8-26).

whimsy-live-folder-resync =
    .label = Resync
whimsy-action-resync-live-folder = Resync Live Folder

## wave8/cmds: View Claude in Whimsy Replays command
whimsy-action-view-claude-replays = View Claude in Whimsy Replays

## wave8/cmds: W8-10 Move tab to another space (Arc parity)
whimsy-action-move-to = Move to
whimsy-action-move-tab-next-space = Move Tab to Next Space
whimsy-action-move-tab-prev-space = Move Tab to Previous Space

## wave8/cmds: W8-42 New Note command and menu item
whimsy-action-create-note = New Note
whimsy-context-new-note =
    .label = New Note

## wave8/cmds: W8-13 the selection verbs as right-click menu items.
whimsy-context-verb-map =
    .label = Show in Maps
# W10-20: names the app a mailto: link opens ("Mail" unless you chose another).
whimsy-context-verb-email =
    .label = Email with { $app }
whimsy-context-verb-note =
    .label = Add to Note
whimsy-context-verb-calendar =
    .label = Add to Calendar
whimsy-context-verb-linear-new =
    .label = New Linear Issue
whimsy-context-verb-linear-search =
    .label = Search Linear
# W10-20: the submenu of actions that hand the selected text to another app
# (macOS's own name for this).
whimsy-context-quick-actions =
    .label = Quick Actions
## W10-26: the Quick Note card (New Note) and its "Note saved" toast.
whimsy-quick-note-title = New Note
whimsy-quick-note-name =
    .placeholder = Title
    .aria-label = Title
whimsy-quick-note-body =
    .placeholder = Write a note. Markdown works.
    .aria-label = Note
whimsy-quick-note-attach = This page · { $host }
whimsy-quick-note-attach-button =
    .aria-label = Keep with this page, { $host }
whimsy-quick-note-private = Not kept with private pages
whimsy-quick-note-no-page = No page to keep it with
whimsy-quick-note-saved = Saved
whimsy-quick-note-hint-attached = Shows again when you open this page
whimsy-quick-note-hint = Notes for { $profile } · saved as you type
whimsy-quick-note-hint-plain = Saved as you type
whimsy-quick-note-open =
    .label = Open in Notes
whimsy-quick-note-done =
    .label = Done
whimsy-note-saved-toast = Note saved
whimsy-note-saved-open = Open
whimsy-action-open-notes = Open Notes
whimsy-library-notes-this-page = This page
whimsy-library-notes-other = Other notes
## batch8: W8-04 Collapse All Folders
whimsy-action-collapse-all-folders = Collapse All Folders
whimsy-action-expand-all-folders = Expand All Folders
## wave8: Balloon Dash back online notice (W8-43)
whimsy-game-back-online = You’re back online
whimsy-game-reload-page = Reload


# wave9/secfix: a normal tab that arrived in the Private Space from another window or Mini.
whimsy-isolation-scratch-moved-toast =
    { $count ->
        [one] Only private tabs go in the Private Space. The tab moved to another space.
       *[other] Only private tabs go in the Private Space. The tabs moved to another space.
    }

# wave9/secfix: Favorite This Split refuses a split with a private pane.
whimsy-split-favorite-private-toast = Splits with private tabs can’t be saved as favorites
## wave9/restore (W9-07): Zen's Change Icon for the current tab, as a command
whimsy-action-change-tab-icon = Change Tab Icon…
## wave9/designfix: Tips can be turned off from the tip (H2).
whimsy-teach-turn-off = Turn Off Tips
whimsy-teach-off-toast = Tips are off. Turn them on again in Settings → Look and Feel.
## wave9/designfix: Library deletes can be undone; screenshots get a menu (M9).
whimsy-library-files-deleted-toast = Deleted screenshot
whimsy-library-notes-deleted-toast = Deleted note
whimsy-library-files-copied-toast = Copied screenshot
whimsy-library-files-menu-open =
    .label = Open
whimsy-library-files-menu-reveal =
    .label =
        { PLATFORM() ->
            [macos] Show in Finder
           *[other] Show in Folder
        }
whimsy-library-files-menu-copy =
    .label = Copy
whimsy-library-files-menu-delete =
    .label = Delete
## wave9/designfix: text that was hard-coded in English (L6).
whimsy-year-off = Your Year in Tabs is turned off.
whimsy-game-off = Balloon Dash is turned off.
whimsy-email-aliases-field-button = Email alias
whimsy-bionic-reader-button = Bionic reading
## wave9/menus: W9-09 right-click ↔ command parity. Each tab, space, split,
## page and selection menu action is also a command (command bar and
## about:keyboard, no default shortcut).
whimsy-action-rename-tab = Rename Tab
whimsy-action-unload-tab = Unload Tab
whimsy-action-archive-tabs-below = Archive Tabs Below
whimsy-action-close-duplicate-tabs = Close Duplicate Tabs
whimsy-action-close-other-tabs = Close Other Tabs
whimsy-action-close-tabs-below = Close Tabs Below
whimsy-action-select-all-tabs = Select All Tabs
whimsy-action-mute-tab-toggle = Mute or Unmute Tab
whimsy-action-mute-tab = Mute Tab
whimsy-action-unmute-tab = Unmute Tab
whimsy-action-add-site-to-routing = Add Site to Air Traffic Control
whimsy-action-replace-pinned-url = Replace Pinned URL with Current
whimsy-action-share-tab = Share Tab…
whimsy-action-rename-space = Rename Space
# W10-39: Settings → Keyboard Shortcuts group for every other key the page
# didn't list (Zen's, Firefox's, DevTools'), so its shortcut shows as taken
# and can be changed.
whimsy-keys-group-other = Other Shortcuts
whimsy-action-change-space-icon = Change Space Icon…
whimsy-action-unload-space = Unload Space
whimsy-action-share-space = Share Space…
whimsy-action-delete-space = Delete Space…
whimsy-action-share-split = Share Split View…
whimsy-action-change-split-icon = Change Split Icon…
whimsy-action-rename-split = Rename Split
whimsy-action-duplicate-split = Duplicate Split
whimsy-action-mute-pane-toggle = Mute or Unmute Focused Pane
whimsy-action-mute-pane = Mute Focused Pane
whimsy-action-unmute-pane = Unmute Focused Pane
# Firefox's own names for these page commands.
whimsy-action-back = Back
whimsy-action-forward = Forward
whimsy-action-view-page-source = View Page Source
whimsy-action-save-page = Save Page As…
whimsy-action-bookmark-page = Bookmark Page…
whimsy-action-inspect-accessibility = Inspect Accessibility Properties
whimsy-action-copy-link-to-highlight = Copy Link to Highlight
whimsy-action-print-selection = Print Selection…
whimsy-highlight-copied-toast = Copied a link to the highlight
whimsy-highlight-none-toast = Select some text on the page first
whimsy-print-selection-none-toast = Select some text on the page first

## wave9/menus: W9-09 commands as right-click menu items. Most are off until
## turned on in Settings → Menus.
whimsy-context-allow-copy =
    .label = Allow Copy and Paste on This Site
whimsy-context-disallow-copy =
    .label = Stop Allowing Copy and Paste on This Site
whimsy-context-wayback =
    .label = Open in Wayback Machine
whimsy-context-capture-portrait =
    .label = Capture in Portrait Mode
whimsy-context-capture-full-page =
    .label = Capture Full Page
whimsy-context-devmode-on =
    .label = Turn Developer Mode On for This Site
whimsy-context-devmode-off =
    .label = Turn Developer Mode Off for This Site
whimsy-context-tab-volume =
    .label = Tab Volume…
whimsy-context-playlist-save-tab =
    .label = Save Video to Playlist
whimsy-context-copy-link-markdown =
    .label = Copy Link as Markdown
whimsy-context-show-hidden-spaces =
    .label = Show Hidden Spaces…
whimsy-context-reset-space-tabs =
    .label = Reset All Tabs in This Space
whimsy-context-add-finder-folder =
    .label = Add Finder Folder…
whimsy-context-collapse-all-folders =
    .label = Collapse All Folders
whimsy-context-expand-all-folders =
    .label = Expand All Folders
whimsy-context-swap-panes =
    .label = Swap Panes
whimsy-context-favorite-split =
    .label = Favorite This Split
whimsy-context-copy-url-quote =
    .label = Copy URL as Quote

## wave9/menus: Settings → Menus rows for them.
whimsy-menus-page-allow-copy =
    .label = Allow Copy and Paste on This Site
    .description = Only on pages that block copying
whimsy-menus-page-wayback =
    .label = Open in Wayback Machine
whimsy-menus-page-capture-portrait =
    .label = Capture in Portrait Mode
whimsy-menus-page-capture-full-page =
    .label = Capture Full Page
whimsy-menus-page-dev-mode =
    .label = Turn Developer Mode On or Off for This Site
whimsy-menus-tab-tab-volume =
    .label = Tab Volume…
whimsy-menus-tab-playlist =
    .label = Save Video to Playlist
    .description = When the tab plays a video file
whimsy-menus-tab-copy-markdown =
    .label = Copy Link as Markdown
whimsy-menus-tab-move-to-new-space =
    .label = Move Tab ▸ New Space…
whimsy-menus-space-show-hidden =
    .label = Show Hidden Spaces…
whimsy-menus-space-reset-tabs =
    .label = Reset All Tabs in This Space
whimsy-menus-sidebar-add-finder-folder =
    .label = Add Finder Folder…
whimsy-menus-sidebar-collapse-all-folders =
    .label = Collapse All Folders
whimsy-menus-sidebar-expand-all-folders =
    .label = Expand All Folders
whimsy-menus-folder-collapse-all =
    .label = Collapse All Folders
whimsy-menus-folder-expand-all =
    .label = Expand All Folders
whimsy-menus-split-swap-panes =
    .label = Swap Panes
whimsy-menus-split-row-favorite =
    .label = Favorite This Split
whimsy-menus-selection-copy-url-quote =
    .label = Copy URL as Quote
whimsy-menus-space-new-profile =
    .label = Profile ▸ Create a New Profile…
whimsy-menus-folder-live-resync =
    .label = Live Options ▸ Resync
    .description = On live folders
whimsy-menus-media = Video and Audio
whimsy-menus-media-description = When you right-click a video or audio player on a page.
whimsy-menus-media-play =
    .label = Play / Pause
whimsy-menus-media-mute =
    .label = Mute / Unmute
whimsy-menus-media-speed =
    .label = Speed
whimsy-menus-media-loop =
    .label = Loop
whimsy-menus-media-fullscreen =
    .label = Full Screen
whimsy-menus-media-controls =
    .label = Show Controls / Hide Controls
whimsy-menus-media-view =
    .label = Open Video in New Tab
whimsy-menus-media-pip =
    .label = Watch in Picture-in-Picture
whimsy-menus-media-playlist =
    .label = Save to Playlist
    .description = When the video or audio is a file Whimsy can save
whimsy-menus-media-save-frame =
    .label = Take Snapshot…
whimsy-menus-media-save =
    .label = Save Video As… / Save Audio As…
whimsy-menus-media-copy-link =
    .label = Copy Video Link / Copy Audio Link
whimsy-menus-media-email =
    .label = Email Video… / Email Audio…

## wave9/menus (design-full-4 M12): Glance size as one assignable command.
whimsy-action-glance-size-cycle = Change Glance Size

## wave9/menus (design-full-4 M11): extra command-bar search words, comma-separated.
# wave10/fixes W10-10: the Private Space was called Scratch; its old name (and the usual private words) still find it.
whimsy-keywords-new-private-space = Scratch, Scratch Space, Incognito, Private Window, Private Browsing
whimsy-keywords-qrcode = QR Code, Create QR Code, Share QR Code, QR
whimsy-keywords-create-note = New Note, Create Note, Note, Take Note
whimsy-keywords-move-tab-next-space = Move Tab to Next Space, Move to Next Space, Send Tab to Next Space
whimsy-keywords-move-tab-prev-space = Move Tab to Previous Space, Move to Previous Space, Send Tab to Previous Space
whimsy-keywords-move-to-space = Move, Move to, Move tab, Move tab to, Move to Space

## wave9/menus (design-full-4 M12): moving the tab to a space by its place,
## like Switch to Space 1–9 (assignable, no default shortcut).
whimsy-action-move-tab-to-space-1 = Move Tab to Space 1
whimsy-action-move-tab-to-space-2 = Move Tab to Space 2
whimsy-action-move-tab-to-space-3 = Move Tab to Space 3
whimsy-action-move-tab-to-space-4 = Move Tab to Space 4
whimsy-action-move-tab-to-space-5 = Move Tab to Space 5
whimsy-action-move-tab-to-space-6 = Move Tab to Space 6
whimsy-action-move-tab-to-space-7 = Move Tab to Space 7
whimsy-action-move-tab-to-space-8 = Move Tab to Space 8
whimsy-action-move-tab-to-space-9 = Move Tab to Space 9

## wave9/menus (design-full-4 M6): the tab menu's close row on an Essential.
whimsy-tab-context-delete-essential =
    .label =
        { $tabCount ->
            [1] Delete Essential
           *[other] Delete { $tabCount } Essentials
        }

## wave9/menus (design-full-4 L8): File menu.
whimsy-menu-quick-window =
    .label = New Mini Whimsy
## wave9: Battery saver (Arc parity: threshold, banner, auto-off, throttles)
whimsy-action-toggle-battery-saver = Turn Battery Saver On or Off
whimsy-action-turn-on-battery-saver = Turn Battery Saver On
whimsy-action-turn-off-battery-saver = Turn Battery Saver Off
whimsy-battery-saver-active-toast = Battery Saver is on: battery below 20%
whimsy-battery-saver-on-toast = Battery Saver is on
whimsy-battery-saver-off-toast = Battery Saver is off
whimsy-battery-saver-turn-off-button = Turn Off
whimsy-battery-saver-header = Battery Saver
whimsy-battery-saver-enable =
    .label = Turn on Battery Saver automatically when the battery is below 20%
whimsy-battery-saver-help = Animations run at up to 30 frames per second and background tabs’ timers slow down. It turns off again when you plug in or the battery is back above 20%.
## wave9: Zap undo granularity (W9-05)

whimsy-action-zap-restore-all = Restore All Zapped Elements
whimsy-site-zap-zapped-menu =
    .label = { $count ->
        [one] Zapped Elements (1)
       *[other] Zapped Elements ({ $count })
    }
# $name (String) - what the zapped element says: its label, alt text or opening words
whimsy-site-zap-restore-item =
    .label = Restore “{ $name }”
# $kind (String) - image, video, frame or other; $index (Number) - its place in the list
whimsy-site-zap-restore-item-unnamed =
    .label = { $kind ->
        [image] Restore Image { $index }
        [video] Restore Video { $index }
        [frame] Restore Embedded Frame { $index }
       *[other] Restore Element { $index }
    }
whimsy-site-zap-restore-all =
    .label = Restore All Zapped Elements
whimsy-site-zap-restored-toast = Restored “{ $name }”
whimsy-site-zap-restored-element-toast = Restored zapped element
whimsy-site-zap-restored-all-toast = Restored all zapped elements

## wave9: form protection (W9-03)

whimsy-tabs-form-protection =
    .label = Protect tabs with unsaved forms from auto-archive
whimsy-action-protect-form = Protect Tab from Auto-Archive
whimsy-action-protect-form-on = Protect This Tab from Auto-Archive
whimsy-action-protect-form-off = Stop Protecting This Tab from Auto-Archive
# $reason (String) - "form" when the page has typed text, "manual" when protected by hand
whimsy-tab-form-protected-tooltip = { $reason ->
        [manual] Protected from auto-archive
       *[form] Protected from auto-archive: this tab has unsent form text
    }
whimsy-form-protected-toast = This tab won’t be auto-archived
whimsy-form-unprotected-toast = This tab can be auto-archived again
## batch9: W9-06 smart address bar buttons
whimsy-smart-buttons-setting =
    .label = Show Reader View, Translate, media and download buttons in the address bar when they apply
whimsy-action-picture-in-picture = Picture-in-Picture
whimsy-action-play-pause-media = Play or Pause Media
whimsy-action-translate-page = Translate Page


## wave9: W8-29 link lasso (Open as Tabs, Make Folder)
# Commands (command bar, about:keyboard): say what they act on.
whimsy-action-lasso-open-tabs = Open Lassoed Links as Tabs
whimsy-action-lasso-make-folder = Make Folder from Lassoed Links
# The pill shown over the lassoed links.
whimsy-link-lasso-pill-open-tabs = Open as Tabs
whimsy-link-lasso-pill-make-folder = Make Folder
# The folder's name when the page has no title or address to name it after.
whimsy-link-lasso-untitled-folder = Links
whimsy-link-lasso-open-toast =
    { $count ->
        [one] Opened 1 tab
       *[other] Opened { $count } tabs
    }

## wave9: Font Inspector (What Font Is This?) and Element Inspector Lite.

whimsy-font-inspector-title = Font Inspector
whimsy-font-inspector-subtitle = { $font }
whimsy-action-inspect-font = Inspect Font
whimsy-action-search-font = Search for This Font
whimsy-context-inspect-font =
    .label = What Font Is This?
    .accesskey = F
whimsy-menus-selection-inspect-font = What Font Is This?
whimsy-font-size-label = Size
whimsy-font-weight-label = Weight
whimsy-font-line-height-label = Line height
whimsy-font-letter-spacing-label = Letter spacing
whimsy-font-color-label = Color
whimsy-font-copy-css = Copy CSS
whimsy-font-search-button = Search for This Font
whimsy-font-pick-another = Pick Another Element
whimsy-font-sample-text = The quick brown fox jumps over the lazy dog

whimsy-element-inspector-title = Element Info
whimsy-action-inspect-element = Element Info
# W10-45: other words people search the command bar with for Element Info.
whimsy-keywords-inspect-element = Inspect Element, Box Model, Margin, Padding, Contrast, Measure, Element Inspector
whimsy-context-element-info =
    .label = Element Info
    .accesskey = E
whimsy-action-measure-gap = Measure Gap
whimsy-element-open-devtools = Open in DevTools
whimsy-element-box-model = Box Model
whimsy-element-margin = Margin
whimsy-element-margin-box = margin
whimsy-element-border = Border
whimsy-element-border-box = border
whimsy-element-padding = Padding
whimsy-element-padding-box = padding
whimsy-element-content = Content
whimsy-element-colors-heading = Colors & Contrast
whimsy-element-text-color = Text Color
whimsy-element-bg-color = Background
whimsy-element-contrast-ratio = Contrast Ratio
whimsy-element-wcag-badge = WCAG { $rating }
whimsy-element-wcag-pass-aaa = WCAG AAA Pass
whimsy-element-wcag-pass-aa = WCAG AA Pass
whimsy-element-wcag-fail = WCAG Fail
whimsy-element-gap-heading = Gap Measurement
# The pill shown while picking an element on the page.
whimsy-element-picker-hint = Hold Option or click another element to measure gap · Esc to stop
whimsy-element-gap-toast = Gap: { $gapX }px horizontal, { $gapY }px vertical
whimsy-element-pick-button = Pick Element
whimsy-element-pick-another = Pick Another
whimsy-element-selected-chip = Selected: { $tag }
whimsy-tabs-font-inspector =
    .label = Font Inspector: What Font Is This? (context menu and command bar)
whimsy-tabs-element-inspector =
    .label = Element Info: box model, colors, contrast and gap measurement


## wave9/pagedev: Fonts on This Page, Page Colors and Built With (W9-11).
## They live in Tools > Browser Tools with the Font Inspector and Element Info.

whimsy-action-page-fonts = Fonts on This Page
whimsy-action-page-colors = Page Colors
whimsy-action-built-with = Built With
whimsy-pagedev-menu-fonts =
    .label = Fonts on This Page
whimsy-pagedev-menu-colors =
    .label = Page Colors
whimsy-pagedev-menu-built-with =
    .label = Built With
whimsy-pagedev-menu-font-inspector =
    .label = What Font Is This?
whimsy-pagedev-menu-element-info =
    .label = Element Info
whimsy-tabs-page-dev =
    .label = Developer tools for the page: Fonts on This Page, Page Colors and Built With (Tools ▸ Browser Tools and command bar)

whimsy-pagedev-unavailable = Whimsy can’t look inside this page. Try a regular web page.
# $value (string) - the text a row copies
whimsy-pagedev-copy-value = Copy { $value }
whimsy-pagedev-share-tiny = under 1%

# $count (number) - font families on the page
whimsy-pagedev-fonts-summary = { $count ->
    [one] 1 font family
   *[other] { $count } font families
}
whimsy-pagedev-fonts-empty = No text is drawn on this page.
whimsy-pagedev-font-source-embedded = Web font embedded in the page
whimsy-pagedev-font-highlight = Highlight on Page
whimsy-pagedev-font-highlight-none = None of this text is visible to highlight

whimsy-pagedev-format-label = Color format
whimsy-pagedev-format-hex = HEX
whimsy-pagedev-format-rgb = RGB
whimsy-pagedev-format-hsl = HSL
# $count (number) - colors on the page
whimsy-pagedev-palette-heading = { $count ->
    [one] 1 color
   *[other] { $count } colors
}
# $count (number) - colors not listed
whimsy-pagedev-colors-more =
    { $count ->
        [one] And 1 rarely used color.
       *[other] And { $count } rarely used colors.
    }
whimsy-pagedev-colors-empty = No colors found on this page.
whimsy-pagedev-role-text = Text
whimsy-pagedev-role-background = Background
whimsy-pagedev-role-border = Border
whimsy-pagedev-role-link = Link
whimsy-pagedev-role-accent = Accent
# $failing (number) - pairs below WCAG AA
whimsy-pagedev-contrast-heading =
    { $failing ->
        [0] Text contrast, all pass AA
        [one] Text contrast, 1 fails AA
       *[other] Text contrast, { $failing } fail AA
    }
# $fg (string) - text color; $bg (string) - background color
whimsy-pagedev-contrast-pair = { $fg } on { $bg }
whimsy-pagedev-result-pass = PASS
whimsy-pagedev-result-fail = FAIL
whimsy-pagedev-contrast-large = Large text
whimsy-pagedev-contrast-image = Over an image, approximate
# $fg, $bg (string) - colors; $ratio (string) - e.g. "4.53:1"; $aa, $aaa (string) - PASS or FAIL
whimsy-pagedev-contrast-copy = { $fg } on { $bg }: { $ratio } (AA { $aa }, AAA { $aaa })
whimsy-pagedev-copy-css-vars =
    .label = Copy as CSS Variables

whimsy-pagedev-built-with-empty = No known technologies found on this page.
whimsy-pagedev-built-with-local = Found on this Mac from the page and its headers. Nothing was sent anywhere.
whimsy-pagedev-copy-all =
    .label = Copy All
whimsy-pagedev-category-js-framework = JavaScript Frameworks
whimsy-pagedev-category-js-library = JavaScript Libraries
whimsy-pagedev-category-cms = Content Management
whimsy-pagedev-category-ecommerce = Online Stores
whimsy-pagedev-category-site-builder = Site Builders
whimsy-pagedev-category-static-site = Static Site Generators
whimsy-pagedev-category-css-framework = CSS Frameworks
whimsy-pagedev-category-analytics = Analytics
whimsy-pagedev-category-tag-manager = Tag Managers
whimsy-pagedev-category-font-service = Font Services
whimsy-pagedev-category-cdn = CDNs
whimsy-pagedev-category-hosting = Hosting
whimsy-pagedev-category-web-server = Web Servers
whimsy-pagedev-category-backend = Back End
# $kind (string) - which sign was found; $detail (string) - the sign itself; $count (number) - matching class names
whimsy-pagedev-evidence =
    { $kind ->
        [generator] Generator tag: { $detail }
        [global] Script global { $detail }
        [selector] Page element { $detail }
        [expando] Element property { $detail }
        [resource] Loads { $detail }
        [header] Response header { $detail }
        [css-var] CSS variable { $detail }
        [classes] { $count } utility classes, like { $detail }
       *[other] { $detail }
    }
## wave9: W9-04 site settings ("This Site" in the site panel)
whimsy-action-site-settings = Site Settings…
whimsy-site-settings-title = This Site
whimsy-site-settings-forget-all = Forget All
whimsy-site-settings-zoom = Zoom
# W10-16: the zoom stepper (− / the % / +); the % resets.
whimsy-site-settings-zoom-out =
    .title = Zoom Out
    .aria-label = Zoom Out
whimsy-site-settings-zoom-in =
    .title = Zoom In
    .aria-label = Zoom In
whimsy-site-settings-zoom-reset =
    .title = Reset to 100%
    .aria-label = Reset zoom to 100%
whimsy-site-settings-autoplay-default = Use Default
whimsy-site-settings-reader = Always Open in Reader View
whimsy-site-settings-fullscreen = Open in Full Screen
whimsy-site-settings-useragent = Pretend to Be
whimsy-site-settings-useragent-reloads = Reloads the page
# $browser (string) - Chrome, Safari, iPhone, Whimsy or Custom
whimsy-site-settings-useragent-reloading = Reloading as { $browser }…
whimsy-site-settings-useragent-default = Whimsy
whimsy-site-settings-useragent-default-detail = no disguise
whimsy-site-settings-useragent-chrome-mac = Chrome
whimsy-site-settings-useragent-safari-mac = Safari
whimsy-site-settings-useragent-safari-iphone = iPhone
whimsy-site-settings-useragent-iphone-detail = mobile site
whimsy-site-settings-useragent-custom = Custom…
whimsy-site-settings-private-note = Private window: these settings are forgotten when you close your private tabs.
# $site (string) - the site's host, e.g. example.com
whimsy-site-settings-forgot-toast = Forgot settings for { $site }
## wave7/easel: View Easels…, Add Page to Easel, Copy Link

whimsy-action-view-easels = View Easels…
whimsy-menu-view-easels =
    .label = View Easels…
whimsy-action-add-page-to-easel = Add Page to Easel
whimsy-easel-export-link = Copy Link
whimsy-easel-status-copied-link = Copied the link to this easel

# batch10: view-source line wrap (W10-34)
whimsy-view-source-wrap =
    .label = Wrap long lines in View Page Source
    .searchkeywords = view source, page source, line wrap, wrap long lines
whimsy-action-view-source-wrap-toggle = Wrap Long Lines in Page Source
whimsy-action-view-source-wrap-on = Wrap Long Lines in Page Source
whimsy-action-view-source-wrap-off = Stop Wrapping Long Lines in Page Source

## wave10/fixes W10-09: the Private Space's empty state (it opens with no tab)

whimsy-private-empty-title = Private Space
whimsy-private-empty-body = Nothing you do here is saved. Pages leave no history, and their cookies and site data are forgotten when you close them.
whimsy-private-empty-new = New Private Tab
whimsy-private-empty-note = This space closes when you leave it with no tabs.
## wave10/mini W10-13: Mini Whimsy's pages (pill tabs) and extensions

whimsy-action-mini-new-tab = New Tab in Mini Whimsy
whimsy-action-mini-extensions = Show Extensions in Mini Whimsy
# The group of Mini's own shortcuts in Settings → Keyboard Shortcuts (they
# work only inside Mini Whimsy).
whimsy-keys-group-mini = Mini Whimsy
whimsy-action-mini-open-in-space = Open in Current Space
whimsy-action-mini-choose-space = Open in Another Space…
whimsy-quick-window-tabs =
    .aria-label = Pages
whimsy-quick-window-tab-close =
    .title = Close Tab
    .aria-label = Close Tab
## wave10 (W10-12): a command for every setting (WhimsySettingsCommands).
## Each setting's short name is its command's name and a Settings search
## word; .keywords are more words Settings search finds it by (comma-separated).
## $name (string) - a setting's short name, from whimsy-setting-<name> below
## $choice (string) - one of the setting's choices, as Settings shows it
## $value (number) - the new level, in percent

whimsy-setting-toggle = Turn { $name } On or Off
whimsy-setting-on = Turn { $name } On
whimsy-setting-off = Turn { $name } Off
whimsy-setting-choose = { $name }: { $choice }
whimsy-setting-increase = Increase { $name }
whimsy-setting-decrease = Decrease { $name }
whimsy-setting-open = Customize { $name }…
whimsy-setting-turned-on = { $name } is on
whimsy-setting-turned-off = { $name } is off
whimsy-setting-chosen = { $name }: { $choice }
whimsy-setting-level = { $name }: { $value }%

whimsy-setting-app-icon = App Icon
    .keywords = dock icon, icon, logo, balloon
whimsy-setting-ui-zoom = Interface Zoom
    .keywords = zoom, interface size, ui scale, bigger, smaller, text size
whimsy-setting-notes = Notes
    .keywords = scratchpad, markdown, library notes
whimsy-setting-note-blocks = Live Blocks in Notes
    .keywords = embed, live notes, note blocks
whimsy-setting-easel = Easels
    .keywords = canvas, drawing, whiteboard, moodboard
whimsy-setting-finder-folders = Finder Folders
    .keywords = folders, library folders, local files
whimsy-setting-screenshot-sidebar = Screenshots in the Library
    .keywords = screenshots, captures, library
whimsy-setting-menu-icons = Menu Icons
    .keywords = icons in menus, context menu icons, right-click icons, macos 26
whimsy-setting-reading-time = Reading Time
    .keywords = minutes to read, reader view, article length
whimsy-setting-dark-pdf = Dark PDFs
    .keywords = pdf dark mode, night mode, invert pdf
whimsy-setting-ui-font = Interface Font
    .keywords = font, typeface, sidebar font, system font
whimsy-setting-density = Density
    .keywords = compact, roomy, spacing, tab height
whimsy-setting-transparency = Transparency
    .keywords = translucent, see-through, blur, opacity, vibrancy
whimsy-setting-liquid-glass = Liquid Glass
    .keywords = glass, macos 26, translucent sidebar
whimsy-setting-menu-bar-extra = Menu Bar Icon
    .keywords = menu bar extra, status bar, tray, mini whimsy, recent tabs
whimsy-setting-seasons = Seasonal Touches
    .keywords = seasons, seasonal themes, halloween, holidays, pumpkins, snow
whimsy-setting-full-url = Full Address
    .keywords = full url, whole url, domain only, address bar, url bar
whimsy-setting-new-windows = New Window Page
    .keywords = homepage, home page, start page, new windows, whimsy home, firefox home
whimsy-setting-new-tabs = New Tab Page
    .keywords = new tabs, whimsy home, firefox home, blank new tab
whimsy-setting-teach = Shortcut Tips
    .keywords = tips, hints, teach, learn shortcuts, onboarding
whimsy-setting-cookie-banners = Reject Cookie Banners
    .keywords = cookies, cookie pop-ups, consent, gdpr, autoconsent
whimsy-setting-ai = AI
    .keywords = enable ai, artificial intelligence, ai features, kill switch, block ai, disable ai, chatbot, llm
# W10-28: Firefox's own AI rows in Settings → AI.
whimsy-setting-firefox-chatbot = Firefox Chatbot
    .keywords = chatbot, ai chatbot, sidebar chatbot, chatgpt, claude, gemini, copilot
whimsy-setting-firefox-link-previews = Firefox Link Previews
    .keywords = link preview, key points, preview summary
whimsy-setting-firefox-tab-groups = Suggest Tab Groups
    .keywords = smart tab groups, tab group suggestions, ai tab groups
whimsy-setting-ai-provider = AI Provider
    .keywords = apple intelligence, claude, ollama, model, api key, local model
whimsy-setting-ai-claude-key = Claude API Key
    .keywords = anthropic, api key, claude key
whimsy-setting-ai-ollama-endpoint = Ollama Address
    .keywords = ollama, local model, endpoint, server
whimsy-setting-ai-ollama-model = Ollama Model
    .keywords = ollama, local model, llama, model
whimsy-setting-tidy-tabs = Tidy Tabs
    .keywords = broom, sort tabs, organize tabs, group tabs, ai tabs, arc max
whimsy-setting-tidy-titles = Tidy Tab Titles
    .keywords = tidy titles, rename tabs, short tab names, ai titles, pinned tab names, arc max
whimsy-setting-ask-on-page = Ask on Page
    .keywords = ask, question, find on page, chat with page, ai find, arc max
whimsy-setting-link-previews = 5-Second Previews
    .keywords = five second previews, link previews, link summary, hover preview, ai previews, arc max
whimsy-setting-page-watch = Watch Pages
    .keywords = page watch, monitor a page, page changes, alert, notify
whimsy-setting-strip-tracking = Clean Links
    .keywords = tracking parameters, utm, fbclid, query stripping, strip trackers, clean urls
whimsy-setting-private-in-window = Private Tabs in This Window
    .keywords = scratch, private space, private tabs, incognito, private window
whimsy-setting-vpn = Built-In VPN
    .keywords = vpn, ip protection, proxy, hide ip
whimsy-setting-email-aliases = Private Email Button
    .keywords = hide my email, firefox relay, email alias, email mask, icloud
whimsy-setting-handoff = Handoff
    .keywords = continuity, iphone, ipad, continue on another device
whimsy-setting-claude = Claude Access
    .keywords = claude code, claude in chrome, mcp, agent, browser use, automation
whimsy-setting-claude-whole-browser = Claude Access to Every Tab
    .keywords = claude, whole browser, all tabs, agent scope
whimsy-setting-claude-ask = Ask Before Claude Acts
    .keywords = claude, permission, confirm, ask per site
whimsy-setting-claude-replay = Claude Replays
    .keywords = claude, replay, recording, runs, agent history
whimsy-setting-update-channel = Update Channel
    .keywords = updates, dev builds, beta, release channel
whimsy-setting-new-tab-below = New Tabs Below Current Tab
    .keywords = tab position, insert after current, open next to current tab
whimsy-setting-new-tab-in-folder = New Tabs Stay in Their Folder
    .keywords = folders, tabs from a folder, owned tabs
whimsy-setting-dim-sleeping = Dim Sleeping Tabs
    .keywords = unloaded tabs, discarded tabs, faded tabs, sleeping
whimsy-setting-newtab-bottom = New Tab Button at the Bottom
    .keywords = plus button, new tab button, sidebar bottom
whimsy-setting-loading-indicator = Loading Indicator
    .keywords = progress bar, spinner, page loading
whimsy-setting-loading-line = Loading Progress Line
    .keywords = safari progress bar, loading line, progress line
whimsy-setting-hide-switcher = Space Switcher
    .keywords = hide space switcher, workspace icons, spaces bar, swipe spaces
whimsy-setting-tab-badges = Tab Badges
    .keywords = unread counts, notification dots, update dots, badges
whimsy-setting-background-mute = Background Tab Sound
    .keywords = mute background tabs, autoplay, sound, audio, mute
whimsy-setting-pip-snap-back = Picture-in-Picture Snap Back
    .keywords = pip, return video to page, put video back
whimsy-setting-call-pip = Floating Video Calls
    .keywords = meet, zoom, facetime, call pip, picture-in-picture calls
whimsy-setting-video-speed = Video Speed Control
    .keywords = playback speed, playback rate, faster video, slower video
whimsy-setting-video-captions = Translated Captions
    .keywords = subtitles, cc, translate captions, closed captions
whimsy-setting-video-speech-captions = Captions from Speech
    .keywords = live captions, transcribe, subtitles, speech recognition
whimsy-setting-playlist-offline = Offline Playlist
    .keywords = playlist, download videos, download audio, offline
whimsy-setting-archive-prompt = Internet Archive Copies
    .keywords = wayback machine, dead page, 404, archive.org, page gone
whimsy-setting-title-lines = Tab Title Lines
    .keywords = wrap tab titles, two-line tabs, multiline titles, long titles
whimsy-setting-auto-archive = Auto-Archive Idle Tabs
    .keywords = archive idle tabs, close old tabs, tab cleanup, auto archive
whimsy-setting-archive-idle-after = Archive Tabs After
    .keywords = auto archive time, idle time, 12 hours, 24 hours, 7 days, 30 days
whimsy-setting-form-protection = Unsaved Form Protection
    .keywords = forms, drafts, unsaved changes, protect tabs
whimsy-setting-archive-view = Tab Archive
    .keywords = closed tabs, archive, recently closed, view archive
whimsy-setting-undo-tab-actions = Undo for Tabs
    .keywords = cmd z, undo close tab, undo tab actions, restore tab
whimsy-setting-snooze-tab = Snooze Tabs
    .keywords = snooze, remind me later, later
whimsy-setting-fire-button = Fire Button
    .keywords = forget, burn, clear site data, fire
whimsy-setting-heavy-tabs = Heavy Tabs
    .keywords = memory, cpu, slow tabs, resource usage, find heavy tabs
whimsy-setting-font-inspector = Font Inspector
    .keywords = what font is this, identify font, typeface
whimsy-setting-element-inspector = Element Info
    .keywords = box model, inspect element, contrast, measure, element inspector
whimsy-setting-page-dev = Page Developer Tools
    .keywords = fonts on this page, page colors, built with, tech stack, developer
whimsy-setting-view-source-wrap = Wrap Long Lines in Page Source
    .keywords = view source, page source, line wrap, wrap long lines
whimsy-setting-tree-tabs = Tree-Style Tabs
    .keywords = tree style tabs, nested tabs, tree tabs, child tabs, indented tabs
whimsy-setting-tree-style = Tree Style
    .keywords = islands, tree, nested tab style
whimsy-setting-command-recent-tabs = Recent Tabs in the Command Bar
    .keywords = command bar, recent tabs, empty command bar
whimsy-setting-close-window-with-last-tab = Close Window with Last Tab
    .keywords = last tab, keep window open, close window
whimsy-setting-dock-badge = Dock Download Badge
    .keywords = dock, badge, download count
whimsy-setting-quick-look = Quick Look for Downloads
    .keywords = quicklook, preview downloads, space bar
whimsy-setting-space-extensions = Extensions per Profile
    .keywords = extensions, add-ons, profile extensions, space extensions
whimsy-setting-split-new-tab = New Tab in the Focused Pane
    .keywords = split view, new tab in split, focused pane
whimsy-setting-history-preview = History Previews
    .keywords = hover card, history hover, page preview
whimsy-setting-people-cards = People Cards
    .keywords = github, linkedin, x, twitter, profile preview, hover card
whimsy-setting-link-cards = Link Cards
    .keywords = link preview, shift hover, where a link goes, hover card
whimsy-setting-already-open = Go to Open Tab
    .keywords = already open, switch to tab, duplicate tabs
whimsy-setting-trails = Trails
    .keywords = back forward menu, history trail, pages you went back from
whimsy-setting-page-actions = Page Actions
    .keywords = add to calendar, open in maps, cook mode, recipes, parcel tracking
whimsy-setting-smart-buttons = Smart Buttons
    .keywords = reader view button, translate button, address bar buttons, media button
whimsy-setting-external-links = Links from Other Apps
    .keywords = external links, default browser, mini whimsy, little arc, links from apps
whimsy-setting-glance-size = Glance Size
    .keywords = peek size, glance width, glance
whimsy-setting-peek-essential-links = Glance for Pinned Tab Links
    .keywords = peek, essentials, pinned tabs, glance, external links
whimsy-setting-split-link-click = Shift-Click to Split
    .keywords = split view, shift click, open in split
whimsy-setting-follower-tabs = Follower Splits
    .keywords = follower tabs, split view, links open in the other pane
whimsy-setting-split-headers = Split Pane Headers
    .keywords = split header, pane title bar, split view
whimsy-setting-bangs = Bang Shortcuts
    .keywords = bangs, !g, duckduckgo bangs, search shortcuts
whimsy-setting-instant-result = Instant Results
    .keywords = shift enter, top result, i’m feeling lucky
whimsy-setting-search-deck = Search Deck
    .keywords = deck, flip through results, search cards
whimsy-setting-next-meeting = Meetings
    .keywords = calendar, next meeting, join meeting, google calendar, apple calendar
whimsy-setting-next-meeting-card = Meeting Card in the Sidebar
    .keywords = upcoming meetings, calendar card, sidebar
whimsy-setting-meeting-google-url = Google Calendar Address
    .keywords = google calendar, ical, calendar link
whimsy-setting-hardware-video-decoding = Hardware Video Decoding
    .keywords = gpu, video acceleration, hardware acceleration, decoding
whimsy-setting-battery-saver = Automatic Battery Saver
    .keywords = battery, low power, energy saver, battery saver
whimsy-setting-menus = Right-Click Menus
    .keywords = menus, context menus, menu items, hide menu items, customize menus
whimsy-setting-bangs-list = Bang List
    .keywords = bangs, custom bangs, edit bangs
whimsy-setting-profiles = Profile Settings
    .keywords = profiles, search engine per profile, download folder per profile
whimsy-setting-profile-name = Profile Name
    .keywords = new profile, rename profile

## wave10: shared surface (WhimsySurface)

whimsy-surface-close =
    .tooltiptext = Close
    .aria-label = Close
whimsy-surface-copied = Copied

## wave10/desA W10-30: Fire, on one surface that explains each choice.
## "Forget About This Site…" opens it with the site chosen.

whimsy-fire-heading = What should Fire erase?
# $profile (string) - profile name, "Default" when none
whimsy-fire-choice-profile = The last hour in { $profile }
# $count (number) - tabs that close; $spaces (string) - "Work and Side Projects"
whimsy-fire-choice-profile-detail = { $count ->
    [0] Erases the last hour of history in your { $spaces } spaces. You’ll be signed out of sites you used in that hour. Other profiles aren’t touched.
    [one] Closes 1 tab in your { $spaces } spaces and erases their last hour of history. You’ll be signed out of sites you used in that hour. Other profiles aren’t touched.
   *[other] Closes { $count } tabs in your { $spaces } spaces and erases their last hour of history. You’ll be signed out of sites you used in that hour. Other profiles aren’t touched.
}
# The same, for a profile whose spaces have no names.
whimsy-fire-choice-profile-detail-unnamed = { $count ->
    [0] Erases this profile’s last hour of history. You’ll be signed out of sites you used in that hour. Other profiles aren’t touched.
    [one] Closes 1 tab and erases this profile’s last hour of history. You’ll be signed out of sites you used in that hour. Other profiles aren’t touched.
   *[other] Closes { $count } tabs and erases this profile’s last hour of history. You’ll be signed out of sites you used in that hour. Other profiles aren’t touched.
}
# $site (string) - base domain
whimsy-fire-choice-site = Everything from { $site }
# $site (string); $count (number) - its tabs that close
whimsy-fire-choice-site-detail = { $count ->
    [0] Erases all of { $site }’s history, sign-ins and saved data, from all time, in every profile.
    [one] Erases all of { $site }’s history, sign-ins and saved data, from all time, in every profile, and closes its tab.
   *[other] Erases all of { $site }’s history, sign-ins and saved data, from all time, in every profile, and closes its { $count } tabs.
}
whimsy-fire-choice-everything = Everything, everywhere
# $count (number) - unpinned tabs in every window that close
whimsy-fire-choice-everything-detail = { $count ->
    [0] Erases all history, sign-ins, site data, form and search history, the download list, closed tabs and the Archive in every profile, from all time.
    [one] Erases all history, sign-ins, site data, form and search history, the download list, closed tabs and the Archive in every profile, from all time, and closes 1 tab.
   *[other] Erases all history, sign-ins, site data, form and search history, the download list, closed tabs and the Archive in every profile, from all time, and closes { $count } tabs.
}
whimsy-fire-kept = Always kept: saved passwords, bookmarks, downloaded files, pinned tabs and Essentials.
whimsy-fire-cancel =
    .label = Cancel
whimsy-fire-run-profile =
    .label = Fire in This Profile
# $site (string)
whimsy-fire-run-site =
    .label = Forget { $site }
whimsy-fire-run-everything =
    .label = Fire Everywhere…
whimsy-fire-everything-confirm-title = Erase everything, everywhere?
# $count (number) - tabs that close
whimsy-fire-everything-confirm-body = Every profile signs out of every site and loses all its history. { $count ->
    [0] This can’t be undone.
    [one] 1 tab closes. This can’t be undone.
   *[other] { $count } tabs close. This can’t be undone.
}
whimsy-fire-back =
    .label = Back
whimsy-fire-everything-confirm-accept =
    .label = Fire Everywhere

# Result toasts: a title and a second line.
# $profile (string); $count (number) - tabs closed; $visits (number) -
# history visits erased; $sites (number) - sites whose data was erased
whimsy-fire-done-profile-title = Fired in { $profile }
whimsy-fire-done-profile-detail = { $count ->
    [0] Erased { $visits ->
        [one] 1 visit
       *[other] { $visits } visits
    } and { $sites ->
        [one] 1 site’s data
       *[other] { $sites } sites’ data
    } from the last hour
    [one] Closed 1 tab · erased { $visits ->
        [one] 1 visit
       *[other] { $visits } visits
    } and { $sites ->
        [one] 1 site’s data
       *[other] { $sites } sites’ data
    } from the last hour
   *[other] Closed { $count } tabs · erased { $visits ->
        [one] 1 visit
       *[other] { $visits } visits
    } and { $sites ->
        [one] 1 site’s data
       *[other] { $sites } sites’ data
    } from the last hour
}
whimsy-fire-done-everything-title = Fired everywhere
# $count (number) - tabs closed
whimsy-fire-done-everything-detail = { $count ->
    [0] Erased all history and site data
    [one] Closed 1 tab · erased all history and site data
   *[other] Closed { $count } tabs · erased all history and site data
}
# $site (string); $count (number) - tabs closed
whimsy-fire-done-site-title = Forgot { $site }
whimsy-fire-done-site-detail = { $count ->
    [0] Erased its history and site data
    [one] Closed 1 tab · erased its history and site data
   *[other] Closed { $count } tabs · erased its history and site data
}
whimsy-fire-failed-title = Couldn’t erase everything
whimsy-fire-failed-detail = Some site data was in use. Nothing else changed.
whimsy-fire-retry = Try Again

## wave10/desA W10-17: What Font Is This?, a card that names the font
## (system fonts plainly) and copies each value where it sits.

whimsy-font-system-name = San Francisco
whimsy-font-source-web = Web font
whimsy-font-source-local = Installed font
whimsy-font-source-system = Mac system font
whimsy-font-source-fallback = System fallback
whimsy-font-style-label = Style
whimsy-font-style-normal = Normal
whimsy-font-style-italic = Italic
# $font (string), $count (number) - characters drawn in it
whimsy-font-also = { $count ->
    [one] Also uses { $font } for 1 character.
   *[other] Also uses { $font } for { $count } characters.
}
# $weight (number) - the CSS weight, shown with its name: "600 Semibold"
whimsy-font-weight-value = { $weight ->
    [100] { $weight } Thin
    [200] { $weight } Extra Light
    [300] { $weight } Light
    [500] { $weight } Medium
    [600] { $weight } Semibold
    [700] { $weight } Bold
    [800] { $weight } Extra Bold
    [900] { $weight } Black
   *[400] { $weight } Regular
}
whimsy-font-close =
    .label = Close
whimsy-font-search-button-label =
    .label = Search for This Font
whimsy-font-copy-css-button =
    .label = Copy CSS
whimsy-font-copied-css-button =
    .label = Copied

## wave10/desA W10-18: Fonts, Colors and Built With on one surface.

whimsy-pagedev-tabs-label = Page tools
whimsy-pagedev-tab-fonts = Fonts
whimsy-pagedev-tab-colors = Colors
whimsy-pagedev-tab-built-with = Built With
whimsy-pagedev-by-share = by share of text
whimsy-pagedev-by-area = by area
# $percent (string), $source (string: Web font / Installed font / Mac system font)
whimsy-pagedev-font-line = { $percent } of text · { $source }
whimsy-pagedev-copy-name = Copy Name
whimsy-pagedev-pill-aaa = AAA
whimsy-pagedev-pill-aa = AA
whimsy-pagedev-pill-fail = Fails
whimsy-pagedev-reading = Reading the page…
whimsy-pagedev-copied-button =
    .label = Copied

## wave10/desA W10-25: form protection. A tab with a form you typed into
## shows an in-progress form glyph, asks before you unload it, and offers
## to fill your answers back in after a reload.

# $count (number) - tabs with forms that would unload
whimsy-form-unload-title = { $count ->
    [one] Unload this tab?
   *[other] Unload { $count } tabs with forms?
}
# $host (string) - the site, like "example.com"
whimsy-form-unload-body = You started a form on <b>{ $host }</b>. Whimsy keeps what you typed and fills it back in when you come back.
whimsy-form-unload-body-private = You started a form on <b>{ $host }</b>. Whimsy keeps what you typed until you close your private tabs.
# $count (number) - tabs with forms
whimsy-form-unload-body-many = You started forms in these { $count } tabs. Whimsy keeps what you typed and fills it back in when you come back.
whimsy-form-unload-keep =
    .label = Keep Loaded
whimsy-form-unload-accept =
    .label = Unload
# $count (number) - fields that can be filled
whimsy-form-refill-ask = { $count ->
    [one] Fill in 1 answer you typed before?
   *[other] Fill in { $count } answers you typed before?
}
whimsy-form-refill-ask-detail = Saved when this tab reloaded
whimsy-form-refill-fill = Fill In
# A tab protected by hand (Protect This Tab) with nothing typed: its lock.
whimsy-tab-protected-marker =
    .tooltiptext = Protected tab
    .aria-label = Protected tab

## W10-22: Settings search shows where the hit is.
whimsy-search-count =
    { $count ->
        [one] 1 setting matches “{ $query }”
       *[other] { $count } settings match “{ $query }”{ $places ->
            [1] {""}
           *[other] {" "}in { $places } places
        }
    }
whimsy-search-more =
    .label = Show { $count } more in { $group }
whimsy-search-keyword = Matches “{ $term }”
whimsy-search-show-in =
    .label = Show in { $pane } →
whimsy-search-none-title = No settings match “{ $query }”
whimsy-search-none-hint = Check the spelling, or try a shorter word.

## W11-15: the Hidden Spaces panel

whimsy-hidden-spaces-title = Hidden spaces
whimsy-hidden-spaces-filter =
    .placeholder = Find a hidden space
    .aria-label = Find a hidden space
# $count (number) - tabs in the space
whimsy-hidden-space-detail = { $count ->
    [one] 1 tab
   *[other] { $count } tabs
}
# $count (number) - tabs in the space; $profile (string) - its profile's name
whimsy-hidden-space-detail-profile = { $count ->
    [one] 1 tab
   *[other] { $count } tabs
} · { $profile }
whimsy-hidden-space-locked = Locked
whimsy-hidden-spaces-none = No hidden spaces
whimsy-hidden-spaces-none-hint = Hide a space to take it out of the switcher without losing its tabs.
# $space (string) - the current space's name
whimsy-hidden-spaces-hide-current =
    .label = Hide “{ $space }”
# $space (string) - the space's name
whimsy-hidden-space-shown-toast = “{ $space }” is back in the switcher

## W11-13: move private pages out to a space

whimsy-action-move-out-of-private = Move Out of Private…
whimsy-context-move-out-of-private =
    .label = Move Out of Private…
whimsy-private-move-title = Move to a space
whimsy-private-move-filter =
    .placeholder = Find a space
    .aria-label = Find a space
whimsy-private-move-hidden = Hidden
whimsy-private-move-hint = The page opens again in that space. Private sign-ins, cookies and history stay behind.
# $count (number) - tabs to move; $space (string) - the space's name
whimsy-private-move-confirm-title = { $count ->
    [one] Move this tab to “{ $space }”?
   *[other] Move { $count } tabs to “{ $space }”?
}
# $count (number) - tabs to move; $profile (string) - the space's profile
whimsy-private-move-confirm-body = { $count ->
    [one] It opens again in the { $profile } profile, outside private browsing, and goes into your history. You might need to sign in again.
   *[other] They open again in the { $profile } profile, outside private browsing, and go into your history. You might need to sign in again.
}
whimsy-private-move-back =
    .label = Back
# $count (number) - tabs to move
whimsy-private-move-confirm-button =
    .label = { $count ->
        [one] Move Tab
       *[other] Move Tabs
    }
# $space (string) - the space's name; $count (number) - tabs moved
whimsy-private-moved-toast = Moved to { $space }

## W11-17: the system unlock prompt (Touch ID or the Mac password). macOS
## shows the reason as “Whimsy is trying to …”.

whimsy-auth-caption = { -brand-short-name }
# $space (string) - the locked space's name
whimsy-auth-reason-space = open the locked space “{ $space }”

## W11-14: private lock

whimsy-auth-reason-private = show your private tabs
whimsy-auth-reason-private-off = turn off the private lock
whimsy-private-lock-tab-label = Private tab
whimsy-private-lock-window-name = Private Window
whimsy-private-lock-urlbar = Locked
# $count (number) - locked tabs in the Private Space
whimsy-private-lock-space-row = { $count ->
    [one] 1 private tab
   *[other] { $count } private tabs
}
whimsy-private-lock-tab-title = This private tab is locked
# $others (number) - other private tabs, at least 1
whimsy-private-lock-tab-others = { $others ->
    [one] Unlock to see it and your other private tab.
   *[other] Unlock to see it and your { $others } other private tabs.
}
whimsy-private-lock-tab-alone = Unlock to see it.
whimsy-private-lock-space-title = Private Space is locked
# $count (number) - tabs in the Private Space
whimsy-private-lock-space-detail = { $count ->
    [one] Unlock to see your private tab.
   *[other] Unlock to see your { $count } private tabs.
}
whimsy-private-lock-window-title = Private window is locked
# $count (number) - tabs in the window
whimsy-private-lock-window-detail = { $count ->
    [one] Unlock to see its tab.
   *[other] Unlock to see its { $count } tabs.
}
whimsy-private-lock-failed = Didn’t unlock. Try again.
whimsy-private-lock-unlock =
    .label = Unlock
whimsy-private-lock-ask-tabs = Lock private tabs?
whimsy-private-lock-ask-space = Lock the Private Space?
whimsy-private-lock-ask-windows = Lock private windows?
whimsy-private-lock-ask-line = When you step away, { -brand-short-name } hides them until you use Touch ID or your Mac password.
whimsy-private-lock-dont =
    .label = Don’t Lock
whimsy-private-lock-yes =
    .label = Lock
whimsy-private-lock-on-toast = Private browsing will lock when you step away
whimsy-action-lock-private-now = Lock Private Browsing Now
whimsy-action-unlock-private = Unlock Private Browsing
whimsy-action-private-lock-tabs-toggle = Turn Lock for Private Tabs On or Off
whimsy-action-private-lock-tabs-on = Turn Lock for Private Tabs On
whimsy-action-private-lock-tabs-off = Turn Lock for Private Tabs Off
whimsy-action-private-lock-space-toggle = Turn Lock for the Private Space On or Off
whimsy-action-private-lock-space-on = Turn Lock for the Private Space On
whimsy-action-private-lock-space-off = Turn Lock for the Private Space Off
whimsy-action-private-lock-windows-toggle = Turn Lock for Private Windows On or Off
whimsy-action-private-lock-windows-on = Turn Lock for Private Windows On
whimsy-action-private-lock-windows-off = Turn Lock for Private Windows Off
whimsy-menu-lock-private =
    .label = Lock Private Browsing

## W11-14: Settings → Privacy → Lock private browsing

whimsy-private-lock-header =
    .label = Lock private browsing
whimsy-private-lock-tabs =
    .label = Lock private tabs
    .description = Hides private tabs in your spaces when you step away. Touch ID or your Mac password shows them again.
whimsy-private-lock-space =
    .label = Lock the Private Space
    .description = Hides the Private Space’s tabs when you step away.
whimsy-private-lock-windows =
    .label = Lock private windows
    .description = Covers private windows when you step away.
whimsy-private-lock-not-chosen = Not chosen yet: { -brand-short-name } asks the first time you browse privately.
whimsy-private-lock-after-label =
    .value = Lock after
whimsy-private-lock-after-now =
    .label = Right away
whimsy-private-lock-after-1m =
    .label = 1 minute away
whimsy-private-lock-after-5m =
    .label = 5 minutes away
whimsy-private-lock-after-15m =
    .label = 15 minutes away
whimsy-private-lock-after-1h =
    .label = 1 hour away
whimsy-private-lock-after-note = Always locks when your Mac sleeps or locks, and when { -brand-short-name } starts sharing your screen.
whimsy-private-lock-sharing =
    .label = Stay unlocked while sharing your screen
# W11-14 (d14): Lock Space's cover. $space (string) - the space's name
whimsy-space-lock-cover-title = “{ $space }” is locked
whimsy-space-lock-cover-detail = Unlock to see its tabs.
