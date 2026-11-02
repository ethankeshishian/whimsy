/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave10 (W10-12): every Whimsy setting, in one table, so each one is
//
// - a command (WhimsyCommands): "Turn Tidy Tab Titles On" / "Off" for a
//   switch, "Glance Size: Wide" for a choice, "Increase Transparency" for
//   a slider, each with a shortcut the person can assign in
//   about:keyboard;
// - found by Settings search under its short name and its other words
//   (whimsy-settings.js puts them on the control as `searchkeywords`, which
//   Firefox's search reads), not only by the words of its label: "Tidy
//   Titles" found nothing while the label said "Tidy tab titles".
//
// One entry per control in Settings, keyed by the control's id there;
// browser_whimsy_settings_audit.js fails when a Whimsy control in Settings
// has no entry here, or an entry's pref, feature or words don't match it.
// A new setting needs one line here and one whimsy.ftl message:
//
//   whimsy-setting-<name> = Short Name
//       .keywords = other words, people, might, search for
//
// Entry fields:
//   name     whimsy-setting-<name> (and the command id); required.
//   setting  The control's id in Settings.
//   pref     The pref it changes (bool unless `choices` or `range`).
//   invert   The switch is on when the pref is false (an "off" pref, as
//            whimsy.ai.blocked was before Enable AI).
//   get/set  For a switch that isn't one bool pref (Clean Links).
//   choices  [{ value, l10nId }]: one command per choice; l10nId names the
//            choice (its value or .label), usually the menuitem's own id.
//   getValue/setValue  For a choice that isn't one pref's value (Settings →
//            Home and startup: a URL, or two prefs, behind each choice).
//   partial  `choices` names only some of Settings' choices (the rest are
//            the fonts installed on this Mac).
//   range    { min, max, step }: Increase and Decrease commands.
//   command  Ids of Whimsy commands that already change this setting (no
//            second command for it).
//   onCommand  A command that already turns this switch on: the command
//            bar offers only "Turn … Off" (no two rows for one thing).
//   feature  The whimsy.feature.<id> switches the Settings row goes with.
//   when     () => bool: also needed for the setting to apply.
//   pane     A settings pane to open instead (rows that are many small
//            switches, like Settings → Menus).
//   covers   A selector: controls inside it belong to this entry too.
//   exempt   Why there is no command (free text such as an API key).

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyAppIcon: "resource:///modules/whimsy/WhimsyAppIcon.sys.mjs",
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
  WhimsyHome: "resource:///modules/whimsy/WhimsyHome.sys.mjs",
});
ChromeUtils.defineLazyGetter(lazy, "l10n", () => new Localization(["branding/brand.ftl", "browser/whimsy.ftl"], true));

const FEATURE_PREF = "whimsy.feature.settings-commands";
const CONFIRM_TOAST_TIMEOUT_MS = 4000;
const ICON = "chrome://browser/skin/zen-icons/settings.svg";

const featureOn = id => Services.prefs.getBoolPref(`whimsy.feature.${id}`, true);
const mac = () => AppConstants.platform == "macosx";
const aiAllowed = () => Services.prefs.getBoolPref("whimsy.ai.enabled", true) && featureOn("ai-providers");
const claudeOn = () => aiAllowed() && Services.prefs.getBoolPref("whimsy.claude.enabled", false);

const STRIP_PREFS = [
  "privacy.query_stripping.enabled",
  "privacy.query_stripping.enabled.pbmode",
  "privacy.query_stripping.strip_on_share.enabled",
];


