/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave7/focus: paste guard, the prompt (see WhimsyPasteGuard.sys.mjs).
// W10-14 (the user: "the UI was horrible"): a WhimsySurface card that reads
// like a decision. A warning key tile, "This looks like an OpenAI API key"
// / "Paste it into **example.com**?", one plain line on why, and Paste
// Anyway / Don't Paste. It hangs 6px under the field it would paste into,
// or sits over the page where the command bar does when there's no field.
// Don't Paste is the default and has the keyboard, so Return, Esc or a
// click anywhere else all keep the secret out. The parent only ever hears
// the kind of secret and the page's host.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsySurface: "resource:///modules/whimsy/WhimsySurface.sys.mjs",
});

const PANEL_ID = "whimsy-paste-guard";
const PANEL_WIDTH = 360;
const HTML_NS = "http://www.w3.org/1999/xhtml";
const FIELD_GAP = 6;

// Fluent can't crop: long hosts keep their start and end.
export function cropHost(host) {
  return host.length > 34 ? `${host.slice(0, 16)}…${host.slice(-16)}` : host;
}
const KINDS = new Set([
  "private-key",
  "anthropic",
  "openai",
  "github",
  "aws",
  "slack",
  "stripe",
  "google",
  "jwt",
  "card",
]);

// The question open in each window, so a second paste answers the first
// with Cancel instead of leaving it waiting.
const pending = new WeakMap();

export class WhimsyPasteGuardParent extends JSWindowActorParent {
  async receiveMessage(message) {
    if (message.name != "WhimsyPasteGuard:Ask") {
      return null;
    }
    const browser = this.browsingContext.top.embedderElement;
    // ownerGlobal isn't defined on elements seen from a module.
    const win = browser?.ownerDocument?.defaultView;
    if (!win || win.closed || !win.gBrowser) {
      return { paste: false };
    }
    const { kind, host, rect } = message.data ?? {};
    const paste = await this.ask(win, browser, {
      kind: KINDS.has(kind) ? kind : "other",
      host: typeof host == "string" ? host.slice(0, 253) : "",
      rect,
    });
    return { paste };
  }

  ask(win, browser, { kind, host, rect }) {
    pending.get(win)?.(false);
    const doc = win.document;
    return new Promise(resolve => {
      let answer = false;
      const finish = value => {
        if (pending.get(win) == finish) {
          pending.delete(win);
        }
        resolve(value);
      };
      pending.set(win, finish);

      const parts = lazy.WhimsySurface.create(win, {
        id: PANEL_ID,
        width: PANEL_WIDTH,
        footer: true,
        className: "whimsy-paste-guard",
        initialFocus: () => cancelButton,
        onHidden: () => {
          // Back to the field, so the paste (or the next keystroke) lands
          // where the person was typing.
          if (browser.isConnected && win.gBrowser.selectedBrowser == browser) {
            browser.focus();
          }
          finish(answer);
        },
      });
      const { panel, view, footer } = parts;
      this.panel = panel;

      const head = doc.createXULElement("hbox");
      head.className = "whimsy-paste-guard-head";
      head.setAttribute("align", "start");
      const tile = lazy.WhimsySurface.tile(doc, {
        icon: "chrome://browser/skin/zen-icons/selectable/key.svg",
        tone: "warning",
      });
      // What Whimsy did with it, for whoever wonders: on the key's tooltip.
      tile.removeAttribute("aria-hidden");
      doc.l10n.setAttributes(tile, "whimsy-paste-guard-privacy");
      const text = doc.createXULElement("vbox");
      text.className = "whimsy-paste-guard-text";
      text.setAttribute("flex", "1");
      const title = doc.createElementNS(HTML_NS, "h1");
      title.id = `${PANEL_ID}-title`;
      title.className = "whimsy-surface-title whimsy-paste-guard-title";
      doc.l10n.setAttributes(title, "whimsy-paste-guard-title", { kind });
      const where = doc.createElementNS(HTML_NS, "p");
      where.className = "whimsy-paste-guard-where";
      if (host) {
        doc.l10n.setAttributes(where, "whimsy-paste-guard-where", { host: cropHost(host) });
        where.title = host;
      } else {
        doc.l10n.setAttributes(where, "whimsy-paste-guard-where-page");
      }
      text.append(title, where);
      head.append(tile, text);

      const note = doc.createElementNS(HTML_NS, "p");
      note.id = `${PANEL_ID}-note`;
      note.className = "whimsy-paste-guard-note";
      doc.l10n.setAttributes(note, "whimsy-paste-guard-note");
      view.append(head, note);
      panel.setAttribute("aria-labelledby", title.id);
      panel.setAttribute("aria-describedby", note.id);

      const pasteButton = lazy.WhimsySurface.footerButton(doc, {
        l10nId: "whimsy-paste-guard-paste",
        onCommand: () => {
          answer = true;
          lazy.WhimsySurface.close(panel);
        },
      });
      pasteButton.id = `${PANEL_ID}-paste`;
      const cancelButton = lazy.WhimsySurface.footerButton(doc, {
        l10nId: "whimsy-paste-guard-cancel",
        primary: true,
        onCommand: () => lazy.WhimsySurface.close(panel),
      });
      cancelButton.id = `${PANEL_ID}-cancel`;
      // The default on the trailing edge, as in a macOS alert.
      footer.append(pasteButton, cancelButton);
      lazy.WhimsySurface.finish(parts);

      if (rect && [rect.left, rect.top, rect.width, rect.height].every(Number.isFinite)) {
        lazy.WhimsySurface.open(win, panel, { screenRect: rect, position: "after_start", gap: FIELD_GAP });
      } else {
        lazy.WhimsySurface.open(win, panel, { at: "page-top-center" });
      }
    });
  }

  didDestroy() {
    // The page went away mid-question: its sheet has nothing to paste into.
    if (this.panel?.isConnected) {
      lazy.WhimsySurface.close(this.panel);
    }
    this.panel = null;
  }
}
