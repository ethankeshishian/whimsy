/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Link lasso, the page side. Option-drag draws a rectangle over the page;
// links it touches light up with a live count. Releasing sends them to
// WhimsyLassoParent, which makes a folder of unloaded tabs. Esc, switching
// away or releasing over no links cancels. Only an Option-drag that the
// page didn't handle itself starts it (design tools that use Option-drag
// keep it), never in fields or editable content; a plain drag, a selection
// and an Option-click work as before. The overlay is anonymous content (the
// way Find and Screenshots draw), so the page can't see or style it.

const lazy = {};
ChromeUtils.defineLazyGetter(lazy, "l10n", () => new Localization(["browser/whimsy.ftl"]));

const FEATURE_PREF = "whimsy.feature.link-lasso";
const DRAG_THRESHOLD = 5;
const MAX_HIGHLIGHTS = 300;
const SHEET = "chrome://browser/content/whimsy/whimsy-lasso.css";
const SCROLLBAR_PARTS = new Set(["scrollbar", "scrollbarbutton", "slider", "thumb", "scrollcorner", "resizer"]);

export class WhimsyLassoChild extends JSWindowActorChild {
  lasso = null;

  handleEvent(event) {
    switch (event.type) {
      case "mousedown":
        this.onMouseDown(event);
        break;
      case "mousemove":
        this.onMouseMove(event);
        break;
      case "mouseup":
        this.onMouseUp(event);
        break;
      case "keydown":
        if (event.key == "Escape" && this.lasso) {
          event.preventDefault();
          event.stopPropagation();
          this.end({ cancel: true, released: false });
        }
        break;
      case "scroll":
        this.update();
        break;
      case "blur":
        // The window losing focus, not an element in the page.
        if (!event.target?.nodeType) {
          this.end({ cancel: true, released: false });
        }
        break;
      case "pagehide":
        this.end({ cancel: true, released: false });
        break;
      case "click":
        // The click that ends a lasso never follows a link.
        event.preventDefault();
        event.stopPropagation();
        break;
    }
  }

  onMouseDown(event) {
    if (
      this.lasso ||
      event.button != 0 ||
      !event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.defaultPrevented ||
      !Services.prefs.getBoolPref(FEATURE_PREF, true)
    ) {
      return;
    }
    const doc = this.document;
    if (!doc?.body || doc.designMode == "on" || SCROLLBAR_PARTS.has(event.originalTarget?.localName)) {
      return;
    }
    const target = event.composedTarget ?? event.target;
    const el = target?.nodeType == target?.ELEMENT_NODE ? target : target?.parentElement;
    if (el?.closest?.("input, textarea, select, [contenteditable]") || el?.isContentEditable) {
      return;
    }
    // Stops a text selection or a link drag from starting; an Option-click
    // without a drag still clicks.
    event.preventDefault();
    const win = this.contentWindow;
    this.lasso = {
      startX: event.clientX + win.scrollX,
      startY: event.clientY + win.scrollY,
      clientX: event.clientX,
      clientY: event.clientY,
      started: false,
      links: [],
      count: -1,
      frame: 0,
    };
    for (const type of ["mousemove", "mouseup", "keydown", "scroll", "blur", "pagehide"]) {
      win.addEventListener(type, this, { capture: true, mozSystemGroup: true });
    }
  }

