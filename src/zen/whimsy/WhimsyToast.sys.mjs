/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave8/snooze (W8-37): one toast for every Whimsy action that can be
// undone (Snooze, Hide Space, the archive sweep, ...).
//
// Zen's toast (nsZenToastManager) hides its buttons' text (zen-popup.css:
// `.button-text { display: none }`) and leaves after two seconds, so the
// Undo button read as an empty pill and was gone before anyone could reach
// it. Arc's toast says what happened and offers Undo as a word; Gmail's
// "Conversation snoozed · Undo" stays long enough to change your mind.
//
// So this toast sits in Zen's own toast corner (#zen-toast-container,
// top, on the side away from the sidebar) with Zen's toast shape, and is
// built from plain HTML:
//
//   div.whimsy-toast[role=status]       one at a time; a new one replaces it
//     div.whimsy-toast-text
//       span.whimsy-toast-message        Fluent
//       span.whimsy-toast-detail         optional second line (a tab title)
//     button.whimsy-toast-action         "Undo"  ⌘Z  (aria-keyshortcuts)
//
// It stays 6s with an action (4s without), waits while the pointer is on
// it, while it has keyboard focus and while the window is in the
// background; Esc dismisses it from the keyboard. It rises a few pixels as
// it fades in and leaves faster than it came; with reduced motion it only
// fades. Colours come from Zen's panel variables, so light, dark and space
// themes all follow.

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

const HTML_NS = "http://www.w3.org/1999/xhtml";
const CONTAINER_ID = "zen-toast-container";
const ACTION_TIMEOUT_MS = 6000;
const PLAIN_TIMEOUT_MS = 4000;
const RESUME_MIN_MS = 2000; // after hover/focus, at least this long again
const EXIT_FALLBACK_MS = 260;

const state = new WeakMap(); // toast -> { timer, deadline, remaining, ... }

function containerOf(doc) {
  return doc.getElementById(CONTAINER_ID);
}

