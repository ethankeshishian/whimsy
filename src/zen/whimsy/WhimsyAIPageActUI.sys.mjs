/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W23 page-act: the one chat card the page-act features post (Draft reply,
// Form fill, Compare, tab requests). Every word is a Fluent id; text a
// model or a page wrote (a draft, a quote, a store's name) only ever goes in
// as textContent. Buttons call the owner's handler; a picked choice dims the
// rest so a card can't be answered twice.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyAIStore: "resource:///modules/whimsy/WhimsyAIStore.sys.mjs",
  WhimsyChat: "resource:///modules/whimsy/WhimsyChat.sys.mjs",
  WhimsyChatPanel: "resource:///modules/whimsy/WhimsyChatPanel.sys.mjs",
});

const SHEET = "chrome://browser/content/whimsy/whimsy-page-act.css";
const CARD = "page-act";
const owners = new Map();
let registered = false;

function h(doc, tag, attrs = {}, ...children) {
  const el = doc.createElementNS("http://www.w3.org/1999/xhtml", tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) {
      continue;
    }
    if (key == "l10n") {
      const [id, args] = Array.isArray(value) ? value : [value];
      doc.l10n.setAttributes(el, id, args ?? undefined);
    } else if (key.startsWith("on")) {
      el.addEventListener(key.slice(2), value);
    } else {
      el.setAttribute(key, value === true ? "" : value);
    }
  }
  for (const child of children.flat()) {
    if (child != null && child !== false) {
      el.append(child);
    }
  }
  return el;
}

function text(doc, value, cls) {
  const el = h(doc, "div", { class: cls });
  el.textContent = String(value ?? "");
  return el;
}

function line(doc, entry) {
  if (!entry) {
    return null;
  }
  const [id, args] = Array.isArray(entry) ? entry : [entry];
  return h(doc, "p", { class: "whimsy-pa-line", l10n: [id, args] });
}

function steps(doc, list) {
  return h(
    doc,
    "div",
    { class: "whimsy-pa-steps", role: "list" },
    list.map(step => {
      const label = text(doc, step.label, "whimsy-pa-step-label");
      const note = step.note ? h(doc, "small", { l10n: step.note }) : h(doc, "small");
      return h(doc, "div", { class: "whimsy-pa-step", role: "listitem", "data-state": step.state ?? "wait" }, h(doc, "span", { class: "whimsy-pa-step-mark", "aria-hidden": "true" }), label, note);
    })
  );
}

function table(doc, data) {
  const head = h(doc, "tr", {}, data.columns.map(id => h(doc, "th", { scope: "col", l10n: id })));
  const rows = data.rows.map(row =>
    h(
      doc,
      "tr",
      { class: row.best ? "is-best" : null, "data-store": row.key ?? null },
      row.cells.map((cell, i) => {
        const td = h(doc, "td", { class: cell.off ? "is-off" : null });
        const main = cell.l10n ? h(doc, i == 0 ? "b" : "span", { l10n: cell.l10n }) : h(doc, i == 0 || cell.strong ? "b" : "span");
        if (!cell.l10n) {
          main.textContent = String(cell.text ?? "");
        }
        if (i == 0 && cell.url) {
          const link = h(doc, "a", {
            href: cell.url,
            class: "whimsy-pa-store",
            onclick: event => {
              event.preventDefault();
              if (/^https:/.test(cell.url)) {
                doc.defaultView.openTrustedLinkIn(cell.url, "tab");
              }
            },
          });
          link.append(main);
          td.append(link);
        } else {
          td.append(main);
        }
        if (cell.small) {
          const small = h(doc, "small", cell.small.l10n ? { l10n: cell.small.l10n } : {});
          if (!cell.small.l10n) {
            small.textContent = String(cell.small.text ?? "");
          }
          td.append(small);
        }
        return td;
      })
    )
  );
  return h(doc, "table", { class: "whimsy-pa-table" }, head, rows);
}

