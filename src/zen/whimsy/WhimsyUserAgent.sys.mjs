/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Per-site user agent (Safari's Develop > User Agent; the "User-Agent
// Switcher" extensions): "Pretend to be..." in the command bar sets the
// current site to Chrome, Safari (macOS or iPhone) or a custom string,
// reloading once. People use this for sites that block Firefox outright
// ("best viewed in Chrome") or to get a site's mobile layout.
// Built on BrowsingContext.customUserAgent (the same pref-free mechanism
// Responsive Design Mode uses); no engine patch. Per-site overrides are
// marked with a permission (so the permission manager's own UI/APIs can
// list and clear them) plus a JSON pref for the string itself.
// whimsy.feature.site-user-agent.

const FEATURE_PREF = "whimsy.feature.site-user-agent";
const SITES_PREF = "whimsy.useragent.sites";
const PERM_TYPE = "whimsy-useragent";

export const PRESETS = {
  "chrome-mac":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/129.0.0.0 Safari/537.36",
  "safari-mac":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) " +
    "Version/17.5 Safari/605.1.15",
  "safari-iphone":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) " +
    "Version/17.5 Mobile/15E148 Safari/604.1",
};

function readSites() {
  try {
    return JSON.parse(Services.prefs.getStringPref(SITES_PREF, "{}"));
  } catch (e) {
    return {};
  }
}

function writeSites(sites) {
  Services.prefs.setStringPref(SITES_PREF, JSON.stringify(sites));
}

export const WhimsyUserAgent = {
  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  // Returns the stored UA string for a host, or null.
  uaFor(host) {
    const sites = readSites();
    const entry = sites[host];
    if (!entry) {
      return null;
    }
    return entry.preset == "custom" ? entry.custom || null : PRESETS[entry.preset] || null;
  },

  set(host, preset, custom) {
    const sites = readSites();
    sites[host] = preset == "custom" ? { preset, custom } : { preset };
    writeSites(sites);
    try {
      const uri = Services.io.newURI(`https://${host}/`);
      const principal = Services.scriptSecurityManager.createContentPrincipal(uri, {});
      Services.perms.addFromPrincipal(principal, PERM_TYPE, Services.perms.ALLOW_ACTION);
    } catch (e) {}
  },

  clear(host) {
    const sites = readSites();
    delete sites[host];
    writeSites(sites);
    try {
      const uri = Services.io.newURI(`https://${host}/`);
      const principal = Services.scriptSecurityManager.createContentPrincipal(uri, {});
      Services.perms.removeFromPrincipal(principal, PERM_TYPE);
    } catch (e) {}
  },

  initWindow(win) {
    const listener = {
      QueryInterface: ChromeUtils.generateQI(["nsIWebProgressListener", "nsISupportsWeakReference"]),
      onLocationChange: (progress, request, location, flags) => {
        if (!this.enabled || !progress.isTopLevel) {
          return;
        }
        this.applyTo(progress.browsingContext, location.asciiHost);
      },
    };
    win.gBrowser.addTabsProgressListener?.(listener) ?? win.gBrowser.addProgressListener(listener);
    win._whimsyUserAgentListener = listener;
  },

  applyTo(browsingContext, host) {
    if (!browsingContext) {
      return;
    }
    const ua = host ? this.uaFor(host) : null;
    const current = browsingContext.customUserAgent || "";
    if ((ua || "") != current) {
      browsingContext.customUserAgent = ua || "";
    }
  },

  // Reload the given tab's browser once, after the pref change above has
  // committed, so onLocationChange picks up the new UA before the request.
  reload(win, tab) {
    tab.linkedBrowser.reload();
  },

  // "Pretend to be..." (command bar): a small panel of presets for the
  // current tab's site.
  openPicker(win) {
    const { document, gBrowser } = win;
    const tab = gBrowser.selectedTab;
    const host = tab.linkedBrowser?.currentURI?.asciiHost;
    if (!host) {
      return;
    }
    document.getElementById("whimsy-useragent-panel")?.remove();
    const panel = document.createXULElement("panel");
    panel.id = "whimsy-useragent-panel";
    panel.className = "whimsy-useragent-panel";
    panel.setAttribute("noautohide", "false");
    panel.setAttribute("type", "arrow");

    const choose = (preset, custom) => {
      if (preset) {
        this.set(host, preset, custom);
      } else {
        this.clear(host);
      }
      this.reload(win, tab);
      panel.hidePopup();
    };
    const OPTIONS = [
      [null, "whimsy-useragent-default"],
      ["chrome-mac", "whimsy-useragent-chrome"],
      ["safari-mac", "whimsy-useragent-safari-mac"],
      ["safari-iphone", "whimsy-useragent-safari-iphone"],
    ];
    const sites = readSites();
    const activePreset = sites[host]?.preset ?? null;
    for (const [preset, l10nId] of OPTIONS) {
      const item = document.createXULElement("toolbarbutton");
      item.className = "subviewbutton";
      document.l10n.setAttributes(item, l10nId);
      item.setAttribute("aria-checked", preset == activePreset);
      item.addEventListener("command", () => choose(preset));
      panel.appendChild(item);
    }
    panel.addEventListener("keydown", e => e.key == "Escape" && panel.hidePopup());
    panel.addEventListener("popuphidden", () => panel.remove());
    document.documentElement.appendChild(panel);
    panel.openPopup(gBrowser.selectedBrowser, "overlap");
  },
};