// In Settings order: Look and Feel, Privacy, About, Tab Management, Links,
// Search, General, Menus.
export const SETTINGS = [
  // Look and Feel
  { name: "app-icon", setting: "whimsyAppIconList", pref: "whimsy.app-icon", feature: ["app-icon"], when: mac,
    get choices() {
      return lazy.WhimsyAppIcon.ICONS.map(value => ({ value, l10nId: `whimsy-app-icon-${value}` }));
    } },
  { name: "ui-zoom", setting: "whimsyUiZoom", pref: "whimsy.ui-zoom", feature: ["ui-zoom"],
    command: ["cmd_whimsyZoomInterfaceIn", "cmd_whimsyZoomInterfaceOut", "cmd_whimsyZoomInterfaceReset"] },
  { name: "notes", setting: "whimsyNotesEnabled", pref: "whimsy.feature.notes" },
  { name: "note-blocks", setting: "whimsyNoteBlocksEnabled", pref: "whimsy.feature.note-blocks" },
  { name: "easel", setting: "whimsyEaselEnabled", pref: "whimsy.feature.easel" },
  { name: "finder-folders", setting: "whimsyFinderFoldersEnabled", pref: "whimsy.feature.finder-folders" },
  { name: "screenshot-sidebar", setting: "whimsyScreenshotSidebarEnabled", pref: "whimsy.feature.screenshot-sidebar" },
  { name: "menu-icons", setting: "whimsyMenuIcons", pref: "whimsy.look.menu-icons", feature: ["menu-icons"] },
  { name: "reading-time", setting: "whimsyReadingTime", pref: "whimsy.reader.reading-time", feature: ["reading-time"] },
  { name: "dark-pdf", setting: "whimsyDarkPdf", pref: "whimsy.pdf.dark", feature: ["dark-pdf"],
    command: ["cmd_whimsyToggleDarkPdf"] },
  { name: "ui-font", setting: "whimsyUiFont", pref: "whimsy.look.ui-font", feature: ["ui-font"],
    // Any other font is picked from the list in Settings (every installed
    // font); the command goes back to the system font.
    choices: [{ value: "", l10nId: "whimsy-look-ui-font-system" }], partial: true },
  { name: "density", setting: "whimsyDensity", pref: "browser.uidensity", feature: ["space-look"],
    choices: [
      { value: 1, l10nId: "whimsy-look-density-compact" },
      { value: 0, l10nId: "whimsy-look-density-normal" },
      { value: 2, l10nId: "whimsy-look-density-roomy" },
    ] },
  { name: "transparency", setting: "whimsyTransparency", pref: "whimsy.look.transparency", feature: ["transparency"],
    when: mac, range: { min: 0, max: 80, step: 10 } },
  { name: "liquid-glass", setting: "whimsyLiquidGlass", pref: "whimsy.look.liquid-glass",
    feature: ["liquid-glass", "transparency"],
    when: () => AppConstants.isPlatformAndVersionAtLeast("macosx", "25"), command: ["cmd_whimsyLiquidGlassToggle"] },
  { name: "menu-bar-extra", setting: "whimsyMenuBarExtra", pref: "whimsy.menu-bar-extra.show",
    feature: ["menu-bar-extra"], when: mac },
  { name: "seasons", setting: "whimsySeasonalThemes", pref: "whimsy.seasons.enabled", feature: ["seasonal-themes"] },
  { name: "full-url", setting: "whimsyAlwaysFullUrl", pref: "whimsy.urlbar.always-full-url",
    feature: ["full-url-click"] },
  { name: "teach", setting: "whimsyTeachEnabled", pref: "whimsy.teach.enabled", feature: ["teach-once"] },

  // Home and startup (W11-07): Firefox's New windows and New tabs
  // dropdowns, with Whimsy Home and Firefox Home both offered. They replace
  // Look's "Use the Whimsy homepage" switch (one control per setting).
  // Custom URLs are typed in Settings, so they have no command.
  { name: "new-windows", setting: "homepageNewWindows", pref: "browser.startup.homepage", partial: true,
    getValue: () => lazy.WhimsyHome.newWindowsChoice(),
    setValue: value => lazy.WhimsyHome.setNewWindowsChoice(value),
    choices: [
      { value: "whimsy", l10nId: "whimsy-home-choice-whimsy" },
      { value: "home", l10nId: "whimsy-home-choice-firefox" },
      { value: "blank", l10nId: "whimsy-home-choice-blank" },
    ] },
  { name: "new-tabs", setting: "homepageNewTabs", pref: "whimsy.newtab.page", partial: true,
    getValue: () => lazy.WhimsyHome.newTabsChoice(),
    setValue: value => lazy.WhimsyHome.setNewTabsChoice(value),
    choices: [
      { value: "whimsy", l10nId: "whimsy-home-choice-whimsy" },
      { value: "home", l10nId: "whimsy-home-choice-firefox" },
      { value: "blank", l10nId: "whimsy-home-choice-blank" },
    ] },

  // Privacy & Security
  { name: "cookie-banners", setting: "whimsyRejectCookieBanners", pref: "whimsy.reject-cookie-banners",
    feature: ["cookie-banners"] },
  { name: "ai", setting: "whimsyAIEnable", pref: "whimsy.ai.enabled", feature: ["ai-kill-switch"] },
  { name: "ai-provider", setting: "whimsyAIProvider", pref: "whimsy.ai.provider", feature: ["ai-providers"],
    when: aiAllowed,
    choices: [
      { value: "apple", l10nId: "whimsy-ai-provider-apple" },
      { value: "claude", l10nId: "whimsy-ai-provider-claude" },
      { value: "ollama", l10nId: "whimsy-ai-provider-ollama" },
    ] },
  { name: "ai-claude-key", setting: "whimsyAIClaudeKey", feature: ["ai-providers"], exempt: "an API key, typed or pasted in Settings" },
  { name: "ai-ollama-endpoint", setting: "whimsyAIOllamaEndpoint", feature: ["ai-providers"],
    exempt: "an address, typed in Settings" },
  { name: "ai-ollama-model", setting: "whimsyAIOllamaModel", feature: ["ai-providers"],
    exempt: "the models the Ollama server has, listed only in Settings" },
  { name: "tidy-tabs", setting: "whimsyAITidyTabs", pref: "whimsy.feature.tidy-tabs", feature: ["ai-providers"],
    when: aiAllowed },
  { name: "tidy-titles", setting: "whimsyAITidyTitles", pref: "whimsy.feature.tidy-titles", feature: ["ai-providers"],
    when: aiAllowed },
  { name: "ask-on-page", setting: "whimsyAIAskOnPage", pref: "whimsy.feature.ask-on-page", feature: ["ai-providers"],
    when: aiAllowed },
  { name: "link-previews", setting: "whimsyAILinkPreviews", pref: "whimsy.feature.link-previews",
    feature: ["ai-providers"], when: aiAllowed },
  { name: "page-watch", setting: "whimsyAIPageWatch", pref: "whimsy.feature.page-watch", feature: ["ai-providers"],
    when: aiAllowed },
  // W10-28: Firefox's own AI rows in Settings → AI (Enable AI governs them).
  { name: "firefox-chatbot", setting: "whimsyAIFirefoxChatbot", feature: ["ai-providers"],
    exempt: "the chatbot sites Firefox offers, listed only in Settings" },
  { name: "firefox-link-previews", setting: "whimsyAIFirefoxLinkPreviews", pref: "browser.ml.linkPreview.enabled",
    feature: ["ai-providers"], when: aiAllowed },
  { name: "firefox-tab-groups", setting: "whimsyAIFirefoxTabGroups", pref: "browser.tabs.groups.smart.userEnabled",
    feature: ["ai-providers"], when: aiAllowed },
  { name: "strip-tracking", setting: "whimsyStripTracking", feature: ["strip-tracking"],
    get: () => Services.prefs.getBoolPref(STRIP_PREFS[0], false),
    // Same as the Settings switch: on restores the defaults (so Tracking
    // Protection stays "Standard"), off turns all three off.
    set: on => {
      for (const pref of STRIP_PREFS) {
        if (on && Services.prefs.getDefaultBranch("").getBoolPref(pref, false)) {
          Services.prefs.clearUserPref(pref);
        } else {
          Services.prefs.setBoolPref(pref, on);
        }
      }
    } },
  { name: "private-in-window", setting: "whimsyPrivateInWindow", pref: "whimsy.private.in-window", feature: ["scratch"] },
  // W11-14: the private lock's switches have their own commands (Turn Lock
  // for … On/Off), which ask for Touch ID before turning one off while locked.
  { name: "private-lock-tabs", setting: "whimsyPrivateLockTabs", pref: "whimsy.privateLock.tabs",
    feature: ["private-lock"], command: ["cmd_whimsyTogglePrivateLock_tabs"] },
  { name: "private-lock-space", setting: "whimsyPrivateLockSpace", pref: "whimsy.privateLock.space",
    feature: ["private-lock"], command: ["cmd_whimsyTogglePrivateLock_space"] },
  { name: "private-lock-windows", setting: "whimsyPrivateLockWindows", pref: "whimsy.privateLock.windows",
    feature: ["private-lock"], command: ["cmd_whimsyTogglePrivateLock_windows"] },
  { name: "private-lock-after", setting: "whimsyPrivateLockAfter", pref: "whimsy.privateLock.afterSeconds",
    feature: ["private-lock"],
    choices: [
      { value: 0, l10nId: "whimsy-private-lock-after-now" },
      { value: 60, l10nId: "whimsy-private-lock-after-1m" },
      { value: 300, l10nId: "whimsy-private-lock-after-5m" },
      { value: 900, l10nId: "whimsy-private-lock-after-15m" },
      { value: 3600, l10nId: "whimsy-private-lock-after-1h" },
    ] },
  { name: "private-lock-sharing", setting: "whimsyPrivateLockSharing", pref: "whimsy.privateLock.stayUnlockedWhileSharing",
    feature: ["private-lock"] },
  // "Set Up VPN" (cmd_whimsyVPNToggle) already turns it on, so the command
  // bar offers only Turn Off here; the shortcut still flips it.
  { name: "vpn", setting: "whimsyVpnEnabled", pref: "browser.ipProtection.enabled", feature: ["vpn"],
    onCommand: "cmd_whimsyVPNToggle" },
  { name: "email-aliases", setting: "whimsyEmailAliasesButton", pref: "whimsy.email-aliases.button",
    feature: ["email-aliases"] },
  { name: "handoff", setting: "whimsyHandoffSend", pref: "whimsy.handoff.send", feature: ["handoff"], when: mac },
  { name: "claude", setting: "whimsyClaudeEnable", pref: "whimsy.claude.enabled", feature: ["claude-space"],
    when: aiAllowed },
  { name: "claude-whole-browser", setting: "whimsyClaudeWholeBrowser", pref: "whimsy.claude.whole-browser",
    feature: ["claude-space"], when: claudeOn },
  { name: "claude-ask", setting: "whimsyClaudeAsk", pref: "whimsy.claude.ask-per-site", feature: ["claude-space"],
    when: claudeOn },
  { name: "claude-replay", setting: "whimsyClaudeReplay", pref: "whimsy.claude.replay", feature: ["claude-space"] },

  // About
  { name: "update-channel", setting: "whimsyUpdatesChannel", pref: "whimsy.update-channel",
    choices: [
      { value: "release", l10nId: "whimsy-updates-channel-release" },
      { value: "dev", l10nId: "whimsy-updates-channel-dev" },
    ] },

  // Tab Management
  { name: "new-tab-below", setting: "whimsyNewTabBelow", pref: "browser.tabs.insertAfterCurrent",
    feature: ["new-tab-position"] },
  { name: "new-tab-in-folder", setting: "whimsyNewTabInFolder", pref: "zen.folders.owned-tabs-in-folder",
    feature: ["new-tab-position"] },
  { name: "dim-sleeping", setting: "whimsyDimSleepingTabs", pref: "whimsy.tabs.dim-sleeping", feature: ["dim-sleeping"] },
  { name: "newtab-bottom", setting: "whimsyNewTabBottom", pref: "whimsy.tabs.newtab-button-bottom",
    feature: ["newtab-bottom"] },
  { name: "loading-indicator", setting: "whimsyLoadingIndicator", pref: "zen.view.enable-loading-indicator",
    feature: ["loading-line"] },
  { name: "loading-line", setting: "whimsyLoadingLine", pref: "whimsy.tabs.loading-line", feature: ["loading-line"] },
  { name: "hide-switcher", setting: "whimsyHideSpaceSwitcher", pref: "whimsy.spaces.hide-switcher",
    feature: ["hide-switcher"], command: ["cmd_whimsyToggleSpaceSwitcher"] },
  { name: "tab-badges", setting: "whimsyTabBadges", pref: "whimsy.tabs.badges", feature: ["tab-badges"] },
  { name: "background-mute", setting: "whimsyBackgroundMute", pref: "whimsy.media.background-mute",
    feature: ["background-mute"], command: ["cmd_whimsyToggleBackgroundMute"] },
  { name: "pip-snap-back", setting: "whimsyPipSnapBack", pref: "whimsy.media.pip-snap-back", feature: ["pip-snap-back"] },
  { name: "call-pip", setting: "whimsyCallPip", pref: "whimsy.feature.call-pip", feature: ["call-pip"] },
  { name: "video-speed", setting: "whimsyVideoSpeed", pref: "whimsy.feature.video-speed", feature: ["video-speed"] },
  { name: "video-captions", setting: "whimsyVideoCaptions", pref: "whimsy.feature.video-captions",
    feature: ["video-captions"] },
  { name: "video-speech-captions", setting: "whimsyVideoSpeechCaptions", pref: "whimsy.feature.video-speech-captions",
    feature: ["video-speech-captions"] },
  { name: "playlist-offline", setting: "whimsyPlaylistOffline", pref: "whimsy.playlist.offline-download",
    feature: ["playlist"] },
  { name: "archive-prompt", setting: "whimsyArchivePrompt", pref: "whimsy.archive.prompt", feature: ["wayback"] },
  { name: "title-lines", setting: "whimsyTitleLines", pref: "whimsy.tabs.title-lines", feature: ["title-lines"],
    choices: [1, 2, 3].map(value => ({ value, l10nId: `whimsy-tabs-title-lines-${value}` })) },
  { name: "auto-archive", setting: "whimsyAutoArchiveTabs", pref: "whimsy.feature.auto-archive-tabs",
    feature: ["auto-archive-tabs"] },
  { name: "archive-idle-after", setting: "whimsyArchiveIdleAfter", pref: "whimsy.tabs.archive.idle-after",
    feature: ["auto-archive-tabs"],
    choices: ["12h", "24h", "7d", "30d", "never"].map(value => ({
      value,
      l10nId: `whimsy-tabs-archive-idle-after-${value}`,
    })) },
  { name: "form-protection", setting: "whimsyFormProtection", pref: "whimsy.feature.form-protection",
    feature: ["form-protection"] },
  { name: "archive-view", setting: "whimsyArchiveView", pref: "whimsy.feature.archive-view", feature: ["archive-view"] },
  { name: "undo-tab-actions", setting: "whimsyUndoTabActions", pref: "whimsy.feature.undo-tab-actions",
    feature: ["undo-tab-actions"] },
  { name: "snooze-tab", setting: "whimsySnoozeTab", pref: "whimsy.feature.snooze-tab", feature: ["snooze-tab"] },
  { name: "fire-button", setting: "whimsyFireButton", pref: "whimsy.feature.fire-button", feature: ["fire-button"] },
  { name: "heavy-tabs", setting: "whimsyHeavyTabs", pref: "whimsy.feature.heavy-tabs", feature: ["heavy-tabs"] },
  { name: "font-inspector", setting: "whimsyFontInspector", pref: "whimsy.feature.font-inspector",
    feature: ["font-inspector"] },
  { name: "element-inspector", setting: "whimsyElementInspector", pref: "whimsy.feature.element-inspector",
    feature: ["element-inspector"] },
  { name: "page-dev", setting: "whimsyPageDev", pref: "whimsy.feature.page-dev", feature: ["page-dev"] },
  // W10-34: its command already exists (Wrap Long Lines in Page Source).
  { name: "view-source-wrap", setting: "whimsyViewSourceWrap", pref: "view_source.wrap_long_lines",
    feature: ["view-source-wrap"], command: ["cmd_whimsyToggleViewSourceWrap"] },
  { name: "tree-tabs", setting: "whimsyTreeTabs", pref: "whimsy.feature.tree-tabs", feature: ["tree-tabs"] },
  { name: "tree-style", setting: "whimsyTreeStyle", pref: "whimsy.tabs.tree-style", feature: ["tree-tabs"],
    choices: [
      { value: "tree", l10nId: "whimsy-tabs-tree-style-tree" },
      { value: "islands", l10nId: "whimsy-tabs-tree-style-islands" },
    ] },
  { name: "command-recent-tabs", setting: "whimsyCommandRecentTabs", pref: "whimsy.feature.command-bar-recent-tabs" },
  { name: "close-window-with-last-tab", setting: "whimsyCloseWindowWithLastTab",
    pref: "browser.tabs.closeWindowWithLastTab", feature: ["window-close"] },
  { name: "dock-badge", setting: "whimsyDockBadge", pref: "whimsy.downloads.dock-badge", feature: ["dock-badge"] },
  { name: "quick-look", setting: "whimsyQuickLook", pref: "whimsy.feature.quick-look", feature: ["quick-look"] },
  { name: "space-extensions", setting: "whimsySpaceExtensions", pref: "whimsy.feature.space-extensions",
    feature: ["space-extensions"] },
  { name: "split-new-tab", setting: "whimsySplitNewTab", pref: "whimsy.feature.split-new-tab" },
  { name: "history-preview", setting: "whimsyHoverHistory", pref: "whimsy.feature.history-preview",
    feature: ["history-preview"] },
  { name: "people-cards", setting: "whimsyHoverPeople", pref: "whimsy.feature.people-cards", feature: ["people-cards"] },
  { name: "link-cards", setting: "whimsyHoverLinks", pref: "whimsy.feature.link-cards", feature: ["link-cards"] },
  { name: "profiles", setting: "whimsyProfilesList", feature: ["space-profiles"],
    exempt: "each profile's own name, search engine and download folder, set in its editor" },
  { name: "profile-name", setting: "whimsyProfilesCreate", feature: ["space-profiles"],
    exempt: "a new profile's name, typed in its new row in Settings" },
  { name: "already-open", setting: "whimsyAlreadyOpen", pref: "whimsy.feature.already-open" },
  { name: "trails", setting: "whimsyTrails", pref: "whimsy.feature.trails" },
  { name: "page-actions", setting: "whimsyPageActions", pref: "whimsy.feature.page-actions" },
  { name: "smart-buttons", setting: "whimsySmartButtons", pref: "whimsy.feature.smart-buttons" },
  { name: "upload-badges", setting: "whimsyUploadBadges", pref: "whimsy.uploadClipboard.badges",
    feature: ["upload-clipboard"] },

  // Links
  { name: "external-links", setting: "whimsyExternalLinksTarget", pref: "whimsy.external-links.target",
    feature: ["external-link-target"],
    choices: [
      { value: "quick-window", l10nId: "whimsy-external-links-quick-window" },
      { value: "tab", l10nId: "whimsy-external-links-tab" },
      { value: "glance", l10nId: "whimsy-external-links-glance" },
    ] },
  { name: "glance-size", setting: "whimsyGlanceSize", pref: "whimsy.glance.size", feature: ["glance-size"],
    command: ["cmd_whimsyGlanceSize"] },
  { name: "peek-essential-links", setting: "whimsyPeekEssentialLinks", pref: "zen.glance.open-essential-external-links",
    feature: ["peek-essential-links"] },
  { name: "split-link-click", setting: "whimsySplitLinkShiftClick", pref: "whimsy.splitlink.shift-click",
    feature: ["split-link-click"] },
  { name: "follower-tabs", setting: "whimsyFollowerTabs", pref: "whimsy.feature.follower-tabs",
    feature: ["follower-tabs"] },
  { name: "split-headers", setting: "whimsySplitAlwaysShowHeaders", pref: "whimsy.split.always-show-headers",
    feature: ["split-pane-menu"] },

  // Search
  { name: "bangs", setting: "whimsyBangsEnabled", pref: "whimsy.feature.offline-bangs" },
  { name: "bangs-list", setting: "whimsyBangsList", exempt: "the list of bangs, edited as text in Settings" },
  { name: "instant-result", setting: "whimsySearchInstant", pref: "whimsy.feature.instant-result" },
  { name: "search-deck", setting: "whimsySearchDeck", pref: "whimsy.feature.search-deck",
    when: () => featureOn("instant-result") },

  // General (or Tab Management with Firefox's settings redesign)
  { name: "next-meeting", setting: "whimsyNextMeetingEnabled", pref: "whimsy.feature.next-meeting" },
  { name: "next-meeting-card", setting: "whimsyNextMeetingCard", pref: "whimsy.next-meeting.sidebar-card",
    when: () => featureOn("next-meeting") },
  { name: "meeting-google-url", setting: "whimsyMeetingGoogleURL",
    exempt: "a private calendar address, pasted in Settings" },
  { name: "hardware-video-decoding", setting: "whimsyHardwareVideoDecoding",
    pref: "media.hardware-video-decoding.enabled", feature: ["hardware-video-decoding"] },
  { name: "battery-saver", setting: "whimsyBatterySaverEnabled", pref: "whimsy.battery-saver.enabled",
    feature: ["battery-saver"] },

  // Settings → Menus: a switch for every row of every right-click menu
  // (hundreds, and turning one off is done where you'd miss it, in its
  // menu). Search finds each row; the command opens the pane.
  { name: "menus", setting: "whimsyMenusCategory", covers: '[data-category="paneWhimsyMenus"]', pane: "whimsyMenus",
    feature: ["menu-prefs"] },
];

