/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The one hover host for links in pages (wave7/ux, reworked for W25's hover
// cards). One card at a time, never stacked:
//   - the People card on a profile link (WhimsyPeople), while People cards
//     are on;
//   - otherwise the hover card (WhimsyHoverCards): a picture on top, the
//     title, the address, and the AI description. Every link gets one while
//     whimsy.feature.hover-cards is on, private tabs included (there it
//     shows only the link's text and address).
// Both open after one 500ms delay against the link's box
// (openPopupAtScreenRect), so layout flips the card above the link when
// there's no room below and it never covers the link. Moving on to another
// link swaps the hover card with no delay; a People card (which has
// buttons) keeps the hover bridge, so links crossed on the way to it don't
// replace it. Tabs have their own card (WhimsyHoverCards' TabHover) and
// History rows keep WhimsyHoverCard.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  buildPersonCard: "resource:///modules/whimsy/WhimsyHoverCard.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  WhimsyHoverCards: "resource:///modules/whimsy/WhimsyHoverCards.sys.mjs",
  WhimsyPeople: "resource:///modules/whimsy/WhimsyPeople.sys.mjs",
});

const HTML = "http://www.w3.org/1999/xhtml";
const PANEL_ID = "whimsy-link-hover";
const ENTER_DELAY_MS = 500;
// wave9/mini W8-28: long enough to cross from the link to a People card and
// reach its buttons (180 ms lost the card on LinkedIn's dense layouts).
const LEAVE_GRACE_MS = 400;
// The hover card has no buttons: it closes soon after the link is left,
// leaving a moment for the next link's hover to swap it.
const CARD_LEAVE_MS = 100;
// A link entered this soon after a card closed opens its card at once.
const SWAP_MS = 300;
// Space between the link and the stack (the cards' own gap is CSS).
const LINK_GAP_PX = 4;
const OPEN_ATTR = "whimsy-open";
const hosts = new WeakMap();

// One person or place, however the page spells the link (LinkedIn adds
// ?miniProfileUrn=..., trailing slashes, www.): the same card stays open.
function keyOf(url) {
  return lazy.WhimsyPeople.profile(url) ?? url;
}