  onMouseMove(event) {
    const lasso = this.lasso;
    if (!lasso) {
      return;
    }
    if (!(event.buttons & 1)) {
      // The button was released outside the window.
      this.end({ cancel: !lasso.started, released: true });
      return;
    }
    lasso.clientX = event.clientX;
    lasso.clientY = event.clientY;
    if (!lasso.started) {
      const win = this.contentWindow;
      const dx = event.clientX + win.scrollX - lasso.startX;
      const dy = event.clientY + win.scrollY - lasso.startY;
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) {
        return;
      }
      this.start();
    }
    event.preventDefault();
    this.update();
  }

  onMouseUp(event) {
    const lasso = this.lasso;
    if (!lasso) {
      return;
    }
    if (lasso.started) {
      event.preventDefault();
      event.stopPropagation();
    }
    this.end({ cancel: false, released: true });
  }

  // The drag passed the threshold: draw the overlay and measure the links.
  start() {
    const lasso = this.lasso;
    const doc = this.document;
    const win = this.contentWindow;
    lasso.started = true;
    win.getSelection()?.removeAllRanges();
    const here = doc.documentURI.replace(/#.*$/, "");
    for (const link of doc.links) {
      const url = link.href;
      if (!/^https?:/i.test(url) || url.replace(/#.*$/, "") == here) {
        continue;
      }
      const rects = [...link.getClientRects()]
        .filter(r => r.width > 0 && r.height > 0)
        .map(r => ({ left: r.left + win.scrollX, top: r.top + win.scrollY, right: r.right + win.scrollX, bottom: r.bottom + win.scrollY }));
      if (!rects.length || !link.checkVisibility({ visibilityProperty: true, opacityProperty: true })) {
        continue;
      }
      const title = (link.innerText || link.getAttribute("title") || link.getAttribute("aria-label") || link.getAttribute("alt") || "")
        .replace(/\s+/g, " ")
        .trim();
      lasso.links.push({ url, title, rects });
    }
    const content = doc.insertAnonymousContent();
    const root = doc.createElement("div");
    root.className = "whimsy-lasso";
    const sheet = doc.createElement("link");
    sheet.rel = "stylesheet";
    sheet.href = SHEET;
    const rect = doc.createElement("div");
    rect.className = "whimsy-lasso-rect";
    const hits = doc.createElement("div");
    hits.className = "whimsy-lasso-hits";
    const count = doc.createElement("div");
    count.className = "whimsy-lasso-count";
    count.setAttribute("role", "status");
    root.append(hits, rect, count);
    content.root.append(sheet, root);
    lasso.content = content;
    lasso.rect = rect;
    lasso.hits = hits;
    lasso.countEl = count;
  }

  // Redraws the rectangle and the matched links, at most once a frame.
  update() {
    const lasso = this.lasso;
    if (!lasso?.started || lasso.frame) {
      return;
    }
    const win = this.contentWindow;
    lasso.frame = win.requestAnimationFrame(() => {
      lasso.frame = 0;
      if (this.lasso != lasso) {
        return;
      }
      const x = lasso.clientX + win.scrollX;
      const y = lasso.clientY + win.scrollY;
      const box = {
        left: Math.min(lasso.startX, x),
        top: Math.min(lasso.startY, y),
        right: Math.max(lasso.startX, x),
        bottom: Math.max(lasso.startY, y),
      };
      const style = lasso.rect.style;
      style.left = `${box.left - win.scrollX}px`;
      style.top = `${box.top - win.scrollY}px`;
      style.width = `${box.right - box.left}px`;
      style.height = `${box.bottom - box.top}px`;

      const hit = lasso.links.filter(link =>
        link.rects.some(r => r.left < box.right && r.right > box.left && r.top < box.bottom && r.bottom > box.top)
      );
      lasso.selected = hit;
      const doc = this.document;
      const boxes = [];
      for (const link of hit.slice(0, MAX_HIGHLIGHTS)) {
        for (const r of link.rects) {
          const el = doc.createElement("div");
          el.className = "whimsy-lasso-hit";
          el.style.left = `${r.left - win.scrollX - 2}px`;
          el.style.top = `${r.top - win.scrollY - 1}px`;
          el.style.width = `${r.right - r.left + 4}px`;
          el.style.height = `${r.bottom - r.top + 2}px`;
          boxes.push(el);
        }
      }
      lasso.hits.replaceChildren(...boxes);

      const unique = new Set(hit.map(link => link.url)).size;
      const countStyle = lasso.countEl.style;
      countStyle.left = `${Math.min(lasso.clientX + 14, win.innerWidth - 120)}px`;
      countStyle.top = `${Math.min(lasso.clientY + 18, win.innerHeight - 36)}px`;
      if (unique != lasso.count) {
        lasso.count = unique;
        lazy.l10n.formatValue("whimsy-link-lasso-count", { count: unique }).then(text => {
          if (this.lasso == lasso && lasso.count == unique) {
            lasso.countEl.textContent = text;
          }
        });
      }
    });
  }

  end({ cancel, released }) {
    const lasso = this.lasso;
    if (!lasso) {
      return;
    }
    this.lasso = null;
    const win = this.contentWindow;
    for (const type of ["mousemove", "mouseup", "keydown", "scroll", "blur", "pagehide"]) {
      win?.removeEventListener(type, this, { capture: true, mozSystemGroup: true });
    }
    if (lasso.frame) {
      win?.cancelAnimationFrame(lasso.frame);
    }
    if (lasso.content) {
      try {
        this.document.removeAnonymousContent(lasso.content);
      } catch (e) {}
    }
    if (!lasso.started) {
      return;
    }
    if (win) {
      this.swallowClick(win, released);
    }
    if (cancel) {
      return;
    }
    // Compute the final selection now (the last frame may not have run).
    const x = lasso.clientX + (win?.scrollX ?? 0);
    const y = lasso.clientY + (win?.scrollY ?? 0);
    const box = {
      left: Math.min(lasso.startX, x),
      top: Math.min(lasso.startY, y),
      right: Math.max(lasso.startX, x),
      bottom: Math.max(lasso.startY, y),
    };
    const links = [];
    const seen = new Set();
    for (const link of lasso.links) {
      if (seen.has(link.url)) {
        continue;
      }
      if (link.rects.some(r => r.left < box.right && r.right > box.left && r.top < box.bottom && r.bottom > box.top)) {
        seen.add(link.url);
        links.push({ url: link.url, title: link.title });
      }
    }
    if (!links.length) {
      return;
    }
    this.sendAsyncMessage("WhimsyLasso:Create", {
      links,
      pageTitle: this.document.title,
      pageURL: this.document.documentURI,
    });
  }

  // The click that follows the release (now, or after Esc when the button
  // comes up) must not follow a link.
  swallowClick(win, released) {
    // The default group, so stopping it keeps the page's own listeners
    // from seeing the click.
    const options = { capture: true };
    win.addEventListener("click", this, { ...options, once: true });
    const drop = () => win.setTimeout(() => win.removeEventListener("click", this, options), 0);
    if (released) {
      drop();
    } else {
      win.addEventListener("mouseup", drop, { ...options, once: true });
    }
  }

  didDestroy() {
    this.lasso = null;
  }
}
