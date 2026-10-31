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

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  WhimsyPanels: "resource:///modules/whimsy/WhimsyPanels.sys.mjs",
  WhimsyProfiles: "resource:///modules/whimsy/WhimsyProfiles.sys.mjs",
});

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
    const raw = JSON.parse(Services.prefs.getStringPref(SITES_PREF, "{}"));
    if (!raw || typeof raw !== "object") {
      return { default: {} };
    }
    // Backward compatibility: if raw has host keys directly (e.g. raw["example.com"] = { preset: "..." })
    // wrap it into { default: raw }
    const firstVal = Object.values(raw)[0];
    if (firstVal && (firstVal.preset !== undefined || typeof firstVal !== "object")) {
      return { default: raw };
    }
    return raw;
  } catch (e) {
    return { default: {} };
  }
}

function writeSites(sites) {
  Services.prefs.setStringPref(SITES_PREF, JSON.stringify(sites));
}

// wave8/isolation & W8-49: a choice made in a private tab stays in memory and
// applies to private tabs only (host -> entry, or null for "Default"). Gone
// when the last private tab closes.
const privateSites = new Map();
let watchingPrivate = false;

function watchPrivateEnd() {
  if (watchingPrivate) {
    return;
  }
  watchingPrivate = true;
  Services.obs.addObserver(() => privateSites.clear(), "last-pb-context-exited");
}

function parseOptions(opts) {
  if (typeof opts === "boolean") {
    return { isPrivate: opts, profileKey: "default" };
  }
  if (typeof opts === "string") {
    return { isPrivate: false, profileKey: opts };
  }
  return {
    isPrivate: !!opts?.isPrivate,
    profileKey: opts?.profileKey || "default",
  };
}

function entryFor(host, opts = {}) {
  const { isPrivate, profileKey } = parseOptions(opts);
  if (isPrivate && privateSites.has(host)) {
    return privateSites.get(host);
  }
  const sites = readSites();
  return sites[profileKey]?.[host] ?? null;
}

