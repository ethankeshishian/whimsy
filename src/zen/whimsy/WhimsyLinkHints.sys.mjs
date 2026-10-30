/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave6/zap: Link hints, keyboard-only clicking.
//
// The original: Vimium's "f" (and qutebrowser's hints). Keyboard people love
// it because every link and button on a page becomes two keystrokes away,
// with no mouse and no tabbing through fifty stops. The flow: press the
// shortcut, small letter badges appear on everything clickable on screen,
// type a badge's letters and it's clicked; hold Shift on the last letter to
// open a link in a new tab instead; Esc (or any other key, a click, a
// scroll) puts the badges away.
//
// Whimsy's version: Cmd+J (the shortlist's pick; it was Firefox's Downloads
// shortcut, and Downloads stays in the Tools menu and the Library), also
// "Link Hints" in the command bar. Badges take
// the space's accent color. Letters work on any keyboard layout (on
// non-Latin layouts, by key position). Screen readers hear how many hints
// there are and how to use them through a status message.

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyShortcuts: "resource:///modules/whimsy/WhimsyShortcuts.sys.mjs",
});
ChromeUtils.defineLazyGetter(lazy, "l10n", () => new Localization(["browser/whimsy.ftl"], true));

const FEATURE_PREF = "whimsy.feature.link-hints";
const COMMAND_ID = "whimsy-link-hints";
const STATUS_ID = "whimsy-link-hints-status";
const FALLBACK_RGB = { r: 91, g: 91, b: 214 };

export const WhimsyLinkHints = {
  COMMAND_ID,

  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  canHint(win) {
    const uri = win?.gBrowser?.selectedBrowser?.currentURI;
    return this.enabled && !!uri && ["http", "https", "file"].includes(uri.scheme);
  },

  actorFor(browser) {
    try {
      return browser?.browsingContext?.currentWindowGlobal?.getActor("WhimsyLinkHints") ?? null;
    } catch (e) {
      return null; // A page the actor doesn't run on.
    }
  },

  // The badge colors: the space's accent, with black or white ink, whichever
  // reads better on it.
  colors(win) {
    // Resolved through a probe, since the variable may be a color-mix().
    const { document } = win;
    const probe = document.createElementNS("http://www.w3.org/1999/xhtml", "div");
    probe.style.color = "var(--zen-primary-color)";
    probe.hidden = true;
    document.documentElement.append(probe);
    let rgba = null;
    try {
      rgba = win.InspectorUtils.colorToRGBA(win.getComputedStyle(probe).color);
    } catch (e) {
      rgba = null;
    }
    probe.remove();
    if (!rgba) {
      rgba = FALLBACK_RGB;
    }
    const accent = `rgb(${rgba.r}, ${rgba.g}, ${rgba.b})`;
    const lin = v => {
      v /= 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    const luminance = 0.2126 * lin(rgba.r) + 0.7152 * lin(rgba.g) + 0.0722 * lin(rgba.b);
    // Contrast against white vs. against near-black: pick the larger.
    const onWhite = 1.05 / (luminance + 0.05);
    const onBlack = (luminance + 0.05) / 0.06;
    return { accent, ink: onWhite >= onBlack ? "#ffffff" : "#16161a" };
  },

  toggle(win) {
    if (!this.canHint(win)) {
      return false;
    }
    const browser = win.gBrowser.selectedBrowser;
    const actor = this.actorFor(browser);
    if (!actor) {
      return false;
    }
    // The page takes the keys while hints show, even if the address bar
    // had focus.
    if (win.document.activeElement != browser) {
      browser.focus();
    }
    actor.sendAsyncMessage("Whimsy:Hints:Toggle", this.colors(win));
    return true;
  },

  // A polite status message for screen readers (and nothing visible: the
  // page shows its own help pill).
  statusRegion(win) {
    const { document } = win;
    let region = document.getElementById(STATUS_ID);
    if (!region) {
      region = document.createElementNS("http://www.w3.org/1999/xhtml", "div");
      region.id = STATUS_ID;
      region.setAttribute("role", "status");
      region.setAttribute("aria-live", "polite");
      region.style.cssText =
        "position: fixed; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap;";
      document.documentElement.append(region);
    }
    return region;
  },

  onState(win, browser, { state, count = 0 }) {
    if (browser != win.gBrowser?.selectedBrowser) {
      return;
    }
    const ids = {
      open: "whimsy-link-hints-open",
      none: "whimsy-link-hints-none",
      closed: "whimsy-link-hints-closed",
    };
    const id = ids[state];
    const region = this.statusRegion(win);
    if (!id) {
      region.textContent = "";
      return;
    }
    lazy.l10n.formatValue(id, { count }).then(text => {
      region.textContent = "";
      // A fresh frame, so the same message twice in a row is read again.
      win.requestAnimationFrame(() => {
        region.textContent = text;
      });
    });
    if (state == "none") {
      win.gZenUIManager?.showToast?.("whimsy-link-hints-none", {});
    }
  },

  initWindow(win) {
    const shortcuts = lazy.WhimsyShortcuts;
    // Downloads is Cmd+J everywhere but Linux (Ctrl+Shift+Y there). Only
    // take it while Downloads is still on plain Cmd+J: WhimsyShortcuts runs
    // first and moves Downloads to Shift+Cmd+J (Arc), and releasing it then
    // would leave Downloads with no key at all.
    const downloads = win.document.getElementById("key_openDownloads");
    if (
      this.enabled &&
      AppConstants.platform != "linux" &&
      downloads?.getAttribute("key")?.toUpperCase() == "J" &&
      downloads.getAttribute("modifiers") == "accel"
    ) {
      shortcuts.releaseKey(win, "key_openDownloads");
    }
    shortcuts.addCommand(win, {
      id: COMMAND_ID,
      run: w => this.toggle(w),
      key: this.enabled ? { id: "key_whimsyLinkHints", key: "J", modifiers: "accel" } : null,
    });
    shortcuts.addActions([
      {
        l10nId: "whimsy-action-link-hints",
        command: COMMAND_ID,
        icon: "chrome://browser/skin/zen-icons/move-cursor.svg",
        isAvailable: w => this.canHint(w),
      },
    ]);
  },
};
