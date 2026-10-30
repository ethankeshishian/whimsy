/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave5: Live blocks in Notes (Arc Easels' Live Captures, July 2022). A
// block is a sandboxed remote <browser> showing a cropped region of a page,
// in the same container the page's tab had. Pages load only while the block
// is on screen and the note is open, so a closed note costs nothing, and
// every open is a fresh load (the "refresh when the note opens" rule).

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
});

export const TAB_DROP_TYPE = "application/x-moz-tabbrowser-tab";
export const FEATURE_PREF = "whimsy.feature.note-blocks";

// The page lays out at a desktop width, then the crop is scaled to fit the
// block, like Arc's capture of a region of the page you were looking at.
export const PAGE_WIDTH = 1024;
export const PAGE_HEIGHT = 768;
// While picking a region the block shows more of the page.
export const PICK_HEIGHT = 1200;
// Drags smaller than this (page px) reset the crop to the whole page.
export const MIN_CROP = 24;

// No popups, pointer lock, autoplay-style automatic features, modals,
// orientation lock, presentation or downloads. Scripts, forms and storage stay
// so signed-in pages still work in their container.
export const BLOCK_SANDBOX_FLAGS = 0x2 | 0x40 | 0x100 | 0x800 | 0x2000 | 0x4000 | 0x10000;

export function blocksEnabled() {
  return Services.prefs.getBoolPref(FEATURE_PREF, false);
}

function isPrivateWindow(win) {
  return !!win && lazy.PrivateBrowsingUtils.isWindowPrivate(win);
}

// `/embed` alone embeds the current tab; `/embed <url>` embeds that address in
// the current tab's container.
export function parseEmbedCommand(line) {
  const match = /^\s*\/embed(?:\s+(\S+))?\s*$/i.exec(line ?? "");
  if (!match) {
    return null;
  }
  return { url: match[1] ?? null };
}

export function blockFromURL(url, { title = "", userContextId = 0, isPrivate = false } = {}) {
  if (isPrivate) {
    return { error: "whimsy-note-block-private" };
  }
  let uri;
  try {
    const spec = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;
    uri = Services.io.newURI(spec);
  } catch {
    return { error: "whimsy-note-block-unsupported" };
  }
  if (!uri.schemeIs("https") && !uri.schemeIs("http")) {
    return { error: "whimsy-note-block-unsupported" };
  }
  return {
    block: {
      id: Services.uuid.generateUUID().toString().slice(1, -1),
      url: uri.spec,
      title: title || uri.host,
      userContextId: userContextId || 0,
      crop: null,
      width: null,
    },
  };
}

export function blockFromTab(tab) {
  if (!tab?.linkedBrowser) {
    return { error: "whimsy-note-block-unsupported" };
  }
  const isPrivate =
    isPrivateWindow(tab.ownerGlobal) || lazy.PrivateBrowsingUtils.isBrowserPrivate(tab.linkedBrowser);
  return blockFromURL(tab.linkedBrowser.currentURI?.spec ?? "", {
    title: tab.label,
    userContextId: tab.userContextId,
    isPrivate,
  });
}

// Maps a selection made over the whole-page view (frame px) to page px.
export function cropFromSelection(rect, scale) {
  const crop = {
    x: Math.max(0, Math.round(rect.left / scale)),
    y: Math.max(0, Math.round(rect.top / scale)),
    w: Math.round(rect.width / scale),
    h: Math.round(rect.height / scale),
  };
  crop.w = Math.min(crop.w, PAGE_WIDTH - crop.x);
  crop.h = Math.min(crop.h, PICK_HEIGHT - crop.y);
  if (crop.w < MIN_CROP || crop.h < MIN_CROP) {
    return null;
  }
  return crop;
}

const BUTTONS = [
  ["crop", "screenshot"],
  ["reload", "reload"],
  ["open", "open"],
  ["remove", "close"],
];

class WhimsyNoteBlock extends HTMLElement {
  // Set by the Notes section before the element connects.
  block = null;
  onBlockChange = null;
  onBlockRemove = null;

  #browser = null;
  #frame = null;
  #stage = null;
  #picker = null;
  #picking = false;
  #visibility = null;
  #resize = null;
  #saveTimer = null;

  get browser() {
    return this.#browser;
  }

  get picking() {
    return this.#picking;
  }

