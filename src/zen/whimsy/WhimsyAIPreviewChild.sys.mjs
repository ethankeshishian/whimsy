/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// AI v1: 5-second previews (Arc Max), the page side. Shift while pointing at
// a link asks for a preview; on the sites Arc named (search results, X,
// Threads, Hacker News), resting on a link to another site is enough. The
// parent (WhimsyAIPage) checks the switches again, fetches and draws.

const PREF = "whimsy.feature.link-previews";
// W10-28: Settings → AI's Enable AI (WhimsyAI.PREF).
const AI_ENABLED_PREF = "whimsy.ai.enabled";
// wave7/ux: the link card (where a link goes) shows on the same triggers,
// with or without AI. The parent's hover host waits its one delay, so this
// side reports a hover right away.
const LINK_CARDS_PREF = "whimsy.feature.link-cards";
// Arc: "Google, DuckDuckGo, Bing, X, Threads and Hacker News".
// page-1.3: a passage's tint eases from 32% to 18% over 600ms.
const LEVELS = [32, 30, 28, 26, 24, 22, 20, 18];
const TINT_MS = 600;
const HOVER_SITES =
  /(^|\.)(google\.[a-z.]+|duckduckgo\.com|bing\.com|x\.com|twitter\.com|threads\.net|threads\.com|news\.ycombinator\.com)$/i;

export class WhimsyAIPreviewChild extends JSWindowActorChild {
  link = null;

  get enabled() {
    return (
      Services.prefs.getBoolPref(LINK_CARDS_PREF, true) ||
      (Services.prefs.getBoolPref(PREF, true) && Services.prefs.getBoolPref(AI_ENABLED_PREF, false))
    );
  }

  handleEvent(event) {
    switch (event.type) {
      case "mouseover":
        this.onOver(event);
        break;
      case "mouseout":
        if (this.link && !this.link.contains(event.relatedTarget)) {
          this.leave();
        }
        break;
      case "keydown":
        if (event.key == "Shift" && !event.repeat && this.link) {
          this.show("shift");
        }
        break;
      case "pagehide":
        this.leave();
        break;
    }
  }

  receiveMessage({ name, data }) {
    switch (name) {
      case "WhimsyAIPreview:Scroll":
        this.scrollBy(data);
        break;
      case "WhimsyAIPreview:Passage":
        return this.tintPassage(data);
      case "WhimsyAIPreview:PdfPages":
        return this.pdfPages(data);
      case "WhimsyAIPreview:PdfTurn":
        return this.pdfTurn(data);
    }
    return null;
  }

  didDestroy() {
    this.clearPassage();
  }

  // ---- A summary's passage chip (page-1.3) ----

  findPassage(win, quote) {
    const sel = win.getSelection();
    const body = win.document.body;
    if (!body) {
      return null;
    }
    const tries = [quote, quote.split(/\s+/).slice(0, 8).join(" ")];
    for (const text of tries) {
      sel.removeAllRanges();
      sel.collapse(body, 0);
      if (text.length >= 8 && win.find(text, false, false, false, false, false, false) && sel.rangeCount) {
        const range = sel.getRangeAt(0).cloneRange();
        sel.removeAllRanges();
        return range;
      }
    }
    sel.removeAllRanges();
    return null;
  }

  // Scrolls the passage a third of the way down and tints it with the
  // accent, 32% easing to 18%, until the next scroll.
  async tintPassage({ quote, color, reduced }) {
    const win = this.contentWindow;
    this.clearPassage();
    if (!win || !quote) {
      return false;
    }
    const range = this.findPassage(win, String(quote));
    if (!range) {
      return false;
    }
    const token = (this.passageToken = (this.passageToken ?? 0) + 1);
    const behavior = reduced ? "instant" : "smooth";
    const rect = range.getBoundingClientRect();
    const target = Math.max(0, Math.min(win.scrollMaxY, win.scrollY + rect.top - win.innerHeight / 3));
    let moved = false;
    if (win.scrollMaxY > 0) {
      moved = Math.abs(target - win.scrollY) > 1;
      win.scrollTo({ top: target, behavior });
    } else {
      const el = range.startContainer.nodeType == 1 ? range.startContainer : range.startContainer.parentElement;
      el?.scrollIntoView({ block: "center", behavior });
      moved = !reduced;
    }
    if (moved && !reduced) {
      await new Promise(resolve => {
        const done = () => {
          win.clearTimeout(timer);
          win.removeEventListener("scrollend", done, true);
          resolve();
        };
        const timer = win.setTimeout(done, 1000);
        win.addEventListener("scrollend", done, true);
      });
    }
    if (token != this.passageToken || !this.contentWindow) {
      return false;
    }
    // The layout can shift while the scroll runs (a side panel opening, images loading): land exactly.
    if (win.scrollMaxY > 0) {
      const landed = range.getBoundingClientRect().top - win.innerHeight / 3;
      const fixed = Math.max(0, Math.min(win.scrollMaxY, win.scrollY + landed));
      if (Math.abs(fixed - win.scrollY) > 8) {
        win.scrollTo({ top: fixed, behavior: "instant" });
        // Its scroll event fires on the next frame; the tint must not take it as the reader's.
        await new Promise(resolve => win.requestAnimationFrame(() => win.requestAnimationFrame(resolve)));
        if (token != this.passageToken || !this.contentWindow) {
          return false;
        }
      }
    }
    this.paintPassage(win, range, String(color || "AccentColor"), reduced);
    return true;
  }

