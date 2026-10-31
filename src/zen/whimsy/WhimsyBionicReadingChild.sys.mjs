/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Bionic (or "guided") reading: bolds the leading ~50% of each word's
// letters so the eye's natural fixation points land on already-emphasized
// letters. Scoped to about:reader's own content (`.moz-reader-content`),
// not arbitrary pages — mutating arbitrary page DOM on every site is far
// riskier, and the feature's whole premise (long-form reading) already
// lives in reader mode. Opt-in, off by default (whimsy.reader.bionic):
// some readers find it measurably faster, others find it distracting.
//
// Toggling off fully restores the original text nodes (unwraps every
// <b class="whimsy-bionic-word"> back into plain text and normalizes), so
// a screen reader or Find-in-page never sees injected markup when the
// feature is off, and so toggling is exactly reversible rather than a
// purely visual undo.

const PREF = "whimsy.reader.bionic";
const WORD_CLASS = "whimsy-bionic-word";
// The portion of each word's leading letters to bold. 0.5 sits in the
// middle of the ~40-60% range the technique is usually described with.
const BOLD_RATIO = 0.5;
const BUTTON_SHEET =
  "data:text/css," +
  encodeURIComponent(`
.whimsy-bionic-button > .whimsy-bionic-glyph {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  font: 700 15px/1 Georgia, serif;
  color: var(--icon-fill);
  pointer-events: none;
}
.whimsy-bionic-button[aria-pressed="true"] {
  background-color: var(--toolbar-button-background-active);
  border-color: var(--toolbar-button-border-active);
}
.whimsy-bionic-button[aria-pressed="true"] > .whimsy-bionic-glyph {
  color: var(--toolbar-button-foreground-active);
}`);
const WORD_RE = /([A-Za-z]+(?:['’][A-Za-z]+)?)|([^A-Za-z]+)/g;

export class WhimsyBionicReadingChild extends JSWindowActorChild {
  handleEvent(event) {
    if (event.type == "AboutReaderContentReady" && Services.prefs.getBoolPref("whimsy.feature.bionic-reading", true)) {
      this.onReady();
    }
  }

  onReady() {
    const content = this.document?.querySelector(".moz-reader-content");
    const toolbar = this.document?.querySelector(".reader-controls");
    if (!content || !toolbar || this._button) {
      return;
    }
    this._content = content;
    this._button = this.document.createElement("button");
    this._button.className = "toolbar-button whimsy-bionic-button";
    this._button.title = "Bionic reading";
    this._button.setAttribute("aria-pressed", "false");
    this._button.addEventListener("click", () => this.toggle());
    // Reader's toolbar buttons draw their icon as a background image chosen
    // by class; this one has none, so it showed as an empty, invisible
    // square. A bold "B" glyph marks it instead.
    const glyph = this.document.createElement("span");
    glyph.className = "whimsy-bionic-glyph";
    glyph.setAttribute("aria-hidden", "true");
    glyph.textContent = "B";
    this._button.append(glyph);
    this._addStyle();
    toolbar.append(this._button);
    this._applyEnabled(this.enabled);
    try {
      this.document.l10n?.addResourceIds(["browser/whimsy.ftl"]);
      this._button.setAttribute("data-l10n-id", "whimsy-bionic-reading-toggle");
      this.document.l10n?.translateFragment(this._button).catch(() => {});
    } catch (e) {
      // No Fluent bundle reachable here: the title attribute already set
      // above is the fallback.
    }
  }

  // about:reader's CSP (default-src chrome:) blocks an inline <style>, so
  // the button's look goes in as an author sheet, as allow-copy does.
  _addStyle() {
    const win = this.contentWindow;
    if (!win || this._styled) {
      return;
    }
    this._styled = true;
    try {
      win.windowUtils.loadSheetUsingURIString(BUTTON_SHEET, win.windowUtils.AUTHOR_SHEET);
    } catch (e) {
      // Already loaded in this document.
    }
  }

  get enabled() {
    try {
      return Services.prefs.getBoolPref(PREF, false);
    } catch (e) {
      return false;
    }
  }

  async toggle() {
    try {
      const on = await this.sendQuery("Whimsy:SetBionic", { on: !this._enabled });
      this._applyEnabled(on);
    } catch (e) {
      console.error("Whimsy: bionic reading toggle failed", e);
    }
  }

  // wave7/keys: the "Turn Bionic Reading On/Off" command saved the choice
  // in the parent; show it on this page.
  receiveMessage(message) {
    if (message.name == "Whimsy:ApplyBionic") {
      this._applyEnabled(!!message.data?.on);
    }
  }

  _applyEnabled(on) {
    this._enabled = on;
    this._button?.setAttribute("aria-pressed", String(on));
    this._button?.classList.toggle("active", on);
    if (on) {
      this._apply();
    } else {
      this._restore();
    }
  }

  _apply() {
    if (!this._content || this._applied) {
      return;
    }
    this._applied = true;
    const doc = this._content.ownerDocument;
    const walker = doc.createTreeWalker(this._content, doc.defaultView.NodeFilter.SHOW_TEXT, {
      acceptNode: node => {
        const parentTag = node.parentNode?.nodeName;
        if (!node.parentNode || parentTag == "SCRIPT" || parentTag == "STYLE") {
          return doc.defaultView.NodeFilter.FILTER_REJECT;
        }
        if (node.parentNode.closest?.(`.${WORD_CLASS}`)) {
          return doc.defaultView.NodeFilter.FILTER_REJECT;
        }
        return /\S/.test(node.nodeValue) ? doc.defaultView.NodeFilter.FILTER_ACCEPT : doc.defaultView.NodeFilter.FILTER_SKIP;
      },
    });
    const nodes = [];
    let node;
    while ((node = walker.nextNode())) {
      nodes.push(node);
    }
    for (const textNode of nodes) {
      this._bionicNode(textNode);
    }
  }

  _bionicNode(node) {
    const text = node.nodeValue;
    const doc = node.ownerDocument;
    const fragment = doc.createDocumentFragment();
    let match;
    let changed = false;
    WORD_RE.lastIndex = 0;
    while ((match = WORD_RE.exec(text))) {
      if (match[1]) {
        const word = match[1];
        const boldLength = Math.max(1, Math.min(word.length, Math.ceil(word.length * BOLD_RATIO)));
        const bold = doc.createElement("b");
        bold.className = WORD_CLASS;
        bold.textContent = word.slice(0, boldLength);
        fragment.append(bold);
        if (boldLength < word.length) {
          fragment.append(doc.createTextNode(word.slice(boldLength)));
        }
        changed = true;
      } else {
        fragment.append(doc.createTextNode(match[2]));
      }
    }
    if (changed) {
      node.replaceWith(fragment);
    }
  }

  _restore() {
    if (!this._content || !this._applied) {
      return;
    }
    this._applied = false;
    for (const word of [...this._content.querySelectorAll(`.${WORD_CLASS}`)]) {
      word.replaceWith(this._content.ownerDocument.createTextNode(word.textContent));
    }
    this._content.normalize();
  }
}