  connectedCallback() {
    if (!this.block) {
      return;
    }
    const doc = this.ownerDocument;
    this.classList.add("whimsy-note-block");
    this.replaceChildren();

    const header = doc.createElement("div");
    header.className = "whimsy-note-block-header";
    const title = doc.createElement("span");
    title.className = "whimsy-note-block-title";
    title.textContent = this.block.title;
    title.title = this.block.url;
    header.append(title);
    for (const [action, icon] of BUTTONS) {
      const button = doc.createElement("button");
      button.className = "whimsy-note-block-button";
      button.dataset.action = action;
      doc.l10n.setAttributes(button, `whimsy-note-block-${action}`);
      const img = doc.createElement("img");
      img.src = `chrome://browser/skin/zen-icons/${icon}.svg`;
      img.alt = "";
      button.append(img);
      button.addEventListener("click", event => {
        event.stopPropagation();
        this.#onAction(action);
      });
      header.append(button);
    }

    this.#frame = doc.createElement("div");
    this.#frame.className = "whimsy-note-block-frame";
    if (this.block.width) {
      this.#frame.style.width = `${this.block.width}px`;
    }
    this.#stage = doc.createElement("div");
    this.#stage.className = "whimsy-note-block-stage";
    this.#frame.append(this.#stage);
    this.append(header, this.#frame);

    const win = doc.defaultView;
    this.#visibility = new win.IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) {
        this.#visibility?.disconnect();
        this.#visibility = null;
        this.#load();
      }
    });
    this.#visibility.observe(this.#frame);
    this.#resize = new win.ResizeObserver(() => {
      this.#layout();
      this.#saveWidthSoon();
    });
    this.#resize.observe(this.#frame);
    this.#layout();
  }

  disconnectedCallback() {
    this.#visibility?.disconnect();
    this.#resize?.disconnect();
    this.#visibility = this.#resize = null;
    clearTimeout(this.#saveTimer);
    this.#browser?.remove();
    this.#browser = null;
    this.#picking = false;
    this.removeAttribute("picking");
    this.replaceChildren();
  }

  #load() {
    if (this.#browser || !this.isConnected) {
      return;
    }
    const doc = this.ownerDocument;
    if (isPrivateWindow(doc.defaultView)) {
      // Never load a regular-session page inside a private window.
      const paused = doc.createElement("div");
      paused.className = "whimsy-note-block-paused";
      doc.l10n.setAttributes(paused, "whimsy-note-block-paused-private");
      this.#stage.replaceWith(paused);
      return;
    }
    const userContextId = this.block.userContextId || 0;
    const browser = doc.createXULElement("browser");
    browser.setAttribute("type", "content");
    browser.setAttribute("remote", "true");
    browser.setAttribute("maychangeremoteness", "true");
    browser.setAttribute("nodefaultsrc", "true");
    browser.setAttribute("disableglobalhistory", "true");
    browser.setAttribute("messagemanagergroup", "whimsy-note-blocks");
    browser.setAttribute("tooltip", "aHTMLTooltip");
    if (userContextId) {
      browser.setAttribute("usercontextid", String(userContextId));
    }
    browser.className = "whimsy-note-block-browser";
    this.#stage.append(browser);
    this.#browser = browser;
    if (browser.browsingContext) {
      browser.browsingContext.sandboxFlags |= BLOCK_SANDBOX_FLAGS;
    }
    browser.addEventListener("DidChangeBrowserRemoteness", () => {
      if (browser.browsingContext) {
        browser.browsingContext.sandboxFlags |= BLOCK_SANDBOX_FLAGS;
      }
    });
    browser.loadURI(Services.io.newURI(this.block.url), {
      triggeringPrincipal: Services.scriptSecurityManager.createNullPrincipal({ userContextId }),
      loadFlags: Ci.nsIWebNavigation.LOAD_FLAGS_BYPASS_HISTORY,
    });
    this.setAttribute("loaded", "true");
  }

  #view() {
    if (this.#picking || !this.block.crop) {
      return { x: 0, y: 0, w: PAGE_WIDTH, h: this.#picking ? PICK_HEIGHT : PAGE_HEIGHT };
    }
    return this.block.crop;
  }

  get scale() {
    return (this.#frame?.clientWidth || 280) / this.#view().w;
  }

  #layout() {
    if (!this.#frame) {
      return;
    }
    const view = this.#view();
    const scale = this.scale;
    const height = `${Math.round(view.h * scale)}px`;
    if (this.#frame.style.height != height) {
      this.#frame.style.height = height;
    }
    this.#stage.style.width = `${PAGE_WIDTH}px`;
    this.#stage.style.height = `${Math.max(view.y + view.h, PAGE_HEIGHT)}px`;
    this.#stage.style.transform = `scale(${scale}) translate(${-view.x}px, ${-view.y}px)`;
  }

  // The frame is resizable horizontally (CSS resize); remember the width the
  // person chose once they stop dragging.
  #saveWidthSoon() {
    clearTimeout(this.#saveTimer);
    if (!this.#frame?.style.width) {
      return;
    }
    this.#saveTimer = setTimeout(() => {
      const width = Math.round(this.#frame?.getBoundingClientRect().width ?? 0);
      if (width && width != this.block.width) {
        this.#change({ width });
      }
    }, 400);
  }

  #change(changes) {
    this.block = { ...this.block, ...changes };
    this.#layout();
    this.onBlockChange?.(this.block);
  }

  #onAction(action) {
    switch (action) {
      case "crop":
        this.togglePicking();
        break;
      case "reload":
        if (this.#browser) {
          this.#browser.reload();
        } else {
          this.#load();
        }
        break;
      case "open":
        this.ownerDocument.defaultView.openTrustedLinkIn(this.block.url, "tab", {
          userContextId: this.block.userContextId || 0,
        });
        break;
      case "remove":
        this.onBlockRemove?.(this.block);
        break;
    }
  }

  togglePicking(force = !this.#picking) {
    if (force == this.#picking) {
      return;
    }
    this.#picking = force;
    this.toggleAttribute("picking", force);
    this.#picker?.remove();
    this.#picker = null;
    if (force) {
      this.#picker = this.#createPicker();
      this.#frame.append(this.#picker);
      this.#picker.focus();
    }
    this.#layout();
  }

  // Applies a selection drawn over the whole-page view, in frame px.
  applySelection(rect) {
    const crop = cropFromSelection(rect, this.scale);
    this.togglePicking(false);
    this.#change({ crop });
  }

  #createPicker() {
    const doc = this.ownerDocument;
    const picker = doc.createElement("div");
    picker.className = "whimsy-note-block-picker";
    picker.tabIndex = 0;
    doc.l10n.setAttributes(picker, "whimsy-note-block-picker");
    const selection = doc.createElement("div");
    selection.className = "whimsy-note-block-selection";
    picker.append(selection);
    let start = null;
    const rectFrom = event => {
      const bounds = picker.getBoundingClientRect();
      const x = Math.min(Math.max(event.clientX - bounds.left, 0), bounds.width);
      const y = Math.min(Math.max(event.clientY - bounds.top, 0), bounds.height);
      return {
        left: Math.min(start.x, x),
        top: Math.min(start.y, y),
        width: Math.abs(x - start.x),
        height: Math.abs(y - start.y),
      };
    };
    picker.addEventListener("pointerdown", event => {
      const bounds = picker.getBoundingClientRect();
      start = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
      picker.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    picker.addEventListener("pointermove", event => {
      if (!start) {
        return;
      }
      const r = rectFrom(event);
      Object.assign(selection.style, {
        display: "block",
        left: `${r.left}px`,
        top: `${r.top}px`,
        width: `${r.width}px`,
        height: `${r.height}px`,
      });
    });
    picker.addEventListener("pointerup", event => {
      if (!start) {
        return;
      }
      const r = rectFrom(event);
      start = null;
      this.applySelection(r);
    });
    picker.addEventListener("keydown", event => {
      if (event.key == "Escape") {
        event.stopPropagation();
        this.togglePicking(false);
      }
    });
    return picker;
  }
}

// Tests reach the helpers through the element class, since this module lives
// in the window's module loader.
WhimsyNoteBlock.helpers = {
  blockFromTab,
  blockFromURL,
  parseEmbedCommand,
  cropFromSelection,
  BLOCK_SANDBOX_FLAGS,
  PAGE_WIDTH,
};

if (!customElements.get("whimsy-note-block")) {
  customElements.define("whimsy-note-block", WhimsyNoteBlock);
}
