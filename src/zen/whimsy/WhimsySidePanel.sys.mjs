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
// Floats across page clicks and tab switches. Minimize keeps the live page;
// Expand selects it once without changing its Essential routing preference.
// Width, height, and position are remembered per host.

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

  geometry(tab) {
    const entry = readWidths()[hostOf(tab)];
    const saved = typeof entry == "number" ? { width: entry } : entry ?? {};
    const panels = this.doc.getElementById("tabbrowser-tabpanels");
    const available = panels.clientHeight;
    const maxHeight = Math.max(0, available - 40);
    const height = Math.max(Math.min(320, maxHeight), Math.min(this.dragSize?.height ?? saved.height ?? 680, maxHeight));
    const width = Math.min(Math.max(0, panels.clientWidth - 40), this.win.innerWidth < NARROW_WINDOW ? MIN_WIDTH :
      Math.max(MIN_WIDTH, Math.min(this.dragSize?.width ?? saved.width ?? DEFAULT_WIDTH, Math.floor(this.win.innerWidth / 2))));
    const top = Math.max(20, Math.min(this.dragSize?.top ?? saved.top ?? (available - height) / 2, available - height - 20));
    const docked = this.side == "right" ? panels.clientWidth - width - 20 : 20;
    const left = Math.max(20, Math.min(this.dragSize?.left ?? saved.left ?? docked, panels.clientWidth - width - 20));
    return { width, height, top, left };
  }

  width(tab) {
    return this.geometry(tab).width;
  }

  layout() {
    const box = this.container(this.tab);
    if (!box) {
      return;
    }
    box.setAttribute("side", this.side);
    const size = this.geometry(this.tab);
    for (const key of ["width", "height", "top", "left"]) {
      box.style.setProperty(`--whimsy-side-panel-${key}`, `${size[key]}px`);
    }
    box.querySelector(".whimsy-side-panel-size").textContent = `${Math.round(size.width)} × ${Math.round(size.height)}`;
  }

  async expand() {
    const tab = this.tab;
    if (!tab || this.expanding) {
      return;
    }
    this.cancelDrag?.();
    const box = this.container(tab);
    const from = box.getBoundingClientRect();
    const to = this.doc.getElementById("tabbrowser-tabpanels").getBoundingClientRect();
    for (const a of box.getAnimations()) {
      a.cancel();
    }
    const expansion = {};
    this.expanding = expansion;
    box.setAttribute("expanding", "true");
    const reduce = reducedMotion(this.win);
    const frames = reduce ? { opacity: [1, 0] } : [
      { width: `${from.width}px`, height: `${from.height}px`, top: `${from.top - to.top}px`,
        left: `${from.left - to.left}px` },
      { width: `${to.width}px`, height: `${to.height}px`, top: "0px",
        left: "0px", borderRadius: "0px" },
    ];
    const animation = box.animate(frames, { duration: reduce ? 60 : 280,
      easing: "cubic-bezier(.32,.72,0,1)", fill: "forwards" });
    await animation.finished.catch(() => {});
    if (this.tab == tab && this.expanding == expansion) {
      this.hide({ animate: false });
      this.win.gBrowser.selectedTab = tab;
      this.clearPhone(tab);
      tab.linkedBrowser.focus();
      if (reduce) {
        box.animate({ opacity: [0, 1] }, { duration: 60 });
      }
    }
    animation.cancel();
    box.removeAttribute("expanding");
    if (this.expanding == expansion) {
      this.expanding = null;
    }
  }

  hasFocus() {
    return !!this.tab && !!this.container(this.tab)?.contains(this.doc.activeElement);
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
    this.cancelDrag?.();
    this.expanding = null;
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
    this.cancelDrag?.();
    this.expanding = null;
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
      for (const key of ["width", "height", "top", "left"]) {
        box.style.removeProperty(`--whimsy-side-panel-${key}`);
      }
      box.querySelector(`:scope > .${HEAD_CLASS}`)?.setAttribute("hidden", "true");
      for (const grip of box.querySelectorAll(`:scope > .${GRIP_CLASS}, :scope > .whimsy-side-panel-size`)) {
        grip.setAttribute("hidden", "true");
      }
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

  // The header (favicon, host, Expand, Minimize) and grips, built once
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
      glyph.dataset.icon = "minimize";
      glyph.setAttribute("aria-hidden", "true");
      hide.append(glyph);
      hide.addEventListener("click", () => this.hide());
      const expand = h("button", "whimsy-chat-btn whimsy-side-panel-expand");
      doc.l10n.setAttributes(expand, "whimsy-side-panel-expand-button");
      const expandGlyph = h("span", "whimsy-chat-icon");
      expandGlyph.dataset.icon = "expand";
      expandGlyph.setAttribute("aria-hidden", "true");
      expand.append(expandGlyph);
      expand.addEventListener("click", () => this.expand());
      head.addEventListener("mousedown", e => {
        if (!e.target.closest("button")) {
          this.startDrag(e, true);
        }
      });
      head.addEventListener("dblclick", e => {
        if (!e.target.closest("button")) {
          this.expand();
        }
      });
      head.append(favicon, title, expand, hide);
      // Above the page: the panel stacks its parts top to bottom while it
      // floats (whimsy-side-panel.css).
      box.prepend(head);

      for (const edge of ["e", "w", "n", "s", "ne", "nw", "se", "sw"]) {
        const grip = h("div", GRIP_CLASS);
        grip.dataset.edge = edge;
        grip.setAttribute("role", "separator");
        grip.setAttribute("aria-orientation", edge == "e" ? "vertical" : "horizontal");
        doc.l10n.setAttributes(grip, "whimsy-side-panel-splitter");
        grip.addEventListener("mousedown", e => this.startDrag(e));
        grip.addEventListener("dblclick", () => this.resetWidth());
        box.append(grip);
      }
      const size = h("div", "whimsy-side-panel-size");
      size.setAttribute("aria-hidden", "true");
      box.append(size);
    }
    head.removeAttribute("hidden");
    for (const grip of box.querySelectorAll(`:scope > .${GRIP_CLASS}, :scope > .whimsy-side-panel-size`)) {
      grip.removeAttribute("hidden");
    }
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

  startDrag(event, moving = false) {
    if (event.button != 0 || !this.tab || this.expanding) {
      return;
    }
    // Header clicks and double-clicks retain their normal behavior below 4px.
    if (!moving) {
      event.preventDefault();
      event.stopPropagation();
      if (event.detail >= 2) {
        this.resetWidth();
        return;
      }
    }
    this.cancelDrag?.();
    const { win } = this;
    const tab = this.tab;
    const box = this.container(tab);
    const grip = event.currentTarget;
    const edge = moving ? "" : grip.dataset.edge;
    // Keep the pointer origin fixed for this manipulation.
    const startX = event.screenX;
    const startY = event.screenY;
    const start = this.geometry(tab);
    const panels = this.doc.getElementById("tabbrowser-tabpanels");
    const clamp = (n, min, max) => Math.max(min, Math.min(n, max));
    let active = !moving;
    let ended = false;
    let shield;
    const activate = () => {
      for (const animation of box.getAnimations()) {
        animation.cancel();
      }
      // A chrome shield prevents remote content from receiving move/up events
      // even when the pointer leaves the header or crosses another browser.
      shield = this.doc.createElementNS(HTML_NS, "div");
      shield.className = "whimsy-side-panel-drag-shield";
      shield.style.cursor = moving ? "default" : win.getComputedStyle(grip).cursor;
      panels.append(shield);
      box.setAttribute(moving ? "moving" : "resizing", "true");
      grip.setAttribute("resizing", "true");
    };
    const apply = e => {
      if (ended) {
        return;
      }
      const dx = e.screenX - startX;
      const dy = e.screenY - startY;
      if (!active) {
        if (Math.hypot(dx, dy) < 4) {
          return;
        }
        active = true;
        activate();
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      const next = { ...start };
      if (moving) {
        next.left += dx;
        next.top += dy;
      } else {
        const minWidth = Math.min(MIN_WIDTH, panels.clientWidth - 40);
        const maxWidth = win.innerWidth < NARROW_WINDOW ? minWidth : Math.min(Math.floor(win.innerWidth / 2), panels.clientWidth - 40);
        if (edge.includes("w")) {
          next.width = clamp(start.width - dx, minWidth, Math.min(maxWidth, start.left + start.width - 20));
          next.left = start.left + start.width - next.width;
        } else if (edge.includes("e")) {
          next.width = clamp(start.width + dx, minWidth, Math.min(maxWidth, panels.clientWidth - start.left - 20));
        }
        const minHeight = Math.min(320, panels.clientHeight - 40);
        if (edge.includes("n")) {
          next.top = clamp(start.top + dy, 20, start.top + start.height - minHeight);
          next.height = start.height + start.top - next.top;
        } else if (edge.includes("s")) {
          next.height = clamp(start.height + dy, minHeight, panels.clientHeight - start.top - 20);
        }
      }
      this.dragSize = next;
      this.layout();
    };
    const finish = () => {
      if (ended) {
        return;
      }
      ended = true;
      win.removeEventListener("mousemove", apply, true);
      win.removeEventListener("mouseup", up, true);
      win.removeEventListener("blur", finish);
      shield?.remove();
      grip.removeAttribute("resizing");
      box.removeAttribute("resizing");
      box.removeAttribute("moving");
      this.dragSize = null;
      this.cancelDrag = null;
      if (this.tab == tab) {
        this.layout();
      }
    };
    const up = e => {
      try {
        if (active) {
          apply(e);
          this.saveGeometry(tab);
        }
      } finally {
        // A failed pref write must not leave the shield or listeners alive.
        finish();
      }
    };
    this.cancelDrag = finish;
    if (active) {
      activate();
    }
    win.addEventListener("mousemove", apply, true);
    win.addEventListener("mouseup", up, true);
    win.addEventListener("blur", finish);
  }

  saveGeometry(tab) {
    const host = hostOf(tab);
    if (host) {
      const widths = readWidths();
      widths[host] = Object.fromEntries(Object.entries(this.geometry(tab)).map(([key, value]) => [key, Math.round(value)]));
      Services.prefs.setStringPref(WIDTHS_PREF, JSON.stringify(widths));
    }
  }

  resetWidth() {
    this.cancelDrag?.();
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
    // Chat retains its existing light dismiss; Essentials float across clicks.
    const panels = this.doc.getElementById("tabbrowser-tabpanels");
    const target = event.target;
    if (!panels?.contains(target)) {
      return;
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

  // Zen assumes a Glance parent is the selected page. A floating Essential
  // is a background tab: #createBrowserElement writes parent._selected=true,
  // but selecting the child only deselects gBrowser's actual selected page.
  // Keep that temporary selection out of tileFor(), and restore the actual
  // page after Zen's close cleanup (which may select the Essential parent).
  hookGlance() {
    const manager = this.win.gZenGlanceManager;
    if (!manager) {
      return;
    }
    const panel = this;
    const open = manager.openGlance;
    manager.openGlance = function (data, existingTab, ownerTab) {
      const tab = panel.tab;
      if (!tab || panel.glanceSession || (ownerTab && ownerTab != tab) ||
          (!ownerTab && !panel.hasFocus() && panel.win.gContextMenu?.browser != tab.linkedBrowser)) {
        return open.call(this, data, existingTab, ownerTab);
      }
      const session = { tab, page: panel.win.gBrowser.selectedTab };
      panel.glanceSession = session;
      panel.pressed = null;
      let result;
      try {
        result = open.call(this, data, existingTab, tab);
      } catch (error) {
        panel.finishGlance(session);
        throw error;
      } finally {
        if (panel.win.gBrowser.selectedTab != tab) {
          tab._selected = false;
        }
      }
      return Promise.resolve(result).then(glance => {
        if (glance) {
          session.glance = glance;
        } else {
          panel.finishGlance(session);
        }
        return glance;
      }, error => {
        panel.finishGlance(session);
        throw error;
      });
    };
    const fullyOpen = manager.fullyOpenGlance;
    manager.fullyOpenGlance = async function (...args) {
      const session = panel.glanceSession;
      const result = await fullyOpen.apply(this, args);
      if (session && !session.tab.hasAttribute("glance-id")) {
        panel.finishGlance(session);
      }
      return result;
    };
    this.win.addEventListener("GlanceClose", event => {
      const session = this.glanceSession;
      if (session && (!session.glance || session.glance == event.target)) {
        // GlanceClose fires before #resetGlanceState removes the parent's ID.
        this.win.queueMicrotask(() => this.finishGlance(session));
      }
    });
  }

  finishGlance(session) {
    if (this.glanceSession != session) {
      return;
    }
    this.glanceSession = null;
    const { tab, page } = session;
    const browser = this.win.gBrowser;
    if (browser.selectedTab == tab && page?.isConnected && !page.closing) {
      browser.selectedTab = page;
    }
    if (browser.selectedTab != tab) {
      tab._selected = false;
    }
    this.pressed = null;
    if (tab.isConnected && !tab.closing && this.routes(tab) && !tab.selected) {
      this.show(tab);
    }
  }

  // ---- Wiring ----

  init() {
    const { win, doc } = this;
    const gBrowser = win.gBrowser;
    this.hookGlance();
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
      if (!this.glanceSession && (this.tab == tab || tab.hasAttribute("zen-glance-tab"))) {
        this.hide({ animate: false });
      } else if (this.tab) {
        // Tab selection deactivates background docshells; keep PiP painting.
        this.tab.linkedBrowser.zenModeActive = true;
        this.tab.linkedBrowser.docShellIsActive = true;
      }
      this.chat?.close({ reason: "tab" });
      if (tab.hasAttribute("zen-essential") && this.glanceSession?.tab != tab) {
        this.clearPhone(tab);
      }
    };
    const onClose = event => {
      if (event.target == this.glanceSession?.tab) {
        this.glanceSession = null;
      }
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
      this.hide({ animate: !this.glanceSession });
      if (this.glanceSession) {
        const browser = this.glanceSession.tab.linkedBrowser;
        browser.zenModeActive = true;
        browser.docShellIsActive = true;
      }
      this.chat?.close({ reason: "glance" });
    };
    const onResize = () => this.tab && this.layout();
    const onMouseDown = e => this.onMouseDown(e);
    const onClick = e => this.onClick(e);
    gBrowser.tabContainer.addEventListener("TabSelect", onSelect);
    gBrowser.tabContainer.addEventListener("TabClose", onClose);
    gBrowser.tabContainer.addEventListener("TabAttrModified", onAttr);
    win.addEventListener("GlanceOpen", onGlance);
    win.addEventListener("ZenWorkspaceChanged", () => {
      this.glanceSession = null;
      onGlance();
    });
    // Capture before Firefox's close-tab key/command. Remote browser focus is
    // represented by the browser element in the chrome document.
    win.addEventListener("keydown", e => {
      if (e.key.toLowerCase() == "w" && e.getModifierState("Accel") && !e.shiftKey && !e.altKey && this.hasFocus()) {
        e.preventDefault();
        e.stopImmediatePropagation();
        this.hide();
      }
    }, true);
    win.addEventListener("command", e => {
      if (e.target.id == "cmd_close" && this.hasFocus()) {
        e.preventDefault();
        e.stopImmediatePropagation();
        this.hide();
      }
    }, true);
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
        this.cancelDrag?.();
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