export const WhimsyLinkHover = {
  ENTER_DELAY_MS,
  LEAVE_GRACE_MS,
  PANEL_ID,

  get linkCardsEnabled() {
    return lazy.WhimsyHoverCards.enabled;
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
    // wave9/mini W8-28: a link crossed on the way to the shown card waits
    // here (the hover bridge) instead of replacing the card at once.
    this.pending = null;
    this.overPanel = false;
    this.closedAt = 0;
    this.onKey = event => {
      // Keys (Esc above all) close it; modifiers alone don't.
      if (!["Shift", "Control", "Alt", "Meta"].includes(event.key)) {
        this.cancelPending();
        this.hide();
      }
    };
    this.onDismiss = () => {
      this.cancelPending();
      this.hide();
    };
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
   * @param {"hover"} [req.how]
   * @param {number} req.x - the link's box, screen CSS pixels
   * @param {number} req.y
   * @param {number} req.width
   * @param {number} req.height
   * @param {string} [req.title] - the link's text
   * @param {number} [req.userContextId]
   */
  enter(req) {
    const { browser, url } = req;
    if (!browser || !url) {
      return;
    }
    const key = keyOf(url);
    // People cards never show in private tabs; the hover card does, with
    // the link's text and address only.
    const kind = this.kindFor(req, lazy.PrivateBrowsingUtils.isBrowserPrivate(browser));
    if (!kind) {
      return;
    }
    const target = this.target;
    if (target && target.key == key && target.browser == browser) {
      // The same link again (the other child, or back onto it from the way
      // to the card).
      this.cancelPending();
      this.win.clearTimeout(target.leaveTimer);
      target.title ||= req.title;
      return;
    }
    const pending = this.pending;
    if (pending && pending.key == key && pending.browser == browser) {
      pending.title ||= req.title;
      return;
    }
    this.cancelPending();
    const next = {
      ...req,
      key,
      kind,
      controller: new AbortController(),
      shown: false,
      // Decided during the delay, so the card opens with its description's
      // place already there (no jump when it arrives).
      ai: kind == "link" ? lazy.WhimsyHoverCards.linkDescribes(browser, url).catch(() => false) : false,
    };
    if (target?.shown && target.kind == "people") {
      // wave9/mini W8-28, the hover bridge: the pointer is probably on its
      // way to the open People card and crossing other links (LinkedIn
      // stacks a person's photo, name and headline as separate links). The
      // card stays; this link takes over only if the pointer rests on it for
      // the whole delay, and never once the pointer reaches the card.
      this.pending = next;
      next.enterTimer = this.win.setTimeout(() => this.#promote(next), ENTER_DELAY_MS);
      return;
    }
    // Moving along links: the next card swaps in with no delay.
    const swap = !!target?.shown || Date.now() - this.closedAt < SWAP_MS;
    this.hide({ animate: false });
    this.target = next;
    next.enterTimer = this.win.setTimeout(() => this.#open(next), swap ? 0 : ENTER_DELAY_MS);
  }

  // The bridged link won: it replaces whatever card is still showing.
  #promote(next) {
    if (this.pending != next) {
      return;
    }
    this.win.clearTimeout(next.enterTimer);
    this.pending = null;
    if (this.overPanel) {
      next.controller.abort();
      return;
    }
    this.hide({ animate: false });
    this.target = next;
    this.#open(next);
  }

  cancelPending() {
    const pending = this.pending;
    if (pending) {
      this.pending = null;
      this.win.clearTimeout(pending.enterTimer);
      pending.controller.abort();
    }
  }

  // People on a profile link (when People cards are on), else the hover
  // card (when hover cards are on), else none.
  kindFor({ url }, isPrivate = false) {
    if (!isPrivate && lazy.WhimsyPeople.enabled && lazy.WhimsyPeople.profile(url)) {
      return "people";
    }
    return WhimsyLinkHover.linkCardsEnabled ? "link" : null;
  }

  // The pointer left the link (browser given) or a card (url only checked).
  leave(browser = null, url = null) {
    const pending = this.pending;
    if (pending && (browser || url) && (!browser || pending.browser == browser) &&
        (!url || pending.key == keyOf(url))) {
      // Only passing over it on the way to the card.
      this.cancelPending();
    }
    const target = this.target;
    if (!target || (browser && target.browser != browser) || (url && target.key != keyOf(url))) {
      return;
    }
    if (!target.shown) {
      this.hide({ animate: false });
      return;
    }
    this.win.clearTimeout(target.leaveTimer);
    if (this.overPanel) {
      // The page's mouseout arrives over IPC, often after the pointer is
      // already on the card: never start the countdown from there.
      return;
    }
    target.leaveTimer = this.win.setTimeout(() => {
      if (this.target == target && !this.overPanel && !this.panel?.matches(":hover")) {
        // A link the pointer is resting on may still take over.
        this.hide({ keepPending: true });
      }
    }, target.kind == "people" ? LEAVE_GRACE_MS : CARD_LEAVE_MS);
  }

  async #open(target) {
    const ai = await target.ai;
    if (this.target != target || target.shown || this.win.closed) {
      return;
    }
    // The last card may still be closing: a panel that's hiding can't open
    // again, and its popuphidden would end this card.
    if (this.panel?.state == "hiding") {
      await new Promise(resolve => this.panel.addEventListener("popuphidden", resolve, { once: true }));
      if (this.target != target || target.shown || this.win.closed) {
        return;
      }
    }
    if (target.browser != this.win.gBrowser.selectedBrowser) {
      return;
    }
    target.shown = true;
    // An earlier card's exit may still be timed to hide the panel: this card
    // replaces it, so that close must not land on the new one.
    this.closing = null;
    const panel = this.#ensurePanel();
    const stack = panel.querySelector(".whimsy-link-hover-stack");
    stack.replaceChildren(target.kind == "people" ? this.#peopleCard(target) : this.#hoverCard(target, ai));
    panel.removeAttribute(OPEN_ATTR);
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
      this.overPanel = false;
      this.closedAt = Date.now();
      panel.removeAttribute(OPEN_ATTR);
      if (this.target?.shown) {
        this.target.controller.abort();
        this.target = null;
      }
    });
    // wave9/mini W8-28: tracked here rather than read from :hover, which
    // the popup's own widget doesn't always report in time.
    panel.addEventListener("mouseenter", () => {
      this.overPanel = true;
      this.win.clearTimeout(this.target?.leaveTimer);
      this.cancelPending();
    });
    panel.addEventListener("mouseleave", () => {
      this.overPanel = false;
      this.leave();
    });
    // A native popup owns wheel input over its rect; forward it to the page (B3).
    panel.addEventListener("wheel", event => this.#forwardWheel(event), { passive: true });
    doc.getElementById("mainPopupSet").append(panel);
    return panel;
  }

  #forwardWheel(event) {
    const target = this.target;
    if (!target?.shown) {
      return;
    }
    try {
      const actor = target.browser.browsingContext?.currentWindowGlobal?.getActor("WhimsyAIPreview");
      actor?.sendAsyncMessage("WhimsyAIPreview:Scroll", {
        screenX: event.screenX,
        screenY: event.screenY,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        deltaZ: event.deltaZ,
        deltaMode: event.deltaMode,
      });
    } catch {
      // The tab's process may already be gone.
    }
  }

  #card(kind) {
    const doc = this.win.document;
    const card = doc.createElementNS(HTML, "div");
    card.className = "whimsy-link-hover-card";
    card.dataset.card = kind;
    return card;
  }

  // W25: the hover card (WhimsyHoverCards), filled in place as the
  // picture, title, and description arrive. Clicking it opens the link, as
  // clicking the link would.
  #hoverCard(target, ai) {
    const card = this.#card("link");
    card.append(lazy.WhimsyHoverCards.linkCard(this.win, { ...target, ai }));
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
    // wave9/mini W8-28: the link's own name and photo (on its own site)
    // show at once and fill whatever the lookup can't.
    const context = target.context ?? null;
    fill(context, true);
    const { signal } = target.controller;
    lazy.WhimsyPeople.lookup(this.win, profileUrl, { userContextId: target.userContextId || 0 })
      .catch(() => null)
      .then(found => {
        if (!signal.aborted) {
          fill(lazy.WhimsyPeople.merge(found, context), false);
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

  // Clicking a card opens the link, as clicking the link would.
  #follow(event, url) {
    if (event.button != 0) {
      return;
    }
    this.hide({ animate: false });
    this.win.openTrustedLinkIn(url, "current");
  }

  // The card leaves on one attribute, one exit transition, then the popup
  // closes. Reduced motion has no transition, so it closes at once.
  hide({ animate = true, keepPending = false } = {}) {
    if (!keepPending) {
      this.cancelPending();
    }
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
      this.closing = null;
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
    this.cancelPending();
    this.hide({ animate: false });
    this.win.removeEventListener("keydown", this.onKey, true);
    this.win.removeEventListener("TabSelect", this.onDismiss);
    this.win.removeEventListener("blur", this.onDismiss);
    this.panel?.remove();
    hosts.delete(this.win);
  }
}
