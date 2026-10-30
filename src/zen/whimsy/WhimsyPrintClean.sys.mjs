/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// "Print a clean page" (Edge's reading-view print path): printing a page
// as-is bleeds a sidebar, nav and ad placeholders across the job. Reader
// mode already strips all of that down to the article (Readability's
// extraction, the same pipeline batch5's reading-time estimate reads), so
// the only new work is wiring "reader mode, then print" into one command
// instead of two manual steps, without changing the tab the person's
// actually looking at.
//
// A page Readability can't parse as an article (browser.isArticle is
// false) has no clean version to print, so this falls back to a normal
// print rather than failing silently.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyShortcuts: "resource:///modules/whimsy/WhimsyShortcuts.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.print-clean";
const COMMAND_ID = "whimsy-cmd-print-clean";

export const WhimsyPrintClean = {
  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  initWindow(win) {
    if (!this.enabled) {
      return;
    }
    lazy.WhimsyShortcuts.addCommand(win, {
      id: COMMAND_ID,
      run: w => this.run(w),
    });
    lazy.WhimsyShortcuts.addActions([
      {
        l10nId: "whimsy-action-print-clean",
        command: COMMAND_ID,
        icon: "chrome://browser/skin/zen-icons/reader-mode.svg",
        isAvailable: w => this.enabled && !!w.gBrowser.selectedBrowser?.currentURI?.spec,
      },
    ]);
  },

  run(win) {
    const browser = win.gBrowser.selectedBrowser;
    if (!browser?.isArticle) {
      win.PrintUtils?.startPrintWindow(browser.browsingContext, {});
      return;
    }
    this._printCleanCopy(win, browser.currentURI.spec).catch(e =>
      console.error("Whimsy: print a clean page failed", e)
    );
  },

  async _printCleanCopy(win, url) {
    const tab = win.gBrowser.addTab(`about:reader?url=${encodeURIComponent(url)}`, {
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      inBackground: true,
      skipAnimation: true,
    });
    const browser = tab.linkedBrowser;
    const removeTab = () => {
      if (win.gBrowser.tabs.includes(tab)) {
        win.gBrowser.removeTab(tab, { skipPermitUnload: true });
      }
    };
    try {
      await this._waitForLoad(win, browser);
      // The tab-modal print preview clones the page's content synchronously
      // when it opens, so the background tab can close right after.
      win.PrintUtils?.startPrintWindow(browser.browsingContext, {});
    } finally {
      removeTab();
    }
  },

  _waitForLoad(win, browser) {
    return new Promise((resolve, reject) => {
      const timer = win.setTimeout(() => {
        win.gBrowser.removeTabsProgressListener(listener);
        reject(new Error("timed out waiting for the clean copy to load"));
      }, 15000);
      const listener = {
        onStateChange: (b, webProgress, request, flags) => {
          if (b != browser || !webProgress.isTopLevel) {
            return;
          }
          const done = Ci.nsIWebProgressListener.STATE_STOP | Ci.nsIWebProgressListener.STATE_IS_WINDOW;
          if ((flags & done) != done) {
            return;
          }
          win.clearTimeout(timer);
          win.gBrowser.removeTabsProgressListener(listener);
          resolve();
        },
      };
      win.gBrowser.addTabsProgressListener(listener);
    });
  },
};
