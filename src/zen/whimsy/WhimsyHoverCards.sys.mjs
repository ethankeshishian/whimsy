/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W25 hover cards: one card, the same for a tab and for a link (owner
// approved, intake-w25 hover-summary.html). A picture on top (the tab
// itself, or the link's own preview image; with no image, a tile with the
// site's icon in the same space, so nothing below moves), then the title,
// the address, and the AI summary: a one- or two-sentence description and
// three bullets, from one request. It opens after
// resting 500ms and swaps with no delay as you move along. No buttons, no
// menu, and one switch (whimsy.feature.hover-cards, Settings › General ›
// Hover cards), on by default.
//
// - Descriptions follow the AI switch, through WhimsyAIPage's one
//   description path and cache: a tab's from its loaded page (nothing is
//   fetched), a link's from the public page read without sign-ins.
// - Private tabs: a tab gets its picture, title, and address and a note,
//   never a description. A link gets only its text and address, so the
//   linked page isn't loaded at all.
// - Links are hosted by WhimsyLinkHover (placement, People cards, and the
//   hover bridge); this module builds the card and runs tab hovers. It
//   replaces Firefox's tab hover preview for Whimsy
//   (browser.tabs.hoverPreview.enabled is off through overlay.py).

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  NetUtil: "resource://gre/modules/NetUtil.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
  WhimsyAIContext: "resource:///modules/whimsy/WhimsyAIContext.sys.mjs",
  WhimsyAIPage: "resource:///modules/whimsy/WhimsyAIPage.sys.mjs",
  WhimsyAIReader: "resource:///modules/whimsy/WhimsyAIReader.sys.mjs",
  WhimsyHoverCard: "resource:///modules/whimsy/WhimsyHoverCard.sys.mjs",
  WhimsyPeople: "resource:///modules/whimsy/WhimsyPeople.sys.mjs",
});

const PREF = "whimsy.feature.hover-cards";
const AI_PREF = "whimsy.ai.enabled";
const HTML = "http://www.w3.org/1999/xhtml";
const TAB_PANEL_ID = "whimsy-tab-hover";
const ENTER_DELAY_MS = 500;
// Moving to the next tab or link this soon after a card closed opens its
// card at once, as Firefox's tab preview does (ZERO_DELAY_ACTIVATION_TIME).
const SWAP_MS = 300;
// Leaving a tab: a moment to reach the next one before the card closes.
const TAB_LEAVE_MS = 100;
const OPEN_ATTR = "whimsy-open";
// Between the tab and its card.
const TAB_GAP_PX = 8;
// The picture's size in CSS pixels (the card is 300 wide, 12px padding).
const PICTURE = { width: 276, height: 140 };
const PAGE_MAX_BYTES = 1024 * 1024;
const IMAGE_MAX_BYTES = 3 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 8000;
const META_CACHE_MAX = 60;
const META_CACHE_MS = 30 * 60 * 1000;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"];

// url -> { at, data: { title, image } }: a link's own title and preview
// image address (never the page's text).
const metaCache = new Map();
Services.obs.addObserver(() => metaCache.clear(), "browser:purge-session-history");

const tabHovers = new WeakMap();

function hostOf(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol == "about:" || !parsed.host) {
      return parsed.href;
    }
    return parsed.host.replace(/^www\./, "");
  } catch {
    return String(url ?? "");
  }
}

