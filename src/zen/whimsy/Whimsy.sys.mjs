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
  WhimsyCookieBanners: "resource:///modules/whimsy/WhimsyCookieBanners.sys.mjs",
  WhimsyCopy: "resource:///modules/whimsy/WhimsyCopy.sys.mjs",
  WhimsyExternalLinks: "resource:///modules/whimsy/WhimsyExternalLinks.sys.mjs",
  WhimsyFolderColors: "resource:///modules/whimsy/WhimsyFolderColors.sys.mjs",
  WhimsyFollowerTabs: "resource:///modules/whimsy/WhimsyFollowerTabs.sys.mjs",
  WhimsyGithubReviews: "resource:///modules/whimsy/WhimsyGithubReviews.sys.mjs",
  WhimsyLook: "resource:///modules/whimsy/WhimsyLook.sys.mjs",
  WhimsyMedia: "resource:///modules/whimsy/WhimsyMedia.sys.mjs",
  WhimsyPage: "resource:///modules/whimsy/WhimsyPage.sys.mjs",
  WhimsyQuickWindow: "resource:///modules/whimsy/WhimsyQuickWindow.sys.mjs",
  WhimsyShortcuts: "resource:///modules/whimsy/WhimsyShortcuts.sys.mjs",
  WhimsySpaces: "resource:///modules/whimsy/WhimsySpaces.sys.mjs",
  WhimsyTabs: "resource:///modules/whimsy/WhimsyTabs.sys.mjs",
  WhimsyUpdates: "resource:///modules/whimsy/WhimsyUpdates.sys.mjs",
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
        },
      },
      allFrames: true,
      // The child only works on its own page, and the parent only answers
      // with the tab's own settings, so web processes may run it.
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
    // batch12: Little Arc (quick window). Set before anything else reads
    // the document, so whimsy-browser.css's rules apply from first paint.
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
    // Media: each part checks its switch and prefs on use.
    run("media", () => lazy.WhimsyMedia.initWindow(win));
    run("page", () => lazy.WhimsyPage.initWindow(win));
    // Once per session; it watches its pref and switch to turn the built-in
    // add-on on or off.
    run("cookie-banners", () => lazy.WhimsyCookieBanners.init());
    run("ai-kill-switch", () => lazy.WhimsyAI.init());
    if (this.featureEnabled("github-reviews")) {
      run("github-reviews", () => lazy.WhimsyGithubReviews.init());
    }
    run("update-channel", () =>
      lazy.WhimsyUpdates.initChannel().catch(e => console.error("Whimsy: update channel", e))
    );
    run("updates", () => lazy.WhimsyUpdates.showUpdatedNotice(win));
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
