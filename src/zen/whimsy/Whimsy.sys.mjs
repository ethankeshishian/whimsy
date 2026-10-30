/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Whimsy's entry point. Zen's startup calls Whimsy.initWindow(window) once per
// browser window (a hook re-applied by whimsy/overlay.py after each upstream
// sync). Each feature can be switched off with whimsy.feature.<id>, which
// overlay.py does when Zen ships the same feature itself.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  WhimsyAI: "resource:///modules/whimsy/WhimsyAI.sys.mjs",
  WhimsyAppIcon: "resource:///modules/whimsy/WhimsyAppIcon.sys.mjs",
  WhimsyCommandBar: "resource:///modules/whimsy/WhimsyCommandBar.sys.mjs",
  WhimsyCookieBanners: "resource:///modules/whimsy/WhimsyCookieBanners.sys.mjs",
  WhimsyCopy: "resource:///modules/whimsy/WhimsyCopy.sys.mjs",
  WhimsyExternalLinks: "resource:///modules/whimsy/WhimsyExternalLinks.sys.mjs",
  WhimsyFolderColors: "resource:///modules/whimsy/WhimsyFolderColors.sys.mjs",
  WhimsyFollowerTabs: "resource:///modules/whimsy/WhimsyFollowerTabs.sys.mjs",
  WhimsyGithubReviews: "resource:///modules/whimsy/WhimsyGithubReviews.sys.mjs",
  WhimsyLibrarySection: "resource:///modules/whimsy/WhimsyLibrarySection.sys.mjs",
  WhimsyLiveFolders: "resource:///modules/whimsy/WhimsyLiveFolders.sys.mjs",
  WhimsyLook: "resource:///modules/whimsy/WhimsyLook.sys.mjs",
  WhimsyMedia: "resource:///modules/whimsy/WhimsyMedia.sys.mjs",
  WhimsyPage: "resource:///modules/whimsy/WhimsyPage.sys.mjs",
  WhimsyQuickWindow: "resource:///modules/whimsy/WhimsyQuickWindow.sys.mjs",
  WhimsyShortcuts: "resource:///modules/whimsy/WhimsyShortcuts.sys.mjs",
  WhimsySpaces: "resource:///modules/whimsy/WhimsySpaces.sys.mjs",
  // batch6: split view extras.
  WhimsySplit: "resource:///modules/whimsy/WhimsySplit.sys.mjs",
  WhimsyTabs: "resource:///modules/whimsy/WhimsyTabs.sys.mjs",
  WhimsyUpdates: "resource:///modules/whimsy/WhimsyUpdates.sys.mjs",
  // batch8: tab lifecycle
  WhimsyArchive: "resource:///modules/whimsy/WhimsyArchive.sys.mjs",
  WhimsyUndo: "resource:///modules/whimsy/WhimsyUndo.sys.mjs",
  WhimsySnooze: "resource:///modules/whimsy/WhimsySnooze.sys.mjs",
  WhimsyTreeTabs: "resource:///modules/whimsy/WhimsyTreeTabs.sys.mjs",
  WhimsyFireButton: "resource:///modules/whimsy/WhimsyFireButton.sys.mjs",
  WhimsyHeavyTabs: "resource:///modules/whimsy/WhimsyHeavyTabs.sys.mjs",
  WhimsySpaceArchive: "resource:///modules/whimsy/WhimsySpaceArchive.sys.mjs", // batch9: spaces
  WhimsySpaceLock: "resource:///modules/whimsy/WhimsySpaceLock.sys.mjs", // batch9: spaces
  WhimsySpaceExtensions: "resource:///modules/whimsy/WhimsySpaceExtensions.sys.mjs", // ext: per-space extensions
});

