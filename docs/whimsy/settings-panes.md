# Settings panes: Appearance and Tabs and browsing, merged into Zen's

Firefox 159's settings redesign added an **Appearance** pane and a **Tabs and
browsing** pane. They overlap Zen's **Look and Feel** and **Tab Management**.
Whimsy keeps Zen's two panes, moves every Firefox setting that Zen and Whimsy
lack into them, and drops each Firefox control that repeats one Zen already
has. The rule: no setting is lost, and each setting has one control.

How it works (`src/zen/whimsy/content/whimsy-settings.js`, section
"fix/panes"):

- Firefox's own setting groups (`config/appearance.mjs`,
  `config/tabs-browsing.mjs`, `config/home-startup.mjs`) are placed in Zen's
  panes as `<setting-group>` elements (templates `template-whimsyFirefoxLooks`
  and `template-whimsyFirefoxTabs` in `whimsy-preferences-head.inc.xhtml`).
  The prefs, labels and behavior are Firefox's.
- The Appearance and Tabs and browsing panes are registered without groups,
  so they get no page and no sidebar button. Their sub-pages (Containers,
  Browser icon) hang off Zen's pane instead.
- Old links redirect through Firefox's `LEGACY_PANE_MAPPINGS`:
  `#appearance` goes to Look and Feel, `#appearance-windowDensity` to its
  Window density group, `#tabsBrowsing` to Tab Management's "Tabs and
  browsing" section, `#tabsBrowsing-drm` (and `-link-preview`, `-cfraddons`,
  `-cfrfeatures`) to that group, and `#tabsBrowsing-layout` or
  `#general-layout` to Zen's layout chooser.
- Settings search finds every moved control in its new pane.

Tests: `src/zen/whimsy/tests/browser_whimsy_settings_panes.js`.

## Inventory

"Where now" is the pane the control lives in after the merge. "Duplicate"
means Zen or Whimsy already had a control for the same thing, so Firefox's is
left out.

### Firefox: Appearance

