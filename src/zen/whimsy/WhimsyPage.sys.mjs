/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Page tools: things you do to the page you're on.
//
// Capture (Arc's Capture, Edge's Web Capture): Firefox Screenshots is the
// capture tool (drag a region, click an element, or Visible / Full Page,
// then Copy or Download). Whimsy adds Arc's Cmd+Shift+2 for it, and a
// one-step "Copy Full-Page Screenshot" (Cmd+Opt+Shift+F and the command
// bar) that drops the whole page on the clipboard with no editor between.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  BrowserUtils: "resource://gre/modules/BrowserUtils.sys.mjs",
  ScreenshotsUtils: "moz-src:///browser/components/screenshots/ScreenshotsUtils.sys.mjs",
  WhimsyShortcuts: "resource:///modules/whimsy/WhimsyShortcuts.sys.mjs",
});

const CAPTURE_FEATURE_PREF = "whimsy.feature.capture";

// Edit text on page (the designMode bookmarklet): turn it on from the page
// menu or the command bar, click anywhere and type, then press Esc (or
// click the "Editing" pill in the address bar) to finish. People use it to
// try copy changes, redact a screenshot, or test text lengths. It's per
// page: reloading or leaving the page ends it.
const EDIT_FEATURE_PREF = "whimsy.feature.edit-page";
const EDIT_MENU_ID = "context-whimsy-edit-page";
const EDIT_PILL_ID = "whimsy-editing-pill";

function isWebPage(win) {
  const tab = win.gBrowser.selectedTab;
  const uri = tab.linkedBrowser?.currentURI;
  return !!tab.linkedPanel && !tab.hasAttribute("zen-empty-tab") && !!uri && !uri.spec.startsWith("about:blank");
}

