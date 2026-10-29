# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# Whimsy's own strings, linked into the browser window and Settings.

## After an update (sidebar notification; see ZenSidebarNotification.mjs)

whimsy-updated-heading = { -brand-short-name } updated
whimsy-rolled-back-heading = Rolled back to the previous version
whimsy-updated-notes-label = What's new
whimsy-updated-notes-tooltip =
    .title = View the release notes
whimsy-updated-rollback-label = Something broke? Roll back
whimsy-updated-rollback-tooltip =
    .title = Open update settings
whimsy-updated-settings-label = Update settings
whimsy-updated-settings-tooltip =
    .title = Open update settings

## Settings → Look and Feel → Updates

whimsy-updates-header = Updates
whimsy-updates-description = { -brand-short-name } follows each new Zen release and installs it the next time you quit.
whimsy-updates-auto =
    .label = Update automatically
whimsy-updates-channel = Channel
whimsy-updates-channel-release =
    .label = Release
whimsy-updates-channel-dev =
    .label = Dev
whimsy-updates-channel-release-note = Tested builds, published each night.
whimsy-updates-channel-dev-note = Every change as soon as it's built. Expect rough edges.
whimsy-updates-check =
    .label = Check now
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

whimsy-updates-browser = Up to date · { -brand-short-name } { $version }
whimsy-updates-browser-detail = New versions download in the background and install when you restart { -brand-short-name }.
whimsy-updates-browser-manual = Automatic updates are off · { -brand-short-name } { $version }
whimsy-updates-browser-manual-detail = Use Check now to look for a new version.
whimsy-updates-up-to-date = Up to date · { -brand-short-name } { $version }
whimsy-updates-paused = Paused · { -brand-short-name } { $version }
whimsy-updates-running = Updating: { $step }
whimsy-updates-current = Running { -brand-short-name } { $version } until the update is ready.
whimsy-updates-ready = { $version } is ready
whimsy-updates-ready-detail = It installs the next time you quit { -brand-short-name }.
whimsy-updates-checked = Last checked { $date }
whimsy-updates-never-checked = Not checked yet. Updates run each night.
whimsy-updates-last-problem = Last check ({ $date }): { $message }

# Versions are Zen's version plus a Whimsy revision, like 1.24b-w3.
whimsy-updates-based-on = Based on Zen { $zen } · Firefox { $firefox }
whimsy-updates-based-on-label = Based on Zen { $zen } ({ $label }) · Firefox { $firefox }
whimsy-updates-history = Version history
whimsy-updates-history-this = This version
whimsy-updates-history-dev = Built from { $commit }, not released yet
whimsy-updates-history-zen = Zen { $zen }
whimsy-updates-history-same-code = Rebuilt with no { -brand-short-name } changes
whimsy-updates-history-none = No releases yet.

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

## Settings → Look and Feel → Interface zoom

whimsy-ui-zoom-header = Interface zoom
whimsy-ui-zoom-description = Make the toolbars, sidebar, menus and panels bigger or smaller. Web pages keep their own zoom.
whimsy-ui-zoom-label = Zoom