export const WhimsyHoverCards = {
  PREF,
  TAB_PANEL_ID,
  ENTER_DELAY_MS,
  SWAP_MS,

  // Tests only: (url, { kind: "page" | "image" }) => { text } | { bytes, type },
  // in place of the network.
  _testFetcher: null,

  setTestFetcher(fn) {
    if (fn && !Cu.isInAutomation) {
      throw new Error("The test fetcher is for automated tests only");
    }
    this._testFetcher = fn || null;
    // A stand-in starts from nothing remembered.
    metaCache.clear();
  },

  get enabled() {
    return Services.prefs.getBoolPref(PREF, true);
  },

  // Descriptions follow the AI switch (Settings › AI).
  get aiOn() {
    return lazy.WhimsyAIPage.descriptionsEnabled;
  },

  initWindow(win) {
    if (tabHovers.has(win) || !win.gBrowser) {
      return;
    }
    tabHovers.set(win, new TabHover(win));
  },

  forWindow(win) {
    return tabHovers.get(win) ?? null;
  },

  isPrivateTab(tab) {
    return (
      !!tab &&
      (lazy.PrivateBrowsingUtils.isBrowserPrivate(tab.linkedBrowser) || lazy.WhimsyAIContext.isPrivate(tab))
    );
  },

  isPrivateBrowser(browser) {
    if (!browser) {
      return false;
    }
    if (lazy.PrivateBrowsingUtils.isBrowserPrivate(browser)) {
      return true;
    }
    const tab = browser.documentGlobal?.gBrowser?.getTabForBrowser(browser);
    return !!tab && lazy.WhimsyAIContext.isPrivate(tab);
  },

  /**
   * The card's parts, empty: fill them with the fill* methods. Remote text
   * goes in as text only, and pictures as an <img> or <canvas>, never markup.
   *
   * @param {ChromeWindow} win
   * @param {{ title: string, url: string, icon?: string, kind: "tab" | "link" }} data
   * @returns {Element}
   */
  buildCard(win, { title, url, icon, kind }) {
    const doc = win.document;
    const el = (className, text) => {
      const node = doc.createElementNS(HTML, "div");
      node.className = className;
      if (text) {
        node.textContent = String(text).slice(0, 500);
      }
      return node;
    };
    const card = el("whimsy-hc whimsy-surface-tokens");
    card.dataset.kind = kind;
    card.setAttribute("role", "tooltip");
    const picture = el("whimsy-hc-picture");
    card.append(picture);
    const host = hostOf(url);
    card.append(el("whimsy-hc-title", title || host));
    const address = el("whimsy-hc-address");
    address.append(this.icon(win, url, icon, "whimsy-hc-favicon", host), el("whimsy-hc-host", host));
    card.append(address);
    card.whimsyHover = { url, host, icon };
    this.fillSiteTile(win, card);
    return card;
  },

  // The site's icon, or its first letter when there's none.
  icon(win, url, icon, className, host) {
    const doc = win.document;
    const letter = doc.createElementNS(HTML, "span");
    letter.className = `${className} whimsy-hc-letter`;
    letter.textContent = (host.replace(/^[^a-z0-9]+/i, "")[0] || "·").toUpperCase();
    letter.setAttribute("aria-hidden", "true");
    const src = icon || (/^https?:/i.test(url) ? `page-icon:${url}` : null);
    if (!src) {
      return letter;
    }
    const img = doc.createElementNS(HTML, "img");
    img.className = className;
    img.alt = "";
    img.addEventListener("error", () => img.replaceWith(letter), { once: true });
    img.src = src;
    return img;
  },

  /**
   * The popup a card shows in, for tabs and links alike: no surface, border,
   * or shadow of its own (whimsy-ai.css), only room around the card for the
   * card's shadow. Not yet in the document.
   */
  createHost(doc, id) {
    const panel = doc.createXULElement("panel");
    panel.id = id;
    panel.classList.add("whimsy-hc-host-panel");
    panel.setAttribute("noautofocus", "true");
    panel.setAttribute("consumeoutsideclicks", "false");
    panel.setAttribute("animate", "false");
    panel.setAttribute("flip", "both");
    panel.setAttribute("role", "group");
    const stack = doc.createElementNS(HTML, "div");
    stack.className = "whimsy-link-hover-stack";
    panel.append(stack);
    return panel;
  },

  // No picture: a tile with the site's icon, in the picture's space.
  fillSiteTile(win, card) {
    const picture = card.querySelector(".whimsy-hc-picture");
    const { url, host, icon } = card.whimsyHover;
    picture.dataset.kind = "site";
    picture.replaceChildren(this.icon(win, url, icon, "whimsy-hc-site-icon", host));
  },

  fillPicture(card, node) {
    const picture = card.querySelector(".whimsy-hc-picture");
    picture.dataset.kind = "image";
    node.classList.add("whimsy-hc-image");
    picture.replaceChildren(node);
  },

  fillTitle(card, title) {
    if (title) {
      card.querySelector(".whimsy-hc-title").textContent = String(title).slice(0, 300);
    }
  },

  // The AI summary's place: "loading" (quiet lines), the description with
  // its three bullets (`points`, from the same answer), a note ("private",
  // "unloaded", "private-link", "failed"), or nothing.
  fillDescription(win, card, { loading = false, text = null, points = null, note = null } = {}) {
    const doc = win.document;
    card.querySelector(".whimsy-hc-desc")?.remove();
    card.querySelector(".whimsy-hc-points")?.remove();
    if (!loading && !text && !note) {
      card.removeAttribute("aria-busy");
      return;
    }
    const desc = doc.createElementNS(HTML, "div");
    desc.className = "whimsy-hc-desc";
    if (loading) {
      desc.classList.add("is-loading");
      desc.setAttribute("aria-hidden", "true");
      desc.append(doc.createElementNS(HTML, "i"), doc.createElementNS(HTML, "i"));
      card.setAttribute("aria-busy", "true");
    } else if (note) {
      desc.classList.add("is-note");
      desc.dataset.note = note;
      const label = doc.createElementNS(HTML, "span");
      doc.l10n.setAttributes(label, `whimsy-hover-card-${note}`);
      desc.append(label);
      card.removeAttribute("aria-busy");
    } else {
      desc.classList.add("is-text");
      desc.textContent = String(text).slice(0, 400);
      card.removeAttribute("aria-busy");
    }
    card.append(desc);
    if (loading) {
      // The bullets' place while the summary loads.
      const list = doc.createElementNS(HTML, "div");
      list.className = "whimsy-hc-points is-loading";
      list.setAttribute("aria-hidden", "true");
      for (let i = 0; i < 3; i++) {
        list.append(doc.createElementNS(HTML, "i"));
      }
      card.append(list);
    } else if (text && Array.isArray(points) && points.length) {
      const list = doc.createElementNS(HTML, "ul");
      list.className = "whimsy-hc-points";
      for (const point of points.slice(0, 3)) {
        const item = doc.createElementNS(HTML, "li");
        item.textContent = String(point).slice(0, 160);
        list.append(item);
      }
      card.append(list);
    }
  },

  // A described page: the description and its bullets, from one answer.
  fillSummary(win, card, found) {
    this.fillDescription(win, card, { text: found?.description, points: found?.points });
  },

  /**
   * A link's card, filled as its parts arrive. In a private tab nothing is
   * fetched: the link's text and address, with the site tile.
   *
   * @param {ChromeWindow} win
   * @param {{ url: string, title?: string, browser: MozBrowser, controller: AbortController, ai?: boolean }} target
   * @returns {Element}
   */
  linkCard(win, target) {
    const { url, browser } = target;
    const signal = target.controller.signal;
    const card = this.buildCard(win, { title: target.title, url, kind: "link" });
    if (this.isPrivateBrowser(browser)) {
      card.dataset.private = "true";
      this.fillDescription(win, card, { note: "private-link" });
      return card;
    }
    // Only public pages, without the person's cookies (security M5): a
    // hover never makes Whimsy fetch an intranet page.
    if (!lazy.WhimsyAIReader.isPublicUrl(url)) {
      return card;
    }
    this.linkMeta(win, url, { signal })
      .then(meta => {
        if (signal.aborted || !meta) {
          return;
        }
        if (!target.title) {
          this.fillTitle(card, meta.title);
        }
        if (meta.image) {
          this.loadImage(win, meta.image, signal).then(img => {
            if (img && !signal.aborted) {
              this.fillPicture(card, img);
            }
          });
        }
      })
      .catch(() => {});
    if (target.ai) {
      this.fillDescription(win, card, { loading: true });
      lazy.WhimsyAIPage.describe(url, { anonymous: true, signal })
        .then(found => !signal.aborted && this.fillSummary(win, card, found))
        .catch(() => !signal.aborted && this.fillDescription(win, card, { note: "failed" }));
    }
    return card;
  },

  /**
   * Whether a link's card gets a description: AI on and a provider that
   * answers, a public page, and not a private tab.
   */
  async linkDescribes(browser, url) {
    if (!this.aiOn || this.isPrivateBrowser(browser) || !lazy.WhimsyAIReader.isPublicUrl(url)) {
      return false;
    }
    return lazy.WhimsyAIPage.canDescribe();
  },

  // ---- A link's own title and preview image ----

  async linkMeta(win, url, { signal } = {}) {
    const cached = metaCache.get(url);
    if (cached && Date.now() - cached.at < META_CACHE_MS) {
      return cached.data;
    }
    const { text } = await this.fetch(url, { kind: "page", signal });
    const found = lazy.WhimsyPeople.parseMeta(win, text);
    const data = { title: found.title || null, image: found.image || null };
    metaCache.set(url, { at: Date.now(), data });
    if (metaCache.size > META_CACHE_MAX) {
      metaCache.delete(metaCache.keys().next().value);
    }
    return data;
  },

  // The preview image, fetched without cookies like the page, shown from
  // memory (a blob), so the image's site never sees the person's session.
  async loadImage(win, url, signal) {
    try {
      if (!lazy.WhimsyAIReader.isPublicUrl(url) || !url.startsWith("https://")) {
        return null;
      }
      const { bytes, type } = await this.fetch(url, { kind: "image", signal });
      if (signal?.aborted || !bytes?.byteLength) {
        return null;
      }
      const blobUrl = win.URL.createObjectURL(new win.Blob([bytes], { type }));
      const img = win.document.createElementNS(HTML, "img");
      img.alt = "";
      // Kept while the card shows; let go when it closes.
      const revoke = () => win.URL.revokeObjectURL(blobUrl);
      signal?.addEventListener("abort", revoke, { once: true });
      img.src = blobUrl;
      try {
        await img.decode();
      } catch (error) {
        revoke();
        throw error;
      }
      return img;
    } catch {
      return null;
    }
  },

  /**
   * One anonymous GET: no cookies sent or kept, redirects only to public
   * pages, a size and time cap, and only HTML (a page) or a raster image.
   *
   * @returns {Promise<{ text?: string, bytes?: Uint8Array, type?: string }>}
   */
  async fetch(url, { kind, signal } = {}) {
    if (this._testFetcher) {
      return this._testFetcher(url, { kind });
    }
    const isImage = kind == "image";
    const uri = Services.io.newURI(url);
    const principal = Services.scriptSecurityManager.createNullPrincipal({});
    const channel = lazy.NetUtil.newChannel({
      uri,
      contentPolicyType: Ci.nsIContentPolicy.TYPE_OTHER,
      loadingPrincipal: principal,
      triggeringPrincipal: principal,
      securityFlags: Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_INHERITS_SEC_CONTEXT,
    }).QueryInterface(Ci.nsIHttpChannel);
    // Never from or into the cache: each fetch's address is checked below.
    channel.loadFlags |= Ci.nsIRequest.LOAD_ANONYMOUS | Ci.nsIRequest.LOAD_BYPASS_CACHE | Ci.nsIRequest.INHIBIT_CACHING;
    channel.setRequestHeader("Accept", isImage ? IMAGE_TYPES.join(", ") : "text/html", false);
    channel.notificationCallbacks = {
      QueryInterface: ChromeUtils.generateQI(["nsIInterfaceRequestor", "nsIChannelEventSink"]),
      getInterface(iid) {
        return this.QueryInterface(iid);
      },
      asyncOnChannelRedirect(_oldChannel, newChannel, _flags, callback) {
        const ok = lazy.WhimsyAIReader.isPublicUrl(newChannel.URI.spec);
        callback.onRedirectVerifyCallback(ok ? Cr.NS_OK : Cr.NS_BINDING_ABORTED);
      },
    };
    const max = isImage ? IMAGE_MAX_BYTES : PAGE_MAX_BYTES;
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      let done = false;
      const timer = lazy.setTimeout(() => channel.cancel(Cr.NS_ERROR_NET_TIMEOUT), FETCH_TIMEOUT_MS);
      const onAbort = () => channel.cancel(Cr.NS_BINDING_ABORTED);
      signal?.addEventListener("abort", onAbort, { once: true });
      const finish = () => {
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return bytes;
      };
      channel.asyncOpen({
        onStartRequest(request) {
          // A public name can resolve to a private address (DNS rebinding):
          // the address actually connected to must be public too.
          if (!WhimsyHoverCards.connectedPublicly(request)) {
            request.cancel(Cr.NS_ERROR_CONNECTION_REFUSED);
          }
        },
        onDataAvailable(request, stream, _offset, count) {
          const chunk = new Uint8Array(lazy.NetUtil.readInputStream(stream, count));
          if (size + count > max) {
            // A page's meta tags are near the top: keep what fits.
            if (!isImage) {
              chunks.push(chunk.subarray(0, max - size));
              size = max;
              done = true;
            }
            request.cancel(Cr.NS_ERROR_FILE_TOO_BIG);
            return;
          }
          size += count;
          chunks.push(chunk);
        },
        onStopRequest(_request, status) {
          lazy.clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          let type = "";
          let ok = Components.isSuccessCode(status) || done;
          try {
            type = channel.contentType;
            ok &&= channel.responseStatus == 200 && (isImage ? IMAGE_TYPES.includes(type) : type == "text/html");
          } catch {
            ok = false;
          }
          if (!ok) {
            reject(new Error("Not available"));
            return;
          }
          const bytes = finish();
          resolve(isImage ? { bytes, type } : { text: new TextDecoder().decode(bytes) });
        },
      });
    });
  },

  /** Whether `ip` (the address a fetch connected to) is a public one. */
  isPublicAddress(ip) {
    if (!ip) {
      return false;
    }
    return lazy.WhimsyAIReader.isPublicUrl(`http://${ip.includes(":") ? `[${ip}]` : ip}/`);
  },

  // Through a proxy the proxy resolves the name, so only a direct
  // connection's address can be checked.
  connectedPublicly(request) {
    try {
      if (request.QueryInterface(Ci.nsIProxiedChannel).proxyInfo) {
        return true;
      }
    } catch {}
    try {
      return this.isPublicAddress(request.QueryInterface(Ci.nsIHttpChannelInternal).remoteAddress);
    } catch {
      return false;
    }
  },

  // ---- A tab's picture ----

  /**
   * The tab itself: a fresh capture of a loaded tab, or the picture saved
   * when it was last open. Null leaves the site tile.
   */
  async tabPicture(win, tab) {
    const browser = tab.linkedBrowser;
    const url = browser?.currentURI?.spec;
    if (tab.hasAttribute("pending") || !tab.linkedPanel) {
      const saved = url ? await lazy.WhimsyHoverCard.cachedThumbnail(url) : null;
      if (!saved) {
        return null;
      }
      const img = win.document.createElementNS(HTML, "img");
      img.alt = "";
      img.src = saved;
      return img;
    }
    const canvas = win.document.createElementNS(HTML, "canvas");
    canvas.width = Math.round(PICTURE.width * win.devicePixelRatio);
    canvas.height = Math.round(PICTURE.height * win.devicePixelRatio);
    try {
      const captured = await win.PageThumbs.captureTabPreviewThumbnail(browser, canvas);
      return captured ? canvas : null;
    } catch {
      return null;
    }
  },
};

