/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave7/ux: one hover host for links in pages (review HIG 13, user's call:
// "Do either people or link preview. If AI is enabled, then show the AI
// preview under. So two floating cards, designed well, that don't overlap
// each other", and "those cards should appear and disappear with the same
// timing and animation").
//
// Up to two cards, stacked in one popup so they can never overlap or drift
// apart:
//   1. Who or where: the People card on a profile link (WhimsyPeople), or
//      otherwise the link card (where the link goes). Never both.
//   2. The AI summary (WhimsyAIPage, 5-second previews), only while that
//      feature is on. It opens with card 1, showing its loading lines,
//      and fills in place; it never animates in on its own.
// Both share one width and one gap, open after one delay and leave after
// one grace period, and run one transition: a single attribute on the
// popup starts both cards' transitions in the same style flush. The popup
// opens against the link's box (openPopupAtScreenRect), so layout flips
// the whole stack above the link when there's no room below and it never
// covers the link.
//
// Triggers stay where they were: People cards on any profile link
// (WhimsyPeopleChild); link cards on Shift over a link, or resting on an
// outbound link on search results, X, Threads and Hacker News
// (WhimsyAIPreviewChild). Tabs keep Firefox's tab hover preview and History
// rows keep WhimsyHoverCard: different surfaces, and opening this host
// closes nothing of theirs. Nothing shows in private tabs.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  WhimsyAIPage: "resource:///modules/whimsy/WhimsyAIPage.sys.mjs",
  buildPersonCard: "resource:///modules/whimsy/WhimsyHoverCard.sys.mjs",
  WhimsyPeople: "resource:///modules/whimsy/WhimsyPeople.sys.mjs",
});

const HTML = "http://www.w3.org/1999/xhtml";
const PANEL_ID = "whimsy-link-hover";
const LINK_CARDS_PREF = "whimsy.feature.link-cards";
const ENTER_DELAY_MS = 500;
const LEAVE_GRACE_MS = 180;
// Space between the link and the stack (the cards' own gap is CSS).
const LINK_GAP_PX = 4;
const OPEN_ATTR = "whimsy-open";
const hosts = new WeakMap();

export const WhimsyLinkHover = {
  ENTER_DELAY_MS,
  LEAVE_GRACE_MS,
  PANEL_ID,

  get linkCardsEnabled() {
    return Services.prefs.getBoolPref(LINK_CARDS_PREF, true);
  },

  forWindow(win) {
    let host = hosts.get(win);
    if (!host) {
      host = new LinkHover(win);
      hosts.set(win, host);
    }
    return host;
  },
};

class LinkHover {
  constructor(win) {
    this.win = win;
    this.target = null;
    this.onKey = event => {
      // Shift is how you ask for a card; other keys (Esc above all) close it.
      if (!["Shift", "Control", "Alt", "Meta"].includes(event.key)) {
        this.hide();
      }
    };
    this.onDismiss = () => this.hide();
    win.addEventListener("keydown", this.onKey, true);
    win.addEventListener("TabSelect", this.onDismiss);
    win.addEventListener("blur", this.onDismiss);
    win.addEventListener("unload", () => this.destroy(), { once: true });
  }

  get panel() {
    return this.win.document.getElementById(PANEL_ID);
  }

  get isOpen() {
    return !!this.panel && this.panel.state != "closed" && this.panel.hasAttribute(OPEN_ATTR);
  }

