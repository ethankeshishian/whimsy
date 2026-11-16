/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W29 side panels (intake-w29/designs/side-panels.md, v2): an Essential
// opens in a floating popover next to the sidebar instead of becoming the
// page. On by default for every Essential (owner, W29: "Make essentials
// popover by default"); its menu's Open in Side Panel checkmark, unchecked,
// makes it a normal tab again. The popover is the Essential's own tab panel
// (.browserSidebarContainer), floated over the page the way Glance floats
// a live browser, so nothing reloads or reparents. Chat can use the same
// spot (whimsy.chat.popover, WhimsyChatPanel.sys.mjs); the popover holds one
// thing at a time.
//
// It hides on a click in the page (the click still reaches the page), a
// click on its tile, the header's hide button, a tab switch, or a Glance
// opening. Esc never hides it: Esc belongs to the site.
//
// Resizable (owner, W29: "It's resizable too"): a grip on the page-side
// edge, 320px to half the window like chat (WhimsyChatPanel.sys.mjs:436-442),
// remembered per site (by host) in whimsy.side-panel.widths.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  SessionStore: "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
  WhimsyTabs: "resource:///modules/whimsy/WhimsyTabs.sys.mjs",
  WhimsyUserAgent: "resource:///modules/whimsy/WhimsyUserAgent.sys.mjs",
  PRESETS: "resource:///modules/whimsy/WhimsyUserAgent.sys.mjs",
});

const HTML_NS = "http://www.w3.org/1999/xhtml";
const SHEET = "chrome://browser/content/whimsy/whimsy-side-panel.css";
// The header and hide button are chat's (whimsy-chat.css:175-230).
const CHAT_SHEET = "chrome://browser/content/whimsy/whimsy-chat.css";
const FEATURE_PREF = "whimsy.feature.side-panels";
const WIDTHS_PREF = "whimsy.side-panel.widths";
// Every Essential opens in the popover unless this is set (on every
// window's copy), as Show Unread Badge stores its opt-out
// (WhimsyTabs.sys.mjs, HIDE_BADGE_KEY).
const OFF_ATTR = "whimsy-side-panel-off";
const OFF_KEY = "whimsy-side-panel-off";
const MENU_ID = "context_whimsySidePanel";
// On the tab panel while it floats.
const SHOW_ATTR = "whimsy-popover";
const HEAD_CLASS = "whimsy-side-panel-head";
const GRIP_CLASS = "whimsy-side-panel-grip";

// Chat's widths and gap (WhimsyChatPanel.sys.mjs:44-49).
const DEFAULT_WIDTH = 380;
const MIN_WIDTH = 320;
const NARROW_WINDOW = 1000;
const DUR_FADE = 150;

const managers = new WeakMap();

const featureOn = () => Services.prefs.getBoolPref(FEATURE_PREF, true);