| Group | Control | Pref / backing | Duplicate? | Where now |
| --- | --- | --- | --- | --- |
| Website appearance | Forced-colors warning (message, not a control) | `(forced-colors)` media query | No | Look and Feel |
| Website appearance | System / Light / Dark chooser | `layout.css.prefers-color-scheme.content-override` | No: Zen and Whimsy have none | Look and Feel (top) |
| Browser theme | Manage themes link | opens about:addons themes | Yes: Zen's "Manage themes in Extensions & Themes" line (hidden by default by `zen.theme.disable-lightweight`) | Look and Feel. Firefox's link is kept; Zen's line is removed |
| Window density | Automatic / Standard / Compact / Touch | `browser.uidensity` | No (Whimsy's Interface zoom is `whimsy.ui-zoom`, a different setting) | Look and Feel. Shown only with `browser.nova.enabled`, which Zen locks off |
| Window density | Use touch spacing automatically | `browser.touchmode.auto` | No | Look and Feel. Linux and Windows tablets only |
| Browser icon | Current icon, Change browser icon (sub-page) | `browser.shell.customIcon.id` | No (Whimsy's App icon is macOS) | Look and Feel. Windows only, behind `browser.shell.customIcon.enabled` |
| Related settings | Links to Accessibility, Home, Tabs and browsing | navigation only | Yes: the sidebar | Dropped |

### Firefox: Tabs and browsing

| Group | Control | Pref / backing | Duplicate? | Where now |
| --- | --- | --- | --- | --- |
| Default browser | Default browser status, Make default | shell service | No (Sync's card is a promo, hidden from search) | Tab Management. Only while Firefox's Home pane is hidden (`zen.urlbar.replace-newtab`, on by default); otherwise it stays in Home |
| Startup | Open previous windows and tabs | `browser.startup.page` | No | Tab Management (same Home rule) |
| Startup | Open a new tab on restore | `browser.sessionstore.newTabOnRestore` | No | Tab Management (same Home rule) |
| Startup | Continue where you left off (Zen's addition) | `zen.workspaces.continue-where-left-off` | No | Tab Management (same Home rule) |
| Startup | Open on login, and its notices | Windows launch-on-login | No | Tab Management. Windows only |
| Startup | Always check if default browser | `browser.shell.checkDefaultBrowser` | No | Tab Management (same Home rule) |
| Browser layout | Horizontal / Vertical tabs | `sidebar.verticalTabs` | Yes: Zen locks the pref and has its own Layout chooser | Dropped; links land on Zen's chooser |
| Tabs: Opening | Open links in tabs instead of new windows | `browser.link.open_newwindow` | No | Tab Management |
| Tabs: Opening | Switch to new tabs right away | `browser.tabs.loadInBackground` (inverted) | No | Tab Management |
| Tabs: Opening | Open links from apps next to your current tab | `browser.link.open_newwindow.override.external` | No (Whimsy's Links pane sets where app links open, `whimsy.external-links.target`) | Tab Management |
| Tabs: Opening | Confirm before opening many tabs | `browser.tabs.warnOnOpen` | No | Tab Management |
| Tabs: Interaction | Ctrl+Tab in recently used order | `browser.ctrlTab.sortByRecentlyUsed` | No (Zen's Ctrl+Tab options are other prefs) | Tab Management |
| Tabs: Interaction | Image in tab hover preview | `browser.tabs.hoverPreview.showThumbnails` | No | Tab Management |
| Tabs: Interaction | Tab group suggestions | `browser.tabs.groups.smart.userEnabled` | No | Tab Management. Needs tab groups, which Zen turns off |
| Tabs: Interaction | Drag to create tab groups | `browser.tabs.dragDrop.createGroup.enabled` | No | Tab Management. Needs tab groups |
| Tabs: Interaction | Show tabs in taskbar | `browser.taskbar.previews.enable` | No | Tab Management. Windows only |
| Tabs: Containers | Use Container Tabs | `privacy.userContext.enabled` | No | Tab Management |
| Tabs: Containers | Containers settings (sub-page) | Containers sub-page | No | Tab Management; the sub-page's breadcrumb reads Tab Management |
| Tabs: Closing | Confirm before closing multiple tabs | `browser.tabs.warnOnClose` | No | Tab Management |
| Tabs: Closing | Confirm before quitting with the quit shortcut | `browser.warnOnQuitShortcut` | No | Tab Management. Not on Windows |
| Page navigation | Always use the cursor keys to navigate | `accessibility.browsewithcaret` | No | Tab Management |
| Page navigation | Search for text when you start typing | `accessibility.typeaheadfind` | No | Tab Management |
| Page navigation | Link previews, key points, long press | `browser.ml.linkPreview.enabled`, `.optin`, `.longPress` | No | Tab Management. Follows Firefox's AI controls |
| Page navigation | Highlight to search, ask a chatbot | `browser.highlightToSearch.enabled`, `browser.ml.chat.shortcuts` | No | Tab Management. Behind `browser.highlightToSearch.featureGate` |
| Keyboard shortcuts | Customize keyboard shortcuts link | opens about:keyboard | Yes: Zen's Keyboard Shortcuts sidebar entry | Dropped |
| Media | Picture-in-Picture video controls | `media.videocontrols.picture-in-picture.video-toggle.enabled` | No (Whimsy's PiP snap-back and call PiP are other prefs) | Tab Management |
| Media | Picture-in-Picture when switching tabs | `media.videocontrols.picture-in-picture.enable-when-switching-tabs.enabled` | No | Tab Management |
| Media | Play DRM-controlled content | `media.eme.enabled` | No | Tab Management. Behind `browser.eme.ui.enabled` |
| Performance | Use recommended performance settings | `browser.preferences.defaultPerformanceSettings.enabled` | No | Tab Management, with Whimsy's Hardware video decoding right after |
| Performance | Use hardware acceleration | `layers.acceleration.disabled` (inverted) | No | Tab Management. Shown when recommended settings are off |
| Recommendations | Recommend extensions as you browse | `browser.newtabpage.activity-stream.asrouter.userprefs.cfr.addons` | No | Tab Management |
| Recommendations | Recommend features as you browse | `browser.newtabpage.activity-stream.asrouter.userprefs.cfr.features` | No | Tab Management |

### Zen: Look and Feel (unchanged unless noted)

| Group | Control | Pref / backing | Duplicate? |
| --- | --- | --- | --- |
| Sidebar and tabs layout | Single / Multiple / Collapsed toolbar | Zen layout prefs | Replaces Firefox's Browser layout |
| Vertical tabs | New tab button in the tab list | `zen.tabs.show-newtab-vertical` | No |
| Vertical tabs | New tab button at the top | `zen.view.show-newtab-button-top` | No |
| Vertical tabs | "Manage themes in Extensions & Themes" line | opens about:addons | Removed: Firefox's Browser theme link is the one control |
| Compact mode | Flash the toolbar popup | `zen.view.compact.toolbar-flash-popup` | No |
| Window dragging | Drag the window from content | `zen.view.drag-window-from-content` | No |
| Glance | Enable Glance, trigger | `zen.glance.enabled`, `zen.glance.activation-method` | Lives in Whimsy's Links pane |

### Zen: Tab Management (unchanged)

| Group | Control | Pref / backing | Duplicate? |
| --- | --- | --- | --- |
| Workspaces | Sync only pinned tabs | `zen.window-sync.sync-only-pinned-tabs` | No |
| Workspaces | Hide the default container indicator | `zen.workspaces.hide-default-container-indicator` | No |
| Workspaces | Force container tabs to their workspace | `zen.workspaces.force-container-workspace` | No |
| Workspaces | Close the tab on Back with no history | `zen.tabs.close-on-back-with-no-history` | No |
| Workspaces | Ctrl+Tab skips pending tabs | `zen.tabs.ctrl-tab.ignore-pending-tabs` | No |
| Workspaces | Ctrl+Tab skips Essentials | `zen.tabs.ctrl-tab.ignore-essential-tabs` | No |
| Workspaces | Select the recently used tab on close | `zen.tabs.select-recently-used-on-close` | No |
| Pinned tabs | Restore pinned tabs to their pinned URL | `zen.pinned-tab-manager.restore-pinned-tabs-to-pinned-url` | No |
| Pinned tabs | Container-specific Essentials | `zen.workspaces.separate-essentials` | No |
| Pinned tabs | Close shortcut behavior | `zen.pinned-tab-manager.close-shortcut-behavior` | No |

### Whimsy's additions in these two panes (unchanged)

| Pane | Group | Prefs | Duplicate? |
| --- | --- | --- | --- |
| Look and Feel | App icon | Whimsy app icon (macOS) | No |
| Look and Feel | Interface zoom | `whimsy.ui-zoom` | No |
| Look and Feel | Library | `whimsy.feature.notes`, `.finder-folders`, `.screenshot-sidebar` | No |
| Look and Feel | Look | `whimsy.look.menu-icons`, `whimsy.reader.reading-time`, `whimsy.pdf.dark`, `whimsy.look.ui-font`, `whimsy.look.liquid-glass`, `whimsy.menu-bar-extra.show`, `whimsy.seasons.enabled`, `whimsy.urlbar.always-full-url`, `whimsy.feature.home` | No |
| Look and Feel | Next meeting | Whimsy calendar settings | No |
| Tab Management | Tabs | `browser.tabs.insertAfterCurrent`, `zen.folders.owned-tabs-in-folder`, `whimsy.tabs.*`, `zen.view.enable-loading-indicator`, `whimsy.spaces.hide-switcher`, `whimsy.media.*`, `whimsy.playlist.offline-download`, `whimsy.archive.prompt`, `whimsy.new-note.target`, `whimsy.feature.*` tab features, `whimsy.feature.split-new-tab` | No |
| Tab Management | Spaces | space manager, hidden spaces, `browser.tabs.closeWindowWithLastTab`, `whimsy.downloads.dock-badge`, `whimsy.feature.quick-look` | No |
| Tab Management | Extensions per space | `whimsy.feature.space-extensions` | No |
| Tab Management | Hover cards | `whimsy.feature.history-preview`, `whimsy.feature.people-cards` | No |
| Tab Management | Hardware video decoding (after Firefox's Performance) | `media.hardware-video-decoding.enabled` | No |