  /**
   * A pointer arrived on a link.
   *
   * @param {object} req
   * @param {"people" | "link"} req.source - which child saw it
   * @param {MozBrowser} req.browser
   * @param {string} req.url
   * @param {"hover" | "shift"} req.how - Shift opens at once
   * @param {number} req.x - the link's box, screen CSS pixels
   * @param {number} req.y
   * @param {number} req.width
   * @param {number} req.height
   * @param {string} [req.title] - the link's text
   * @param {number} [req.userContextId]
   */
  enter(req) {
    const { browser, url } = req;
    if (!browser || !url || lazy.PrivateBrowsingUtils.isBrowserPrivate(browser)) {
      return;
    }
    const target = this.target;
    if (target && target.url == url && target.browser == browser) {
      // The same link again (the other child, or Shift pressed on it).
      this.win.clearTimeout(target.leaveTimer);
      target.title ||= req.title;
      if (req.how == "shift" && !target.shown) {
        this.win.clearTimeout(target.enterTimer);
        target.how = "shift";
        this.#open(target);
      }
      return;
    }
    this.hide({ animate: false });
    const kind = this.kindFor(req);
    const controller = new AbortController();
    const next = {
      ...req,
      kind,
      controller,
      shown: false,
      // Decided during the delay so both cards can open on the same frame.
      aiMode: lazy.WhimsyAIPage.previewMode(browser, url, req.how).catch(() => null),
    };
    this.target = next;
    const delay = req.how == "shift" ? 0 : ENTER_DELAY_MS;
    next.enterTimer = this.win.setTimeout(() => this.#open(next), delay);
  }

  // Card 1: People on a profile link (when People cards are on), else the
  // link card (when link cards are on), else none (the AI card alone).
  kindFor({ url }) {
    if (lazy.WhimsyPeople.enabled && lazy.WhimsyPeople.profile(url)) {
      return "people";
    }
    return WhimsyLinkHover.linkCardsEnabled ? "link" : null;
  }

  // The pointer left the link (browser given) or a card (url only checked).
  leave(browser = null, url = null) {
    const target = this.target;
    if (!target || (browser && target.browser != browser) || (url && target.url != url)) {
      return;
    }
    if (!target.shown) {
      this.hide({ animate: false });
      return;
    }
    this.win.clearTimeout(target.leaveTimer);
    target.leaveTimer = this.win.setTimeout(() => {
      if (this.target == target && !this.panel?.matches(":hover")) {
        this.hide();
      }
    }, LEAVE_GRACE_MS);
  }

  async #open(target) {
    const aiMode = await target.aiMode;
    if (this.target != target || target.shown || this.win.closed) {
      return;
    }
    if (!target.kind && !aiMode) {
      this.target = null;
      return;
    }
    if (target.how == "hover" && target.browser != this.win.gBrowser.selectedBrowser) {
      return;
    }
    target.shown = true;
    const panel = this.#ensurePanel();
    const stack = panel.querySelector(".whimsy-link-hover-stack");
    stack.replaceChildren();
    if (target.kind) {
      stack.append(this.#primaryCard(target));
    }
    if (aiMode) {
      stack.append(this.#aiCard(target, aiMode));
    }
    panel.removeAttribute(OPEN_ATTR);
    panel.toggleAttribute("whimsy-two-cards", stack.childElementCount == 2);
    const { x, y, width, height } = target;
    panel.openPopupAtScreenRect(
      "after_start",
      Math.round(x),
      Math.round(y - LINK_GAP_PX),
      Math.max(1, Math.round(width)),
      Math.max(1, Math.round(height + 2 * LINK_GAP_PX)),
      false,
      false
    );
  }

  #ensurePanel() {
    let panel = this.panel;
    if (panel) {
      return panel;
    }
    const doc = this.win.document;
    panel = doc.createXULElement("panel");
    panel.id = PANEL_ID;
    panel.setAttribute("noautofocus", "true");
    panel.setAttribute("consumeoutsideclicks", "false");
    panel.setAttribute("animate", "false");
    panel.setAttribute("flip", "both");
    panel.setAttribute("role", "group");
    const stack = doc.createElementNS(HTML, "div");
    stack.className = "whimsy-link-hover-stack";
    panel.append(stack);
    panel.addEventListener("popupshown", () => {
      // Flipped above the link: the cards rise from below instead.
      const target = this.target;
      const top = target && panel.getOuterScreenRect().y < target.y;
      panel.setAttribute("side", top ? "top" : "bottom");
      // One attribute, one flush: both cards start their transitions on the
      // same frame, with the same duration and curve.
      this.win.requestAnimationFrame(() => {
        if (panel.state == "open") {
          panel.setAttribute(OPEN_ATTR, "true");
        }
      });
    });
    panel.addEventListener("popuphidden", () => {
      panel.removeAttribute(OPEN_ATTR);
      if (this.target?.shown) {
        this.target.controller.abort();
        this.target = null;
      }
    });
    panel.addEventListener("mouseenter", () => this.win.clearTimeout(this.target?.leaveTimer));
    panel.addEventListener("mouseleave", () => this.leave());
    doc.getElementById("mainPopupSet").append(panel);
    return panel;
  }

  #card(kind) {
    const doc = this.win.document;
    const card = doc.createElementNS(HTML, "div");
    card.className = "whimsy-link-hover-card";
    card.dataset.card = kind;
    return card;
  }

