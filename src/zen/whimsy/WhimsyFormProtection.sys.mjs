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
      const win = browser.ownerGlobal;
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

  isFormProtected(tab) {
    if (!this.enabled || !tab) {
      return false;
    }
    if (tab.hasAttribute(ATTR)) {
      return true;
    }
    return this.hasSessionRestoreFormData(tab);
  },

  updateTabProtection(tab, hasForm) {
    if (!this.enabled) {
      tab.removeAttribute(ATTR);
      return;
    }
    const shouldProtect = hasForm || this.hasSessionRestoreFormData(tab);
    if (shouldProtect) {
      tab.setAttribute(ATTR, "true");
      try {
        const tooltip = lazy.l10n.formatValueSync("whimsy-tab-form-protected-tooltip");
        if (tooltip) {
          tab.setAttribute("title", tooltip);
        }
      } catch (e) {}
    } else {
      tab.removeAttribute(ATTR);
      tab.removeAttribute("title");
    }
  },

  toggleTabProtection(tab) {
    if (!tab) {
      return false;
    }
    const current = tab.hasAttribute(ATTR);
    if (current) {
      tab.removeAttribute(ATTR);
      tab.removeAttribute("title");
    } else {
      tab.setAttribute(ATTR, "true");
      try {
        const tooltip = lazy.l10n.formatValueSync("whimsy-tab-form-protected-tooltip");
        if (tooltip) {
          tab.setAttribute("title", tooltip);
        }
      } catch (e) {}
    }
    return !current;
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
      isAvailable: w => this.enabled && !!w.gBrowser?.selectedBrowser?.currentURI?.spec?.startsWith("http"),
    });

    // Clean up attribute on tab reload or location change if form is cleared
    const onLocationChange = (browser, webProgress, request, location) => {
      const tab = win.gBrowser?.getTabForBrowser(browser);
      if (tab && !this.hasSessionRestoreFormData(tab) && !browser._whimsyFormContexts?.size) {
        tab.removeAttribute(ATTR);
      }
    };
    win.gBrowser?.addTabsProgressListener({
      onLocationChange,
    });
  },
};
