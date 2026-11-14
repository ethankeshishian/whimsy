/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W28: the page minimap's page side (see WhimsyMinimap.sys.mjs). It only
// measures and scrolls its own top-level page: how tall the page is, how
// much of it shows, and where it's scrolled to. It sends nothing while the
// tab is in the background, scroll positions at most once a frame, and the
// page's size only after it has stopped changing for a moment. It never
// reads page content; the picture is drawn by the parent's compositor.
// The actor exists only while Show Page Minimap is on.

// How long the page's size must hold still before it's reported again.
const CHANGE_MS = 250;
// The strip at the right edge that brings a faded minimap back: its 104px,
// its 10px margin, and a little more.
const EDGE = 124;
const WEB_SCHEMES = new Set(["http", "https", "file"]);

export class WhimsyMinimapChild extends JSWindowActorChild {
  #on = false;
  #frame = 0;
  #changeTimer = 0;
  #mutations = null;
  #sizes = null;
  #near = false;

  handleEvent(event) {
    switch (event.type) {
      case "pageshow":
        this.#start();
        break;
      case "pagehide":
        this.#stop();
        break;
      case "scroll":
        // Only the page's own scrolling (an element's scroll doesn't bubble).
        if (event.isTrusted && event.target == this.document) {
          this.#queueScroll();
        }
        break;
      case "resize":
        this.#changed();
        break;
      case "visibilitychange":
        if (!this.document.hidden) {
          this.#send("WhimsyMinimap:State", this.#state());
        }
        break;
      case "mousemove":
        this.#move(event);
        break;
    }
  }

  receiveMessage(message) {
    switch (message.name) {
      case "WhimsyMinimap:Start":
        this.#start();
        return this.#state();
      case "WhimsyMinimap:ScrollTo":
        this.#scrollTo(message.data);
        return null;
    }
    return null;
  }

  didDestroy() {
    this.#stop();
  }

  // Web pages only: not pdf.js (its viewer has its own sidebar), nor a page
  // whose principal isn't the web's.
  #supported() {
    const doc = this.document;
    if (!doc?.documentElement || doc.contentType == "application/pdf") {
      return false;
    }
    try {
      return WEB_SCHEMES.has(doc.nodePrincipal?.URI?.scheme);
    } catch (e) {
      return false;
    }
  }

  #start() {
    if (this.#on || !this.#supported()) {
      return;
    }
    const win = this.contentWindow;
    if (!win) {
      return;
    }
    this.#on = true;
    const options = { passive: true, mozSystemGroup: true };
    win.addEventListener("scroll", this, options);
    win.addEventListener("resize", this, options);
    win.addEventListener("mousemove", this, options);
    this.document.addEventListener("visibilitychange", this, options);
    // A page that grows or shrinks (a feed loading more, a section opening).
    this.#mutations = new win.MutationObserver(() => this.#changed());
    this.#mutations.observe(this.document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style", "hidden", "open", "src"],
    });
    this.#sizes = new win.ResizeObserver(() => this.#changed());
    this.#sizes.observe(this.document.documentElement);
    this.#send("WhimsyMinimap:State", this.#state());
  }

  #stop() {
    if (!this.#on) {
      return;
    }
    this.#on = false;
    const win = this.contentWindow;
    const options = { mozSystemGroup: true };
    try {
      win?.removeEventListener("scroll", this, options);
      win?.removeEventListener("resize", this, options);
      win?.removeEventListener("mousemove", this, options);
      this.document?.removeEventListener("visibilitychange", this, options);
    } catch (e) {
      // The window is already gone.
    }
    this.#mutations?.disconnect();
    this.#sizes?.disconnect();
    this.#mutations = this.#sizes = null;
    if (this.#frame) {
      win?.cancelAnimationFrame(this.#frame);
    }
    this.#frame = 0;
    if (this.#changeTimer) {
      win?.clearTimeout(this.#changeTimer);
    }
    this.#changeTimer = 0;
  }

  // The page's height, the part that shows, and where it's scrolled to, in
  // CSS pixels. A page whose root doesn't scroll reports its viewport's
  // height, so it never counts as long.
  #state() {
    const win = this.contentWindow;
    if (!win || !this.#supported()) {
      return null;
    }
    const doc = this.document;
    const root = doc.scrollingElement ?? doc.documentElement;
    const view = win.innerHeight;
    let scrolls = win.scrollMaxY > 0;
    if (scrolls && root) {
      const overflow = win.getComputedStyle(root).overflowY;
      scrolls = overflow != "hidden" && overflow != "clip";
    }
    return {
      y: scrolls ? win.scrollY : 0,
      height: scrolls ? win.scrollMaxY + view : view,
      view,
      width: root?.clientWidth || win.innerWidth,
    };
  }

  #queueScroll() {
    if (this.#frame || this.document.hidden) {
      return;
    }
    this.#frame = this.contentWindow.requestAnimationFrame(() => {
      this.#frame = 0;
      this.#send("WhimsyMinimap:Scroll", { y: this.contentWindow?.scrollY ?? 0 });
    });
  }

  #changed() {
    const win = this.contentWindow;
    if (!win || this.document.hidden) {
      return;
    }
    win.clearTimeout(this.#changeTimer);
    this.#changeTimer = win.setTimeout(() => {
      this.#changeTimer = 0;
      this.#send("WhimsyMinimap:State", this.#state());
    }, CHANGE_MS);
  }

  #move(event) {
    if (!event.isTrusted) {
      return;
    }
    const near = event.clientX >= this.contentWindow.innerWidth - EDGE;
    if (near != this.#near) {
      this.#near = near;
      this.#send("WhimsyMinimap:Edge", { near });
    }
  }

  #scrollTo(data) {
    const win = this.contentWindow;
    const y = Number(data?.y);
    if (!win || !Number.isFinite(y)) {
      return;
    }
    win.scrollTo({
      top: Math.max(0, Math.min(y, win.scrollMaxY)),
      behavior: data.smooth ? "smooth" : "instant",
    });
  }

  #send(name, data) {
    if (!data || this.document?.hidden) {
      return;
    }
    try {
      this.sendAsyncMessage(name, data);
    } catch (e) {
      // The actor is going away with its page.
    }
  }
}