export const WhimsyPage = {
  get captureEnabled() {
    return Services.prefs.getBoolPref(CAPTURE_FEATURE_PREF, true);
  },

  initWindow(win) {
    this.initCapture(win);
    this.initEditPage(win);
  },

  actorFor(browser) {
    return browser?.browsingContext?.currentWindowGlobal?.getActor("WhimsyPage") ?? null;
  },

  // --- Capture ---

  initCapture(win) {
    if (!this.captureEnabled) {
      return;
    }
    const { WhimsyShortcuts } = lazy;
    // Arc's capture shortcut, beside Firefox's Cmd+Shift+S.
    WhimsyShortcuts.addKey(win, {
      id: "key_whimsyScreenshotArc",
      command: "Browser:Screenshot",
      key: "2",
      modifiers: "accel,shift",
    });
    WhimsyShortcuts.addCommand(win, {
      id: "cmd_whimsyCopyFullPage",
      run: w => this.copyFullPageScreenshot(w),
      key: { id: "key_whimsyCopyFullPage", key: "F", modifiers: "accel,alt,shift" },
    });
    WhimsyShortcuts.addActions([
      {
        l10nId: "whimsy-action-copy-full-page",
        command: "cmd_whimsyCopyFullPage",
        icon: "chrome://browser/skin/zen-icons/screenshot.svg",
        isAvailable: w => this.captureEnabled && isWebPage(w),
      },
    ]);
  },

  // Copies the whole page as a PNG (Screenshots draws it). Returns the image's size in CSS pixels,
  // or null when the page can't be captured.
  async copyFullPageScreenshot(win, browser = win.gBrowser.selectedBrowser) {
    if (!this.captureEnabled || !isWebPage(win)) {
      return null;
    }
    const { ScreenshotsUtils, BrowserUtils } = lazy;
    let rect;
    try {
      rect = await browser.browsingContext.currentWindowGlobal.getActor("WhimsyPage").sendQuery("Whimsy:PageBounds");
    } catch (e) {
      console.error("Whimsy: full-page capture", e);
      win.gZenUIManager?.showToast?.("whimsy-capture-failed-toast");
      return null;
    }
    const canvas = await ScreenshotsUtils.createCanvas(rect, browser);
    const blob = await canvas.convertToBlob();
    BrowserUtils.copyImageToClipboard(await blob.arrayBuffer());
    win.gZenUIManager?.showToast?.("whimsy-capture-copied-toast");
    const ratio = rect.devicePixelRatio || 1;
    return { width: canvas.width / ratio, height: canvas.height / ratio };
  },

  // --- Edit text on page ---

  get editPageEnabled() {
    return Services.prefs.getBoolPref(EDIT_FEATURE_PREF, true);
  },

  initEditPage(win) {
    const { document, gBrowser } = win;
    const { WhimsyShortcuts } = lazy;
    WhimsyShortcuts.addCommand(win, {
      id: "cmd_whimsyEditPage",
      run: w => this.toggleEditing(w),
    });
    WhimsyShortcuts.addActions([
      {
        l10nId: "whimsy-action-edit-page",
        command: "cmd_whimsyEditPage",
        icon: "chrome://browser/skin/zen-icons/edit-theme.svg",
        isAvailable: w => this.editPageEnabled && isWebPage(w),
      },
    ]);
    const menu = document.getElementById("contentAreaContextMenu");
    menu?.addEventListener("popupshowing", event => {
      if (event.target == menu) {
        this.updateEditMenu(win);
      }
    });
    gBrowser.tabContainer.addEventListener("TabSelect", () => this.updateEditPill(win));
    gBrowser.addTabsProgressListener({
      onLocationChange: (browser, webProgress, request, location, flags) => {
        if (webProgress.isTopLevel && !(flags & Ci.nsIWebProgressListener.LOCATION_CHANGE_SAME_DOCUMENT) && browser.whimsyEditing) {
          browser.whimsyEditing = false;
          this.updateEditPill(win);
        }
      },
    });
  },

  updateEditMenu(win) {
    const { document } = win;
    let item = document.getElementById(EDIT_MENU_ID);
    const context = win.gContextMenu;
    const show = this.editPageEnabled && isWebPage(win) && !!context && !context.onTextInput && !context.onEditable;
    if (!show) {
      if (item) {
        item.hidden = true;
      }
      return;
    }
    if (!item) {
      item = document.createXULElement("menuitem");
      item.id = EDIT_MENU_ID;
      item.setAttribute("type", "checkbox");
      document.l10n.setAttributes(item, "whimsy-context-edit-page");
      item.addEventListener("command", () => this.toggleEditing(win));
      const anchor = document.getElementById("context-take-screenshot");
      anchor ? anchor.after(item) : document.getElementById("contentAreaContextMenu").appendChild(item);
    }
    item.hidden = false;
    item.toggleAttribute("checked", !!win.gBrowser.selectedBrowser.whimsyEditing);
  },

  // Turns editing on or off for the current page; returns whether it's on.
  async toggleEditing(win, on = !win.gBrowser.selectedBrowser.whimsyEditing) {
    const browser = win.gBrowser.selectedBrowser;
    if (on && (!this.editPageEnabled || !isWebPage(win))) {
      return false;
    }
    const actor = this.actorFor(browser);
    if (!actor) {
      return false;
    }
    const editing = await actor.sendQuery("Whimsy:SetEditable", { on });
    browser.whimsyEditing = editing;
    this.updateEditPill(win);
    if (editing) {
      win.gZenUIManager?.showToast?.("whimsy-edit-page-toast");
    }
    return editing;
  },

  // From the page: Esc ended editing.
  onEditingEnded(browser) {
    browser.whimsyEditing = false;
    const win = browser.ownerDocument?.defaultView;
    if (win) {
      this.updateEditPill(win);
    }
  },

  updateEditPill(win) {
    const { document } = win;
    const editing = !!win.gBrowser.selectedBrowser?.whimsyEditing;
    let pill = document.getElementById(EDIT_PILL_ID);
    if (!pill) {
      if (!editing) {
        return;
      }
      pill = document.createXULElement("hbox");
      pill.id = EDIT_PILL_ID;
      pill.setAttribute("align", "center");
      pill.setAttribute("role", "button");
      pill.setAttribute("tabindex", "0");
      const label = document.createXULElement("label");
      document.l10n.setAttributes(label, "whimsy-editing-pill");
      pill.append(label);
      pill.addEventListener("click", () => this.toggleEditing(win, false));
      pill.addEventListener("keydown", event => {
        if (event.key == "Enter" || event.key == " ") {
          this.toggleEditing(win, false);
        }
      });
      const buttons = document.getElementById("page-action-buttons");
      buttons ? buttons.prepend(pill) : document.getElementById("urlbar-container")?.append(pill);
    }
    pill.hidden = !editing;
  },
};