export const WhimsyToast = {
  ACTION_TIMEOUT_MS,
  PLAIN_TIMEOUT_MS,

  /** The Whimsy toast showing in `win`, if any. */
  current(win) {
    return containerOf(win.document)?.querySelector(":scope > .whimsy-toast:not([leaving])") ?? null;
  },

  /** "⌘Z" on macOS, "Ctrl+Z" elsewhere. */
  undoKeys() {
    return AppConstants.platform == "macosx" ? "⌘Z" : "Ctrl+Z";
  },

  /**
   * Shows a toast, replacing any Whimsy toast already showing.
   *
   * @param {Window} win
   * @param {object} o
   * @param {string} o.l10nId - the message
   * @param {object} [o.l10nArgs]
   * @param {string} [o.detail] - plain text second line (cropped)
   * @param {string} [o.detailL10nId] - a Fluent second line instead
   * @param {object} [o.detailArgs]
   * @param {string} [o.icon] - a chrome:// icon before the text (16px)
   * @param {Element} [o.browser] - the tab the toast is about: it goes
   *   (at once) when you switch away from that tab or it navigates
   * @param {object} [o.action] - { id, l10nId, keys, ariaKeys, onCommand };
   *   onCommand may return "keep" to keep the toast (it then usually
   *   update()s itself into a busy state)
   * @param {number} [o.timeout] - ms; 0 = until dismissed (busy states)
   * @returns {Element|null} the toast; toast.update(changes) changes it
   *   in place (see update())
   */
  show(win, o) {
    const doc = win.document;
    const container = containerOf(doc);
    if (!container) {
      return null;
    }
    const old = this.current(win);
    if (old) {
      this._dismissNow(old);
    }

    const toast = doc.createElementNS(HTML_NS, "div");
    toast.className = "whimsy-toast";
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");
    toast.setAttribute("aria-atomic", "true");
    toast._messageId = o.l10nId;

    if (o.icon) {
      const icon = doc.createElementNS(HTML_NS, "img");
      icon.className = "whimsy-toast-icon";
      icon.setAttribute("alt", "");
      icon.src = o.icon;
      toast.append(icon);
    }

    const text = doc.createElementNS(HTML_NS, "div");
    text.className = "whimsy-toast-text";
    const message = doc.createElementNS(HTML_NS, "span");
    message.className = "whimsy-toast-message";
    doc.l10n.setAttributes(message, o.l10nId, o.l10nArgs ?? undefined);
    text.append(message);
    toast.append(text);
    this._setDetail(toast, o);

    const timeout = o.timeout ?? (o.action ? ACTION_TIMEOUT_MS : PLAIN_TIMEOUT_MS);
    const s = { win, timeout, timer: null, deadline: 0, remaining: timeout, hovered: false, focused: false, busy: false };
    state.set(toast, s);
    if (o.action) {
      this._setAction(toast, o.action);
    }
    toast.update = changes => this.update(toast, changes);

    toast.addEventListener("mouseenter", () => {
      s.hovered = true;
      this._pause(toast);
    });
    toast.addEventListener("mouseleave", () => {
      s.hovered = false;
      this._resume(toast);
    });
    toast.addEventListener("focusin", () => {
      s.focused = true;
      this._pause(toast);
    });
    toast.addEventListener("focusout", event => {
      if (!toast.contains(event.relatedTarget)) {
        s.focused = false;
        this._resume(toast);
      }
    });
    toast.addEventListener("keydown", event => {
      if (event.key == "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.dismiss(toast);
      }
    });
    // Nobody reads a toast in a window that's in the background.
    const onDeactivate = () => this._pause(toast);
    const onActivate = () => this._resume(toast);
    win.addEventListener("deactivate", onDeactivate);
    win.addEventListener("activate", onActivate);
    // A toast about one tab (a dead page's offer) belongs to that tab: it
    // goes at once when you switch away or the tab navigates.
    let removeOwner = () => {};
    if (o.browser && win.gBrowser) {
      const browser = o.browser;
      toast._browser = browser;
      const onTabSelect = () => {
        if (win.gBrowser.selectedBrowser != browser) {
          this._dismissNow(toast);
        }
      };
      const listener = {
        onLocationChange: (b, progress, request, location, flags) => {
          if (b == browser && progress?.isTopLevel &&
            !(flags & Ci.nsIWebProgressListener.LOCATION_CHANGE_SAME_DOCUMENT)) {
            this._dismissNow(toast);
          }
        },
      };
      win.gBrowser.tabContainer.addEventListener("TabSelect", onTabSelect);
      win.gBrowser.addTabsProgressListener(listener);
      removeOwner = () => {
        win.gBrowser.tabContainer.removeEventListener("TabSelect", onTabSelect);
        win.gBrowser.removeTabsProgressListener(listener);
      };
    }
    s.cleanup = () => {
      win.removeEventListener("deactivate", onDeactivate);
      win.removeEventListener("activate", onActivate);
      removeOwner();
    };

    container.removeAttribute("hidden");
    container.append(toast);
    if (doc.hasFocus?.() === false) {
      this._pause(toast);
    } else {
      this._schedule(toast, timeout);
    }
    return toast;
  },

  _setDetail(toast, o) {
    const doc = toast.ownerDocument;
    const text = toast.querySelector(".whimsy-toast-text");
    let detail = text.querySelector(".whimsy-toast-detail");
    if (!o.detail && !o.detailL10nId) {
      detail?.remove();
      return;
    }
    if (!detail) {
      detail = doc.createElementNS(HTML_NS, "span");
      detail.className = "whimsy-toast-detail";
      text.append(detail);
    }
    if (o.detailL10nId) {
      doc.l10n.setAttributes(detail, o.detailL10nId, o.detailArgs ?? undefined);
      detail.removeAttribute("title");
      // Our own sentence: wraps to a second line rather than being cut.
      detail.setAttribute("wrap", "true");
    } else {
      detail.removeAttribute("data-l10n-id");
      detail.removeAttribute("data-l10n-args");
      detail.removeAttribute("wrap");
      detail.textContent = o.detail;
      detail.title = o.detail; // cropped to one line; the whole title on hover
    }
  },

  _setAction(toast, action) {
    const doc = toast.ownerDocument;
    let button = toast.querySelector(".whimsy-toast-action");
    if (!action) {
      button?.remove();
      return;
    }
    if (!button) {
      button = doc.createElementNS(HTML_NS, "button");
      button.type = "button";
      button.className = "whimsy-toast-action";
      button.addEventListener("click", event => {
        event.stopPropagation();
        const s = state.get(toast);
        if (!s || s.busy) {
          return;
        }
        const result = button._action?.onCommand?.(event);
        if (result !== "keep") {
          this.dismiss(toast);
        }
      });
      toast.append(button);
    }
    button._action = action;
    button.replaceChildren();
    button.removeAttribute("aria-keyshortcuts");
    if (action.id) {
      const other = doc.getElementById(action.id);
      if (other && other != button) {
        other.removeAttribute("id");
      }
      button.id = action.id;
    }
    const spinner = doc.createElementNS(HTML_NS, "span");
    spinner.className = "whimsy-toast-spinner";
    spinner.setAttribute("aria-hidden", "true");
    const label = doc.createElementNS(HTML_NS, "span");
    label.className = "whimsy-toast-action-label";
    doc.l10n.setAttributes(label, action.l10nId, action.l10nArgs ?? undefined);
    button.append(spinner, label);
    if (action.keys) {
      const keys = doc.createElementNS(HTML_NS, "kbd");
      keys.className = "whimsy-toast-keys";
      keys.setAttribute("aria-hidden", "true");
      keys.textContent = action.keys;
      button.append(keys);
    }
    if (action.ariaKeys) {
      button.setAttribute("aria-keyshortcuts", action.ariaKeys);
    }
  },

  /**
   * Changes a toast in place, without animating it again.
   *
   * @param {Element} toast
   * @param {object} c - any of: l10nId, l10nArgs, detail, detailL10nId,
   *   detailArgs, action (null removes it), busy, timeout
   *   busy: true disables the action and puts a small spinner in it, and
   *   holds the toast until the next update.
   */
  update(toast, c = {}) {
    const s = state.get(toast);
    if (!s || !toast.isConnected) {
      return;
    }
    const doc = toast.ownerDocument;
    if (c.l10nId) {
      toast._messageId = c.l10nId;
      doc.l10n.setAttributes(toast.querySelector(".whimsy-toast-message"), c.l10nId, c.l10nArgs ?? undefined);
    }
    if ("detail" in c || "detailL10nId" in c) {
      this._setDetail(toast, c);
    }
    if ("action" in c) {
      this._setAction(toast, c.action);
    }
    if ("busy" in c) {
      s.busy = !!c.busy;
      toast.toggleAttribute("busy", s.busy);
      toast.setAttribute("aria-busy", s.busy ? "true" : "false");
      const button = toast.querySelector(".whimsy-toast-action");
      if (button) {
        button.disabled = s.busy;
      }
    }
    if (s.busy) {
      s.win.clearTimeout(s.timer);
      s.timeout = 0;
      return;
    }
    if ("timeout" in c || "busy" in c) {
      const ms = c.timeout ?? (toast.querySelector(".whimsy-toast-action") ? ACTION_TIMEOUT_MS : PLAIN_TIMEOUT_MS);
      s.timeout = ms;
      if (!s.paused) {
        this._schedule(toast, ms);
      } else {
        s.remaining = ms;
      }
    }
  },

  /** Hides a toast with its exit motion, then removes it. */
  dismiss(toast) {
    const s = state.get(toast);
    if (!toast?.isConnected || toast.hasAttribute("leaving")) {
      return;
    }
    if (s) {
      s.win.clearTimeout(s.timer);
      s.cleanup?.();
    }
    const win = toast.ownerDocument.defaultView; // ownerGlobal is gone for modules (Gecko 159)
    // Keyboard focus in a vanishing toast would be lost; hand it back to
    // the page.
    const hadFocus = toast.contains(toast.ownerDocument.activeElement);
    toast.setAttribute("leaving", "true");
    let done = false;
    const finish = () => {
      if (done) {
        return;
      }
      done = true;
      this._remove(toast);
    };
    toast.addEventListener("transitionend", event => event.propertyName == "opacity" && finish());
    win.setTimeout(finish, EXIT_FALLBACK_MS);
    if (hadFocus) {
      win.gBrowser?.selectedBrowser?.focus();
    }
  },

  _dismissNow(toast) {
    const s = state.get(toast);
    if (s) {
      s.win.clearTimeout(s.timer);
      s.cleanup?.();
    }
    this._remove(toast);
  },

  _remove(toast) {
    const container = toast.parentNode;
    toast.remove();
    state.delete(toast);
    if (container && !container.children.length) {
      container.setAttribute("hidden", "true");
    }
  },

  _schedule(toast, ms) {
    const s = state.get(toast);
    if (!s) {
      return;
    }
    s.win.clearTimeout(s.timer);
    s.remaining = ms;
    s.deadline = Date.now() + ms;
    s.paused = false;
    // 0: until dismissed (or updated); busy: until the work answers.
    if (!ms || s.busy || Services.prefs.getBoolPref("ui.popup.disable_autohide", false)) {
      return;
    }
    s.timer = s.win.setTimeout(() => this.dismiss(toast), ms);
  },

  _pause(toast) {
    const s = state.get(toast);
    if (!s || s.paused) {
      return;
    }
    s.win.clearTimeout(s.timer);
    s.remaining = Math.max(0, s.deadline - Date.now());
    s.paused = true;
    toast.setAttribute("paused", "true");
  },

  _resume(toast) {
    const s = state.get(toast);
    if (!s || !s.paused || s.hovered || s.focused || !toast.isConnected) {
      return;
    }
    if (toast.ownerDocument.hasFocus?.() === false) {
      return;
    }
    toast.removeAttribute("paused");
    this._schedule(toast, s.timeout ? Math.max(s.remaining, RESUME_MIN_MS) : 0);
  },

  /** Whether `toast` is waiting (hovered, focused, window in background). */
  isPaused(toast) {
    return !!state.get(toast)?.paused;
  },
};