// A tab's card: TabHoverStart and TabHoverEnd from the tab strip (Zen's
// sidebar), one panel beside the tab.
class TabHover {
  constructor(win) {
    this.win = win;
    this.tab = null;
    this.timer = 0;
    this.leaveTimer = 0;
    this.closedAt = 0;
    this.controller = null;
    this.onStart = event => this.enter(event.target);
    this.onEnd = event => this.leave(event.target);
    this.onDismiss = () => this.hide();
    this.onPopup = event => {
      const target = event.target;
      if (target != this.panel && (target.localName == "panel" || target.localName == "menupopup")) {
        this.hide();
      }
    };
    this.onPref = () => {
      if (!WhimsyHoverCards.enabled) {
        this.hide();
      }
    };
    win.addEventListener("TabHoverStart", this.onStart);
    win.addEventListener("TabHoverEnd", this.onEnd);
    win.addEventListener("TabSelect", this.onDismiss);
    win.addEventListener("TabClose", this.onDismiss);
    win.addEventListener("blur", this.onDismiss);
    win.addEventListener("keydown", this.onDismiss, true);
    win.addEventListener("popupshowing", this.onPopup, true);
    Services.prefs.addObserver(PREF, this.onPref);
    Services.prefs.addObserver(AI_PREF, this.onPref);
    this.suppressTabTooltip();
    win.addEventListener("unload", () => this.destroy(), { once: true });
  }

