/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave7/small: Cast to AirPlay (Arc's View > Cast...; AirPlay first, per
// the user). Gecko can't route a <video> to AirPlay, so the page's video
// address plays on the receiver through the native nsIWhimsyAirPlay
// (src/zen/whimsy/airplay: an AVPlayer plus AVKit's route picker, the same
// AirPlay menu as Safari's). The page's video pauses while the TV plays and
// picks up where the TV left off when casting stops. Media Source videos
// (blob: addresses: YouTube, Netflix...) can't be sent on their own; for
// those the toast points to Screen Mirroring in Displays settings.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AppConstants: "resource://gre/modules/AppConstants.sys.mjs",
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.cast";
const CONTRACT = "@whimsy/airplay;1";
const MIRROR_SETTINGS = "x-apple.systempreferences:com.apple.Displays-Settings.extension";
const MENU_ID = "menu_whimsyCast";
const TOAST_BUTTON_ID = "whimsy-cast-toast-button";

function isWebPage(win) {
  const uri = win.gBrowser?.selectedBrowser?.currentURI;
  return !!uri && (uri.schemeIs("https") || uri.schemeIs("http") || uri.schemeIs("file"));
}

export const WhimsyCast = {
  // The running cast: { win, browser, tab, connected, onClose } or null.
  session: null,
  // Tests put a stand-in for the native service here.
  nativeOverride: null,

  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  get native() {
    if (this.nativeOverride) {
      return this.nativeOverride;
    }
    if (lazy.AppConstants.platform != "macosx" || !Cc[CONTRACT]) {
      return null;
    }
    try {
      return Cc[CONTRACT].getService(Ci.nsIWhimsyAirPlay);
    } catch (e) {
      return null;
    }
  },

  get casting() {
    return !!this.session;
  },

  initWindow(win) {
    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsyCast",
      l10nId: "whimsy-action-cast",
      run: w => this.cast(w),
      icon: "chrome://browser/skin/zen-icons/media-play.svg",
      isAvailable: w => this.enabled && !!this.native && !this.casting && isWebPage(w),
    });
    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsyCastStop",
      l10nId: "whimsy-action-cast-stop",
      run: () => this.stop(),
      icon: "chrome://browser/skin/zen-icons/media-pause.svg",
      isAvailable: () => this.enabled && this.casting,
    });
    this.addMenuItem(win);
    win.addEventListener("unload", () => this.session?.win == win && this.stop(), { once: true });
  },

  // View > Cast..., at the end of the View menu (Arc's place for it). It
  // reads "Stop Casting" while a cast runs.
  addMenuItem(win) {
    const { document } = win;
    const popup = document.getElementById("menu_viewPopup");
    if (!popup || document.getElementById(MENU_ID)) {
      return;
    }
    const item = document.createXULElement("menuitem");
    item.id = MENU_ID;
    item.setAttribute("data-l10n-id", "whimsy-menu-cast");
    item.addEventListener("command", () => (this.casting ? this.stop() : this.cast(win)));
    popup.append(document.createXULElement("menuseparator"), item);
    popup.addEventListener("popupshowing", event => {
      if (event.target != popup) {
        return;
      }
      item.hidden = !this.enabled || !this.native;
      item.disabled = !this.casting && !isWebPage(win);
      document.l10n.setAttributes(item, this.casting ? "whimsy-menu-cast-stop" : "whimsy-menu-cast");
    });
  },

  toast(win, messageId, button = null) {
    const ui = win.gZenUIManager;
    if (!ui?.showToast) {
      return;
    }
    if (!button) {
      ui.showToast(messageId);
      return;
    }
    ui.showToast(messageId, {
      button: {
        id: TOAST_BUTTON_ID,
        command: event => {
          event.target.closest(".zen-toast")?.remove();
          button.run();
        },
      },
    });
    const el = win.document.getElementById(TOAST_BUTTON_ID);
    if (el) {
      win.document.l10n.setAttributes(el, button.l10nId);
    }
  },

  actor(browser) {
    try {
      return browser?.browsingContext?.currentWindowGlobal?.getActor("WhimsyPage") ?? null;
    } catch (e) {
      // The page is going away (its tab closed or it navigated).
      return null;
    }
  },

  // Pauses or seeks the page's video; a page that's gone is left alone.
  control(browser, data) {
    this.actor(browser)
      ?.sendQuery("Whimsy:CastControl", data)
      .catch(() => {});
  },

  // Where the AirPlay menu opens: the top right of the page, in screen
  // pixels (the picker's own button sits there while it's open).
  anchor(win, browser) {
    const rect = browser.getBoundingClientRect();
    return { x: win.mozInnerScreenX + rect.right - 44, y: win.mozInnerScreenY + rect.top + 8 };
  },

  /**
   * Casts the current tab's main video. Resolves to what happened:
   * "picking" (the AirPlay menu is open), "mirror" (a Media Source video:
   * pointed to Screen Mirroring), "no-video", "unavailable" or "off".
   */
  async cast(win) {
    if (!this.enabled) {
      return "off";
    }
    const native = this.native;
    if (!native) {
      this.toast(win, "whimsy-cast-unavailable-toast");
      return "unavailable";
    }
    const browser = win.gBrowser.selectedBrowser;
    let source = null;
    try {
      source = await this.actor(browser)?.sendQuery("Whimsy:CastSource");
    } catch (e) {
      console.error("Whimsy: cast", e);
    }
    if (!source) {
      this.toast(win, "whimsy-cast-no-video-toast");
      return "no-video";
    }
    if (!source.direct) {
      this.toast(win, "whimsy-cast-mirror-toast", {
        l10nId: "whimsy-cast-mirror-button",
        run: () => this.openMirroring(),
      });
      return "mirror";
    }
    this.stop();
    const tab = win.gBrowser.getTabForBrowser(browser);
    const session = { win, browser, tab, connected: false, onClose: null };
    session.onClose = () => this.session == session && this.stop();
    tab?.addEventListener("TabClose", session.onClose, { once: true });
    this.session = session;
    const { x, y } = this.anchor(win, browser);
    try {
      native.cast(source.src, source.time || 0, x, y, (state, time) => this.onState(session, state, time));
    } catch (e) {
      console.error("Whimsy: cast", e);
      this.end(session);
      this.toast(win, "whimsy-cast-failed-toast");
      return "failed";
    }
    return "picking";
  },

  onState(session, state, time) {
    if (this.session != session) {
      return;
    }
    const { win, browser } = session;
    switch (state) {
      case "connected":
        session.connected = true;
        this.control(browser, { action: "pause" });
        this.toast(win, "whimsy-cast-connected-toast", {
          l10nId: "whimsy-cast-stop-button",
          run: () => this.stop(),
        });
        break;
      case "ended":
      case "disconnected":
      case "failed":
      case "cancelled": {
        const wasConnected = session.connected;
        this.end(session);
        if (wasConnected && Number.isFinite(time) && browser.isConnected) {
          this.control(browser, { action: "seek", time });
        }
        if (state == "failed") {
          this.toast(win, "whimsy-cast-failed-toast");
        } else if (wasConnected) {
          this.toast(win, "whimsy-cast-stopped-toast");
        }
        if (state == "ended") {
          this.native?.stop();
        }
        break;
      }
    }
  },

  end(session) {
    session.tab?.removeEventListener("TabClose", session.onClose);
    if (this.session == session) {
      this.session = null;
    }
  },

  // Stops the cast; the native side answers "disconnected", which puts the
  // page's video at the TV's position.
  stop() {
    if (!this.session) {
      return;
    }
    try {
      this.native?.stop();
    } catch (e) {
      console.error("Whimsy: cast stop", e);
    }
    // A native side that didn't answer still ends the session here.
    if (this.session) {
      this.end(this.session);
    }
  },

  openMirroring() {
    try {
      const uri = Services.io.newURI(MIRROR_SETTINGS);
      Cc["@mozilla.org/uriloader/external-protocol-service;1"]
        .getService(Ci.nsIExternalProtocolService)
        .loadURI(uri, Services.scriptSecurityManager.getSystemPrincipal());
    } catch (e) {
      console.error("Whimsy: open Screen Mirroring", e);
    }
  },
};