function reducedMotion(win) {
  return win.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function cssMs(value) {
  const v = (value ?? "").trim();
  return v.endsWith("ms") ? parseFloat(v) : parseFloat(v) * 1000;
}

function loadSheet(win, url) {
  try {
    win.windowUtils.loadSheetUsingURIString(url, win.windowUtils.AUTHOR_SHEET);
  } catch (e) {
    // Already loaded in this window.
  }
}

function readWidths() {
  try {
    const value = JSON.parse(Services.prefs.getStringPref(WIDTHS_PREF, "{}"));
    return value && typeof value == "object" ? value : {};
  } catch (e) {
    return {};
  }
}

function hostOf(tab) {
  try {
    return tab.linkedBrowser?.currentURI?.host || "";
  } catch (e) {
    return "";
  }
}

class SidePanel {
  constructor(win) {
    this.win = win;
    this.doc = win.document;
    // The Essential showing, or null.
    this.tab = null;
    // The chat panel while it shows in the popover (WhimsyChatPanel).
    this.chat = null;
    this.lastPage = null;
    // Essentials this module made undiscardable, so only those are let go.
    this.keptAlive = new WeakSet();
    this.pressed = null;
  }

  // ---- Which Essentials open here ----

  isOn(tab) {
    return !!tab?.hasAttribute?.("zen-essential") && !tab.hasAttribute(OFF_ATTR);
  }

  routes(tab) {
    return featureOn() && !lazy.PrivateBrowsingUtils.isWindowPrivate(this.win) && this.isOn(tab) && !tab.closing;
  }

  // Turns the popover on or off for one Essential, on every window's copy.
  setOn(tab, on) {
    for (const copy of [tab, ...lazy.WhimsyTabs.copiesOf(tab)]) {
      copy.toggleAttribute(OFF_ATTR, !on);
      try {
        if (on) {
          lazy.SessionStore.deleteCustomTabValue(copy, OFF_KEY);
        } else {
          lazy.SessionStore.setCustomTabValue(copy, OFF_KEY, "true");
        }
      } catch (e) {
        // A tab the session store doesn't know yet.
      }
      const panel = managers.get(copy.documentGlobal);
      if (!on) {
        panel?.letGo(copy);
      }
    }
    if (on && tab.selected) {
      // Checking it while on it: the tab you were on before comes back.
      const back = this.lastPage?.isConnected && !this.lastPage.closing ? this.lastPage : this.win.gBrowser._findTabToBlurTo(tab);
      if (back && back != tab) {
        this.win.gBrowser.selectedTab = back;
      }
    } else if (!on && this.tab == tab) {
      this.hide();
    }
    return on;
  }

  // An Essential switched off: it goes back to Firefox's rules.
  letGo(tab) {
    if (this.tab == tab) {
      this.hide({ animate: false });
    }
    if (this.keptAlive.has(tab)) {
      this.keptAlive.delete(tab);
      tab.undiscardable = false;
    }
    this.clearPhone(tab);
  }

  // ---- Show and hide ----

  container(tab) {
    return tab?.linkedBrowser?.closest?.(".browserSidebarContainer") ?? null;
  }

  get side() {
    return this.doc.documentElement.getAttribute("zen-right-side") == "true" ? "right" : "left";
  }

  width(tab) {
    const max = Math.floor(this.win.innerWidth / 2);
    if (this.win.innerWidth < NARROW_WINDOW) {
      return MIN_WIDTH;
    }
    const saved = this.dragWidth ?? readWidths()[hostOf(tab)] ?? DEFAULT_WIDTH;
    return Math.max(MIN_WIDTH, Math.min(saved, max));
  }

  layout() {
    const box = this.container(this.tab);
    if (!box) {
      return;
    }
    box.setAttribute("side", this.side);
    box.style.setProperty("--whimsy-side-panel-width", `${this.width(this.tab)}px`);
  }

  // The site's page lives in another window (Zen's window sync): that
  // window's copy holds it, so this click selects it as a page, which moves
  // it here (see the handback: a deviation from design step 9).
  pageElsewhere(tab) {
    return lazy.WhimsyTabs.contentOwner(tab) != tab;
  }

  toggle(tab) {
    if (this.tab == tab) {
      this.hide();
    } else {
      this.show(tab);
    }
  }

  show(tab) {
    const { win } = this;
    const previous = this.tab;
    if (previous == tab) {
      return;
    }
    // One thing at a time: chat steps aside.
    this.chat?.close({ reason: "popover" });
    if (!tab.linkedPanel) {
      win.gBrowser._insertBrowser(tab);
    }
    const browser = tab.linkedBrowser;
    const box = this.container(tab);
    if (!box) {
      return;
    }
    const changed = this.setPhone(tab);
    if (tab.hasAttribute("pending")) {
      // A pending tab's reload restores its saved page (as
      // WhimsyTabs.wakeEssentials does), now with the phone user agent.
      tab._zenContentsVisible = true;
      browser.reload();
    } else if (changed && browser.currentURI?.spec != "about:blank") {
      browser.reload();
    }
    tab._zenContentsVisible = true;
    if (!tab.undiscardable) {
      tab.undiscardable = true;
      this.keptAlive.add(tab);
    }
    this.tab = tab;
    this.buildChrome(tab, box);
    this.layout();
    box.setAttribute(SHOW_ATTR, "true");
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-label", hostOf(tab) || tab.label);
    // As Glance and split view keep a background browser painting
    // (ZenGlanceManager.mjs:1445-1447).
    browser.zenModeActive = true;
    browser.docShellIsActive = true;
    // The tile takes the selected look while it shows (tab.mjs inherits
    // selected=visuallyselected onto its parts).
    tab.setAttribute("visuallyselected", "true");
    if (previous) {
      this.release(previous, { animate: true, crossfade: true });
      this.animate(box, "swap");
    } else {
      this.animate(box, "in");
    }
    browser.focus();
    win.dispatchEvent(new win.CustomEvent("WhimsySidePanelShown", { detail: { tab } }));
  }

  hide({ animate = true } = {}) {
    const tab = this.tab;
    if (!tab) {
      return;
    }
    this.tab = null;
    const box = this.container(tab);
    const hadFocus = !!box?.contains(this.doc.activeElement);
    this.release(tab, { animate });
    if (hadFocus && !tab.selected) {
      this.win.gBrowser.selectedBrowser?.focus();
    }
    this.win.dispatchEvent(new this.win.CustomEvent("WhimsySidePanelHidden", { detail: { tab } }));
  }

  release(tab, { animate, crossfade = false }) {
    const box = this.container(tab);
    const browser = tab.linkedBrowser;
    if (!tab.selected) {
      tab.removeAttribute("visuallyselected");
    }
    if (browser) {
      browser.zenModeActive = false;
      browser.docShellIsActive = tab.selected;
    }
    if (!box) {
      return;
    }
    const done = () => {
      if (this.tab == tab) {
        return;
      }
      box.removeAttribute(SHOW_ATTR);
      box.removeAttribute("role");
      box.removeAttribute("aria-label");
      box.removeAttribute("side");
      box.style.removeProperty("--whimsy-side-panel-width");
      box.querySelector(`:scope > .${HEAD_CLASS}`)?.setAttribute("hidden", "true");
      box.querySelector(`:scope > .${GRIP_CLASS}`)?.setAttribute("hidden", "true");
      for (const a of box.getAnimations()) {
        a.cancel();
      }
    };
    if (!animate || tab.selected) {
      done();
      return;
    }
    this.animate(box, crossfade ? "fade-out" : "out").then(done);
  }

  panelMotion() {
    const style = this.win.getComputedStyle(this.doc.documentElement);
    return {
      in: {
        duration: cssMs(style.getPropertyValue("--whimsy-dur-panel")) || 0,
        easing: style.getPropertyValue("--whimsy-ease-panel").trim() || "linear",
      },
      out: {
        duration: cssMs(style.getPropertyValue("--whimsy-dur-panel-exit")) || 0,
        easing: style.getPropertyValue("--whimsy-ease-panel-exit").trim() || "ease",
      },
    };
  }

  // Open: a fade and a scale from 96% (origin on the sidebar edge, in
  // CSS); close: the reverse, shorter; a swap: a 150ms crossfade. Reduce
  // Motion: opacity only (design section 9).
  animate(box, kind) {
    for (const a of box.getAnimations()) {
      a.cancel();
    }
    const motion = this.panelMotion();
    const reduce = reducedMotion(this.win);
    let keyframes;
    let options;
    if (kind == "swap" || kind == "fade-out") {
      keyframes = { opacity: kind == "swap" ? [0, 1] : [1, 0] };
      options = { duration: DUR_FADE, easing: "linear" };
    } else if (kind == "in") {
      keyframes = reduce ? { opacity: [0, 1] } : { opacity: [0, 1], scale: [0.96, 1] };
      options = { duration: motion.in.duration, easing: reduce ? "linear" : motion.in.easing };
    } else {
      keyframes = reduce ? { opacity: [1, 0] } : { opacity: [1, 0], scale: [1, 0.96] };
      options = { duration: motion.out.duration, easing: reduce ? "linear" : motion.out.easing };
    }
    const fill = kind == "out" || kind == "fade-out" ? "forwards" : "none";
    const anim = box.animate(keyframes, { ...options, fill });
    return anim.finished.then(() => {}, () => {});
  }

  // The header (favicon, host, hide button last) and the grip, built once
  // per tab panel from chat's parts.
  buildChrome(tab, box) {
    const { doc } = this;
    let head = box.querySelector(`:scope > .${HEAD_CLASS}`);
    if (!head) {
      const h = (tag, cls) => {
        const el = doc.createElementNS(HTML_NS, tag);
        if (cls) {
          el.className = cls;
        }
        return el;
      };
      head = h("header", `whimsy-chat-head ${HEAD_CLASS}`);
      const favicon = h("img", "whimsy-side-panel-favicon");
      favicon.setAttribute("alt", "");
      const title = h("h2", "whimsy-side-panel-host");
      const hide = h("button", "whimsy-chat-btn whimsy-side-panel-hide");
      doc.l10n.setAttributes(hide, "whimsy-side-panel-hide-button");
      const glyph = h("span", "whimsy-chat-icon");
      glyph.dataset.icon = "chat-hide";
      glyph.setAttribute("aria-hidden", "true");
      hide.append(glyph);
      hide.addEventListener("click", () => this.hide());
      head.append(favicon, title, hide);
      // Above the page: the panel stacks its parts top to bottom while it
      // floats (whimsy-side-panel.css).
      box.prepend(head);

      const grip = h("div", GRIP_CLASS);
      grip.setAttribute("role", "separator");
      grip.setAttribute("aria-orientation", "vertical");
      doc.l10n.setAttributes(grip, "whimsy-side-panel-splitter");
      grip.addEventListener("mousedown", e => this.startDrag(e));
      grip.addEventListener("dblclick", () => this.resetWidth());
      box.append(grip);
    }
    head.removeAttribute("hidden");
    box.querySelector(`:scope > .${GRIP_CLASS}`)?.removeAttribute("hidden");
    this.updateHeader(tab);
  }

  updateHeader(tab) {
    const head = this.container(tab)?.querySelector(`:scope > .${HEAD_CLASS}`);
    if (!head) {
      return;
    }
    const host = hostOf(tab);
    head.querySelector(".whimsy-side-panel-host").textContent = host || tab.label;
    const image = tab.getAttribute("image") || "";
    const favicon = head.querySelector(".whimsy-side-panel-favicon");
    if (image) {
      favicon.src = image;
      favicon.hidden = false;
    } else {
      favicon.removeAttribute("src");
      favicon.hidden = true;
    }
    this.container(tab)?.setAttribute("aria-label", host || tab.label);
  }

  // ---- Resize: chat's drag (WhimsyChatPanel.sys.mjs:468-550) ----

  startDrag(event) {
    if (event.button != 0 || !this.tab) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (event.detail >= 2) {
      this.resetWidth();
      return;
    }
    const { win } = this;
    const tab = this.tab;
    const grip = event.currentTarget;
    const startX = event.screenX;
    const startWidth = this.width(tab);
    const dir = this.side == "left" ? 1 : -1;
    let moved = false;
    let frame = 0;
    let lastX = startX;
    let ended = false;
    grip.setAttribute("resizing", "true");
    const apply = () => {
      frame = 0;
      if (ended) {
        return;
      }
      this.dragWidth = startWidth + (lastX - startX) * dir;
      this.layout();
    };
    const move = e => {
      if (ended) {
        return;
      }
      if (e.screenX != startX) {
        moved = true;
      }
      lastX = e.screenX;
      frame ||= win.requestAnimationFrame(apply);
    };
    const up = e => {
      if (ended) {
        return;
      }
      ended = true;
      lastX = e.screenX;
      win.removeEventListener("mousemove", move, true);
      win.removeEventListener("mouseup", up, true);
      grip.removeAttribute("resizing");
      if (frame) {
        win.cancelAnimationFrame(frame);
        frame = 0;
      }
      if (moved) {
        this.dragWidth = startWidth + (lastX - startX) * dir;
        this.saveWidth(tab, this.width(tab));
      }
      this.dragWidth = null;
      this.layout();
    };
    win.addEventListener("mousemove", move, true);
    win.addEventListener("mouseup", up, true);
  }

  saveWidth(tab, width) {
    const host = hostOf(tab);
    if (!host) {
      return;
    }
    const widths = readWidths();
    widths[host] = Math.round(width);
    Services.prefs.setStringPref(WIDTHS_PREF, JSON.stringify(widths));
  }

  resetWidth() {
    const host = this.tab && hostOf(this.tab);
    if (!host) {
      return;
    }
    const widths = readWidths();
    delete widths[host];
    Services.prefs.setStringPref(WIDTHS_PREF, JSON.stringify(widths));
    this.layout();
  }

  // ---- Phone-sized layout (design section 4) ----

  // Gives the tab's page Whimsy's iPhone preset; returns whether it changed.
  setPhone(tab) {
    const browser = tab.linkedBrowser;
    const ua = lazy.PRESETS["safari-iphone"];
    if (!browser) {
      return false;
    }
    browser._whimsySidePanelUA = ua;
    const bc = browser.browsingContext;
    if (!bc || bc.customUserAgent == ua) {
      return false;
    }
    bc.customUserAgent = ua;
    return true;
  }

  // The same site as a normal tab is desktop again (or its own Pretend to
  // Be choice), reloaded once if that changes what it's sent.
  clearPhone(tab) {
    const browser = tab.linkedBrowser;
    if (!browser?._whimsySidePanelUA) {
      return;
    }
    delete browser._whimsySidePanelUA;
    const bc = browser.browsingContext;
    if (!bc) {
      return;
    }
    const before = bc.customUserAgent || "";
    lazy.WhimsyUserAgent.applyTo(bc, hostOf(tab));
    if ((bc.customUserAgent || "") != before && !tab.hasAttribute("pending") && browser.currentURI?.spec != "about:blank") {
      browser.reload();
    }
  }

  // ---- Chat in the popover (whimsy.chat.popover) ----

  chatShown(chat) {
    if (this.tab) {
      this.hide({ animate: false });
    }
    this.chat = chat;
  }

  chatHidden(chat) {
    if (this.chat == chat) {
      this.chat = null;
    }
  }

  // ---- Clicks ----

  // A plain click on a switched-on Essential's tile, not on one of its
  // buttons: the popover's, not the tab strip's.
  tileFor(event) {
    if (event.button != 0 || event.shiftKey || event.altKey || event.getModifierState("Accel") || event.ctrlKey) {
      return null;
    }
    const target = event.target;
    const tab = target?.closest?.(".tabbrowser-tab");
    if (!tab || !this.routes(tab)) {
      return null;
    }
    if (target.closest(".tab-close-button, .tab-reset-button, .tab-reset-pin-button, .tab-icon-overlay, .tab-audio-button")) {
      return null;
    }
    // On it as a page already, or its page is in another window: a click
    // stays a click.
    if (tab.selected || (this.tab != tab && this.pageElsewhere(tab))) {
      return null;
    }
    return tab;
  }

  onMouseDown(event) {
    this.pressed = null;
    const tile = this.tileFor(event);
    if (tile) {
      // Not preventDefault: dragging the tile still works.
      event.stopPropagation();
      this.pressed = tile;
      return;
    }
    // Light dismiss: a click in the page hides the popover, and still
    // reaches the page.
    const panels = this.doc.getElementById("tabbrowser-tabpanels");
    const target = event.target;
    if (!panels?.contains(target)) {
      return;
    }
    if (this.tab && !this.container(this.tab)?.contains(target)) {
      this.hide();
    }
    if (this.chat) {
      this.chat.close({ reason: "page" });
    }
  }

  onClick(event) {
    const tile = this.pressed;
    if (!tile || event.button != 0) {
      return;
    }
    this.pressed = null;
    if (!tile.contains(event.target)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.toggle(tile);
  }

  // ---- The menu item and command ----

  // The command acts on the Essential showing, else the selected one.
  target() {
    const tab = this.tab ?? this.win.gBrowser.selectedTab;
    return featureOn() && tab?.hasAttribute("zen-essential") ? tab : null;
  }

  updateMenu() {
    const { doc, win } = this;
    const tab = win.TabContextMenu?.contextTab;
    let item = doc.getElementById(MENU_ID);
    const show = featureOn() && !!tab?.hasAttribute("zen-essential") && !tab.multiselected;
    if (!show) {
      if (item) {
        item.hidden = true;
      }
      return;
    }
    if (!item) {
      item = doc.createXULElement("menuitem");
      item.id = MENU_ID;
      item.setAttribute("type", "checkbox");
      doc.l10n.setAttributes(item, "tab-context-whimsy-side-panel");
      item.addEventListener("command", () => {
        const contextTab = win.TabContextMenu?.contextTab;
        if (contextTab?.hasAttribute("zen-essential")) {
          this.setOn(contextTab, !this.isOn(contextTab));
        }
      });
      // Directly under Show Unread Badge (design section 1).
      const anchor = doc.getElementById("context_whimsyUnreadBadge") ?? doc.getElementById("context_zen-remove-essential");
      if (anchor) {
        anchor.after(item);
      } else {
        doc.getElementById("tabContextMenu").appendChild(item);
      }
    } else if (item.previousElementSibling?.id != "context_whimsyUnreadBadge") {
      doc.getElementById("context_whimsyUnreadBadge")?.after(item);
    }
    item.hidden = false;
    if (this.isOn(tab)) {
      item.setAttribute("checked", "true");
    } else {
      item.removeAttribute("checked");
    }
  }

  // ---- Wiring ----

  init() {
    const { win, doc } = this;
    const gBrowser = win.gBrowser;
    loadSheet(win, CHAT_SHEET);
    loadSheet(win, SHEET);

    const restore = tab => {
      let off = false;
      try {
        off = lazy.SessionStore.getCustomTabValue(tab, OFF_KEY) == "true";
      } catch (e) {}
      tab.toggleAttribute(OFF_ATTR, off);
    };
    win.addEventListener("SSTabRestoring", event => restore(event.target));
    win.gZenWorkspaces?.promiseInitialized?.then(() => {
      for (const tab of win.gZenWorkspaces?.allStoredTabs ?? gBrowser.tabs) {
        restore(tab);
      }
    });

    const selected = gBrowser.selectedTab;
    if (selected && !selected.hasAttribute("zen-essential")) {
      this.lastPage = selected;
    }
    const onSelect = event => {
      const tab = event.target;
      if (!tab.hasAttribute("zen-essential") && !tab.hasAttribute("zen-glance-tab")) {
        this.lastPage = tab;
      }
      if (this.tab) {
        // Selected itself (Open in Tab): it's the page now, at once.
        this.hide({ animate: this.tab != tab });
      }
      this.chat?.close({ reason: "tab" });
      if (tab.hasAttribute("zen-essential")) {
        this.clearPhone(tab);
      }
    };
    const onClose = event => {
      if (event.target == this.tab) {
        this.hide({ animate: false });
      }
      if (event.target == this.lastPage) {
        this.lastPage = null;
      }
    };
    const onAttr = event => {
      if (event.target == this.tab) {
        this.updateHeader(this.tab);
      }
    };
    const onGlance = () => {
      this.hide();
      this.chat?.close({ reason: "glance" });
    };
    const onResize = () => this.tab && this.layout();
    const onMouseDown = e => this.onMouseDown(e);
    const onClick = e => this.onClick(e);
    gBrowser.tabContainer.addEventListener("TabSelect", onSelect);
    gBrowser.tabContainer.addEventListener("TabClose", onClose);
    gBrowser.tabContainer.addEventListener("TabAttrModified", onAttr);
    win.addEventListener("GlanceOpen", onGlance);
    win.addEventListener("resize", onResize);
    win.addEventListener("mousedown", onMouseDown, true);
    win.addEventListener("click", onClick, true);
    const onPref = () => {
      if (!featureOn() && this.tab) {
        this.hide({ animate: false });
      }
    };
    Services.prefs.addObserver(FEATURE_PREF, onPref);
    const onWidths = () => this.tab && this.layout();
    Services.prefs.addObserver(WIDTHS_PREF, onWidths);
    win.addEventListener(
      "unload",
      () => {
        Services.prefs.removeObserver(FEATURE_PREF, onPref);
        Services.prefs.removeObserver(WIDTHS_PREF, onWidths);
      },
      { once: true }
    );

    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsySidePanel",
      l10nId: "whimsy-action-side-panel",
      run: () => {
        const tab = this.target();
        if (!tab) {
          return;
        }
        if (this.isOn(tab)) {
          // Open in Tab: off, and it's the page.
          this.setOn(tab, false);
          gBrowser.selectedTab = tab;
        } else {
          this.setOn(tab, true);
        }
      },
      icon: "chrome://browser/skin/zen-icons/essential-add.svg",
      variants: [
        { l10nId: "whimsy-action-open-in-side-panel", isAvailable: () => !!this.target() && !this.isOn(this.target()) },
        { l10nId: "whimsy-action-open-in-tab", isAvailable: () => !!this.target() && this.isOn(this.target()) },
      ],
    });
    const menu = doc.getElementById("tabContextMenu");
    menu?.addEventListener("popupshowing", event => {
      if (event.target == menu) {
        this.updateMenu();
      }
    });
  }
}

export const WhimsySidePanel = {
  OFF_ATTR,
  OFF_KEY,
  WIDTHS_PREF,
  DEFAULT_WIDTH,
  MIN_WIDTH,

  get enabled() {
    return featureOn();
  },

  forWindow(win) {
    let panel = managers.get(win);
    if (!panel) {
      panel = new SidePanel(win);
      managers.set(win, panel);
    }
    return panel;
  },

  initWindow(win) {
    if (!win.gBrowser || managers.has(win)) {
      return;
    }
    this.forWindow(win).init();
  },
};