  #text(className, text) {
    const el = this.win.document.createElementNS(HTML, "div");
    el.className = className;
    el.textContent = String(text).slice(0, 500);
    return el;
  }

  #primaryCard(target) {
    return target.kind == "people" ? this.#peopleCard(target) : this.#linkCard(target);
  }

  // Where the link goes: its icon, its text, and the address.
  #linkCard(target) {
    const doc = this.win.document;
    const card = this.#card("link");
    let host = target.url;
    let rest = "";
    try {
      const url = new URL(target.url);
      host = url.host.replace(/^www\./, "");
      rest = `${url.pathname}${url.search}`.replace(/^\/$/, "");
    } catch {}
    const head = doc.createElementNS(HTML, "div");
    head.className = "whimsy-link-hover-head";
    const icon = doc.createElementNS(HTML, "img");
    icon.className = "whimsy-link-hover-icon";
    icon.alt = "";
    icon.src = `page-icon:${target.url}`;
    icon.addEventListener("error", () => icon.remove(), { once: true });
    const titles = doc.createElementNS(HTML, "div");
    titles.className = "whimsy-link-hover-titles";
    titles.append(this.#text("whimsy-link-hover-title", target.title || host));
    const address = this.#text("whimsy-link-hover-url", host);
    if (rest) {
      const path = doc.createElementNS(HTML, "span");
      path.className = "whimsy-link-hover-path";
      path.textContent = rest.slice(0, 300);
      address.append(path);
    }
    titles.append(address);
    head.append(icon, titles);
    card.append(head);
    card.addEventListener("click", event => this.#follow(event, target.url));
    return card;
  }

  // Who it is: fix7/tabs' People card (avatar or initials, name, handle and
  // site, bio, stats, Open Profile and Copy Link), showing the handle and a
  // quiet placeholder at once and filled in place when the profile loads
  // (WhimsyPeople rate-limits and caches; a failed lookup keeps the handle).
  // Its own 400ms dwell gave way to the host's one delay.
  #peopleCard(target) {
    const card = this.#card("people");
    const profileUrl = lazy.WhimsyPeople.profile(target.url);
    const close = () => this.hide({ animate: false });
    const fill = (found, loading) => {
      const person = lazy.WhimsyPeople.card(found, profileUrl, { loading });
      card.replaceChildren(lazy.buildPersonCard(this.win, person, { close }));
      card.setAttribute("aria-label", person.name || person.handle);
    };
    fill(null, true);
    const { signal } = target.controller;
    lazy.WhimsyPeople.lookup(this.win, profileUrl, { userContextId: target.userContextId || 0 })
      .catch(() => null)
      .then(found => {
        if (!signal.aborted) {
          fill(found, false);
        }
      });
    card.setAttribute("role", "dialog");
    // Its buttons act; a click elsewhere on the card opens the profile.
    card.addEventListener("click", event => {
      if (!event.target.closest("button")) {
        this.#follow(event, profileUrl);
      }
    });
    return card;
  }

  // The AI summary: present from the first frame (loading lines), filled in
  // place by WhimsyAIPage.
  #aiCard(target, mode) {
    const doc = this.win.document;
    const card = this.#card("ai");
    const label = doc.createElementNS(HTML, "div");
    label.className = "whimsy-link-hover-eyebrow";
    doc.l10n.setAttributes(label, "whimsy-link-hover-ai-label");
    const body = doc.createElementNS(HTML, "div");
    body.className = "whimsy-link-hover-ai";
    card.append(label, body);
    lazy.WhimsyAIPage.fillPreview(this.win, body, {
      url: target.url,
      browser: target.browser,
      mode,
      signal: target.controller.signal,
    }).catch(error => console.error("Whimsy: link preview", error));
    card.addEventListener("click", event => this.#follow(event, target.url));
    return card;
  }

  // Clicking a card opens the link, as clicking the link would.
  #follow(event, url) {
    if (event.button != 0) {
      return;
    }
    this.hide({ animate: false });
    this.win.openTrustedLinkIn(url, "current");
  }

  // Both cards leave together: one attribute off, one shared exit, then the
  // popup closes. Reduced motion has no transition, so it closes at once.
  hide({ animate = true } = {}) {
    const target = this.target;
    if (target) {
      this.win.clearTimeout(target.enterTimer);
      this.win.clearTimeout(target.leaveTimer);
      target.controller.abort();
      this.target = null;
    }
    const panel = this.panel;
    if (!panel || panel.state == "closed") {
      return;
    }
    if (!animate || !panel.hasAttribute(OPEN_ATTR)) {
      panel.hidePopup();
      return;
    }
    panel.removeAttribute(OPEN_ATTR);
    const exitMs = this.exitDuration(panel);
    if (!exitMs) {
      panel.hidePopup();
      return;
    }
    const closing = (this.closing = {});
    this.win.setTimeout(() => {
      // A new hover may have reopened it in the meantime.
      if (this.closing == closing && !panel.hasAttribute(OPEN_ATTR) && panel.state != "closed") {
        panel.hidePopup();
      }
    }, exitMs);
  }

  exitDuration(panel) {
    const card = panel.querySelector(".whimsy-link-hover-card");
    if (!card) {
      return 0;
    }
    const seconds = this.win
      .getComputedStyle(card)
      .transitionDuration.split(",")
      .map(value => parseFloat(value) || 0);
    return Math.round(Math.max(0, ...seconds) * 1000);
  }

  destroy() {
    this.hide({ animate: false });
    this.win.removeEventListener("keydown", this.onKey, true);
    this.win.removeEventListener("TabSelect", this.onDismiss);
    this.win.removeEventListener("blur", this.onDismiss);
    this.panel?.remove();
    hosts.delete(this.win);
  }
}
