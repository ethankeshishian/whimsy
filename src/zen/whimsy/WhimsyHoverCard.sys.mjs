/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Hover cards (Arc parity). Arc shows a small card when you rest the pointer
// on a tab (title, address, a preview of the page), on a profile link (who
// the person is) and on a history entry. Tabs reuse Firefox's own tab hover
// preview (browser.tabs.hoverPreview.*, which Zen ships off and Whimsy turns
// on through overlay.py PREF_OVERRIDES): it already handles unloaded and
// private tabs, the vertical sidebar and its own thumbnails. This module is
// the one shared card for everything else: History rows in Zen's Library
// (whimsy.feature.history-preview) and People cards (WhimsyPeople*.sys.mjs).
//
// The pattern is Zen's folder hover-search (ZenFolders.mjs): an enter delay,
// then a short grace period on leave so moving into the card keeps it open.
// History only shows a thumbnail Firefox already saved (PageThumbs); it never
// loads or captures a page, so most entries get a text card.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  PageThumbs: "resource://gre/modules/PageThumbs.sys.mjs",
  PageThumbsStorage: "resource://gre/modules/PageThumbs.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
});

const HTML = "http://www.w3.org/1999/xhtml";
const HISTORY_PREF = "whimsy.feature.history-preview";
const ENTER_DELAY_MS = 600;
const LEAVE_GRACE_MS = 180;
const cards = new WeakMap();

export const WhimsyHoverCard = {
  ENTER_DELAY_MS,

  forWindow(win) {
    let card = cards.get(win);
    if (!card) {
      card = new HoverCard(win);
      cards.set(win, card);
    }
    return card;
  },

  // History rows: ZenLibraryHistorySection's row carries its visit as
  // `whimsyVisit` (a one-line overlay.py hook), so the card never guesses
  // which visit a row is from its position.
  initWindow(win) {
    const card = this.forWindow(win);
    const rowFor = target => target?.closest?.("[data-section='history'] .zen-library-row");
    const over = event => {
      const row = rowFor(event.target);
      if (!row || row.contains(event.relatedTarget)) {
        return;
      }
      const visit = row.whimsyVisit;
      if (
        !visit?.url ||
        !/^https?:\/\//i.test(visit.url) ||
        !Services.prefs.getBoolPref(HISTORY_PREF, true) ||
        lazy.PrivateBrowsingUtils.isWindowPrivate(win)
      ) {
        return;
      }
      card.schedule(
        row,
        async () => ({
          title: visit.title || visit.url,
          url: visit.url,
          image: await this.cachedThumbnail(visit.url),
          emptyImageL10nId: "whimsy-hover-no-preview",
        }),
        HISTORY_PREF
      );
    };
    const out = event => {
      const row = rowFor(event.target);
      if (row && !row.contains(event.relatedTarget)) {
        card.leave(row);
      }
    };
    win.document.addEventListener("mouseover", over);
    win.document.addEventListener("mouseout", out);
  },

  async cachedThumbnail(url) {
    try {
      return (await lazy.PageThumbsStorage.fileExistsForURL(url))
        ? lazy.PageThumbs.getThumbnailURL(url)
        : null;
    } catch {
      return null;
    }
  },
};

class HoverCard {
  constructor(win) {
    this.win = win;
    this.generation = 0;
    this.onDismiss = () => this.hide();
    win.addEventListener("keydown", this.onDismiss, true);
    win.addEventListener("TabSelect", this.onDismiss);
    win.addEventListener("blur", this.onDismiss);
    win.addEventListener("scroll", this.onDismiss, true);
    win.addEventListener("unload", () => this.destroy(), { once: true });
  }

  // Shows the card for `anchor` after the enter delay. `load` resolves to
  // the card's data (or null for no card); `pref` is the feature switch,
  // checked again after loading so turning it off mid-hover wins.
  schedule(anchor, load, pref) {
    this.hide();
    this.anchor = anchor;
    const generation = this.generation;
    this.timer = this.win.setTimeout(async () => {
      try {
        if (!Services.prefs.getBoolPref(pref, true)) {
          return;
        }
        const data = await load();
        if (
          data &&
          generation === this.generation &&
          !this.win.closed &&
          (anchor.isConnected ?? true) &&
          Services.prefs.getBoolPref(pref, true)
        ) {
          this.show(anchor, data);
        }
      } catch (error) {
        console.debug("Whimsy: hover card unavailable", error);
      }
    }, ENTER_DELAY_MS);
  }

  leave(anchor) {
    if (this.anchor !== anchor) {
      return;
    }
    // Cancel a card that hasn't loaded yet; let an open one linger briefly
    // so the pointer can move into it.
    ++this.generation;
    this.win.clearTimeout(this.timer);
    this.win.clearTimeout(this.closeTimer);
    this.closeTimer = this.win.setTimeout(() => {
      if (!this.panel?.matches(":hover")) {
        this.hide();
      }
    }, LEAVE_GRACE_MS);
  }

  #ensurePanel() {
    if (this.panel) {
      return this.panel;
    }
    const doc = this.win.document;
    const panel = doc.createXULElement("panel");
    panel.id = "whimsy-hover-card";
    panel.setAttribute("type", "arrow");
    panel.setAttribute("noautofocus", "true");
    panel.setAttribute("consumeoutsideclicks", "false");
    panel.setAttribute("role", "tooltip");
    panel.addEventListener("mouseenter", () => this.win.clearTimeout(this.closeTimer));
    panel.addEventListener("mouseleave", () => this.hide());
    doc.getElementById("mainPopupSet").append(panel);
    this.panel = panel;
    return panel;
  }

  // Everything remote is set as text or an <img> src, never as markup.
  show(anchor, { title, url, image, avatar, description, screen, emptyImageL10nId }) {
    const doc = this.win.document;
    const panel = this.#ensurePanel();
    panel.replaceChildren();
    if (image && /^(?:moz-page-thumb:|https:\/\/)/.test(image)) {
      const img = doc.createElementNS(HTML, "img");
      img.className = avatar ? "whimsy-hover-avatar" : "whimsy-hover-image";
      img.alt = "";
      img.referrerPolicy = "no-referrer";
      img.addEventListener("error", () => img.remove(), { once: true });
      img.src = image;
      panel.append(img);
    } else if (emptyImageL10nId) {
      const empty = doc.createElementNS(HTML, "div");
      empty.className = "whimsy-hover-empty";
      doc.l10n.setAttributes(empty, emptyImageL10nId);
      panel.append(empty);
    }
    for (const [kind, text] of [
      ["title", title],
      ["url", url],
      ["description", description],
    ]) {
      if (text) {
        const el = doc.createElementNS(HTML, "div");
        el.className = `whimsy-hover-${kind}`;
        el.textContent = String(text).slice(0, 500);
        panel.append(el);
      }
    }
    if (screen) {
      panel.openPopupAtScreen(screen.x, screen.y, false);
    } else {
      panel.openPopup(anchor, "after_start", 0, 4, false, false);
    }
  }

  hide() {
    ++this.generation;
    this.win.clearTimeout(this.timer);
    this.win.clearTimeout(this.closeTimer);
    this.anchor = null;
    if (this.panel && this.panel.state != "closed") {
      this.panel.hidePopup();
    }
  }

  destroy() {
    this.hide();
    this.win.removeEventListener("keydown", this.onDismiss, true);
    this.win.removeEventListener("TabSelect", this.onDismiss);
    this.win.removeEventListener("blur", this.onDismiss);
    this.win.removeEventListener("scroll", this.onDismiss, true);
    this.panel?.remove();
    cards.delete(this.win);
  }
}
