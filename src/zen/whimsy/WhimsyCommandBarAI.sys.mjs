/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W23 cmdbar-ai: Ask AI in the command bar. A question gets an "Ask AI ⌘↩"
// row under the first result; asking turns the results into a short answer
// card under the input, with the question moved into the card and the input
// cleared for a follow-up. ⌘↩ always takes the next AI step: ask, then
// "Open in chat", or "Continue in chat" with a typed follow-up. Esc closes
// from any state and keeps the exchange in chat's list. Also: ⌘1–⌘9 pick a
// row while the bar is open, and the empty mic slot on the input's right.

import { UrlbarProvider } from "moz-src:///browser/components/urlbar/UrlbarUtils.sys.mjs";
import { UrlbarShared } from "chrome://browser/content/urlbar/UrlbarShared.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  ProvidersManager: "moz-src:///browser/components/urlbar/UrlbarProvidersManager.sys.mjs",
  UrlbarResult: "chrome://browser/content/urlbar/UrlbarResult.mjs",
  WhimsyAI: "resource:///modules/whimsy/WhimsyAI.sys.mjs",
  WhimsyAIContext: "resource:///modules/whimsy/WhimsyAIContext.sys.mjs",
  WhimsyAIHints: "resource:///modules/whimsy/WhimsyAIHints.sys.mjs",
  WhimsyAIProviders: "resource:///modules/whimsy/WhimsyAIProviders.sys.mjs",
  WhimsyAIRouter: "resource:///modules/whimsy/WhimsyAIRouter.sys.mjs",
  WhimsyAIStore: "resource:///modules/whimsy/WhimsyAIStore.sys.mjs",
  WhimsyAIUpdates: "resource:///modules/whimsy/WhimsyAIUpdates.sys.mjs",
  WhimsyChat: "resource:///modules/whimsy/WhimsyChat.sys.mjs",
  WhimsyChatAnswer: "resource:///modules/whimsy/WhimsyChatAnswer.sys.mjs",
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
});

const HTML_NS = "http://www.w3.org/1999/xhtml";
const ASK_FEATURE = "whimsy.feature.ai-ask";
const NUMBERS_FEATURE = "whimsy.feature.command-bar-numbers";
const SHEET = "chrome://browser/content/whimsy/whimsy-cmdbar-ai.css";
const ICONS = "chrome://browser/content/whimsy/icons/";
const SPARKLE = "chrome://browser/skin/zen-icons/sparkles.svg";
const ASK_TYPE = "whimsy-ask";
const CARD_TYPE = "whimsy-ask-card";
const LOADING_MS = 300;
const HOLD_MS = 400;
const PAGE_CHARS = 60000;

const QUESTION_WORDS = new Set([
  "what", "which", "who", "whom", "whose", "when", "where", "why", "how", "is", "are", "was", "were",
  "do", "does", "did", "can", "could", "should", "would", "will", "may", "might", "has", "have", "am",
]);
const REQUEST_VERBS = new Set([
  "summarize", "summarise", "sum", "explain", "compare", "write", "draft", "translate", "tell", "find", "list",
  "give", "show", "describe", "help", "make", "suggest", "recommend", "plan", "rewrite", "define", "convert",
  "calculate", "outline", "create", "teach", "fix", "check", "review",
]);
const SETUP_WORDS = ["ai", "claude", "chatgpt", "set up", "setup"];

function urlLike(text) {
  const t = text.trim();
  if (/^[a-z][\w+.-]*:\/\//i.test(t) || /^(about|chrome|file|data|view-source|moz-extension|javascript|mailto):/i.test(t)) {
    return true;
  }
  if (/\s/.test(t)) {
    return false;
  }
  return /^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/|$)/i.test(t) || /^[\w-]+(\.[\w-]+)*\.[a-z]{2,}(:\d+)?(\/|\?|#|$)/i.test(t) || t.startsWith("/");
}

/** Whether `text` reads like a question or a request (never URL-like). */
export function looksLikeQuestion(text) {
  const t = String(text ?? "").trim();
  if (t.length < 3 || urlLike(t)) {
    return false;
  }
  if (t.endsWith("?")) {
    return true;
  }
  const words = t.toLowerCase().split(/\s+/);
  if (QUESTION_WORDS.has(words[0])) {
    return words.length >= 2;
  }
  return REQUEST_VERBS.has(words[0]) && words.length >= 3;
}

/** "page" or "video" when the text points at what's on screen. */
export function scopeOf(text) {
  const t = String(text ?? "").toLowerCase();
  if (/\b(this|the) video\b/.test(t)) {
    return "video";
  }
  if (/\b(this|here|the article|this page|this tab|this site)\b/.test(t)) {
    return "page";
  }
  return null;
}

function featureOn(pref) {
  return Services.prefs.getBoolPref(pref, true);
}

function aiOn() {
  return featureOn(ASK_FEATURE) && lazy.WhimsyAI.enabled;
}

function isPrivateContext(context, win) {
  return !!context?.isPrivate || (win ? lazy.WhimsyAIContext.isPrivate(win.gBrowser?.selectedTab) : false);
}

function h(doc, tag, attrs = {}, ...kids) {
  const el = doc.createElementNS(HTML_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) {
      continue;
    }
    if (k == "l10n") {
      const [id, args] = Array.isArray(v) ? v : [v];
      doc.l10n.setAttributes(el, id, args);
    } else if (k.startsWith("on")) {
      el.addEventListener(k.slice(2), v);
    } else if (k == "class") {
      el.className = v;
    } else {
      el.setAttribute(k, v === true ? "" : v);
    }
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid != null && kid !== false) {
      el.append(kid);
    }
  }
  return el;
}

