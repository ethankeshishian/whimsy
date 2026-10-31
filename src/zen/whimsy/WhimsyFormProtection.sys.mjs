/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W9-03: Form protection: tabs with half-filled forms are exempt from
// auto-archive and typed text is restored after tab crash or reload.
//
// When a user fills in a form on a page, WhimsyFormProtection marks the tab
// with `whimsy-form-protected="true"` and displays a subtle indicator on the
// tab. WhimsyArchive's sweepWindow checks `isFormProtected(tab)` and exempts
// protected tabs from being auto-archived. Firefox SessionStore's built-in
// form data caching (`TabStateCache`) is also consulted, ensuring session
// restore form data is respected and preserved across reloads and crashes.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  TabStateCache: "moz-src:///browser/components/sessionstore/TabStateCache.sys.mjs",
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
  WhimsyToast: "resource:///modules/whimsy/WhimsyToast.sys.mjs",
});
ChromeUtils.defineLazyGetter(lazy, "l10n", () => new Localization(["browser/whimsy.ftl"], true));

const FEATURE_PREF = "whimsy.feature.form-protection";
const COMMAND_ID = "cmd_whimsyProtectForm";
const ATTR = "whimsy-form-protected";

export class WhimsyFormProtectionParent extends JSWindowActorParent {
  receiveMessage(message) {
    if (message.name === "Whimsy:FormProtectionState") {
      const browser = this.browsingContext?.top?.embedderElement;
      if (!browser) {
        return;
      }
      if (!browser._whimsyFormContexts) {
        browser._whimsyFormContexts = new Set();
      }
      if (message.data.hasForm) {
        browser._whimsyFormContexts.add(this.browsingContext.id);
      } else {
        browser._whimsyFormContexts.delete(this.browsingContext.id);
      }
      const win = browser.documentGlobal;
      const tab = win?.gBrowser?.getTabForBrowser(browser);
      if (tab) {
        WhimsyFormProtection.updateTabProtection(tab, browser._whimsyFormContexts.size > 0);
      }
    }
  }
}

export const WhimsyFormProtection = {
  COMMAND_ID,
  ATTR,
  _initialized: false,

  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  init() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;
    ChromeUtils.registerWindowActor("WhimsyFormProtection", {
      parent: { esModuleURI: "resource:///modules/whimsy/WhimsyFormProtection.sys.mjs" },
      child: {
        esModuleURI: "resource:///modules/whimsy/WhimsyFormProtectionChild.sys.mjs",
        events: {
          input: { mozSystemGroup: true, capture: true },
          change: { mozSystemGroup: true, capture: true },
          pageshow: { mozSystemGroup: true },
        },
      },
      matches: ["https://*/*", "http://*/*"],
      messageManagerGroups: ["browsers"],
      safeForUntrustedWebProcess: true,
    });
  },

  hasSessionRestoreFormData(tab) {
    const browser = tab?.linkedBrowser;
    if (!browser) {
      return false;
    }
    const cached = lazy.TabStateCache?.get(browser.permanentKey);
    const fd = cached?.formdata;
    if (fd) {
      if (fd.id && Object.keys(fd.id).length > 0) {
        return true;
      }
      if (fd.xpath && Object.keys(fd.xpath).length > 0) {
        return true;
      }
      if (fd.innerHTML) {
        return true;
      }
      if (
        Array.isArray(fd.children) &&
        fd.children.some(
          c =>
            c &&
            ((c.id && Object.keys(c.id).length > 0) ||
              (c.xpath && Object.keys(c.xpath).length > 0))
        )
      ) {
        return true;
      }
    }
    return false;
  },

  canProtect(win) {
    return this.enabled && !!win.gBrowser?.selectedBrowser?.currentURI?.spec?.startsWith("http");
  },

  isFormProtected(tab) {
    if (!this.enabled || !tab) {
      return false;
    }
    if (tab.hasAttribute(ATTR)) {
      return true;
    }
    return this.hasSessionRestoreFormData(tab);
  },

  // The dot is drawn with CSS on .tab-icon-stack::before; its meaning goes
  // in the tab's tooltip and accessible description (see wrapTooltip), not
  // in a `title` the tab tooltip overrides (review design-full-4 M10).
  updateTabProtection(tab, hasForm) {
    if (!this.enabled) {
      tab.removeAttribute(ATTR);
      return;
    }
    const shouldProtect = hasForm || tab._whimsyFormManual || this.hasSessionRestoreFormData(tab);
    tab.toggleAttribute(ATTR, !!shouldProtect);
  },

  isManuallyProtected(tab) {
    return !!tab?._whimsyFormManual;
  },

  toggleTabProtection(tab) {
    if (!tab) {
      return false;
    }
    const protect = !tab._whimsyFormManual;
    tab._whimsyFormManual = protect;
    tab.toggleAttribute(ATTR, protect);
    const win = tab.documentGlobal;
    try {
      lazy.WhimsyToast.show(win, {
        l10nId: protect ? "whimsy-form-protected-toast" : "whimsy-form-unprotected-toast",
      });
    } catch (e) {}
    return protect;
  },

  // Firefox's tab tooltip and the focused tab's accessible description both
  // come from gBrowser.getTabTooltip; add a line while the tab is protected.
  wrapTooltip(win) {
    const gBrowser = win.gBrowser;
    if (!gBrowser?.getTabTooltip || gBrowser._whimsyFormTooltip) {
      return;
    }
    gBrowser._whimsyFormTooltip = true;
    const original = gBrowser.getTabTooltip;
    const self = this;
    gBrowser.getTabTooltip = function (tab, ...args) {
      const text = original.call(this, tab, ...args);
      if (!self.enabled || !tab?.hasAttribute(ATTR)) {
        return text;
      }
      let note = "";
      try {
        note = lazy.l10n.formatValueSync("whimsy-tab-form-protected-tooltip", {
          reason: tab._whimsyFormManual ? "manual" : "form",
        });
      } catch (e) {}
      return [text, note].filter(Boolean).join("\n");
    };
  },

  initWindow(win) {
    this.init();
    lazy.WhimsyCommands.register(win, {
      id: COMMAND_ID,
      l10nId: "whimsy-action-protect-form",
      run: w => {
        const tab = w.gBrowser?.selectedTab;
        if (tab) {
          this.toggleTabProtection(tab);
        }
      },
      icon: "chrome://browser/skin/zen-icons/shield.svg",
      isAvailable: w => this.canProtect(w),
      // Review design-full-4 L5: say what running it will do.
      variants: [
        {
          l10nId: "whimsy-action-protect-form-on",
          isAvailable: w => this.canProtect(w) && !this.isManuallyProtected(w.gBrowser.selectedTab),
        },
        {
          l10nId: "whimsy-action-protect-form-off",
          isAvailable: w => this.canProtect(w) && this.isManuallyProtected(w.gBrowser.selectedTab),
        },
      ],
    });
    this.wrapTooltip(win);

    // Clean up attribute on tab reload or location change if form is cleared
    const onLocationChange = (browser, webProgress, request, location) => {
      const tab = win.gBrowser?.getTabForBrowser(browser);
      if (
        tab &&
        !tab._whimsyFormManual &&
        !this.hasSessionRestoreFormData(tab) &&
        !browser._whimsyFormContexts?.size
      ) {
        tab.removeAttribute(ATTR);
      }
    };
    win.gBrowser?.addTabsProgressListener({
      onLocationChange,
    });
  },
};
