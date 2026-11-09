/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W23 secfix H1: the pause before a connector tool that may change
// something. Chat and Ask show this card where the answer streams: the
// tool and server, the arguments it will send, and Allow once or Don't
// allow. Claude Code waits on it through the run's permission tool
// (WhimsyConnectors.guard). Nothing is a default button: Return never
// allows, Escape doesn't allow.

const SHEET = "chrome://browser/content/whimsy/whimsy-tool-confirm.css";
const ARGS_CHARS = 1500;
const sheets = new WeakSet();

function el(doc, tag, attrs = {}, ...children) {
  const node = doc.createElementNS("http://www.w3.org/1999/xhtml", tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) {
      continue;
    }
    if (key == "l10n") {
      const [id, args] = Array.isArray(value) ? value : [value];
      doc.l10n.setAttributes(node, id, args);
    } else {
      node.setAttribute(key, value === true ? "" : String(value));
    }
  }
  node.append(...children.flat().filter(c => c !== null && c !== undefined));
  return node;
}

export const WhimsyToolConfirm = {
  /** "create_comment" reads as "Create comment". */
  toolLabel(tool) {
    const words = String(tool ?? "").replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim().toLowerCase();
    return words ? words[0].toUpperCase() + words.slice(1) : "";
  },

  /** The arguments exactly as they'll be sent, as indented JSON. */
  argsText(args) {
    let text;
    try {
      text = JSON.stringify(args ?? {}, null, 2);
    } catch {
      text = String(args);
    }
    return text.length > ARGS_CHARS ? `${text.slice(0, ARGS_CHARS)}\n…` : text;
  },

  loadSheet(win) {
    if (!sheets.has(win)) {
      sheets.add(win);
      win.windowUtils.loadSheetUsingURIString(SHEET, win.windowUtils.AUTHOR_SHEET);
    }
  },

  /**
   * The card. `answer(allowed)` runs once, on a press. `decided` (true or
   * false) draws the one-line record left after the person chose.
   */
  card(doc, { server, tool, args }, answer, { decided = null } = {}) {
    this.loadSheet(doc.defaultView);
    const names = { tool: this.toolLabel(tool), server: String(server ?? "") };
    if (decided !== null) {
      return el(doc, "div", { class: "whimsy-tool-confirm", "data-decided": decided ? "allowed" : "denied", role: "status" },
        el(doc, "span", { class: "whimsy-tool-confirm-icon", "data-ic": decided ? "check" : "close" }),
        el(doc, "span", { class: "whimsy-tool-confirm-done", l10n: [decided ? "whimsy-tool-confirm-allowed" : "whimsy-tool-confirm-denied", names] }));
    }
    let done = false;
    const press = allowed => {
      if (!done) {
        done = true;
        answer(allowed);
      }
    };
    const id = `whimsy-tool-confirm-${Services.uuid.generateUUID().toString().slice(1, 9)}`;
    const allow = el(doc, "button", { class: "whimsy-tool-confirm-btn", "data-choice": "allow", l10n: "whimsy-tool-confirm-allow" });
    const deny = el(doc, "button", { class: "whimsy-tool-confirm-btn", "data-choice": "deny", l10n: "whimsy-tool-confirm-deny" });
    allow.addEventListener("click", () => press(true));
    deny.addEventListener("click", () => press(false));
    const card = el(doc, "section", { class: "whimsy-tool-confirm", role: "group", "aria-labelledby": id, tabindex: "-1" },
      el(doc, "div", { class: "whimsy-tool-confirm-head" },
        el(doc, "span", { class: "whimsy-tool-confirm-icon", "data-ic": "alert" }),
        el(doc, "span", { class: "whimsy-tool-confirm-title", id, l10n: ["whimsy-tool-confirm-title", names] })),
      el(doc, "p", { class: "whimsy-tool-confirm-note", l10n: "whimsy-tool-confirm-note" }),
      el(doc, "pre", { class: "whimsy-tool-confirm-args", dir: "ltr" }, this.argsText(args)),
      el(doc, "div", { class: "whimsy-tool-confirm-actions" }, allow, deny));
    card.addEventListener("keydown", event => {
      if (event.key == "Escape") {
        event.preventDefault();
        event.stopPropagation();
        press(false);
      } else if (event.key == "Enter" && event.target == card) {
        event.preventDefault();
      }
    });
    return card;
  },

  /**
   * Shows the card at the end of `container` and resolves with the
   * person's answer (false when `signal` aborts first). The card turns
   * into its one-line record.
   */
  ask(container, ask, { signal = null } = {}) {
    const doc = container.ownerDocument;
    return new Promise(resolve => {
      let card = null;
      const finish = allowed => {
        signal?.removeEventListener("abort", onAbort);
        if (card?.isConnected) {
          card.replaceWith(this.card(doc, ask, null, { decided: allowed }));
        }
        resolve(allowed);
      };
      const onAbort = () => finish(false);
      if (signal?.aborted) {
        resolve(false);
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      card = this.card(doc, ask, finish);
      container.append(card);
      card.scrollIntoView?.({ block: "nearest" });
      card.focus({ preventScroll: true });
    });
  },
};