  // Firefox shows the tab's tooltip when its own preview is off; the card
  // takes its place. The speaker's mute and unmute tips still show.
  suppressTabTooltip() {
    const gBrowser = this.win.gBrowser;
    if (!gBrowser?.createTooltip || gBrowser._whimsyHoverCardTooltip) {
      return;
    }
    gBrowser._whimsyHoverCardTooltip = true;
    const original = gBrowser.createTooltip;
    gBrowser.createTooltip = function (event) {
      const tab = event.target?.triggerNode?.closest?.("tab");
      if (tab && WhimsyHoverCards.enabled && !tab._overPlayingIcon && !tab._overAudioButton) {
        event.stopPropagation();
        event.preventDefault();
        return undefined;
      }
      return original.call(this, event);
    };
  }

  get panel() {
    return this.win.document.getElementById(TAB_PANEL_ID);
  }

  get isOpen() {
    return !!this.panel && this.panel.state != "closed";
  }

  enter(tab) {
    if (!tab || tab.localName != "tab" || !WhimsyHoverCards.enabled) {
      return;
    }
    this.win.clearTimeout(this.leaveTimer);
    if (this.tab == tab && (this.isOpen || this.timer)) {
      return;
    }
    this.win.clearTimeout(this.timer);
    this.timer = 0;
    this.tab = tab;
    // Moving along the tabs: the next card swaps in with no delay.
    if (this.isOpen || Date.now() - this.closedAt < SWAP_MS) {
      this.show(tab);
      return;
    }
    this.timer = this.win.setTimeout(() => {
      this.timer = 0;
      if (this.tab == tab) {
        this.show(tab);
      }
    }, ENTER_DELAY_MS);
  }

