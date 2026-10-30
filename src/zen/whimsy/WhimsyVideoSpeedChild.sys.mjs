/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave3/speed: a speed control on every video, shown while the pointer is
// over it (the Video Speed Controller extension's overlay, built in). It
// says the current speed ("1×"); click the number to type any speed (Enter
// applies, clamped to 0.25–4×, Escape cancels), or the arrow beside it for
// quarter steps from 0.25× to 4×. The speed you pick is remembered per site
// (WhimsyVideoSpeedParent) and applied to the site's next videos.
//
// The control is drawn in the document's anonymous content
// (insertAnonymousContent, like Screenshots): the page can't see or style
// it, it sits above the page (fullscreen players included) and it never
// changes the player's DOM. Pointer and key events aimed at it are stopped
// at the top of the event path, so a player never sees a click or a typed
// digit (YouTube seeks on digits) meant for the control.
//
// The actor starts with the first media event of a page; the pointer and
// key listeners never create it, so pages without video pay nothing.

import { clearTimeout, setTimeout } from "resource://gre/modules/Timer.sys.mjs";

const lazy = {};
ChromeUtils.defineLazyGetter(lazy, "l10n", () => new Localization(["browser/whimsy.ftl"], true));

const FEATURE_PREF = "whimsy.feature.video-speed";
const MIN_RATE = 0.25;
const MAX_RATE = 4;
const PRESETS = Array.from({ length: 16 }, (_, i) => (i + 1) / 4);
// Smaller videos (thumbnails, avatars, inline previews) get no control.
const MIN_WIDTH = 120;
const MIN_HEIGHT = 68;
const INSET = 8;
// The control fades after the pointer rests this long, like a player's own
// controls, and lingers this long after the pointer leaves the video.
const IDLE_MS = 2500;
const LEAVE_MS = 300;
// A player that puts the speed back to 1× this soon after Whimsy applied the
// site's speed (YouTube does on load) gets it applied once more.
const RESET_GRACE_MS = 1500;
const STYLESHEET = "chrome://browser/content/whimsy/whimsy-video-speed.css";
const MARKUP = `<template>
  <link rel="stylesheet" href="${STYLESHEET}"/>
  <div id="bar" hidden="">
    <button id="value" type="button"></button>
    <input id="input" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" hidden=""/>
    <button id="toggle" type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="menu">
      <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.75 5 6.75 8 3.75"/></svg>
    </button>
    <div id="menu" role="menu" hidden=""></div>
  </div>
</template>`;

export const clampRate = rate => Math.round(Math.min(MAX_RATE, Math.max(MIN_RATE, rate)) * 100) / 100;

// "1.5", "1,5", "1.5x", "1.5×" and " 2 " all read as speeds; anything else
// is NaN.
export function parseRate(text) {
  const cleaned = String(text).trim().replace(",", ".").replace(/\s*[x×]$/i, "");
  return /^\d*\.?\d+$/.test(cleaned) ? Number(cleaned) : NaN;
}