  paintPassage(win, range, color, reduced) {
    const utils = win.windowUtils;
    if (this.passageSheet?.color != color) {
      if (this.passageSheet) {
        try {
          utils.removeSheetUsingURIString(this.passageSheet.uri, utils.AUTHOR_SHEET);
        } catch {}
      }
      const rules = LEVELS.map(p => `::highlight(whimsy-passage-${p}){background-color:color-mix(in srgb,${color} ${p}%,transparent)}`).join("");
      const uri = "data:text/css," + encodeURIComponent(rules);
      utils.loadSheetUsingURIString(uri, utils.AUTHOR_SHEET);
      this.passageSheet = { uri, color };
    }
    const highlights = win.CSS.highlights;
    const highlight = new win.Highlight(range);
    let name = null;
    const show = level => {
      const next = `whimsy-passage-${level}`;
      if (next != name) {
        if (name) {
          highlights.delete(name);
        }
        highlights.set(next, highlight);
        name = next;
      }
    };
    const token = this.passageToken;
    const clear = () => {
      if (name) {
        highlights.delete(name);
        name = null;
      }
      win.removeEventListener("scroll", onScroll, true);
    };
    const onScroll = () => {
      if (this.passageToken == token) {
        this.clearPassage();
      }
    };
    this.passageClear = clear;
    if (reduced) {
      show(LEVELS.at(-1));
    } else {
      const start = win.performance.now();
      const step = now => {
        if (this.passageToken != token || !name && now != start) {
          return;
        }
        const t = Math.min(1, (now - start) / TINT_MS);
        const eased = 1 - Math.pow(1 - t, 3);
        const want = 32 - 14 * eased;
        show(LEVELS.reduce((a, b) => (Math.abs(b - want) < Math.abs(a - want) ? b : a)));
        if (t < 1) {
          win.requestAnimationFrame(step);
        }
      };
      step(start);
    }
    // The arrival's own last scroll events have fired by the next frame.
    win.requestAnimationFrame(() => {
      if (this.passageToken == token) {
        win.addEventListener("scroll", onScroll, { capture: true, passive: true });
      }
    });
  }

  clearPassage() {
    this.passageToken = (this.passageToken ?? 0) + 1;
    try {
      this.passageClear?.();
    } catch {}
    this.passageClear = null;
  }

  // ---- PDFs in Firefox's viewer ----

  get pdfApp() {
    const app = this.contentWindow?.wrappedJSObject?.PDFViewerApplication;
    return app?.pdfDocument ? app : null;
  }

  // Each page's text; a page with no text layer is read by on-device text
  // recognition first (page-11.3).
  async pdfPages({ ocr = true, maxPages = 400 } = {}) {
    const app = this.pdfApp;
    if (!app) {
      return null;
    }
    const pdf = app.pdfDocument;
    const count = Math.min(Number(pdf.numPages) || 0, maxPages);
    const pages = [];
    let recognized = 0;
    for (let n = 1; n <= count; n++) {
      // Values a content promise resolves to come back Xray-wrapped; pdf.js's objects are plain JS.
      const page = Cu.waiveXrays(await pdf.getPage(n));
      const content = await page.getTextContent();
      let text = [...Cu.waiveXrays(content).items].map(item => String(item?.str ?? "")).join(" ").replace(/\s+/g, " ").trim();
      if (!text && ocr) {
        text = await this.recognizePage(page, n);
        if (text) {
          recognized++;
        }
      }
      pages.push({ n, text });
    }
    return { pages, total: Number(pdf.numPages) || count, recognized };
  }