const BY_SETTING = new Map(SETTINGS.map(entry => [entry.setting, entry]));

function formatSync(l10nId) {
  try {
    const [message] = lazy.l10n.formatMessagesSync([{ id: l10nId }]);
    return message?.value ?? message?.attributes?.find(a => a.name == "label")?.value ?? "";
  } catch (e) {
    console.error(`Whimsy: setting name ${l10nId}`, e);
    return "";
  }
}

function prefType(entry, value) {
  const type = Services.prefs.getPrefType(entry.pref);
  if (type != Services.prefs.PREF_INVALID) {
    return type;
  }
  return typeof value == "number" ? Services.prefs.PREF_INT : Services.prefs.PREF_STRING;
}

export const WhimsySettingsCommands = {
  SETTINGS,

  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  forSetting(id) {
    return BY_SETTING.get(id) ?? null;
  },

  l10nId(entry) {
    return `whimsy-setting-${entry.name}`;
  },

  // The setting's short name ("Tidy Tab Titles").
  nameOf(entry) {
    return formatSync(this.l10nId(entry));
  },

  // Its search words: the short name, then its .keywords.
  keywordsOf(entry) {
    let keywords = "";
    try {
      const [message] = lazy.l10n.formatMessagesSync([{ id: this.l10nId(entry) }]);
      keywords = message?.attributes?.find(a => a.name == "keywords")?.value ?? "";
    } catch (e) {
      console.error(`Whimsy: setting keywords ${entry.name}`, e);
    }
    return [this.nameOf(entry), ...keywords.split(",")].map(word => word.trim()).filter(Boolean);
  },

  // Whether the setting applies here and now (its Settings row is shown).
  available(entry) {
    if (!this.enabled) {
      return false;
    }
    for (const id of entry.feature ?? []) {
      // A row that is its own switch stays, so it can be turned back on.
      if (entry.pref != `whimsy.feature.${id}` && !featureOn(id)) {
        return false;
      }
    }
    try {
      return !entry.when || !!entry.when();
    } catch (e) {
      return false;
    }
  },

  isOn(entry) {
    if (entry.get) {
      return !!entry.get();
    }
    const fallback = entry.pref.startsWith("whimsy.feature.");
    const value = Services.prefs.getBoolPref(entry.pref, fallback);
    return entry.invert ? !value : value;
  },

  setOn(entry, on) {
    if (entry.set) {
      entry.set(on);
    } else {
      Services.prefs.setBoolPref(entry.pref, entry.invert ? !on : on);
    }
  },

  value(entry) {
    if (entry.getValue) {
      return entry.getValue();
    }
    switch (prefType(entry, entry.choices?.[0]?.value ?? 0)) {
      case Services.prefs.PREF_INT:
        return Services.prefs.getIntPref(entry.pref, 0);
      case Services.prefs.PREF_BOOL:
        return Services.prefs.getBoolPref(entry.pref, false);
      default:
        return Services.prefs.getStringPref(entry.pref, "");
    }
  },

  setValue(entry, value) {
    if (entry.setValue) {
      entry.setValue(value);
      return;
    }
    switch (prefType(entry, value)) {
      case Services.prefs.PREF_INT:
        Services.prefs.setIntPref(entry.pref, Number(value));
        break;
      case Services.prefs.PREF_BOOL:
        Services.prefs.setBoolPref(entry.pref, !!value);
        break;
      default:
        Services.prefs.setStringPref(entry.pref, String(value));
    }
  },

  // The commands an entry gets: [{ id, l10nId, l10nArgs, run, ... }].
  specsFor(entry) {
    if (entry.exempt || entry.command) {
      return [];
    }
    const name = () => this.nameOf(entry);
    const base = `cmd_whimsySetting-${entry.name}`;
    const available = () => this.available(entry);
    if (entry.pane) {
      return [
        {
          id: base,
          l10nId: "whimsy-setting-open",
          l10nArgs: () => ({ name: name() }),
          run: win => win.openPreferences(entry.pane),
          isAvailable: available,
        },
      ];
    }
    if (entry.choices) {
      return entry.choices.map(choice => ({
        id: `${base}-${choice.value === "" ? "default" : choice.value}`,
        l10nId: "whimsy-setting-choose",
        l10nArgs: () => ({ name: name(), choice: formatSync(choice.l10nId) }),
        run: win => {
          if (available()) {
            this.setValue(entry, choice.value);
            this.confirm(win, "whimsy-setting-chosen", { name: name(), choice: formatSync(choice.l10nId) });
          }
        },
        isAvailable: () => available() && this.value(entry) !== choice.value,
      }));
    }
    if (entry.range) {
      const { min, max, step } = entry.range;
      const move = direction => win => {
        if (!available()) {
          return;
        }
        const current = this.value(entry);
        // Steps land on multiples of `step`, from wherever the slider was.
        const next =
          direction > 0
            ? Math.min(max, (Math.floor(current / step) + 1) * step)
            : Math.max(min, (Math.ceil(current / step) - 1) * step);
        this.setValue(entry, next);
        this.confirm(win, "whimsy-setting-level", { name: name(), value: next });
      };
      return [
        {
          id: `${base}-up`,
          l10nId: "whimsy-setting-increase",
          l10nArgs: () => ({ name: name() }),
          run: move(1),
          isAvailable: () => available() && this.value(entry) < max,
        },
        {
          id: `${base}-down`,
          l10nId: "whimsy-setting-decrease",
          l10nArgs: () => ({ name: name() }),
          run: move(-1),
          isAvailable: () => available() && this.value(entry) > min,
        },
      ];
    }
    // A switch: one command (its shortcut flips it), offered in the
    // command bar as "Turn … On" or "Turn … Off", whichever applies.
    const toggle = (win, on) => {
      if (!available()) {
        return;
      }
      this.setOn(entry, on);
      this.confirm(win, on ? "whimsy-setting-turned-on" : "whimsy-setting-turned-off", { name: name() });
    };
    return [
      {
        id: base,
        l10nId: "whimsy-setting-toggle",
        l10nArgs: () => ({ name: name() }),
        run: win => toggle(win, !this.isOn(entry)),
        isAvailable: available,
        variants: [
          {
            l10nId: "whimsy-setting-on",
            isAvailable: () => !entry.onCommand && available() && !this.isOn(entry),
          },
          { l10nId: "whimsy-setting-off", isAvailable: () => available() && this.isOn(entry) },
        ],
      },
    ];
  },

  // A toast says what changed: a shortcut gives no other sign.
  confirm(win, l10nId, l10nArgs) {
    try {
      if (win?.document?.documentElement?.getAttribute("windowtype") == "navigator:browser") {
        win.gZenUIManager?.toasts?.open(l10nId, { l10nArgs, timeout: CONFIRM_TOAST_TIMEOUT_MS });
      }
    } catch (e) {
      console.error("Whimsy: setting toast", e);
    }
  },

  initWindow(win) {
    lazy.WhimsyCommands.batchKeys(win, () => {
      for (const entry of SETTINGS) {
        for (const spec of this.specsFor(entry)) {
          try {
            // The command bar finds it by the same words as Settings does.
            lazy.WhimsyCommands.register(win, { icon: ICON, whimsyKeywords: () => this.keywordsOf(entry), ...spec });
          } catch (e) {
            console.error(`Whimsy: setting command ${spec.id}`, e);
          }
        }
      }
    });
  },

  // Settings: every control gets its short name and other words as
  // `searchkeywords`, which Firefox's Settings search matches. Search reads
  // them only on a leaf, a moz-* element or a checkbox, button, label or
  // menulist; a radio group, slider or list takes them on its label (or,
  // with none, on the row before it).
  searchTarget(document, id) {
    const el = document.getElementById(id);
    if (!el) {
      return null;
    }
    const searchable = node =>
      !!node &&
      (node.childElementCount == 0 ||
        node.localName.startsWith("moz-") ||
        ["button", "label", "description", "menulist", "checkbox"].includes(node.localName));
    if (searchable(el)) {
      return el;
    }
    const escaped = document.defaultView.CSS.escape(id);
    const labelled = [
      document.querySelector(`label[control="${escaped}"], label[for="${escaped}"]`),
      ...(el.getAttribute("aria-labelledby") ?? "")
        .split(/\s+/)
        .filter(Boolean)
        .map(ref => document.getElementById(ref)),
      el.querySelector("h1, h2, h3"),
    ].find(searchable);
    if (labelled) {
      return labelled;
    }
    for (let node = el; node && node.id != "mainPrefPane"; node = node.parentElement) {
      for (let before = node.previousElementSibling; before; before = before.previousElementSibling) {
        if (searchable(before)) {
          return before;
        }
      }
    }
    return el;
  },

  applySearchKeywords(document) {
    // Two settings can share a target (a radio group and the switch above
    // it): each one's words are kept.
    const words = new Map();
    for (const entry of SETTINGS) {
      const target = this.searchTarget(document, entry.setting);
      if (target) {
        words.set(target, [...(words.get(target) ?? []), ...this.keywordsOf(entry)]);
      }
    }
    for (const [target, list] of words) {
      target.setAttribute("searchkeywords", list.join(", "));
    }
  },
};