function img(doc, src, cls = "whimsy-ask-icon-img") {
  return h(doc, "img", { class: cls, src, alt: "", "aria-hidden": "true" });
}

function key(doc, text) {
  return h(doc, "kbd", { class: "whimsy-cmdbar-key" }, text.replace("↩", "↩︎"));
}

function hostOf(url) {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return "";
  }
}

const SENTENCE_END = /[.!?。！？](["”’)\]]*)(\s|$)/;

// Citation marks go after the sentence each citation arrived in.
function marked(text, citations, done) {
  const shown = citations
    .map(c => {
      const end = text.slice(c.at).match(SENTENCE_END);
      return end ? { ...c, pos: c.at + end.index + 1 + end[1].length } : done ? { ...c, pos: text.length } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.pos - b.pos);
  let out = "";
  let at = 0;
  for (const c of shown) {
    out += text.slice(at, c.pos) + `\u0001${c.n}\u0002`;
    at = c.pos;
  }
  return out + text.slice(at);
}

// ---- The answer card ----

class Card {
  constructor(win, question, { scope = null, provider = null } = {}) {
    this.win = win;
    this.question = question;
    this.scope = scope;
    this.provider = provider;
    this.tab = win.gBrowser.selectedTab;
    this.tabTitle = this.tab.label;
    this.text = "";
    this.citations = [];
    this.opened = new Set();
    this.status = "waiting";
    this.handoff = null;
    this.error = null;
    this.result = null;
    this.readPage = false;
    this.started = Date.now();
    this.controller = new win.AbortController();
    this.threadId = null;
    this.raf = 0;
  }

  get sources() {
    const seen = new Map();
    for (const c of this.citations) {
      if (c.source?.url && !seen.has(c.n)) {
        seen.set(c.n, { n: c.n, ...c.source });
      }
    }
    return [...seen.values()];
  }

  snapshot() {
    return {
      threadId: this.threadId,
      question: this.question,
      tabTitle: this.tabTitle,
      text: this.text,
      citations: this.citations,
      provider: this.result?.provider ?? this.provider,
      model: this.result?.model ?? null,
      handoff: this.handoff,
      readPage: this.readPage,
      opened: [...this.opened],
      sources: this.sources.length,
      at: Date.now(),
    };
  }

  static restore(win, snap) {
    const card = new Card(win, snap.question);
    Object.assign(card, {
      threadId: snap.threadId,
      tabTitle: snap.tabTitle,
      text: snap.text,
      citations: snap.citations ?? [],
      provider: snap.provider,
      handoff: snap.handoff,
      readPage: snap.readPage,
      opened: new Set(snap.opened ?? []),
      status: "done",
      result: { provider: snap.provider, model: snap.model },
    });
    return card;
  }
}

const cards = new WeakMap();
let nextQuery = 0;

function cardOf(win) {
  return win ? cards.get(win) ?? null : null;
}

function topWindow() {
  return lazy.BrowserWindowTracker.getTopWindow();
}

export class WhimsyAskProvider extends UrlbarProvider {
  get name() {
    return "WhimsyAsk";
  }

  get type() {
    return UrlbarShared.PROVIDER_TYPE.PROFILE;
  }

  // While a card is up it's the only result, whatever is typed.
  getPriority() {
    return cardOf(topWindow()) ? 50 : 0;
  }

  async isActive(context) {
    const win = topWindow();
    if (!win || isPrivateContext(context, win) || context.searchMode || context.restrictSource) {
      return false;
    }
    if (cardOf(win)) {
      return true;
    }
    const text = context.searchString ?? "";
    if (!lazy.WhimsyAI.enabled) {
      return this.setupMatch(text);
    }
    return aiOn() && looksLikeQuestion(text);
  }

  setupMatch(text) {
    const t = text.trim().toLowerCase();
    return t.length >= 2 && SETUP_WORDS.some(w => w.startsWith(t) || t.startsWith(w));
  }

  startQuery(context, addCallback) {
    const win = topWindow();
    const card = cardOf(win);
    if (card) {
      addCallback(this, new lazy.UrlbarResult({
        type: UrlbarShared.RESULT_TYPE.DYNAMIC,
        source: UrlbarShared.RESULT_SOURCE.OTHER_LOCAL,
        suggestedIndex: 0,
        payload: { dynamicType: CARD_TYPE, query: ++nextQuery },
      }));
      return;
    }
    const text = context.searchString.trim();
    if (!lazy.WhimsyAI.enabled) {
      addCallback(this, new lazy.UrlbarResult({
        type: UrlbarShared.RESULT_TYPE.DYNAMIC,
        source: UrlbarShared.RESULT_SOURCE.OTHER_LOCAL,
        suggestedIndex: 1,
        payload: { dynamicType: ASK_TYPE, setup: true, query: text },
      }));
      return;
    }
    addCallback(this, new lazy.UrlbarResult({
      type: UrlbarShared.RESULT_TYPE.DYNAMIC,
      source: UrlbarShared.RESULT_SOURCE.OTHER_LOCAL,
      suggestedIndex: 1,
      payload: { dynamicType: ASK_TYPE, query: text, scope: scopeOf(text) },
    }));
    lazy.WhimsyAIHints.request(win, "ask");
  }

  getViewTemplate(result) {
    if (result.payload.dynamicType == CARD_TYPE) {
      return { attributes: { role: "presentation" }, children: [{ name: "card", tag: "div", classList: ["whimsy-ask-card"] }] };
    }
    return {
      attributes: { selectable: true },
      children: [
        { name: "icon", tag: "img", classList: ["urlbarView-favicon", "whimsy-ask-icon"] },
        { name: "title", tag: "span", classList: ["urlbarView-title"] },
        {
          name: "hint",
          tag: "span",
          classList: ["whimsy-ask-hint"],
          children: [
            { name: "scopeIcon", tag: "img", classList: ["whimsy-ask-scope-icon"] },
            { name: "label", tag: "span", classList: ["whimsy-ask-hint-label"] },
            { name: "keyAccel", tag: "kbd", classList: ["whimsy-cmdbar-key", "whimsy-ask-key-accel"] },
            { name: "keyReturn", tag: "kbd", classList: ["whimsy-cmdbar-key", "whimsy-ask-key-return"] },
          ],
        },
      ],
    };
  }

  getViewUpdate(result) {
    const { payload } = result;
    if (payload.dynamicType == CARD_TYPE) {
      return {};
    }
    if (payload.setup) {
      return {
        icon: { attributes: { src: "chrome://browser/skin/zen-icons/settings.svg" } },
        title: { l10n: { id: "whimsy-cmdbar-setup-ai" } },
        scopeIcon: { attributes: { hidden: true } },
        label: { l10n: { id: "whimsy-cmdbar-setup-ai-tag" } },
        keyAccel: { attributes: { hidden: true } },
        keyReturn: { textContent: "↩︎" },
      };
    }
    const win = topWindow();
    const tabIcon = win?.gBrowser.selectedTab.getAttribute("image") || "chrome://global/skin/icons/defaultFavicon.svg";
    return {
      icon: { attributes: { src: SPARKLE } },
      title: { textContent: payload.query },
      scopeIcon: payload.scope ? { attributes: { src: tabIcon, hidden: null } } : { attributes: { hidden: true } },
      label: { l10n: { id: payload.scope == "video" ? "whimsy-cmdbar-ask-video" : payload.scope ? "whimsy-cmdbar-ask-tab" : "whimsy-cmdbar-ask-ai" } },
      keyAccel: { textContent: "⌘↩︎" },
      keyReturn: { textContent: "↩︎" },
    };
  }

  onEngagement(context, _controller, details) {
    const payload = details.result?.payload;
    const win = details.element?.documentGlobal ?? topWindow();
    if (!payload || payload.dynamicType != ASK_TYPE || !win) {
      return;
    }
    if (payload.setup) {
      win.gURLBar.view.close();
      lazy.WhimsyAIProviders.openSettings(win, "add-provider");
      return;
    }
    // Picking a row closes the view; the card opens it again.
    win.setTimeout(() => WhimsyCommandBarAI.ask(win, payload.query, { scope: payload.scope }), 0);
  }
}

export const WhimsyCommandBarAI = {
  provider: null,
  looksLikeQuestion,
  scopeOf,
  LOADING_MS,

  init() {
    if (this.provider) {
      return;
    }
    const manager = lazy.ProvidersManager.getInstanceForSap("urlbar");
    this.provider = manager.getProvider("WhimsyAsk");
    if (!this.provider) {
      this.provider = new WhimsyAskProvider();
      manager.registerProvider(this.provider);
    }
  },

  initWindow(win) {
    this.init();
    win.windowUtils.loadSheetUsingURIString(SHEET, win.windowUtils.AUTHOR_SHEET);
    this.micSlot(win);
    this.modePill(win);
    const urlbar = win.gURLBar;
    urlbar?.inputField?.addEventListener("keydown", event => this.onInputKey(win, event), true);
    urlbar?.inputField?.addEventListener("input", () => this.onInput(win));
    win.addEventListener("keydown", event => this.onWindowKey(win, event), true);
    win.addEventListener("keyup", event => this.onWindowKeyUp(win, event), true);
    win.addEventListener("blur", () => this.stopNumbers(win));
    urlbar?.controller?.addListener({
      onViewClose: () => this.onViewClose(win),
    });
    // The card row is drawn by the view; fill it whenever a fresh one appears.
    const panel = urlbar?.view?.panel;
    if (panel) {
      new win.MutationObserver(() => {
        const card = cardOf(win);
        const el = card && panel.querySelector(".whimsy-ask-card");
        if (el && el != card.el) {
          this.mountCard(win, el);
        }
      }).observe(panel, { childList: true, subtree: true });
    }
    lazy.WhimsyAIHints.register({
      id: "ask",
      isVisible: w => !!w.gURLBar?.view.isOpen && !!w.gURLBar.view.panel.querySelector(`.urlbarView-row[dynamicType="${ASK_TYPE}"]`),
    });
    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsyAskAI",
      l10nId: "whimsy-cmdbar-command-ask",
      icon: SPARKLE,
      isAvailable: w => aiOn() && !lazy.WhimsyAIContext.isPrivate(w.gBrowser.selectedTab),
      run: () => this.openForAsk(win),
    });
  },

  /** Focuses the command bar ready for a question. */
  openForAsk(win) {
    if (!aiOn() || lazy.WhimsyAIContext.isPrivate(win.gBrowser.selectedTab)) {
      return;
    }
    win.gURLBar.focus();
    win.gURLBar.select();
  },

  /** The empty mic container at the input's right; the voice lane fills it. */
  micSlot(win) {
    const doc = win.document;
    let slot = doc.getElementById("whimsy-cmdbar-mic-slot");
    if (slot) {
      return slot;
    }
    const container = win.gURLBar?.querySelector(".urlbar-input-container");
    if (!container) {
      return null;
    }
    slot = h(doc, "span", { id: "whimsy-cmdbar-mic-slot", class: "whimsy-cmdbar-mic-slot" });
    container.append(slot);
    return slot;
  },

  modePill(win) {
    const doc = win.document;
    let pill = doc.getElementById("whimsy-ask-mode");
    if (pill) {
      return pill;
    }
    const box = win.gURLBar?.querySelector(".urlbar-input-box");
    if (!box) {
      return null;
    }
    pill = h(doc, "span", { id: "whimsy-ask-mode", class: "whimsy-ask-mode", "aria-hidden": "true" }, img(doc, SPARKLE, "whimsy-ask-mode-icon"), h(doc, "span", { l10n: "whimsy-cmdbar-ask-mode" }));
    box.before(pill);
    return pill;
  },

  card(win) {
    return cardOf(win);
  },

  // ---- Asking ----

  /** Asks `text` and shows the answer card under the input. */
  async ask(win, text, { scope = null, provider = null } = {}) {
    const question = String(text ?? "").trim();
    if (!question || !aiOn() || lazy.WhimsyAIContext.isPrivate(win.gBrowser.selectedTab)) {
      return null;
    }
    this.end(win, { keep: true });
    lazy.WhimsyAIUpdates.setRecentAnswer(null);
    lazy.WhimsyAIHints.used("ask");
    const card = new Card(win, question, { scope: scope ?? scopeOf(question), provider });
    cards.set(win, card);
    this.enterMode(win);
    this.requery(win);
    await this.run(win, card);
    return card;
  },

  enterMode(win) {
    const urlbar = win.gURLBar;
    const doc = win.document;
    urlbar.setAttribute("whimsy-ask", "");
    if (!urlbar.focused) {
      urlbar.focus();
    }
    const input = urlbar.inputField;
    if (!this._placeholder) {
      this._placeholder = new WeakMap();
    }
    if (!this._placeholder.has(win)) {
      this._placeholder.set(win, doc.l10n.getAttributes(input));
    }
    doc.l10n.setAttributes(input, "whimsy-cmdbar-ask-followup");
    urlbar.value = "";
  },

  leaveMode(win) {
    const urlbar = win.gURLBar;
    urlbar.removeAttribute("whimsy-ask");
    const saved = this._placeholder?.get(win);
    if (saved) {
      this._placeholder.delete(win);
      if (saved.id) {
        win.document.l10n.setAttributes(urlbar.inputField, saved.id, saved.args);
      } else {
        urlbar.inputField.removeAttribute("data-l10n-id");
      }
    }
  },

  requery(win) {
    const urlbar = win.gURLBar;
    try {
      urlbar.startQuery({ searchString: urlbar.value, allowAutofill: false });
    } catch (e) {
      console.error("Whimsy: Ask requery", e);
    }
  },

  async run(win, card) {
    const tab = card.tab;
    let system = "You are the command bar in Whimsy, a web browser. Answer in a few short sentences, in the language the person writes in. Use the web when it helps.";
    try {
      if (tab && !lazy.WhimsyAIContext.isOffLimits(tab) && /^https?:/.test(tab.linkedBrowser.currentURI.spec)) {
        const context = await lazy.WhimsyAIContext.forTab(tab);
        const text = context.parts.filter(p => typeof p.text == "string").map(p => p.text).join("\n\n");
        if (text) {
          card.readPage = true;
          system += `\nThe person is on this page. Use it when the question is about it.\nPage title: ${tab.label}\nAddress: ${tab.linkedBrowser.currentURI.spec}\nPage text:\n${text.slice(0, PAGE_CHARS)}`;
        }
      }
    } catch (e) {
      console.warn("Whimsy: Ask context", e);
    }
    try {
      const thread = await lazy.WhimsyAIStore.createThread({
        kind: "cmdbar",
        title: card.question,
        tabKey: lazy.WhimsyAIContext.tabKey(tab),
        url: tab.linkedBrowser.currentURI.spec,
        origin: "cmdbar",
        detail: this.detailText(win, card),
      });
      card.threadId = thread.id;
      await lazy.WhimsyAIStore.append(thread.id, { role: "user", text: card.question });
    } catch (e) {
      console.error("Whimsy: Ask thread", e);
    }
    const timer = win.setTimeout(() => {
      if (card.status == "waiting") {
        card.status = "loading";
        this.render(win, card);
      }
    }, LOADING_MS);
    card.request = {
      task: "ask",
      messages: [{ role: "user", content: card.question }],
      system,
      provider: card.provider ?? undefined,
      userStarted: true,
      signal: card.controller.signal,
      onEvent: event => this.onEvent(win, card, event),
    };
    await this.runRequest(win, card, () => lazy.WhimsyAIRouter.run(card.request));
    win.clearTimeout(timer);
  },

  async runRequest(win, card, fn) {
    try {
      const result = await fn();
      card.result = result;
      card.text = result?.text ?? card.text;
      card.status = result?.partial ? "partial" : "done";
    } catch (e) {
      if (card.controller.signal.aborted) {
        card.status = "stopped";
      } else {
        card.error = { code: e?.code ?? "failed", tried: e?.tried ?? [], provider: e?.provider ?? card.provider ?? null, until: e?.until ?? null };
        card.status = "error";
      }
    }
    if (cardOf(win) == card) {
      this.render(win, card);
      this.announce(win, card);
    }
    await this.save(card);
  },

  onEvent(win, card, event) {
    if (cardOf(win) != card) {
      return;
    }
    switch (event.type) {
      case "status":
        if (event.provider) {
          card.provider = event.provider;
        }
        break;
      case "handoff":
        card.handoff = { from: event.from, to: event.to, reason: event.reason, until: event.until ?? null };
        card.provider = event.to;
        break;
      case "text":
        if (card.status == "waiting" || card.status == "loading") {
          card.status = "streaming";
          this.announce(win, card);
        }
        card.text += event.delta;
        break;
      case "citation":
        card.citations.push({ n: Number(event.n) || card.citations.length + 1, at: card.text.length, source: event.source ?? null });
        break;
      case "quota-mid":
        card.next = event.next ?? null;
        break;
    }
    this.scheduleRender(win, card);
  },

  async save(card) {
    if (!card.threadId || card.saved) {
      return;
    }
    if (!card.text && card.status != "error") {
      return;
    }
    card.saved = true;
    try {
      if (card.text) {
        await lazy.WhimsyAIStore.append(card.threadId, {
          role: "ai",
          text: card.text,
          provider: card.result?.provider ?? card.provider ?? null,
          model: card.result?.model ?? null,
          partial: card.status != "done",
          citations: card.citations.length ? card.citations : undefined,
        });
      } else {
        await lazy.WhimsyAIStore.append(card.threadId, { role: "error", code: card.error.code, provider: card.error.provider, tried: card.error.tried, until: card.error.until });
      }
    } catch (e) {
      console.error("Whimsy: Ask save", e);
    }
  },

  detailText(win, card) {
    const l10n = new win.Localization(["browser/whimsy.ftl"], true);
    const total = card.sources.length;
    return total
      ? l10n.formatValueSync("whimsy-cmdbar-thread-detail-sources", { opened: card.opened.size, total })
      : l10n.formatValueSync("whimsy-cmdbar-thread-detail");
  },

  stop(win) {
    const card = cardOf(win);
    if (card && !card.controller.signal.aborted && ["waiting", "loading", "streaming"].includes(card.status)) {
      card.controller.abort();
    }
  },

  /** Leaves the card: stops a stream, keeps the exchange, offers it as the Recent answer. */
  end(win, { keep = true, toChat = false } = {}) {
    const card = cardOf(win);
    if (!card) {
      return;
    }
    if (["waiting", "loading", "streaming"].includes(card.status)) {
      card.controller.abort();
    }
    cards.delete(win);
    this.leaveMode(win);
    win.cancelAnimationFrame(card.raf);
    if (card.threadId) {
      lazy.WhimsyAIStore.updateThread(card.threadId, { detail: this.detailText(win, card) }).catch(() => {});
    }
    if (keep && !toChat && card.text) {
      lazy.WhimsyAIUpdates.setRecentAnswer(card.snapshot());
    } else if (toChat) {
      lazy.WhimsyAIUpdates.setRecentAnswer(null);
    }
  },

  onViewClose(win) {
    if (cardOf(win) && !this._reopening) {
      this.end(win);
    }
    this.stopNumbers(win);
  },

  /** Reopens a Recent answer card as it was left. */
  reopen(win, snap) {
    if (!snap || !aiOn()) {
      return;
    }
    const card = Card.restore(win, snap);
    cards.set(win, card);
    this.enterMode(win);
    this.requery(win);
  },

  async openInChat(win) {
    const card = cardOf(win);
    if (!card) {
      return;
    }
    if (["waiting", "loading", "streaming"].includes(card.status)) {
      this.stop(win);
    }
    await this.save(card);
    const threadId = card.threadId;
    this.end(win, { toChat: true });
    win.gURLBar.view.close();
    win.gURLBar.handleRevert?.();
    win.gBrowser.selectedBrowser.focus();
    if (threadId) {
      await lazy.WhimsyChat.open(win, { threadId });
    }
  },

  async continueInChat(win, text) {
    const card = cardOf(win);
    const prompt = String(text ?? "").trim();
    if (!card || !prompt) {
      return;
    }
    this.stop(win);
    await this.save(card);
    const threadId = card.threadId;
    this.end(win, { toChat: true });
    win.gURLBar.view.close();
    win.gURLBar.handleRevert?.();
    win.gBrowser.selectedBrowser.focus();
    if (threadId) {
      await lazy.WhimsyChat.open(win, { threadId, prompt, send: true });
    }
  },

  /** Opens a cited source: beside the asking tab, or in the background with ⌘. */
  openSource(win, source, { background = false } = {}) {
    const card = cardOf(win);
    if (!card || !source?.url) {
      return;
    }
    card.opened.add(source.n);
    const gBrowser = win.gBrowser;
    const open = gBrowser.tabs.find(t => t.linkedBrowser.currentURI.spec == source.url && !lazy.WhimsyAIContext.isPrivate(t));
    if (background) {
      if (!open) {
        const index = card.tab?.isConnected ? card.tab._tPos + 1 : undefined;
        gBrowser.addTab(source.url, { index, inBackground: true, triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
      }
      this.render(win, card);
      return;
    }
    this.end(win);
    win.gURLBar.view.close();
    win.gURLBar.handleRevert?.();
    if (open) {
      gBrowser.selectedTab = open;
      return;
    }
    const index = card.tab?.isConnected ? card.tab._tPos + 1 : undefined;
    const tab = gBrowser.addTab(source.url, { index, triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
    gBrowser.selectedTab = tab;
  },

  retry(win, opts = {}) {
    const card = cardOf(win);
    if (!card) {
      return;
    }
    this.ask(win, card.question, { scope: card.scope, provider: opts.provider ?? null });
  },

  finishWith(win, next) {
    const card = cardOf(win);
    if (!card?.result || !next) {
      return;
    }
    card.status = "streaming";
    card.controller = new win.AbortController();
    card.saved = false;
    const before = card.text;
    const req = { ...card.request, signal: card.controller.signal };
    this.render(win, card);
    this.runRequest(win, card, async () => {
      const result = await lazy.WhimsyAIRouter.continueOn(card.result, next, req);
      return { ...result, text: before + (result?.text ?? "") };
    });
  },

  // ---- Keys ----

  onInputKey(win, event) {
    if (event.key != "Enter" || event.altKey || event.shiftKey) {
      return;
    }
    const urlbar = win.gURLBar;
    const card = cardOf(win);
    const text = urlbar.value.trim();
    if (event.metaKey || event.ctrlKey) {
      if (card) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (text) {
          this.continueInChat(win, text);
        } else if (card.status != "error") {
          this.openInChat(win);
        }
        return;
      }
      if (urlbar.view.isOpen && urlbar.view.panel.querySelector(`.urlbarView-row[dynamicType="${ASK_TYPE}"]`) && aiOn()) {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.ask(win, text);
      }
      return;
    }
    if (card && text && !urlbar.view.selectedElement) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.continueInChat(win, text);
    } else if (card && !text && !urlbar.view.selectedElement) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  },

  /** Visible rows that ⌘1–⌘9 count: every selectable row, top to bottom. */
  numberedRows(win) {
    const view = win.gURLBar?.view;
    if (!view?.isOpen) {
      return [];
    }
    return [...view.panel.querySelectorAll(".urlbarView-row")]
      .filter(row => !row.hidden && ![CARD_TYPE, "whimsy-update-heading", "whimsy-update-remind-option"].includes(row.getAttribute("dynamicType")) && row.getBoundingClientRect().height > 0)
      .slice(0, 9);
  },

  onWindowKey(win, event) {
    if (!Services.prefs.getBoolPref(NUMBERS_FEATURE, true)) {
      return;
    }
    const open = !!win.gURLBar?.view.isOpen;
    if (event.key == "Meta" || event.key == "Control") {
      if (open && !this._hold) {
        this._hold = win.setTimeout(() => this.showNumbers(win), HOLD_MS);
      }
      return;
    }
    if (this._hold) {
      win.clearTimeout(this._hold);
      this._hold = 0;
    }
    if (!open || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || !/^Digit[1-9]$/.test(event.code)) {
      return;
    }
    const rows = this.numberedRows(win);
    const row = rows[Number(event.code.slice(5)) - 1];
    event.preventDefault();
    event.stopImmediatePropagation();
    this.stopNumbers(win);
    if (!row) {
      return;
    }
    const target = row.querySelector(".urlbarView-row-inner") ?? row;
    win.gURLBar.pickElement(target, event);
  },

  onWindowKeyUp(win, event) {
    if (event.key == "Meta" || event.key == "Control") {
      this.stopNumbers(win);
    }
  },

  showNumbers(win) {
    this._hold = 0;
    if (!win.gURLBar?.view.isOpen) {
      return;
    }
    for (const [i, row] of this.numberedRows(win).entries()) {
      row.setAttribute("whimsy-num", `⌘${i + 1}`);
    }
    win.gURLBar.setAttribute("whimsy-numbers", "");
  },

  stopNumbers(win) {
    if (this._hold) {
      win.clearTimeout(this._hold);
      this._hold = 0;
    }
    const urlbar = win.gURLBar;
    if (!urlbar?.hasAttribute("whimsy-numbers")) {
      return;
    }
    urlbar.removeAttribute("whimsy-numbers");
    for (const row of urlbar.view.panel.querySelectorAll("[whimsy-num]")) {
      row.removeAttribute("whimsy-num");
    }
  },

  // ---- Drawing the card ----

  mountCard(win, el) {
    const card = cardOf(win);
    if (!card) {
      return;
    }
    card.el = el;
    if (!el.firstChild) {
      el.setAttribute("role", "status");
      el.setAttribute("aria-live", "polite");
    }
    this.render(win, card);
  },

  scheduleRender(win, card) {
    if (card.raf) {
      return;
    }
    card.raf = win.requestAnimationFrame(() => {
      card.raf = 0;
      this.render(win, card);
    });
  },

  announce(win, card) {
    const region = card.el?.isConnected ? card.el : null;
    if (!region) {
      return;
    }
    const busy = ["waiting", "loading", "streaming"].includes(card.status);
    region.setAttribute("aria-busy", busy ? "true" : "false");
  },

  render(win, card) {
    const el = card.el;
    if (!el?.isConnected) {
      return;
    }
    const doc = win.document;
    const busy = ["waiting", "loading", "streaming"].includes(card.status);
    const dir = /[֐-ࣿ]/.test(card.question) ? "rtl" : "auto";
    const focused = doc.activeElement && el.contains(doc.activeElement) ? doc.activeElement.dataset.action : null;
    const body = [];
    body.push(h(doc, "div", { class: "whimsy-ask-q", dir: "auto" }, card.question));
    if (card.handoff) {
      body.push(this.handoffLine(doc, card.handoff));
    }
    const provider = card.result?.provider ?? card.provider ?? lazy.WhimsyAIRouter.capable({})[0] ?? null;
    if (card.status != "error" && provider) {
      const who = whoOf(provider, card.result?.model);
      const metaId = card.status == "loading" || card.status == "waiting" ? (card.readPage ? "whimsy-cmdbar-meta-reading" : "whimsy-cmdbar-meta-thinking") : card.readPage ? "whimsy-cmdbar-meta-tab-web" : "whimsy-cmdbar-meta-web";
      body.push(h(doc, "div", { class: "whimsy-ask-meta" }, brand(doc, provider), h(doc, "span", { l10n: [metaId, { who }] })));
    }
    if (card.text) {
      const pills = { pill: n => h(doc, "span", { class: "whimsy-ask-cite" }, String(n)) };
      const blocks = lazy.answerModule.renderMarkdown(doc, marked(card.text, card.citations, !busy), pills);
      const wrap = h(doc, "div", { class: "whimsy-ask-body", dir: "auto" }, blocks);
      if (busy) {
        const last = wrap.lastElementChild ?? wrap;
        last.append(h(doc, "span", { class: "whimsy-ask-caret", "aria-hidden": "true" }));
      }
      body.push(wrap);
    } else if (card.status == "loading") {
      body.push(h(doc, "div", { class: "whimsy-ask-loading", "aria-hidden": "true" }, h(doc, "span", { class: "whimsy-ask-skeleton", style: "width: 92%" }), h(doc, "span", { class: "whimsy-ask-skeleton", style: "width: 60%" })));
    }
    if (card.status == "error") {
      body.push(this.errorLine(win, doc, card));
    } else if (card.status == "partial") {
      body.push(this.partialLine(win, doc, card));
    }
    const sources = card.sources;
    if (sources.length && !busy) {
      body.push(h(doc, "div", { class: "whimsy-ask-sources" }, sources.map(s => this.sourceChip(win, doc, card, s))));
    }
    body.push(this.footer(win, doc, card, busy));
    el.setAttribute("dir", dir);
    el.toggleAttribute("busy", busy);
    el.setAttribute("aria-busy", busy ? "true" : "false");
    el.replaceChildren(...body);
    if (focused) {
      el.querySelector(`[data-action="${focused}"]`)?.focus();
    }
  },

  handoffLine(doc, handoff) {
    const from = nameOf(handoff.from);
    const to = nameOf(handoff.to);
    const until = handoff.until ? new Date(handoff.until).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "";
    const id = handoff.reason == "capability" ? "whimsy-cmdbar-handoff-capability" : until ? "whimsy-cmdbar-handoff-until" : "whimsy-cmdbar-handoff";
    return h(doc, "div", { class: "whimsy-ask-line", tone: "info" }, brand(doc, handoff.to), h(doc, "span", { l10n: [id, { from, to, time: until }] }));
  },

  button(doc, l10n, run, { action, icon } = {}) {
    return h(doc, "button", { class: "whimsy-ask-btn", "data-action": action ?? (Array.isArray(l10n) ? l10n[0] : l10n), onclick: run }, icon ? img(doc, icon, "whimsy-ask-btn-icon") : null, h(doc, "span", { l10n }));
  },

  errorLine(win, doc, card) {
    const P = lazy.WhimsyAIProviders;
    const { code, tried = [], until } = card.error;
    const provider = card.error.provider ?? tried[0] ?? card.provider ?? P.order.find(id => P.isOn(id)) ?? "claude";
    const name = nameOf(provider);
    const others = lazy.WhimsyAIRouter.capable({}).filter(id => id != provider && !tried.includes(id));
    const time = until ? new Date(until).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "";
    const retry = this.button(doc, "whimsy-cmdbar-try-again", () => this.retry(win), { action: "retry" });
    let tone = "fail";
    let l10n = ["whimsy-cmdbar-error-down", { provider: name }];
    let buttons = [retry];
    if (code == "offline") {
      tone = "warn";
      l10n = ["whimsy-cmdbar-error-offline", { provider: name }];
      if (P.order.includes("apple") && P.isOn("apple") && provider != "apple") {
        buttons.push(this.button(doc, "whimsy-cmdbar-ask-apple", () => this.retry(win, { provider: "apple" }), { action: "apple", icon: BRAND_ICONS.apple }));
      }
    } else if (code == "all-failed" || code == "plan-limit" || code == "rate-limited" || code == "none-capable") {
      tone = "warn";
      const names = new Intl.ListFormat("en", { type: "conjunction" }).format((tried.length ? tried : [provider]).map(nameOf));
      l10n = code == "none-capable"
        ? ["whimsy-cmdbar-error-none-capable", { names }]
        : [time ? "whimsy-cmdbar-error-all-out-until" : "whimsy-cmdbar-error-all-out", { names, count: Math.max(tried.length, 1), time }];
      buttons = [];
      if (P.canManageUsage?.(provider)) {
        buttons.push(this.button(doc, "whimsy-cmdbar-manage-usage", () => P.manageUsage(win, provider), { action: "usage" }));
      } else {
        buttons.push(this.button(doc, "whimsy-cmdbar-see-providers", () => P.openSettings(win), { action: "settings" }));
      }
      buttons.push(this.button(doc, ["whimsy-cmdbar-search-instead", { engine: engineName(win) }], () => this.searchInstead(win, card), { action: "search" }));
    } else if (others.length) {
      buttons.push(this.button(doc, ["whimsy-cmdbar-ask-other", { provider: nameOf(others[0]) }], () => this.retry(win, { provider: others[0] }), { action: "other", icon: BRAND_ICONS[others[0]] }));
    }
    return h(doc, "div", { class: "whimsy-ask-line", tone, role: "alert" }, img(doc, code == "offline" ? "chrome://browser/skin/zen-icons/info.svg" : "chrome://browser/skin/zen-icons/security-warning.svg", "whimsy-ask-line-icon"), h(doc, "span", { class: "whimsy-ask-line-text", l10n }), h(doc, "span", { class: "whimsy-ask-spacer" }), buttons);
  },

  partialLine(win, doc, card) {
    const provider = card.result?.provider ?? card.provider;
    const next = card.next ?? card.result?.next ?? lazy.WhimsyAIRouter.capable({}).find(id => id != provider);
    const until = lazy.WhimsyAIProviders.resting?.(provider)?.until;
    const time = until ? new Date(until).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "";
    return h(
      doc,
      "div",
      { class: "whimsy-ask-line", tone: "warn" },
      img(doc, "chrome://browser/skin/zen-icons/security-warning.svg", "whimsy-ask-line-icon"),
      h(doc, "span", { class: "whimsy-ask-line-text", l10n: [time ? "whimsy-cmdbar-partial-until" : "whimsy-cmdbar-partial", { provider: nameOf(provider), time }] }),
      h(doc, "span", { class: "whimsy-ask-spacer" }),
      next ? this.button(doc, ["whimsy-cmdbar-finish-with", { provider: nameOf(next) }], () => this.finishWith(win, next), { action: "finish", icon: BRAND_ICONS[next] }) : null
    );
  },

  searchInstead(win, card) {
    const question = card.question;
    this.end(win, { keep: false });
    win.gURLBar.view.close();
    win.BrowserSearch?.loadSearchFromCommandBar?.(question) ?? win.openTrustedLinkIn(Services.search.defaultEngine?.getSubmission(question)?.uri.spec ?? "about:blank", "current");
  },

  sourceChip(win, doc, card, source) {
    const openTab = win.gBrowser.tabs.some(t => t.linkedBrowser.currentURI.spec == source.url);
    const visited = card.opened.has(source.n);
    const chip = h(
      doc,
      "button",
      { class: "whimsy-ask-source", "data-action": `source-${source.n}`, "data-url": source.url, tab: openTab, visited, title: source.url },
      h(doc, "span", { class: "whimsy-ask-cite" }, String(source.n)),
      img(doc, `page-icon:${source.url}`, "whimsy-ask-source-icon"),
      h(doc, "span", { class: "whimsy-ask-source-title", dir: "auto" }, source.title || hostOf(source.url)),
      visited
        ? h(doc, "span", { class: "whimsy-ask-source-opened" }, img(doc, "chrome://global/skin/icons/check.svg", "whimsy-ask-check"), h(doc, "span", { l10n: "whimsy-cmdbar-source-opened" }))
        : h(doc, "span", { class: "whimsy-ask-source-host" }, openTab ? h(doc, "span", { l10n: ["whimsy-cmdbar-source-open-tab", { host: hostOf(source.url) }] }) : hostOf(source.url))
    );
    chip.addEventListener("click", event => {
      event.preventDefault();
      this.openSource(win, source, { background: event.metaKey || event.ctrlKey || event.button == 1 });
    });
    chip.addEventListener("auxclick", event => {
      if (event.button == 1) {
        event.preventDefault();
        this.openSource(win, source, { background: true });
      }
    });
    return chip;
  },

  footer(win, doc, card, busy) {
    const left = [];
    const right = [];
    const typed = !!win.gURLBar.value.trim();
    if (busy) {
      left.push(this.button(doc, "whimsy-cmdbar-stop", () => this.stop(win), { action: "stop", icon: `${ICONS}stop.svg` }));
      right.push(h(doc, "span", { class: "whimsy-ask-foot-hint", l10n: "whimsy-cmdbar-esc-closes" }));
    } else if (card.status != "error") {
      left.push(this.button(doc, "whimsy-cmdbar-copy", () => lazy.WhimsyChatAnswer.copyText(card.text), { action: "copy", icon: "chrome://global/skin/icons/edit-copy.svg" }));
      if (typed) {
        right.push(h(doc, "button", { class: "whimsy-ask-btn", "data-action": "continue", onclick: () => this.continueInChat(win, win.gURLBar.value) }, h(doc, "span", { l10n: "whimsy-cmdbar-continue-in-chat" }), key(doc, "↩")));
      } else {
        right.push(h(doc, "span", { class: "whimsy-ask-foot-hint", l10n: "whimsy-cmdbar-followup-hint" }));
        right.push(h(doc, "button", { class: "whimsy-ask-btn", "data-action": "open-in-chat", onclick: () => this.openInChat(win) }, h(doc, "span", { l10n: "whimsy-cmdbar-open-in-chat" }), key(doc, "⌘↩")));
      }
    }
    return h(doc, "div", { class: "whimsy-ask-foot" }, left, h(doc, "span", { class: "whimsy-ask-spacer" }), right);
  },

  // Typing a follow-up swaps the footer's way forward.
  onInput(win) {
    const card = cardOf(win);
    if (card?.el) {
      this.render(win, card);
    }
  },
};

const BRAND_ICONS = {
  apple: "chrome://browser/content/whimsy/ai/apple-intelligence.svg",
  claude: `${ICONS}claude.svg`,
  ollama: "chrome://browser/content/whimsy/ai/ollama.svg",
  openai: `${ICONS}openai.svg`,
  gemini: `${ICONS}gemini.svg`,
};

function brand(doc, provider) {
  return img(doc, BRAND_ICONS[provider] ?? SPARKLE, "whimsy-ask-brand");
}

function nameOf(id) {
  return lazy.answerModule.providerName(id);
}

function whoOf(provider, model) {
  return lazy.answerModule.whoLabel(provider, model);
}

function engineName() {
  try {
    return Services.search.defaultEngine?.name ?? "the web";
  } catch {
    return "the web";
  }
}

ChromeUtils.defineLazyGetter(lazy, "answerModule", () => ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyChatAnswer.sys.mjs"));