export const WhimsyUserAgent = {
  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  // Returns the stored UA string for a host, or null.
  uaFor(host, options = {}) {
    const entry = entryFor(host, options);
    if (!entry) {
      return null;
    }
    return entry.preset == "custom" ? entry.custom || null : PRESETS[entry.preset] || null;
  },

  set(host, preset, custom, options = {}) {
    const { isPrivate, profileKey } = parseOptions(options);
    if (isPrivate) {
      watchPrivateEnd();
      privateSites.set(host, preset == "custom" ? { preset, custom } : { preset });
      return;
    }
    const sites = readSites();
    sites[profileKey] ??= {};
    sites[profileKey][host] = preset == "custom" ? { preset, custom } : { preset };
    writeSites(sites);
    try {
      const uri = Services.io.newURI(`https://${host}/`);
      const userContextId = lazy.WhimsyProfiles.idForKey(profileKey);
      const principal = Services.scriptSecurityManager.createContentPrincipal(uri, {
        userContextId,
      });
      Services.perms.addFromPrincipal(principal, PERM_TYPE, Services.perms.ALLOW_ACTION);
    } catch (e) {}
  },

  clear(host, options = {}) {
    const { isPrivate, profileKey } = parseOptions(options);
    if (isPrivate) {
      watchPrivateEnd();
      privateSites.set(host, null);
      return;
    }
    const sites = readSites();
    if (sites[profileKey]) {
      delete sites[profileKey][host];
      writeSites(sites);
    }
    try {
      const uri = Services.io.newURI(`https://${host}/`);
      const userContextId = lazy.WhimsyProfiles.idForKey(profileKey);
      const principal = Services.scriptSecurityManager.createContentPrincipal(uri, {
        userContextId,
      });
      Services.perms.removeFromPrincipal(principal, PERM_TYPE);
    } catch (e) {}
  },

  removeProfile(profileKey) {
    if (!profileKey || profileKey === "default") {
      return;
    }
    const sites = readSites();
    if (sites[profileKey]) {
      delete sites[profileKey];
      writeSites(sites);
    }
  },

  initWindow(win) {
    const listener = {
      QueryInterface: ChromeUtils.generateQI(["nsIWebProgressListener", "nsISupportsWeakReference"]),
      onLocationChange: (progress, request, location, flags) => {
        if (!this.enabled || !progress.isTopLevel) {
          return;
        }
        const bc = progress.browsingContext;
        const attrs = bc?.top?.originAttributes ?? {};
        const isPrivate = (attrs.privateBrowsingId || 0) > 0;
        const userContextId = attrs.userContextId || 0;
        const profileKey = lazy.WhimsyProfiles.keyFor(userContextId);
        this.applyTo(bc, location?.asciiHost, { isPrivate, profileKey });
      },
    };
    win.gBrowser.addTabsProgressListener?.(listener) ?? win.gBrowser.addProgressListener(listener);
    win._whimsyUserAgentListener = listener;
  },

  applyTo(browsingContext, host, options = null) {
    if (!browsingContext) {
      return;
    }
    if (!options) {
      const attrs = browsingContext.top?.originAttributes ?? {};
      const isPrivate = (attrs.privateBrowsingId || 0) > 0;
      const userContextId = attrs.userContextId || 0;
      const profileKey = lazy.WhimsyProfiles.keyFor(userContextId);
      options = { isPrivate, profileKey };
    }
    const ua = host ? this.uaFor(host, options) : null;
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

  // "Pretend to be..." (command bar). fixB: a WhimsyPanels sheet hanging
  // off the address bar's site button (centred when the bar is hidden): a
  // radio list of browsers for this site, plus a custom string. Choosing
  // one reloads the tab once.
  openPicker(win) {
    const { document, gBrowser } = win;
    const tab = gBrowser.selectedTab;
    const host = tab.linkedBrowser?.currentURI?.asciiHost;
    if (!host) {
      return;
    }
    const isPrivate = lazy.PrivateBrowsingUtils.isBrowserPrivate(tab.linkedBrowser);
    const userContextId = tab.userContextId || 0;
    const profileKey = lazy.WhimsyProfiles.keyFor(userContextId);
    const options = { isPrivate, profileKey };

    const { panel, body } = lazy.WhimsyPanels.create(win, {
      id: "whimsy-useragent-panel",
      titleL10nId: "whimsy-useragent-title",
      subtitleL10nId: "whimsy-useragent-subtitle",
      subtitleArgs: { site: host },
      size: "medium",
    });
    panel.classList.add("whimsy-useragent-panel");

    const choose = (preset, custom) => {
      if (preset) {
        this.set(host, preset, custom, options);
      } else {
        this.clear(host, options);
      }
      this.reload(win, tab);
      lazy.WhimsyPanels.close(panel);
    };
    const entry = entryFor(host, options);
    const activePreset = entry?.preset ?? null;
    const OPTIONS = [
      [null, "whimsy-useragent-option-default", "whimsy-useragent-option-default-detail"],
      ["chrome-mac", "whimsy-useragent-option-chrome", "whimsy-useragent-option-chrome-detail"],
      ["safari-mac", "whimsy-useragent-option-safari-mac", "whimsy-useragent-option-safari-mac-detail"],
      ["safari-iphone", "whimsy-useragent-option-safari-iphone", "whimsy-useragent-option-safari-iphone-detail"],
      ["custom", "whimsy-useragent-option-custom", "whimsy-useragent-option-custom-detail"],
    ];

    // The custom string: a field and Apply, shown under the Custom row.
    const customBox = document.createXULElement("vbox");
    customBox.className = "whimsy-useragent-custom-box";
    customBox.hidden = activePreset != "custom";
    const field = document.createElementNS("http://www.w3.org/1999/xhtml", "input");
    field.className = "whimsy-useragent-custom";
    field.setAttribute("spellcheck", "false");
    field.value = entry?.custom ?? "";
    document.l10n.setAttributes(field, "whimsy-useragent-custom-field");
    const apply = lazy.WhimsyPanels.footerButton(document, {
      l10nId: "whimsy-useragent-custom-apply",
      primary: true,
      onCommand: () => {
        const value = field.value.trim();
        if (value) {
          choose("custom", value);
        } else {
          field.focus();
        }
      },
    });
    apply.classList.add("small-button");
    field.addEventListener("keydown", event => {
      if (event.key == "Enter") {
        event.preventDefault();
        apply.doCommand();
      }
    });
    customBox.append(field, apply);

    for (const [preset, l10nId, detailId] of OPTIONS) {
      const item = lazy.WhimsyPanels.item(document, {
        l10nId,
        subtitleL10nId: detailId,
        checked: preset == activePreset,
        onCommand: () => {
          if (preset == "custom") {
            customBox.hidden = false;
            field.focus();
            return;
          }
          choose(preset);
        },
      });
      item.setAttribute("whimsy-useragent-preset", preset ?? "default");
      body.append(item);
    }
    body.append(customBox);
    const anchor = lazy.WhimsyPanels.visibleAnchor(win, ["zen-site-data-icon-button", "identity-icon-box", "urlbar"]);
    lazy.WhimsyPanels.open(win, panel, { anchor, position: "after_start" });
  },
};

// W8-49: clean up per-site UA overrides when a custom profile is deleted.
try {
  lazy.WhimsyProfiles.onDelete?.((id, key) => WhimsyUserAgent.removeProfile(key));
} catch (e) {}