  leave(tab) {
    if (tab != this.tab) {
      return;
    }
    this.win.clearTimeout(this.timer);
    this.timer = 0;
    this.win.clearTimeout(this.leaveTimer);
    this.leaveTimer = this.win.setTimeout(() => {
      if (this.tab == tab) {
        this.hide();
      }
    }, TAB_LEAVE_MS);
  }

  #ensurePanel() {
    let panel = this.panel;
    if (panel) {
      return panel;
    }
    const doc = this.win.document;
    // The link card's host, made the same way: one look for both.
    panel = WhimsyHoverCards.createHost(doc, TAB_PANEL_ID);
    panel.addEventListener("popupshown", () => {
      this.win.requestAnimationFrame(() => {
        if (panel.state == "open") {
          panel.setAttribute(OPEN_ATTR, "true");
        }
      });
    });
    panel.addEventListener("popuphidden", () => {
      panel.removeAttribute(OPEN_ATTR);
      this.closedAt = Date.now();
    });
    doc.getElementById("mainPopupSet").append(panel);
    return panel;
  }

  async show(tab) {
    if (!tab.isConnected || !WhimsyHoverCards.enabled || this.win.closed) {
      return;
    }
    this.controller?.abort();
    const controller = (this.controller = new AbortController());
    const { signal } = controller;
    const win = this.win;
    const browser = tab.linkedBrowser;
    const url = browser?.currentURI?.spec || "";
    const card = WhimsyHoverCards.buildCard(win, {
      title: tab.label,
      url,
      icon: tab.getAttribute("image") || null,
      kind: "tab",
    });
    const isPrivate = WhimsyHoverCards.isPrivateTab(tab);
    const unloaded = tab.hasAttribute("pending") || !tab.linkedPanel;
    let describe = false;
    if (WhimsyHoverCards.aiOn) {
      if (isPrivate) {
        WhimsyHoverCards.fillDescription(win, card, { note: "private" });
      } else if (lazy.WhimsyAIReader.isReadableUrl(url) && !lazy.WhimsyAIContext.isOffLimits(tab)) {
        if (unloaded) {
          WhimsyHoverCards.fillDescription(win, card, { note: "unloaded" });
        } else {
          describe = true;
        }
      }
    }
    const panel = this.#ensurePanel();
    const swap = panel.state == "open" || panel.state == "showing";
    const frame = win.document.createElementNS(HTML, "div");
    frame.className = "whimsy-link-hover-card";
    frame.dataset.card = "tab";
    frame.append(card);
    panel.querySelector(".whimsy-link-hover-stack").replaceChildren(frame);
    if (swap) {
      // Moving along: the card is already there; it follows the tab.
      const { position, x, y } = this.#position(tab);
      panel.setAttribute(OPEN_ATTR, "true");
      panel.moveToAnchor(tab, position, x, y);
    } else {
      panel.removeAttribute(OPEN_ATTR);
      panel.openPopup(tab, this.#position(tab));
    }
    WhimsyHoverCards.tabPicture(win, tab).then(node => {
      if (node && !signal.aborted) {
        WhimsyHoverCards.fillPicture(card, node);
      }
    });
    if (describe && (await lazy.WhimsyAIPage.canDescribe()) && !signal.aborted) {
      WhimsyHoverCards.fillDescription(win, card, { loading: true });
      lazy.WhimsyAIPage.describeTab(tab, { signal })
        .then(found => !signal.aborted && WhimsyHoverCards.fillSummary(win, card, found))
        .catch(() => !signal.aborted && WhimsyHoverCards.fillDescription(win, card, { note: "failed" }));
    }
  }

  // Beside the tab, away from the window's edge: right of a sidebar on the
  // left, left of one on the right, under tabs along the top, with a small
  // gap (the popup's shadow room is outside the card, see whimsy-ai.css).
  #position(tab) {
    if (!this.win.gBrowser.tabContainer.verticalMode) {
      return { position: "after_start", x: 0, y: TAB_GAP_PX };
    }
    const box = tab.getBoundingClientRect();
    return box.left + box.width / 2 < this.win.innerWidth / 2
      ? { position: "end_before", x: TAB_GAP_PX, y: 0 }
      : { position: "start_before", x: -TAB_GAP_PX, y: 0 };
  }

  hide() {
    this.win.clearTimeout(this.timer);
    this.win.clearTimeout(this.leaveTimer);
    this.timer = 0;
    this.tab = null;
    this.controller?.abort();
    this.controller = null;
    const panel = this.panel;
    if (panel && panel.state != "closed") {
      panel.hidePopup();
    }
  }

  destroy() {
    this.hide();
    const win = this.win;
    win.removeEventListener("TabHoverStart", this.onStart);
    win.removeEventListener("TabHoverEnd", this.onEnd);
    win.removeEventListener("TabSelect", this.onDismiss);
    win.removeEventListener("TabClose", this.onDismiss);
    win.removeEventListener("blur", this.onDismiss);
    win.removeEventListener("keydown", this.onDismiss, true);
    win.removeEventListener("popupshowing", this.onPopup, true);
    Services.prefs.removeObserver(PREF, this.onPref);
    Services.prefs.removeObserver(AI_PREF, this.onPref);
    this.panel?.remove();
    tabHovers.delete(win);
  }
}