export class WhimsyVideoSpeedChild extends JSWindowActorChild {
  // Videos seen in this document (pruned when they leave it).
  videos = new Set();
  // Per video: the source the site's speed was applied to, and when.
  applied = new WeakMap();
  // The site's remembered speed, once asked for.
  siteRate = null;
  // The video the control is showing for.
  current = null;

  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  }

  handleEvent(event) {
    switch (event.type) {
      case "loadstart":
      case "loadedmetadata":
      case "play":
        this.onMedia(event);
        break;
      case "ratechange":
        this.onRateChange(event);
        break;
      case "mousemove":
        this.onPointer(event);
        break;
      case "mouseout":
        if (!event.relatedTarget && !this.busy) {
          this.scheduleHide(LEAVE_MS);
        }
        break;
      case "fullscreenchange":
        this.hide();
        break;
      case "pointerdown":
      case "mousedown":
      case "pointerup":
      case "mouseup":
      case "click":
      case "dblclick":
      case "contextmenu":
        this.onPointerButton(event);
        break;
      case "keydown":
      case "keypress":
      case "keyup":
        this.onKey(event);
        break;
    }
  }

  didDestroy() {
    this.clearTimers();
    if (this.anon) {
      try {
        this.document?.removeAnonymousContent(this.anon);
      } catch (e) {
        // The document is already gone.
      }
    }
    this.anon = null;
  }

  // --- Videos and the site's speed ---

  async onMedia(event) {
    const el = event.composedTarget ?? event.originalTarget;
    if (!this.enabled || !HTMLVideoElement.isInstance(el)) {
      return;
    }
    this.videos.add(el);
    if (this.siteRate === null) {
      try {
        this.siteRate = clampRate((await this.sendQuery("WhimsyVideoSpeed:Get")) || 1);
      } catch (e) {
        this.siteRate = 1;
      }
    }
    this.applySiteRate(el);
  }

  // The site's speed goes to each new source once, never over a speed the
  // page chose itself, and never to live streams (they can't run ahead).
  applySiteRate(el) {
    if (this.siteRate == 1 || !Number.isFinite(el.duration) || !el.currentSrc) {
      return;
    }
    const state = this.applied.get(el);
    if (state?.src == el.currentSrc) {
      return;
    }
    if (el.playbackRate != 1) {
      this.applied.set(el, { src: el.currentSrc, at: 0 });
      return;
    }
    this.applied.set(el, { src: el.currentSrc, at: ChromeUtils.now() });
    el.playbackRate = this.siteRate;
  }

  onRateChange(event) {
    const el = event.composedTarget ?? event.originalTarget;
    if (!HTMLVideoElement.isInstance(el) || !this.enabled) {
      return;
    }
    const state = this.applied.get(el);
    if (state?.at && el.playbackRate == 1 && this.siteRate != 1 && ChromeUtils.now() - state.at < RESET_GRACE_MS) {
      state.at = 0;
      el.playbackRate = this.siteRate;
      return;
    }
    if (el == this.current) {
      this.render();
    }
  }

  // The user picked a speed: play at it and remember it for the site.
  setRate(rate) {
    const el = this.current;
    if (!el || !Number.isFinite(rate)) {
      return;
    }
    rate = clampRate(rate);
    el.playbackRate = rate;
    this.siteRate = rate;
    this.applied.set(el, { src: el.currentSrc, at: 0 });
    this.sendAsyncMessage("WhimsyVideoSpeed:Set", { rate });
    this.render();
  }

  // The Cmd+Opt shortcuts (WhimsyPageChild) changed the speed: it's the
  // user's, so it's never put back, and the site's next videos follow it.
  userChanged(el, rate) {
    this.applied.set(el, { src: el.currentSrc, at: 0 });
    if (this.siteRate !== null) {
      this.siteRate = rate;
    }
  }

  // --- Showing the control ---

  // Whether the user is in the middle of using the control.
  get busy() {
    return !!this.anon && (!this.els.menu.hidden || !this.els.input.hidden);
  }

  inControl(node) {
    try {
      return !!node && !!this.anon && this.anon.root.contains(node);
    } catch (e) {
      return false;
    }
  }

  onPointer(event) {
    if (!this.enabled) {
      this.hide();
      return;
    }
    this.pointer = { x: event.clientX, y: event.clientY, inControl: this.inControl(event.originalTarget) };
    if (!this.frameQueued) {
      this.frameQueued = true;
      this.contentWindow?.requestAnimationFrame(() => {
        this.frameQueued = false;
        this.updateHover();
      });
    }
  }

  updateHover() {
    const point = this.pointer;
    if (!point || !this.contentWindow) {
      return;
    }
    if (point.inControl) {
      this.show(this.current);
      return;
    }
    const video = this.videoAt(point.x, point.y);
    if (video) {
      this.show(video);
    } else if (!this.busy) {
      this.scheduleHide(LEAVE_MS);
    }
  }

  // The smallest visible video under the point: an inline preview inside a
  // bigger player is the one meant.
  videoAt(x, y) {
    let best = null;
    let bestArea = Infinity;
    const fullscreen = this.document.fullscreenElement;
    for (const el of this.videos) {
      if (!el.isConnected) {
        this.videos.delete(el);
        continue;
      }
      if (fullscreen && fullscreen != el && !fullscreen.contains(el)) {
        continue;
      }
      const r = el.getBoundingClientRect();
      if (r.width < MIN_WIDTH || r.height < MIN_HEIGHT || x < r.left || x > r.right || y < r.top || y > r.bottom) {
        continue;
      }
      if (r.width * r.height < bestArea) {
        best = el;
        bestArea = r.width * r.height;
      }
    }
    return best;
  }

  show(video) {
    if (!video || !this.ensureControl()) {
      return;
    }
    clearTimeout(this.hideTimer);
    if (video != this.current) {
      this.closeMenu();
      this.cancelEdit();
      this.current = video;
    }
    this.place();
    this.render();
    if (this.sheetReady) {
      this.els.bar.toggleAttribute("data-shown", true);
    }
    this.keepAlive();
  }

  // (Re)starts the idle fade.
  keepAlive() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.busy) {
        this.keepAlive();
      } else if (!this.pointer?.inControl) {
        this.hide();
      }
    }, IDLE_MS);
  }

  // Gives the keyboard back to the page (Space plays and pauses again).
  release() {
    try {
      this.anon?.root.activeElement?.blur();
    } catch (e) {
      // Already gone.
    }
  }

  scheduleHide(ms) {
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => this.hide(), ms);
  }

  hide() {
    this.clearTimers();
    if (!this.anon) {
      return;
    }
    this.closeMenu();
    this.cancelEdit();
    this.els.bar.removeAttribute("data-shown");
  }

  clearTimers() {
    clearTimeout(this.hideTimer);
    clearTimeout(this.idleTimer);
  }

  place() {
    const r = this.current.getBoundingClientRect();
    const win = this.contentWindow;
    const left = Math.min(Math.max(r.left, 0) + INSET, Math.max(INSET, win.innerWidth - 120));
    const top = Math.min(Math.max(r.top, 0) + INSET, Math.max(INSET, win.innerHeight - 34));
    this.els.bar.style.left = `${Math.round(left)}px`;
    this.els.bar.style.top = `${Math.round(top)}px`;
  }

  format(rate) {
    this.numberFormat ??= new Intl.NumberFormat(Services.locale.appLocaleAsBCP47, { maximumFractionDigits: 2 });
    return `${this.numberFormat.format(rate)}×`;
  }

  render() {
    if (!this.anon || !this.current) {
      return;
    }
    const rate = this.current.playbackRate;
    const { value, menu } = this.els;
    value.textContent = this.format(rate);
    value.setAttribute("aria-label", this.strings.value.replace("{rate}", this.format(rate)));
    for (const item of menu.children) {
      item.setAttribute("aria-checked", String(Number(item.dataset.rate) == rate));
    }
  }

  // Builds the control in the document's anonymous content the first time a
  // video is hovered. Returns whether it's there.
  ensureControl() {
    if (this.anon && !Cu.isDeadWrapper(this.anon)) {
      return true;
    }
    const doc = this.document;
    let anon;
    try {
      anon = doc.insertAnonymousContent();
    } catch (e) {
      return false; // No presentation (a hidden document).
    }
    const parsed = new DOMParser().parseFromString(MARKUP, "text/html");
    const template = doc.importNode(parsed.querySelector("template"), true);
    anon.root.appendChild(template.content.cloneNode(true));
    const root = anon.root;
    this.anon = anon;
    this.els = {
      bar: root.getElementById("bar"),
      value: root.getElementById("value"),
      input: root.getElementById("input"),
      toggle: root.getElementById("toggle"),
      menu: root.getElementById("menu"),
    };
    this.strings = this.loadStrings();
    const { value, input, toggle, menu } = this.els;
    value.title = this.strings.valueTitle;
    input.setAttribute("aria-label", this.strings.input);
    input.title = this.strings.valueTitle;
    toggle.title = this.strings.presets;
    toggle.setAttribute("aria-label", this.strings.presets);
    menu.setAttribute("aria-label", this.strings.presets);
    for (const rate of PRESETS) {
      const item = doc.createElement("button");
      item.type = "button";
      item.setAttribute("role", "menuitemradio");
      item.dataset.rate = String(rate);
      item.textContent = this.format(rate);
      menu.appendChild(item);
    }
    root.querySelector("link").addEventListener(
      "load",
      () => {
        // Unhidden but transparent, so the first appearance fades in too.
        this.sheetReady = true;
        this.els.bar.hidden = false;
        if (this.pointer && this.current) {
          this.contentWindow?.requestAnimationFrame(() => this.updateHover());
        }
      },
      { once: true }
    );
    return true;
  }

  loadStrings() {
    const fallback = {
      value: "Playback speed {rate}",
      valueTitle: "Type a speed",
      input: "Playback speed",
      presets: "Speeds",
    };
    try {
      const [value, input, presets] = lazy.l10n.formatMessagesSync([
        { id: "whimsy-video-speed-value", args: { rate: "{rate}" } },
        { id: "whimsy-video-speed-input" },
        { id: "whimsy-video-speed-presets" },
      ]);
      const attr = (message, name) => message?.attributes?.find(a => a.name == name)?.value;
      return {
        value: attr(value, "aria-label") ?? fallback.value,
        valueTitle: attr(value, "title") ?? fallback.valueTitle,
        input: attr(input, "aria-label") ?? fallback.input,
        presets: attr(presets, "aria-label") ?? fallback.presets,
      };
    } catch (e) {
      return fallback;
    }
  }

  // --- Using the control ---

  // Pointer events on the control never reach the page (a click on a
  // player toggles play); the control acts on clicks itself.
  onPointerButton(event) {
    const target = event.originalTarget;
    if (!this.inControl(target)) {
      if (event.type == "mousedown" && this.busy) {
        this.closeMenu();
        this.cancelEdit();
      }
      return;
    }
    event.stopPropagation();
    this.keepAlive();
    if (event.type == "contextmenu" || event.type == "dblclick") {
      event.preventDefault();
    }
    if (event.type != "click" || event.button != 0) {
      return;
    }
    const button = target.closest?.("button") ?? target.parentElement?.closest("button");
    const { value, toggle, menu } = this.els;
    if (button == value) {
      this.startEdit();
    } else if (button == toggle) {
      if (menu.hidden) {
        this.openMenu();
      } else {
        this.closeMenu();
      }
    } else if (button?.parentElement == menu) {
      this.setRate(Number(button.dataset.rate));
      this.closeMenu();
      this.release();
    }
  }

  // Keys typed into the control never reach the page either (players
  // bind digits, arrows, Space and Escape); editing still works, it runs in
  // the system event group.
  onKey(event) {
    if (!this.inControl(event.originalTarget)) {
      // Escape closes the presets wherever the focus is.
      if (event.type == "keydown" && event.key == "Escape" && this.anon && !this.els.menu.hidden) {
        this.closeMenu();
      }
      return;
    }
    event.stopPropagation();
    if (event.type != "keydown") {
      return;
    }
    this.keepAlive();
    const { input, menu, toggle } = this.els;
    if (!input.hidden) {
      if (event.key == "Enter") {
        event.preventDefault();
        this.commitEdit();
      } else if (event.key == "Escape") {
        event.preventDefault();
        this.cancelEdit();
        this.release();
      }
      return;
    }
    if (!menu.hidden) {
      const items = [...menu.children];
      const index = items.indexOf(event.originalTarget.closest?.("button"));
      const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -4, ArrowDown: 4 }[event.key];
      if (step && index >= 0) {
        event.preventDefault();
        items[Math.min(items.length - 1, Math.max(0, index + step))].focus();
      } else if (event.key == "Escape") {
        event.preventDefault();
        this.closeMenu();
        this.release();
      }
      return;
    }
    if (event.key == "ArrowDown" && event.originalTarget == toggle) {
      event.preventDefault();
      this.openMenu();
    }
  }

  openMenu() {
    const { menu, toggle } = this.els;
    this.cancelEdit();
    this.render();
    menu.hidden = false;
    toggle.setAttribute("aria-expanded", "true");
    const checked = menu.querySelector('[aria-checked="true"]') ?? menu.children[3];
    checked.focus({ focusVisible: false });
  }

  closeMenu() {
    if (!this.anon || this.els.menu.hidden) {
      return;
    }
    this.els.menu.hidden = true;
    this.els.toggle.setAttribute("aria-expanded", "false");
  }

  startEdit() {
    const { value, input } = this.els;
    this.closeMenu();
    input.value = String(this.current.playbackRate);
    value.hidden = true;
    input.hidden = false;
    input.focus();
    input.select();
  }

  commitEdit() {
    const rate = parseRate(this.els.input.value);
    this.cancelEdit();
    if (Number.isFinite(rate) && rate > 0) {
      this.setRate(rate);
    }
    this.release();
  }

  cancelEdit() {
    if (!this.anon || this.els.input.hidden) {
      return;
    }
    this.els.input.hidden = true;
    this.els.value.hidden = false;
  }

  // For tests: what the control shows.
  testState() {
    if (!this.anon) {
      return { built: false, shown: false };
    }
    const { bar, value, input, menu } = this.els;
    const rect = el => {
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    };
    return {
      built: true,
      shown: bar.hasAttribute("data-shown") && !bar.hidden,
      text: value.textContent,
      editing: !input.hidden,
      menuOpen: !menu.hidden,
      checked: menu.querySelector('[aria-checked="true"]')?.dataset.rate ?? null,
      value: rect(value),
      toggle: rect(this.els.toggle),
      items: Object.fromEntries([...menu.children].map(item => [item.dataset.rate, rect(item)])),
      // Object keys reorder integer-like rates ("1" before "0.25"); keep the menu's order.
      itemOrder: [...menu.children].map(item => Number(item.dataset.rate)),
    };
  }
}