  // Tests: a stand-in answers instead of the real (slow, platform) call.
  async testRecognizedText(n) {
    try {
      const { text } = await this.sendQuery("WhimsyAIPreview:RecognizeText", { page: n });
      return text;
    } catch {
      return null;
    }
  }

  async recognizePage(page, n) {
    const stood = await this.testRecognizedText(n);
    if (stood != null) {
      return stood;
    }
    const win = this.contentWindow;
    const doc = win.document;
    try {
      const content = win.wrappedJSObject;
      const scale = new content.Object();
      scale.scale = 2;
      const viewport = page.getViewport(scale);
      const canvas = doc.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const params = new content.Object();
      params.canvasContext = Cu.waiveXrays(canvas.getContext("2d"));
      params.viewport = viewport;
      await Cu.waiveXrays(page.render(params)).promise;
      const img = doc.createElement("img");
      img.src = canvas.toDataURL("image/png");
      await img.decode();
      // The OS text-recognition service can stall; a page that never
      // answers reads as text-free rather than hanging the summary (and
      // the test suite) forever.
      const lines = await Promise.race([
        img.recognizeCurrentImageText(),
        new Promise(resolve => win.setTimeout(() => resolve([]), 10000)),
      ]);
      return [...lines].map(line => String(line.string ?? "")).join(" ").replace(/\s+/g, " ").trim();
    } catch (e) {
      console.error("Whimsy: PDF text recognition", e);
      return "";
    }
  }

  pdfTurn({ page }) {
    const app = this.pdfApp;
    if (!app || !(page >= 1)) {
      return false;
    }
    app.page = page;
    return true;
  }

  // The preview card owns wheel input over its rect; replay it on the page underneath.
  scrollBy({ screenX, screenY, deltaX, deltaY, deltaZ, deltaMode }) {
    const win = this.contentWindow;
    const utils = win?.windowUtils;
    if (!utils) {
      return;
    }
    const x = screenX - win.mozInnerScreenX;
    const y = screenY - win.mozInnerScreenY;
    const lineOrPageDeltaX = deltaX > 0 ? Math.floor(deltaX) : Math.ceil(deltaX);
    const lineOrPageDeltaY = deltaY > 0 ? Math.floor(deltaY) : Math.ceil(deltaY);
    utils.sendWheelEvent(x, y, deltaX, deltaY, deltaZ, deltaMode, 0, lineOrPageDeltaX, lineOrPageDeltaY, 0);
  }

  onOver(event) {
    const link = event.target?.closest?.("a[href]");
    if (link == this.link) {
      return;
    }
    if (this.link) {
      this.leave();
    }
    if (!link || !/^https?:/i.test(link.href) || !this.enabled) {
      return;
    }
    this.link = link;
    if (event.shiftKey) {
      this.show("shift");
    } else if (this.isHoverSite() && this.isOutbound(link)) {
      this.show("hover");
    }
  }

  isHoverSite() {
    try {
      return HOVER_SITES.test(this.document.location.hostname);
    } catch {
      return false;
    }
  }

  // Result links, not the site's own navigation.
  isOutbound(link) {
    try {
      const here = this.document.location.hostname.replace(/^www\./, "");
      const there = new URL(link.href).hostname.replace(/^www\./, "");
      return there != here && !there.endsWith(`.${here}`) && !here.endsWith(`.${there}`);
    } catch {
      return false;
    }
  }

  show(how) {
    const link = this.link;
    const win = this.contentWindow;
    if (!link?.isConnected || !win) {
      return;
    }
    const rect = link.getBoundingClientRect();
    this.shown = true;
    this.sendAsyncMessage("WhimsyAIPreview:Show", {
      url: link.href,
      how,
      title: (link.title || link.textContent || "").replace(/\s+/g, " ").trim().slice(0, 200),
      x: win.mozInnerScreenX + rect.left,
      y: win.mozInnerScreenY + rect.top,
      width: rect.width,
      height: rect.height,
    });
  }

  leave() {
    const link = this.link;
    this.link = null;
    if (link && this.shown) {
      this.shown = false;
      this.sendAsyncMessage("WhimsyAIPreview:Leave", { url: link.href });
    }
  }
}