export const WhimsyAIPageActUI = {
  CARD,

  /** owner: {id, onButton(win, msg, buttonId, ctx)}. */
  registerOwner(owner) {
    owners.set(owner.id, owner);
    this.ensureCard();
  },

  ensureCard() {
    if (registered) {
      return;
    }
    registered = true;
    lazy.WhimsyChat.registerCard(CARD, (doc, msg, ctx) => this.render(doc, msg, ctx));
  },

  loadSheet(win) {
    const doc = win.document;
    if (doc.querySelector(`link[href="${SHEET}"]`)) {
      return;
    }
    const link = doc.createElementNS("http://www.w3.org/1999/xhtml", "link");
    link.rel = "stylesheet";
    link.href = SHEET;
    doc.documentElement.append(link);
  },

  render(doc, msg, ctx = {}) {
    const node = h(doc, "div", { class: "whimsy-chat-msg whimsy-pa-card", "data-role": "ai", "data-msg-id": msg.id, "data-kind": msg.kind ?? "" });
    if (msg.status) {
      node.append(h(doc, "div", { class: "whimsy-pa-status", role: "status" }, h(doc, "span", { class: "whimsy-pa-spinner", "aria-hidden": "true" }), h(doc, "span", { l10n: msg.status })));
    }
    for (const entry of msg.lines ?? []) {
      node.append(line(doc, entry));
    }
    if (msg.draft) {
      node.append(text(doc, msg.draft, "whimsy-pa-draft"));
    }
    if (msg.steps?.length) {
      node.append(steps(doc, msg.steps));
    }
    if (msg.table) {
      node.append(table(doc, msg.table));
    }
    if (msg.notice) {
      const notice = h(doc, "div", { class: "whimsy-pa-notice", "data-icon": msg.notice.icon ?? "sparkle" });
      notice.append(h(doc, "span", { class: "whimsy-pa-notice-icon", "aria-hidden": "true" }));
      const body = h(doc, "div", { class: "whimsy-pa-notice-body" });
      if (msg.notice.l10n) {
        body.append(h(doc, "p", { l10n: msg.notice.l10n }));
      }
      if (msg.notice.quote) {
        body.append(text(doc, msg.notice.quote, "whimsy-pa-quote"));
      }
      notice.append(body);
      node.append(notice);
    }
    const buttons = msg.buttons ?? [];
    if (buttons.length) {
      const row = h(doc, "div", { class: "whimsy-pa-buttons" });
      for (const b of buttons) {
        const picked = msg.picked != null;
        const button = h(doc, "button", {
          class: `whimsy-pa-btn${b.primary ? " primary" : ""}`,
          "data-button": b.id,
          disabled: picked && msg.picked != b.id ? true : null,
          "aria-pressed": picked && msg.picked == b.id ? "true" : null,
          l10n: b.l10n,
          onclick: () => this.press(ctx.win ?? doc.defaultView, msg, b.id, ctx),
        });
        row.append(button);
      }
      node.append(row);
    }
    if (msg.meta) {
      node.append(h(doc, "p", { class: "whimsy-pa-meta", l10n: msg.meta }));
    }
    return node;
  },

  press(win, msg, buttonId, ctx) {
    const owner = owners.get(msg.owner);
    Promise.resolve()
      .then(() => owner?.onButton(win, msg, buttonId, ctx))
      .catch(e => console.error(`Whimsy page-act: ${msg.owner} ${buttonId}`, e));
  },

  /** Appends a card to the thread and shows it when the thread is open. */
  async post(panel, threadId, card) {
    const saved = await lazy.WhimsyAIStore.append(threadId, { role: "card", card: CARD, ...card });
    this.show(panel, threadId, saved);
    return saved;
  },

  async patch(panel, threadId, msgId, patch) {
    const saved = await lazy.WhimsyAIStore.updateMessage(threadId, msgId, patch);
    if (saved) {
      this.show(panel, threadId, saved);
    }
    return saved;
  },

  show(panel, threadId, msg) {
    if (!panel?.body || panel.thread?.id != threadId) {
      return;
    }
    const fresh = panel.renderMessage(msg);
    if (!fresh) {
      return;
    }
    const old = panel.body.querySelector(`[data-msg-id="${CSS.escape(msg.id)}"]`);
    if (old) {
      old.replaceWith(fresh);
    } else {
      panel.body.querySelector(".whimsy-chat-empty")?.remove();
      panel.body.append(fresh);
    }
    panel.doc.l10n.translateFragment(fresh).catch(() => {});
    fresh.scrollIntoView?.({ block: "nearest" });
  },

  /** The open chat panel of a window, or null. */
  panelOf(win) {
    return win?.gBrowser ? lazy.WhimsyChatPanel.forWindow(win) : null;
  },
};
