/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave7/focus: paste guard, the sheet (see WhimsyPasteGuard.sys.mjs).
// A small Whimsy sheet hangs off the field: "This looks like an OpenAI API
// key" / "Paste into example.com?", a line on why, and Paste / Cancel.
// Cancel is the default and has the keyboard, so Return, Esc or a click
// anywhere else all keep the secret out. The parent only ever hears the
// kind of secret and the page's host.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyPanels: "resource:///modules/whimsy/WhimsyPanels.sys.mjs",
});

const PANEL_ID = "whimsy-paste-guard";
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

      const { panel, body, footer } = lazy.WhimsyPanels.create(win, {
        id: PANEL_ID,
        size: "medium",
        titleL10nId: "whimsy-paste-guard-title",
        titleArgs: { kind },
        subtitleL10nId: host ? "whimsy-paste-guard-subtitle" : "whimsy-paste-guard-subtitle-page",
        subtitleArgs: host ? { host } : null,
        footer: true,
        onHidden: () => {
          // Back to the field, so the paste (or the next keystroke) lands
          // where the person was typing.
          if (browser.isConnected && win.gBrowser.selectedBrowser == browser) {
            browser.focus();
          }
          finish(answer);
        },
      });
      panel.classList.add("whimsy-paste-guard");
      this.panel = panel;
      panel.setAttribute("aria-describedby", `${PANEL_ID}-note`);

      const note = doc.createXULElement("description");
      note.id = `${PANEL_ID}-note`;
      note.className = "whimsy-paste-guard-note";
      doc.l10n.setAttributes(note, "whimsy-paste-guard-note");
      body.append(note);

      const pasteButton = lazy.WhimsyPanels.footerButton(doc, {
        l10nId: "whimsy-paste-guard-paste",
        onCommand: () => {
          answer = true;
          lazy.WhimsyPanels.close(panel);
        },
      });
      const cancelButton = lazy.WhimsyPanels.footerButton(doc, {
        l10nId: "whimsy-paste-guard-cancel",
        primary: true,
        onCommand: () => lazy.WhimsyPanels.close(panel),
      });
      // The default on the trailing edge, as in a macOS alert.
      footer.append(pasteButton, cancelButton);
      // After WhimsyPanels' own popupshown (which focuses the close
      // button when the body has no rows): Cancel has the keyboard.
      panel.addEventListener("popupshown", () => cancelButton.focus(), { once: true });

      if (rect && [rect.left, rect.top, rect.width, rect.height].every(Number.isFinite)) {
        panel.openPopupAtScreenRect("after_start", rect.left, rect.top, rect.width, rect.height, false, false);
      } else {
        lazy.WhimsyPanels.open(win, panel);
      }
    });
  }

  didDestroy() {
    // The page went away mid-question: its sheet has nothing to paste into.
    if (this.panel?.isConnected) {
      lazy.WhimsyPanels.close(this.panel);
    }
    this.panel = null;
  }
}