// batch9p: Scratch and private tabs
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyPrivate: "resource:///modules/whimsy/WhimsyPrivate.sys.mjs",
  // batch13: page & reading
  WhimsyBionicReading: "resource:///modules/whimsy/WhimsyBionicReading.sys.mjs",
  WhimsyMenuBarExtra: "resource:///modules/whimsy/WhimsyMenuBarExtra.sys.mjs",
  WhimsyPrintClean: "resource:///modules/whimsy/WhimsyPrintClean.sys.mjs",
  WhimsySplitFavorites: "resource:///modules/whimsy/WhimsySplitFavorites.sys.mjs",
  // batch7: new feature modules
  WhimsySeasons: "resource:///modules/whimsy/WhimsySeasons.sys.mjs",
  WhimsyWindowClose: "resource:///modules/whimsy/WhimsyWindowClose.sys.mjs",
  WhimsyUrlbar: "resource:///modules/whimsy/WhimsyUrlbar.sys.mjs",
  WhimsyDownloads: "resource:///modules/whimsy/WhimsyDownloads.sys.mjs",
  WhimsySidebarNav: "resource:///modules/whimsy/WhimsySidebarNav.sys.mjs",
  WhimsyCheatSheet: "resource:///modules/whimsy/WhimsyCheatSheet.sys.mjs",
  WhimsyDelight: "resource:///modules/whimsy/WhimsyDelight.sys.mjs",
  WhimsyUserAgent: "resource:///modules/whimsy/WhimsyUserAgent.sys.mjs",
  WhimsyCookieEditor: "resource:///modules/whimsy/WhimsyCookieEditor.sys.mjs",
  // batch hover: shared hover card (History rows, People cards).
  WhimsyHoverCard: "resource:///modules/whimsy/WhimsyHoverCard.sys.mjs",
  WhimsyProtocol: "resource:///modules/whimsy/WhimsyProtocol.sys.mjs",
  // batch hist: visit-space recorder.
  WhimsySpaceHistory: "resource:///modules/whimsy/WhimsySpaceHistory.sys.mjs",
  WhimsyDevMode: "resource:///modules/whimsy/WhimsyDevMode.sys.mjs",
  WhimsyStats: "resource:///modules/whimsy/WhimsyStats.sys.mjs",
});

// tierC-claude: the Claude space (local MCP server for Claude Code).
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyClaude: "resource:///modules/whimsy/WhimsyClaude.sys.mjs",
  // meeting: Next meeting in the sidebar
  WhimsyNextMeeting: "resource:///modules/whimsy/WhimsyNextMeeting.sys.mjs",
});

// tierC-vpn: VPN (Firefox's built-in IP Protection).
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyVPN: "resource:///modules/whimsy/WhimsyVPN.sys.mjs",
});

// wave3/private: RSS reading (unread counts, Reader View items).
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyLiveFolderReading: "resource:///modules/whimsy/WhimsyLiveFolderReading.sys.mjs",
  // wave3/private: floating calls (Arc).
  WhimsyCallPip: "resource:///modules/whimsy/WhimsyCallPip.sys.mjs",
});

// batch3glance: Glance size and split view (Arc parity).
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyGlance: "resource:///modules/whimsy/WhimsyGlance.sys.mjs",
  WhimsySplitFlow: "resource:///modules/whimsy/WhimsySplitFlow.sys.mjs",
  WhimsySplitLayouts: "resource:///modules/whimsy/WhimsySplitLayouts.sys.mjs",
});

// wave3/cmdbar: recent tabs in the empty command bar.
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyRecentTabs: "resource:///modules/whimsy/WhimsyRecentTabs.sys.mjs",
});

// wave3/cmdbar: offline bangs.
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyBangs: "resource:///modules/whimsy/WhimsyBangs.sys.mjs",
});

// wave3/icons: Arc's space icon picker.
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsySpaceIcons: "resource:///modules/whimsy/WhimsySpaceIcons.sys.mjs",
});

// wave3/speed: speed control on videos.
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyVideoSpeed: "resource:///modules/whimsy/WhimsyVideoSpeed.sys.mjs",
});


