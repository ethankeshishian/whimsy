/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// "Print a clean page" (Edge's reading-view print path): printing a page
// as-is bleeds a sidebar, nav and ad placeholders across the job. Reader
// mode already strips all of that down to the article (Readability), and
// Firefox's own print dialog can print that version: its "Simplify page"
// source option renders the article through about:reader into the
// preview. So this opens the print dialog on the tab the person is looking
// at and picks "Simplify page" for them, leaving the tab itself alone.
//
// An earlier version loaded about:reader in a hidden background tab and
// printed that, closing the tab right away. The tab-modal print dialog
// lives inside its source tab, so closing the tab closed the dialog too
// (the user saw a tab flash open and shut), and about:reader's STATE_STOP
// fires before the article is rendered anyway.
//
// A page Readability can't parse as an article (browser.isArticle is
// false) has no clean version to print, so this is a normal print there.

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
    if (!browser || !win.PrintUtils) {
      return;
    }
    try {
      win.PrintUtils.startPrintWindow(browser.browsingContext, {});
    } catch (e) {
      // Already printing this tab: its dialog is open.
      console.error("Whimsy: print a clean page failed", e);
      return;
    }
    if (browser.isArticle) {
      this._chooseSimplified(win, browser).catch(e =>
        console.error("Whimsy: print a clean page could not simplify", e)
      );
    }
  },

  // Selects the print dialog's "Simplify page" option once the dialog has
  // initialized, exactly as if the person had clicked it.
  async _chooseSimplified(win, browser) {
    const manager = win.PrintUtils.getTabDialogBox(browser).getTabDialogManager();
    const dialog = manager._dialogs.findLast(d => d._box?.querySelector("print-preview"));
    if (!dialog) {
      // The system dialog or silent printing is configured: nothing to pick.
      return;
    }
    await dialog._dialogReady;
    const printWin = dialog.frameContentWindow;
    await printWin?._initialized;
    const radio = printWin?.document.getElementById("source-version-simplified-radio");
    if (!radio || radio.checked || radio.closest("label")?.hidden || radio.closest("section")?.hidden) {
      return;
    }
    radio.click();
  },
};
