/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave7/focus: paste guard, the page's side (see WhimsyPasteGuard.sys.mjs).
// Listens to trusted paste events in the capture phase of the default group
// on the chrome event target, the first stop of the event path: before any
// page listener (even a capturing one on window) and before the editor
// inserts anything. Not the system group, which runs after the page. A
// held paste never reaches the page, so editors that handle paste
// themselves (ProseMirror, Slack, Docs) are covered too. Only when
// the text looks like a secret does it hold the paste and ask the parent;
// "Paste" then runs the paste again (cmd_paste), letting that one through.
// The clipboard text never leaves this function: it's read, tested and
// dropped.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  detectSecret: "resource:///modules/whimsy/WhimsyPasteGuard.sys.mjs",
  isHome: "resource:///modules/whimsy/WhimsyPasteGuard.sys.mjs",
  MAX_LENGTH: "resource:///modules/whimsy/WhimsyPasteGuard.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.paste-guard";
const ENABLED_PREF = "whimsy.paste-guard.enabled";
// How long an approved paste may take to arrive again.
const ALLOW_MS = 1500;
// Taller fields (a chat composer, a whole editable page) anchor the sheet
// at the caret instead of their bottom edge.
const TALL_PX = 120;

const CARD_FIELD = /card.?num|cc.?num|cc-?number|credit.?card|cardnumber/i;

function editableTarget(event) {
  let el = event.composedTarget ?? event.target;
  if (el && el.nodeType != 1) {
    el = el.parentElement;
  }
  if (!el) {
    return null;
  }
  const name = el.localName;
  if (name == "input" || name == "textarea") {
    return el.readOnly || el.disabled ? null : el;
  }
  if (el.isContentEditable || el.ownerDocument?.designMode == "on") {
    return el;
  }
  return null;
}

function isPasswordField(el) {
  return el.localName == "input" && (el.type == "password" || !!el.hasBeenTypePassword);
}

function isCardField(el) {
  if (el.localName != "input") {
    return false;
  }
  const autocomplete = (el.getAttribute("autocomplete") ?? "").toLowerCase();
  if (autocomplete.split(/\s+/).includes("cc-number")) {
    return true;
  }
  return [el.name, el.id, el.getAttribute("aria-label"), el.placeholder].some(v => v && CARD_FIELD.test(v));
}

export class WhimsyPasteGuardChild extends JSWindowActorChild {
  // { until, kind } after "Paste": the next paste of that kind goes through.
  allowed = null;

  handleEvent(event) {
    if (event.type != "paste" || !event.isTrusted) {
      return;
    }
    if (!Services.prefs.getBoolPref(FEATURE_PREF, true) || !Services.prefs.getBoolPref(ENABLED_PREF, true)) {
      return;
    }
    const target = editableTarget(event);
    const data = event.clipboardData;
    if (!target || !data) {
      return;
    }
    let kind = null;
    {
      // Scoped so the text can't outlive the check.
      const text = data.getData("text/plain");
      if (!text || text.length > lazy.MAX_LENGTH) {
        return;
      }
      kind = lazy.detectSecret(text);
    }
    if (!kind) {
      return;
    }
    const allowed = this.allowed;
    this.allowed = null;
    if (allowed && allowed.kind == kind && Date.now() < allowed.until) {
      return;
    }
    const host = this.document?.location?.hostname ?? "";
    if (isPasswordField(target) && lazy.isHome(kind, host)) {
      return;
    }
    if (kind == "card" && isCardField(target)) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    this.ask(target, kind, host);
  }

  // The field's place on screen, in CSS pixels: its box, or for a tall
  // field the caret line.
  anchorRect(target) {
    const win = this.contentWindow;
    try {
      const rect = win.windowUtils.getElementBoundingScreenRect(target);
      if (rect.height <= TALL_PX) {
        return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
      }
      const selection = win.getSelection();
      const caret = selection?.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : null;
      if (caret && (caret.width || caret.height)) {
        const screen = win.windowUtils.toScreenRectInCSSUnits(caret.left, caret.top, Math.max(caret.width, 1), caret.height);
        return { left: screen.left, top: screen.top, width: screen.width, height: screen.height };
      }
      return { left: rect.left, top: rect.top, width: rect.width, height: Math.min(rect.height, 32) };
    } catch (e) {
      return null;
    }
  }

  async ask(target, kind, host) {
    let answer = null;
    try {
      answer = await this.sendQuery("WhimsyPasteGuard:Ask", {
        kind,
        host,
        rect: this.anchorRect(target),
      });
    } catch (e) {
      // The tab went away; nothing to paste into.
      return;
    }
    if (!answer?.paste || !target.isConnected) {
      return;
    }
    this.allowed = { kind, until: Date.now() + ALLOW_MS };
    try {
      if (target.ownerDocument.activeElement != target && typeof target.focus == "function") {
        target.focus();
      }
      this.docShell.doCommand("cmd_paste");
    } catch (e) {
      this.allowed = null;
      console.error("Whimsy: paste guard couldn't paste");
    }
  }
}