// wave3: handoff. Firefox's Handoff without private tabs or Scratch.
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyHandoff: "resource:///modules/whimsy/WhimsyHandoff.sys.mjs",
});


// wave3: playlist.
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyPlaylist: "resource:///modules/whimsy/WhimsyPlaylist.sys.mjs",
});


// wave3/ai: AI v1.
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyAITabs: "resource:///modules/whimsy/WhimsyAITabs.sys.mjs",
  WhimsyAIPage: "resource:///modules/whimsy/WhimsyAIPage.sys.mjs",
  WhimsyPageWatch: "resource:///modules/whimsy/WhimsyPageWatch.sys.mjs",
});

const BROWSER_SHEET = "chrome://browser/content/whimsy/whimsy-browser.css";
const UI_ZOOM_PREF = "whimsy.ui-zoom";

export const Whimsy = {
  featureEnabled(id) {
    return Services.prefs.getBoolPref(`whimsy.feature.${id}`, true);
  },

  // Whimsy's page tools actor (per-tab volume and the page tools). Its
  // child only starts in a page when a message or a media event needs it.
  registerActors() {
    if (this._actorsRegistered) {
      return;
    }
    this._actorsRegistered = true;
    ChromeUtils.registerWindowActor("WhimsyPage", {
      parent: { esModuleURI: "resource:///modules/whimsy/WhimsyPageParent.sys.mjs" },
      child: {
        esModuleURI: "resource:///modules/whimsy/WhimsyPageChild.sys.mjs",
        events: {
          play: { capture: true, mozSystemGroup: true },
          volumechange: { capture: true, mozSystemGroup: true },
          // batch6: Shift+click a link -> split view (whimsy.splitlink.shift-click).
          click: { capture: true },
        },
      },
      allFrames: true,
      // The child only works on its own page, and the parent only answers
      // with the tab's own settings, so web processes may run it.
      safeForUntrustedWebProcess: true,
    });
    // batch7: upload from the clipboard.
    ChromeUtils.registerWindowActor("WhimsyUpload", {
      parent: { esModuleURI: "resource:///modules/whimsy/WhimsyUploadParent.sys.mjs" },
      child: {
        esModuleURI: "resource:///modules/whimsy/WhimsyUploadChild.sys.mjs",
        events: {
          click: { capture: true, mozSystemGroup: true },
          // fixA: Cmd+V on a focused upload button.
          keydown: { capture: true, mozSystemGroup: true },
        },
      },
      allFrames: true,
      safeForUntrustedWebProcess: true,
    });
    // batch7b + wave1/fun: Whimsy network/certificate error branding and
    // the offline game invitation (whimsy://game).
    ChromeUtils.registerWindowActor("WhimsyNetError", {
      parent: { esModuleURI: "resource:///modules/whimsy/WhimsyNetErrorParent.sys.mjs" },
      child: {
        esModuleURI: "resource:///modules/whimsy/WhimsyNetErrorChild.sys.mjs",
        events: { DOMContentLoaded: {}, AboutNetErrorLoad: { wantUntrusted: true } },
      },
      matches: ["about:neterror?*", "about:certerror?*"],
      allFrames: true,
      safeForUntrustedWebProcess: true,
    });
    // batch hover: People cards. The child only messages for links to the
    // profile sites; the parent rate-limits and fetches.
    ChromeUtils.registerWindowActor("WhimsyPeople", {
      parent: { esModuleURI: "resource:///modules/whimsy/WhimsyPeopleParent.sys.mjs" },
      child: {
        esModuleURI: "resource:///modules/whimsy/WhimsyPeopleChild.sys.mjs",
        events: { mouseover: {}, mouseout: {} },
      },
      matches: ["https://*/*", "http://*/*", "file:///*"],
      allFrames: true,
      safeForUntrustedWebProcess: true,
    });
    // wave3: email-aliases. The child only shows a button in email fields;
    // the menu, iCloud and Relay calls live in the parent.
    ChromeUtils.registerWindowActor("WhimsyEmailAliases", {
      parent: { esModuleURI: "resource:///modules/whimsy/WhimsyEmailAliasesParent.sys.mjs" },
      child: {
        esModuleURI: "resource:///modules/whimsy/WhimsyEmailAliasesChild.sys.mjs",
        events: { focusin: { capture: true }, pagehide: {} },
      },
      matches: ["https://*/*", "http://*/*"],
      allFrames: true,
    });

    // wave3/ai: 5-second previews. The child only messages on Shift over a
    // link (or resting on a result link on search sites, X, Threads, HN);
    // the parent checks the switches, fetches and draws the card.
    ChromeUtils.registerWindowActor("WhimsyAIPreview", {
      parent: { esModuleURI: "resource:///modules/whimsy/WhimsyAIPreviewParent.sys.mjs" },
      child: {
        esModuleURI: "resource:///modules/whimsy/WhimsyAIPreviewChild.sys.mjs",
        events: { mouseover: {}, mouseout: {}, keydown: {}, pagehide: {} },
      },
      matches: ["https://*/*", "http://*/*"],
      allFrames: true,
      messageManagerGroups: ["browsers"],
      safeForUntrustedWebProcess: true,
    });
  },

  initWindow(win) {
    const run = (name, fn) => {
      try {
        fn();
      } catch (e) {
        console.error(`Whimsy: ${name} failed`, e);
      }
    };
    run("stylesheet", () =>
      win.windowUtils.loadSheetUsingURIString(BROWSER_SHEET, win.windowUtils.AUTHOR_SHEET)
    );
    // batch12: Mini Whimsy, Arc's Little Arc (quick window). Set before
    // anything else reads the document, so whimsy-browser.css's rules
    // apply from first paint.
    if (win._whimsyQuickWindow) {
      win.document.documentElement.setAttribute("whimsy-quick-window", "");
    }
    run("quick-window", () => lazy.WhimsyQuickWindow.initWindow(win));
    if (this.featureEnabled("ui-zoom")) {
      run("ui-zoom", () => this.initUiZoom(win));
    }
    if (this.featureEnabled("private-indicator") && lazy.PrivateBrowsingUtils.isWindowPrivate(win)) {
      // Styled by whimsy-browser.css: a violet tint and a badge.
      win.document.documentElement.setAttribute("whimsy-private", "");
    }
    if (this.featureEnabled("app-icon")) {
      run("app-icon", () => lazy.WhimsyAppIcon.init());
    }
    // Always installed: it checks its switch on each use, so turning it off
    // hands the shortcuts straight back to Zen.
    run("copy", () => lazy.WhimsyCopy.init(win));
    run("shortcuts", () => lazy.WhimsyShortcuts.initWindow(win));
    // Always installed: isAvailable checks the switch on each use, so
    // turning it off hides it from the command bar straight away.
    run("glance-split-action", () =>
      lazy.WhimsyShortcuts.addActions([
        {
          l10nId: "whimsy-action-split-glance",
          command: "cmd_zenGlanceSplit",
          icon: "chrome://browser/skin/zen-icons/split.svg",
          isAvailable: w =>
            this.featureEnabled("glance-split-action") &&
            !!w.gBrowser.selectedTab?.hasAttribute("glance-id") &&
            w.document.getElementById("cmd_zenGlanceSplit")?.getAttribute("disabled") != "true",
        },
      ])
    );
    // Always installed: it checks its switch and the pref on each external
    // open, so turning it off hands the link straight back to Firefox.
    run("external-links", () => lazy.WhimsyExternalLinks.init());
    // Watches its prefs and switches, so options apply without a restart.
    run("tabs", () => lazy.WhimsyTabs.initWindow(win));
    run("folder-colors", () => lazy.WhimsyFolderColors.initWindow(win));
    // batch12: follower tabs. Checks its own switch on each use (the tab
    // menu item and onLinkFollowed), so turning it off just stops offering
    // it; an already-marked source simply won't redirect any more.
    run("follower-tabs", () => lazy.WhimsyFollowerTabs.initWindow(win));
    // After Zen's spaces are ready; each part checks its switch on use.
    run("spaces", () =>
      win.gZenWorkspaces?.promiseInitialized
        ?.then(() => lazy.WhimsySpaces.initWindow(win))
        .catch(e => console.error("Whimsy: spaces", e))
    );
    run("look", () => lazy.WhimsyLook.initWindow(win));
    run("actors", () => this.registerActors());
    // Library sidebar panels (Notes, Finder folders, Screenshot to
    // sidebar): each one checks its own whimsy.feature.<id> switch.
    // batch hist: lightweight navigation observer; sidecar opened lazily.
    run("space-history", () => lazy.WhimsySpaceHistory.initWindow(win));
    run("library-sections", () => lazy.WhimsyLibrarySection.initWindow(win));
    // Media: each part checks its switch and prefs on use.
    run("media", () => lazy.WhimsyMedia.initWindow(win));
    run("page", () => lazy.WhimsyPage.initWindow(win));
    // batch6: split view extras; each action checks its own switch.
    run("split", () => lazy.WhimsySplit.initWindow(win));
    // batch6: command bar extras ("/" filter, "New ..." actions).
    run("command-bar", () => lazy.WhimsyCommandBar.initWindow(win));
    // Once per session; it watches its pref and switch to turn the built-in
    // add-on on or off.
    run("cookie-banners", () => lazy.WhimsyCookieBanners.init());
    run("ai-kill-switch", () => lazy.WhimsyAI.init());
    if (this.featureEnabled("github-reviews")) {
      run("github-reviews", () => lazy.WhimsyGithubReviews.init());
    }
    // batch11: live folders (Jira + Push refresh + RSS autodiscovery).
    // Always installed: each part checks its own switch on use.
    run("live-folders", () => {
      lazy.WhimsyLiveFolders.init();
      lazy.WhimsyLiveFolders.initWindow(win);
    });
    // Normally already done by WhimsyStartup at profile-after-change.
    run("update-channel", () => lazy.WhimsyUpdates.initChannel());
    run("updates", () => lazy.WhimsyUpdates.showUpdatedNotice(win));
    // batch8: tab lifecycle. Undo first (the others push to its stack);
    // tree tabs after Zen's spaces/folders are ready.
    run("undo", () => lazy.WhimsyUndo.initWindow(win));
    run("archive", () => lazy.WhimsyArchive.initWindow(win));
    run("snooze", () => lazy.WhimsySnooze.initWindow(win));
    run("fire-button", () => lazy.WhimsyFireButton.initWindow(win));
    run("heavy-tabs", () => lazy.WhimsyHeavyTabs.initWindow(win));
    run("tree-tabs", () =>
      win.gZenWorkspaces?.promiseInitialized
        ?.then(() => lazy.WhimsyTreeTabs.initWindow(win))
        .catch(e => console.error("Whimsy: tree-tabs", e))
    );
    // batch9: spaces — after Zen's spaces are ready, like "spaces" above.
    run("archive-space", () =>
      win.gZenWorkspaces?.promiseInitialized
        ?.then(() => lazy.WhimsySpaceArchive.initWindow(win))
        .catch(e => console.error("Whimsy: archive-space", e))
    );
    run("space-lock", () =>
      win.gZenWorkspaces?.promiseInitialized
        ?.then(() => lazy.WhimsySpaceLock.initWindow(win))
        .catch(e => console.error("Whimsy: space-lock", e))
    );
    // batch9p: Scratch and private tabs. Always installed: tabs opened from
    // a private tab must stay private even with the switch off; the
    // shortcuts check the switch and setting on each use.
    run("private", () => lazy.WhimsyPrivate.initWindow(win));
    // batch13: page & reading. Once per session (each checks its own
    // switch and macOS gate on use).
    run("menu-bar-extra", () => lazy.WhimsyMenuBarExtra.init());
    run("bionic-reading", () => lazy.WhimsyBionicReading.init());
    run("print-clean", () => lazy.WhimsyPrintClean.initWindow(win));
    run("split-favorites", () => lazy.WhimsySplitFavorites.initWindow(win));
    // batch7: seasonal themes. Watches its own prefs, so it applies without
    // a restart.
    run("seasons", () => lazy.WhimsySeasons.initWindow(win));
    // batch7: Cmd+W on a lone empty tab closes the window (Arc).
    run("window-close", () => lazy.WhimsyWindowClose.initWindow(win));
    // batch7: full URL on click.
    run("full-url-click", () => lazy.WhimsyUrlbar.initWindow(win));
    // batch7: Dock badge/bounce (once per session), Quick Look and keeping
    // a panel open across a download drag (per window).
    run("downloads", () => {
      lazy.WhimsyDownloads.init().catch(e => console.error("Whimsy: downloads", e));
      lazy.WhimsyDownloads.initWindow(win);
    });
    // batch7: keyboard sidebar navigation (Arc).
    run("sidebar-nav", () => lazy.WhimsySidebarNav.initWindow(win));
    // batch7: shortcut cheat sheet.
    run("cheatsheet", () => lazy.WhimsyCheatSheet.initWindow(win));
    run("cheatsheet-action", () =>
      lazy.WhimsyShortcuts.addActions([
        {
          l10nId: "whimsy-action-cheatsheet",
          command: "whimsy-cheatsheet",
          icon: "chrome://browser/skin/zen-icons/selectable/key.svg",
          isAvailable: () => lazy.WhimsyCheatSheet.enabled,
        },
      ])
    );
    // batch7: inbox-zero balloons.
    run("inbox-zero", () => lazy.WhimsyDelight.initWindow(win));
    // batch7: per-site user agent.
    run("site-user-agent", () => {
      lazy.WhimsyUserAgent.initWindow(win);
      lazy.WhimsyShortcuts.addCommand(win, {
        id: "whimsy-useragent-picker",
        run: w => lazy.WhimsyUserAgent.enabled && lazy.WhimsyUserAgent.openPicker(w),
      });
      lazy.WhimsyShortcuts.addActions([
        {
          l10nId: "whimsy-action-useragent",
          command: "whimsy-useragent-picker",
          icon: "chrome://browser/skin/zen-icons/selectable/globe.svg",
          isAvailable: () => lazy.WhimsyUserAgent.enabled,
        },
      ]);
    });
    // batch7: cookie editor.
    run("cookie-editor", () => {
      lazy.WhimsyShortcuts.addCommand(win, {
        id: "whimsy-cookie-editor",
        run: w => lazy.WhimsyCookieEditor.enabled && lazy.WhimsyCookieEditor.open(w),
      });
      lazy.WhimsyShortcuts.addActions([
        {
          l10nId: "whimsy-action-cookie-editor",
          command: "whimsy-cookie-editor",
          icon: "chrome://browser/skin/zen-icons/cookies-fill.svg",
          isAvailable: () => lazy.WhimsyCookieEditor.enabled,
        },
      ]);
    });
    // batch7: whimsy:// URL schemes (the address-bar half; see
    // WhimsyProtocol.sys.mjs for why the external-link half is deferred).
    run("url-schemes", () => lazy.WhimsyProtocol.initWindow(win));
    // batch hover: History hover cards in Zen's Library (tab cards are
    // Firefox's own browser.tabs.hoverPreview).
    run("history-preview", () => lazy.WhimsyHoverCard.initWindow(win));
    // batch7: developer mode tabs (Arc parity).
    run("dev-mode", () => {
      lazy.WhimsyDevMode.initWindow(win);
      lazy.WhimsyShortcuts.addCommand(win, {
        id: "whimsy-devmode-toggle-site",
        run: w => {
          const uri = w.gBrowser.selectedBrowser?.currentURI;
          if (lazy.WhimsyDevMode.enabled && uri) {
            lazy.WhimsyDevMode.toggleSite(uri);
          }
        },
      });
      lazy.WhimsyShortcuts.addActions([
        {
          l10nId: "whimsy-action-devmode-toggle",
          command: "whimsy-devmode-toggle-site",
          icon: "chrome://browser/skin/zen-icons/selectable/code.svg",
          isAvailable: () => lazy.WhimsyDevMode.enabled,
        },
      ]);
    });
    // ext: per-space extensions. After Zen's spaces are ready, like
    // "spaces" above; the module checks its own switch on each use.
    run("space-extensions", () =>
      win.gZenWorkspaces?.promiseInitialized
        ?.then(() => lazy.WhimsySpaceExtensions.initWindow(win))
        .catch(e => console.error("Whimsy: space-extensions", e))
    );
    // batch7b: offline game (whimsy://game). Always installed: the command
    // bar action and the net-error button both check the switch on use.
    run("game-action", () => {
      lazy.WhimsyShortcuts.addCommand(win, {
        id: "whimsy-game-open",
        run: w => w.openTrustedLinkIn("about:whimsy?game", "current"),
      });
      lazy.WhimsyShortcuts.addActions([
        {
          l10nId: "whimsy-action-game",
          command: "whimsy-game-open",
          icon: "chrome://browser/skin/zen-icons/selectable/game-controller.svg",
          isAvailable: () => Services.prefs.getBoolPref("whimsy.feature.game", true),
        },
      ]);
    });
    // batch7b: Year in tabs (whimsy://year). Always installed: initWindow
    // checks the switch itself before counting anything (WhimsyStats.sys.mjs).
    run("year-in-tabs", () => {
      lazy.WhimsyStats.initWindow(win);
      lazy.WhimsyShortcuts.addCommand(win, {
        id: "whimsy-year-open",
        run: w => w.openTrustedLinkIn("about:whimsy?year", "current"),
      });
      lazy.WhimsyShortcuts.addActions([
        {
          l10nId: "whimsy-action-year",
          command: "whimsy-year-open",
          icon: "chrome://browser/skin/zen-icons/selectable/stats-chart.svg",
          isAvailable: () => lazy.WhimsyStats.enabled,
        },
      ]);
      this.maybeShowYearToast(win);
    });
    // tierC-claude: the Claude space. Once per session, it only watches its
    // switches; the server and page actor exist only while the user has
    // turned Claude on in Settings.
    run("claude-space", () => lazy.WhimsyClaude.initWindow(win));
    // meeting: Next meeting in the sidebar. Always installed: the service
    // checks its switch on each refresh, and never asks for calendar
    // access here (only when the person turns Apple Calendar on).
    run("next-meeting", () => lazy.WhimsyNextMeeting.initWindow(win));
    // tierC-vpn: VPN (Firefox's built-in IP Protection). The toolbar button
    // and panel are Firefox's own (placed automatically once
    // browser.ipProtection.enabled is true); this only adds the command bar
    // actions. Checks its own switch on use, so turning it off just stops
    // offering them.
    run("vpn", () => lazy.WhimsyVPN.initWindow(win));
    // wave3/private: RSS live folders' unread counts and Reader View items.
    // Always installed: each part checks its own switch on use.
    run("live-folder-reading", () => lazy.WhimsyLiveFolderReading.initWindow(win));
    // wave3/private: a call's video floats in picture-in-picture when you
    // leave its tab (Arc). Checks its switch on each tab switch.
    run("call-pip", () => lazy.WhimsyCallPip.initWindow(win));
    // batch3glance: Glance size. Always installed (checks its switch on
    // each Glance), so turning it on or off applies without a restart.
    run("glance-size", () => lazy.WhimsyGlance.initWindow(win));
    // batch3glance: Cmd+T in a split opens into the focused pane (Arc).
    // Always installed; checks its switch on each Cmd+T.
    run("split-new-tab", () => lazy.WhimsySplitFlow.initWindow(win));
    // batch3glance: Add Left/Right/Top/Bottom Split and Change Orientation
    // (Arc). Each action checks the switch.
    run("split-layouts", () => lazy.WhimsySplitLayouts.initWindow(win));
    // wave3/cmdbar: recent tabs in the empty command bar. Registered once
    // even when off; the provider checks its switch on every query.
    run("command-bar-recent-tabs", () => lazy.WhimsyRecentTabs.init());
    // wave3/cmdbar: offline bangs. Registered once even when off; the
    // provider checks its switch on every query.
    run("offline-bangs", () => lazy.WhimsyBangs.init());
    // wave3/icons: Arc's space icon picker. After Zen's spaces are ready,
    // like "spaces" above (so its picker listeners run after Zen's and
    // emoji search's); it checks its switch each time the picker opens.
    run("space-icon-picker", () =>
      win.gZenWorkspaces?.promiseInitialized
        ?.then(() => lazy.WhimsySpaceIcons.initWindow(win))
        .catch(e => console.error("Whimsy: space-icon-picker", e))
    );
    // wave3/speed: speed control on videos. Registered once even when off;
    // the page side checks its switch on every event.
    run("video-speed", () => lazy.WhimsyVideoSpeed.init());

    // wave3: handoff. Wraps Firefox's Handoff update (macOS only); checks
    // its switch on every update.
    run("handoff", () => lazy.WhimsyHandoff.initWindow(win));

    // wave3: playlist. "Save to Playlist" in the page menu and command bar;
    // each checks the switch when used.
    run("playlist", () => lazy.WhimsyPlaylist.initWindow(win));

    // wave3/ai: AI v1. Always installed; each part checks its switch, the AI
    // kill switch and whether a provider is set up on use, so Settings
    // changes apply without a restart.
    run("ai-sheet", () =>
      win.windowUtils.loadSheetUsingURIString(
        "chrome://browser/content/whimsy/whimsy-ai.css",
        win.windowUtils.AUTHOR_SHEET
      )
    );
    run("tidy-tabs", () => lazy.WhimsyAITabs.initWindow(win));
    run("ask-on-page", () => lazy.WhimsyAIPage.initWindow(win));
    // Watches are checked only while Whimsy runs (one timer, only while
    // there are watches and AI is on).
    run("page-watch", () => lazy.WhimsyPageWatch.initWindow(win));
  },

  // batch7b: from December 1, once a year, a toast points at Year in tabs.
  maybeShowYearToast(win) {
    if (!lazy.WhimsyStats.enabled) {
      return;
    }
    const now = new Date();
    if (now.getMonth() != 11) {
      return;
    }
    const year = now.getFullYear();
    if (Services.prefs.getIntPref("whimsy.year.last-toast-year", 0) >= year) {
      return;
    }
    Services.prefs.setIntPref("whimsy.year.last-toast-year", year);
    win.gZenUIManager?.showToast?.("whimsy-year-ready-toast", {});
  },

  // Interface zoom: scales the toolbars, sidebar, menus and panels, never web
  // pages (whimsy-browser.css applies --whimsy-ui-zoom).
  initUiZoom(win) {
    const root = win.document.documentElement;
    root.setAttribute("whimsy-ui-zoom", "");
    const update = () => {
      const zoom = Math.min(200, Math.max(50, Services.prefs.getIntPref(UI_ZOOM_PREF, 100)));
      root.style.setProperty("--whimsy-ui-zoom", zoom / 100);
    };
    Services.prefs.addObserver(UI_ZOOM_PREF, update);
    win.addEventListener("unload", () => Services.prefs.removeObserver(UI_ZOOM_PREF, update), {
      once: true,
    });
    update();
  },
};
