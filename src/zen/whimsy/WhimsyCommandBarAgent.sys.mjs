/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W25: the ⌘K agent (intake-w25/mockups tab-commands.html, K.1–K.11).
// Something to do, typed in the command bar, gets a top row (Do this ↩)
// that hands it to chat's agent (WhimsyChatAgent): one agent, one history
// (the run shows in chat, "From ⌘K"), one Drive or Background setting
// (whimsy.ai.agent.mode), and the same guard pauses.
//
// - One reversible tab action (close, move, pin, mute): the top row says
//   what will happen and the sidebar rings the tabs; Enter does it, and the
//   Undo toast follows. At 15 tabs or more the row turns red and takes ⌘↩.
// - Anything bigger: a short plan with one Approve (↩). The footer has the
//   mode dropdown (website plans only), chat's model dropdown (Auto first;
//   the pick is for this run), Cancel (Esc), and Run in background (⌘↩).
//   Tab and ⇧Tab move through the models; focus stays in the field, and ↓
//   moves into the footer, where ← and → move between its controls.
// - After Approve the bar closes and a status card sits where toasts
//   appear: the step and Stop (⌘.). A guard pause shows exactly what goes
//   out with chat's three answers; Enter does nothing there and Esc is the
//   "Don't" answer. Done is a toast (and a macOS notification when Whimsy
//   isn't in front); a failed run says what didn't happen, with Try again.
// - What it can't do (sending mail, making events: connectors only read)
//   says so in one line, with Ask in chat.

import { UrlbarProvider } from "moz-src:///browser/components/urlbar/UrlbarUtils.sys.mjs";
import { UrlbarShared } from "chrome://browser/content/urlbar/UrlbarShared.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  ProvidersManager: "moz-src:///browser/components/urlbar/UrlbarProvidersManager.sys.mjs",
  UrlbarResult: "chrome://browser/content/urlbar/UrlbarResult.mjs",
  WhimsyAI: "resource:///modules/whimsy/WhimsyAI.sys.mjs",
  WhimsyAIContext: "resource:///modules/whimsy/WhimsyAIContext.sys.mjs",
  WhimsyAIRouter: "resource:///modules/whimsy/WhimsyAIRouter.sys.mjs",
  WhimsyAIStore: "resource:///modules/whimsy/WhimsyAIStore.sys.mjs",
  WhimsyAITabRequests: "resource:///modules/whimsy/WhimsyAITabRequests.sys.mjs",
  WhimsyAgentTasks: "resource:///modules/whimsy/WhimsyAgentTasks.sys.mjs",
  WhimsyChat: "resource:///modules/whimsy/WhimsyChat.sys.mjs",
  WhimsyChatAgent: "resource:///modules/whimsy/WhimsyChatAgent.sys.mjs",
  WhimsyChatAnswer: "resource:///modules/whimsy/WhimsyChatAnswer.sys.mjs",
});
ChromeUtils.defineLazyGetter(lazy, "l10n", () => new Localization(["branding/brand.ftl", "browser/whimsy.ftl"], true));

const HTML_NS = "http://www.w3.org/1999/xhtml";
const ROW_TYPE = "whimsy-cmdk-agent";
const CARD_TYPE = "whimsy-cmdk-plan";
const ASK_FEATURE = "whimsy.feature.ai-ask";
const SPARKLE = "chrome://browser/skin/zen-icons/sparkles.svg";
const CHEVRON = "chrome://browser/content/whimsy/icons/chevron-down.svg";
// "Planning…" gets its spinner only when planning takes longer than this.
const SLOW_MS = 300;
// A one-step action on this many tabs or more takes ⌘↩, not ↩ (K.3).
const MANY_TABS = 15;
const REDUCED = "(prefers-reduced-motion: reduce)";
// Something to do: an imperative that isn't what the bar already does
// (open, go to, search, find, look up), at least three words long. General
// verbs only; never a list of sites.
const DO_VERBS = /^(?:please\s+|can you\s+|could you\s+|would you\s+)*(?:order|re-?order|buy|purchase|book|reserve|schedule|add|remove|delete|cancel|unsubscribe|send|post|reply|email|e-mail|message|text|invite|sign (?:up|in|out)|subscribe|download|install|make|set|set up|change|move|rename|archive|clean up|tidy|collect|gather|research|plan|pay|apply|register|rsvp|accept|decline|follow|share|upload|save|close|pin|unpin|mute|unmute|group|put|organi[sz]e|sort|turn (?:on|off)|switch|enable|disable|create|remind|start)\b/i;

const OBJECT_WORDS = /\b(?:my|me|our|us|this|these|that|those|the|a|an|all|every|tabs?)\b/i;

// Per window: the request in the bar, from Planning to Approve.
const states = new WeakMap();
// Windows where the person moved through the rows since typing: Enter then
// picks what they chose (search works as today).
const moved = new WeakSet();
// Approved tasks with a status card: taskId -> {win, toast, sig, hidden}.
const tracked = new Map();
let nextQuery = 0;

function topWindow() {
  return lazy.BrowserWindowTracker.getTopWindow();
}

function stateOf(win) {
  return win ? states.get(win) ?? null : null;
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

function key(doc, text) {
  return h(doc, "kbd", { class: "whimsy-cmdbar-key", "aria-hidden": "true" }, text);
}

function listOf(items) {
  return new Intl.ListFormat(Services.locale.appLocalesAsBCP47[0] ?? "en", { type: "conjunction" }).format(items);
}

function hostOf(tab) {
  try {
    return tab.linkedBrowser.currentURI.host.replace(/^www\./, "");
  } catch {
    return "";
  }
}

// The models Tab steps through: Auto, then chat's models in their order.
function models() {
  return ["auto", ...lazy.WhimsyAIRouter._enabled()];
}

export class WhimsyCmdkProvider extends UrlbarProvider {
  get name() {
    return "WhimsyCmdk";
  }

  get type() {
    return UrlbarShared.PROVIDER_TYPE.PROFILE;
  }

  // While a request is being planned or shown, it's the only result.
  getPriority() {
    return stateOf(topWindow()) ? 60 : 0;
  }

  async isActive(context) {
    const win = topWindow();
    if (!win || isPrivateContext(context, win) || context.searchMode || context.restrictSource) {
      return false;
    }
    return !!stateOf(win) || WhimsyCommandBarAgent.takes(win, context.searchString ?? "");
  }

  startQuery(context, addCallback) {
    const win = topWindow();
    const st = stateOf(win);
    const add = (payload, suggestedIndex = 0) =>
      addCallback(this, new lazy.UrlbarResult({
        type: UrlbarShared.RESULT_TYPE.DYNAMIC,
        source: UrlbarShared.RESULT_SOURCE.OTHER_LOCAL,
        suggestedIndex,
        payload: { dynamicType: ROW_TYPE, query: ++nextQuery, ...payload },
      }));
    if (!st) {
      add({ kind: "do", text: context.searchString.trim() });
    } else if (st.phase == "plan") {
      add({ dynamicType: CARD_TYPE });
    } else if (st.phase == "confirm") {
      st.options.forEach((_, i) => add({ kind: "confirm", index: i }, i));
    } else {
      add({ kind: st.phase });
    }
  }

  getViewTemplate(result) {
    if (result.payload.dynamicType == CARD_TYPE) {
      return { attributes: { role: "presentation" }, children: [{ name: "card", tag: "div", classList: ["whimsy-cmdk-card"] }] };
    }
    return {
      attributes: result.payload.kind == "planning" ? {} : { selectable: true },
      children: [
        { name: "icon", tag: "img", classList: ["urlbarView-favicon", "whimsy-ask-icon", "whimsy-cmdk-icon"] },
        {
          name: "text",
          tag: "span",
          classList: ["whimsy-cmdk-row-text"],
          children: [
            { name: "title", tag: "span", classList: ["urlbarView-title", "whimsy-cmdk-row-title"] },
            { name: "detail", tag: "span", classList: ["whimsy-cmdk-row-detail"] },
          ],
        },
        { name: "tag", tag: "span", classList: ["whimsy-cmdk-row-tag"] },
        { name: "action", tag: "span", classList: ["whimsy-cmdk-row-action"] },
        { name: "key", tag: "kbd", classList: ["whimsy-cmdbar-key", "whimsy-cmdk-row-key"] },
      ],
    };
  }

  getViewUpdate(result) {
    const { payload } = result;
    if (payload.dynamicType == CARD_TYPE) {
      return {};
    }
    const win = topWindow();
    const st = stateOf(win);
    const hidden = { attributes: { hidden: true } };
    switch (payload.kind) {
      case "planning":
        return {
          icon: { attributes: { src: SPARKLE } },
          title: { textContent: st?.request ?? "", attributes: { danger: null, wrap: null } },
          detail: hidden,
          tag: hidden,
          action: { l10n: { id: "whimsy-cmdk-planning" }, attributes: { slow: st?.slow ? "" : null, hidden: null } },
          key: hidden,
        };
      case "confirm": {
        const option = st?.options[payload.index];
        const many = (option?.tabs.length ?? 0) >= MANY_TABS;
        return {
          icon: { attributes: { src: "chrome://browser/skin/zen-icons/tab.svg" } },
          title: { textContent: option?.label ?? "", attributes: { danger: many ? "" : null, wrap: null } },
          detail: { textContent: option?.detail ?? "", attributes: { hidden: option?.detail ? null : true } },
          tag: option?.tag ? { textContent: option.tag, attributes: { hidden: null } } : hidden,
          action: hidden,
          key: { textContent: many ? "⌘↩︎" : "↩︎", attributes: { hidden: null } },
        };
      }
      case "cant":
        return {
          icon: { attributes: { src: "chrome://browser/skin/zen-icons/info.svg" } },
          title: { textContent: st?.reason ?? "", attributes: { danger: null, wrap: "" } },
          detail: hidden,
          tag: hidden,
          action: { l10n: { id: "whimsy-cmdk-ask-in-chat" }, attributes: { hidden: null } },
          key: { textContent: "↩︎", attributes: { hidden: null } },
        };
      default:
        return {
          icon: { attributes: { src: SPARKLE } },
          title: { textContent: payload.text ?? "", attributes: { danger: null, wrap: null } },
          detail: hidden,
          tag: hidden,
          action: { l10n: { id: "whimsy-cmdk-do-this" }, attributes: { hidden: null } },
          key: { textContent: "↩︎", attributes: { hidden: null } },
        };
    }
  }

  onEngagement(context, _controller, details) {
    const payload = details.result?.payload;
    const win = details.element?.documentGlobal ?? topWindow();
    if (!payload || payload.dynamicType != ROW_TYPE || !win) {
      return;
    }
    // Picking a row closes the view; what comes next opens it again.
    win.setTimeout(() => WhimsyCommandBarAgent.pick(win, payload), 0);
  }
}

export const WhimsyCommandBarAgent = {
  ROW_TYPE,
  CARD_TYPE,
  MANY_TABS,
  provider: null,

  get enabled() {
    return Services.prefs.getBoolPref(ASK_FEATURE, true) && lazy.WhimsyAI.enabled && lazy.WhimsyChatAgent.enabled;
  },

  init() {
    if (this.provider) {
      return;
    }
    const manager = lazy.ProvidersManager.getInstanceForSap("urlbar");
    this.provider = manager.getProvider("WhimsyCmdk");
    if (!this.provider) {
      this.provider = new WhimsyCmdkProvider();
      manager.registerProvider(this.provider);
    }
    Services.obs.addObserver(this, lazy.WhimsyAgentTasks.TOPIC);
  },

  /** Called from WhimsyCommandBarAI.initWindow, which owns the bar's keys. */
  initWindow(win) {
    this.init();
    // Chat's menu rows (the model menu) are drawn in the bar too.
    win.windowUtils.loadSheetUsingURIString(lazy.WhimsyChatAnswer.sheetURL, win.windowUtils.AUTHOR_SHEET);
    const urlbar = win.gURLBar;
    urlbar?.controller?.addListener({ onViewClose: () => this.onViewClose(win) });
    // Before the bar's own input handler starts the next query: editing the
    // request drops the plan first.
    urlbar?.inputField?.addEventListener("input", () => this.onInput(win), true);
    const panel = urlbar?.view?.panel;
    if (panel) {
      new win.MutationObserver(() => {
        const st = stateOf(win);
        const el = st?.phase == "plan" && panel.querySelector(".whimsy-cmdk-card");
        if (el && el != st.el) {
          this.mount(win, el);
        }
      }).observe(panel, { childList: true, subtree: true });
    }
  },

  /** Whether `text` in the bar reads as something to do (K.1). */
  takes(win, text) {
    const t = String(text ?? "").trim();
    if (!this.enabled || t.length < 8 || t.split(/\s+/).length < 4 || /^[a-z][\w+.-]*:\S/i.test(t) || t.endsWith("?")) {
      return false;
    }
    // An instruction names what it acts on ("my", "the", "a"): "book a
    // table for 4" is something to do, "book review hunger games" a search.
    if (!DO_VERBS.test(t) || !OBJECT_WORDS.test(t)) {
      return false;
    }
    // "close the youtube tabs" already has its own row, from the words alone.
    if (lazy.WhimsyAITabRequests.typedRows(win, t).length) {
      return false;
    }
    return true;
  },

  state(win) {
    return stateOf(win);
  },

  // ---- From the row to a plan ----

  pick(win, payload) {
    const st = stateOf(win);
    if (payload.kind == "do") {
      this.plan(win, payload.text);
    } else if (payload.kind == "confirm" && st?.phase == "confirm") {
      this.applyOne(win, payload.index, { force: true });
    } else if (payload.kind == "cant" && st?.phase == "cant") {
      this.askInChat(win);
    }
  },

  /** Enter on Do this: plans `text` in the bar (K.1 → K.3, K.4, K.5, or K.10). */
  async plan(win, text) {
    const request = String(text ?? "").trim();
    if (!request || !this.enabled || lazy.WhimsyAIContext.isPrivate(win.gBrowser.selectedTab)) {
      return;
    }
    this.leave(win);
    const st = {
      phase: "planning",
      request,
      tab: win.gBrowser.selectedTab,
      controller: new win.AbortController(),
      slow: false,
      provider: "auto",
      footIndex: -1,
      menu: null,
      el: null,
    };
    states.set(win, st);
    st.timer = win.setTimeout(() => {
      st.slow = true;
      win.gURLBar.view.panel.querySelector(`.urlbarView-row[dynamicType="${ROW_TYPE}"] .whimsy-cmdk-row-action`)?.setAttribute("slow", "");
    }, SLOW_MS);
    this.show(win);
    try {
      if (lazy.WhimsyAITabRequests.takes(request)) {
        await this.planTabs(win, st);
      } else {
        await this.planTask(win, st);
      }
    } catch (e) {
      if (!st.controller.signal.aborted) {
        console.error("Whimsy ⌘K agent: plan", e);
        st.phase = "cant";
        st.reason = lazy.l10n.formatValueSync("whimsy-cmdk-cant-fallback");
      }
    }
    win.clearTimeout(st.timer);
    if (stateOf(win) != st) {
      return;
    }
    if (st.phase == "ask") {
      // A question after all: the answer card takes it.
      this.leave(win);
      win.gURLBar.value = request;
      lazy.WhimsyCommandBarAI.ask(win, request);
      return;
    }
    this.ring(win);
    this.show(win);
  },

  // K.3: one reversible tab action; the row is the confirm.
  async planTabs(win, st) {
    const plan = await lazy.WhimsyAITabRequests.understand(win, st.request, { signal: st.controller.signal });
    if (!plan) {
      st.phase = "cant";
      st.reason = lazy.l10n.formatValueSync("whimsy-cmdk-tabs-none");
      return;
    }
    const options = plan.ask
      ? plan.ask.map(o => ({ action: plan.action, tabs: o.tabs, name: plan.name ?? "", tag: o.label }))
      : [{ action: plan.action, tabs: plan.tabs, name: plan.name ?? "", said: plan.label ?? "" }];
    st.options = options.map(o => this.describe(o));
    st.index = 0;
    st.phase = "confirm";
  },

  // "Close 6 tabs opened yesterday" and "Mobbin, NN/g, and Reddit. Undo reopens them."
  describe(option) {
    const count = option.tabs.length;
    const name = option.name || lazy.l10n.formatValueSync("whimsy-tabs-folder-default");
    // The model's own words, when they say the same count; else ours.
    const said = String(option.said ?? "").trim();
    const label = said && new RegExp(`\\b${count}\\b`).test(said) && said.length <= 80
      ? said
      : lazy.l10n.formatValueSync(`whimsy-cmdk-one-${option.action}`, { count, name });
    const sites = [...new Set(option.tabs.map(t => hostOf(t) || t.label).filter(Boolean))];
    const shown = sites.length > 6 ? [...sites.slice(0, 5), lazy.l10n.formatValueSync("whimsy-cmdk-more", { count: sites.length - 5 })] : sites;
    const detail = lazy.l10n.formatValueSync("whimsy-cmdk-one-detail", { action: option.action, list: listOf(shown) });
    return { ...option, label, detail };
  },

  // K.4, K.5, K.10: chat's planner, told it came from ⌘K.
  async planTask(win, st) {
    const Agent = lazy.WhimsyChatAgent;
    const mode = Agent.mode;
    const drafted = await Agent.draft(win, st.request, { tab: st.tab, mode, cmdk: true, signal: st.controller.signal });
    if (st.controller.signal.aborted) {
      return;
    }
    if (!drafted) {
      st.phase = "ask";
      return;
    }
    if (drafted.cant != null) {
      st.phase = "cant";
      st.reason = drafted.cant || lazy.l10n.formatValueSync("whimsy-cmdk-cant-fallback");
      return;
    }
    const tab = st.tab;
    const thread = await lazy.WhimsyAIStore.createThread({
      kind: "cmdbar",
      title: st.request,
      tabKey: lazy.WhimsyAIContext.tabKey(tab),
      url: tab.linkedBrowser.currentURI.spec,
      origin: "cmdk",
      detail: lazy.l10n.formatValueSync("whimsy-cmdk-thread-detail"),
    });
    await lazy.WhimsyAIStore.append(thread.id, { role: "user", text: st.request });
    const card = await Agent.append(null, thread.id, { role: "card", card: "agent-plan", state: "drafting", mode, request: st.request });
    const task = await Agent.adopt(win, thread, card, st.request, drafted, { tab, mode, cmdk: true });
    const apps = Array.isArray(drafted.plan.apps) ? drafted.plan.apps.map(a => String(a).slice(0, 40)).filter(Boolean).slice(0, 4) : [];
    Object.assign(st, {
      phase: "plan",
      threadId: thread.id,
      cardId: card.id,
      taskId: task.id,
      title: task.title || st.request,
      steps: drafted.steps,
      // A plan that never opens a website runs in the background.
      web: drafted.plan.web !== false,
      apps,
    });
    if (stateOf(win) != st) {
      Agent.dismissPlan(task.id, thread.id, card.id);
    }
  },

  /** Shows the bar's results for the current state. */
  show(win) {
    const urlbar = win.gURLBar;
    const st = stateOf(win);
    if (!urlbar.focused) {
      urlbar.focus();
    }
    if (st && urlbar.value != st.request) {
      urlbar.value = st.request;
    }
    if (st) {
      st.el = null;
    }
    try {
      urlbar.startQuery({ searchString: urlbar.value, allowAutofill: false });
    } catch (e) {
      console.error("Whimsy ⌘K agent: requery", e);
    }
  },

  // The sidebar rings the tabs a one-step action will touch.
  ring(win) {
    for (const tab of win.gBrowser.tabs) {
      tab.removeAttribute("whimsy-cmdk-ring");
    }
    const st = stateOf(win);
    if (st?.phase == "confirm") {
      for (const tab of st.options[st.index]?.tabs ?? []) {
        tab.setAttribute("whimsy-cmdk-ring", "");
      }
    }
  },

  /** Ends the bar's request. A plan not approved is dismissed; nothing changed. */
  leave(win, { keepTask = false } = {}) {
    const st = stateOf(win);
    if (!st) {
      return;
    }
    states.delete(win);
    win.clearTimeout(st.timer);
    st.controller.abort();
    if (st.taskId && !keepTask) {
      lazy.WhimsyChatAgent.dismissPlan(st.taskId, st.threadId, st.cardId).catch(() => {});
    }
    win.gURLBar?.inputField?.removeAttribute("aria-activedescendant");
    for (const tab of win.gBrowser.tabs) {
      tab.removeAttribute("whimsy-cmdk-ring");
    }
  },

  /** Esc, or Cancel: closes the bar; nothing has changed. */
  cancel(win) {
    this.leave(win);
    this.closeBar(win);
  },

  closeBar(win) {
    const urlbar = win.gURLBar;
    this._closing = true;
    try {
      urlbar.view.close();
      urlbar.handleRevert?.();
    } finally {
      this._closing = false;
    }
    win.gBrowser.selectedBrowser.focus();
  },

  onViewClose(win) {
    if (stateOf(win) && !this._closing) {
      this.leave(win);
    }
  },

  // ---- K.3: the one step ----

  applyOne(win, index = null, { force = false } = {}) {
    const st = stateOf(win);
    const option = st?.phase == "confirm" ? st.options[index ?? st.index] : null;
    if (!option) {
      return false;
    }
    if (option.tabs.length >= MANY_TABS && !force) {
      return false;
    }
    this.leave(win);
    this.closeBar(win);
    lazy.WhimsyAITabRequests.apply(win, option);
    return true;
  },

  askInChat(win) {
    const st = stateOf(win);
    const prompt = st?.request ?? win.gURLBar.value;
    this.leave(win);
    this.closeBar(win);
    lazy.WhimsyChat.open(win, { prompt, focus: "composer" });
  },

  // ---- K.4 and K.5: the plan card ----

  mount(win, el) {
    const st = stateOf(win);
    st.el = el;
    // Focus stays in the request field: a press on the card never takes it.
    el.addEventListener("mousedown", event => {
      if (!event.target.closest("input, textarea")) {
        event.preventDefault();
      }
    });
    el.setAttribute("aria-label", st.title);
    this.render(win);
  },

  /** The footer's controls, in ← → order. */
  controls(win) {
    const st = stateOf(win);
    const out = [];
    if (st.web) {
      out.push("where");
    }
    out.push("model", "cancel");
    if (st.web && lazy.WhimsyChatAgent.mode != "background") {
      out.push("background");
    }
    out.push("approve");
    return out;
  },

  render(win) {
    const st = stateOf(win);
    const el = st?.el;
    if (!el?.isConnected) {
      return;
    }
    const doc = win.document;
    const fresh = !el.firstChild;
    const steps = h(doc, "ol", { class: "whimsy-cmdk-steps" },
      st.steps.map((s, i) => h(doc, "li", { class: "whimsy-cmdk-step", "data-pause": s.pause ?? null },
        h(doc, "span", { class: "whimsy-cmdk-num", "aria-hidden": "true" }, String(i + 1)),
        h(doc, "span", { class: "whimsy-cmdk-step-text", dir: "auto" }, s.text),
        s.pause ? h(doc, "span", { class: "whimsy-cmdk-asks", l10n: "whimsy-cmdk-asks-first" }) : null)));
    const controls = this.controls(win);
    const kbd = name => (st.footIndex >= 0 && controls[st.footIndex] == name ? "" : null);
    const mode = lazy.WhimsyChatAgent.mode;
    const provider = st.provider;
    const who = provider == "auto" ? lazy.l10n.formatValueSync("whimsy-chat-model-auto") : lazy.answer.whoLabel(provider);
    const left = [];
    if (st.web) {
      const where = lazy.l10n.formatValueSync(`whimsy-cmdk-where-${mode}`);
      left.push(h(doc, "button", {
        id: "cmdk-foot-where",
        class: "whimsy-chat-model-button whimsy-cmdk-drop",
        "data-control": "where",
        "aria-haspopup": "listbox",
        "aria-expanded": String(st.menu?.kind == "where"),
        "data-kbd-focus": kbd("where"),
        l10n: ["whimsy-cmdk-where-button", { where }],
        onclick: () => this.toggleMenu(win, "where"),
      }, h(doc, "span", {}, where), h(doc, "img", { class: "whimsy-chat-model-chevron", src: CHEVRON, alt: "" })));
    }
    left.push(h(doc, "button", {
      id: "cmdk-foot-model",
      class: "whimsy-chat-model-button whimsy-cmdk-drop",
      "data-control": "model",
      "data-provider": provider,
      "aria-haspopup": "listbox",
      "aria-expanded": String(st.menu?.kind == "model"),
      "data-kbd-focus": kbd("model"),
      l10n: ["whimsy-cmdk-model-button", { who }],
      onclick: () => this.toggleMenu(win, "model"),
    },
    provider == "auto" ? null : h(doc, "img", { class: "whimsy-chat-brand", src: lazy.answer.BRANDS[provider] ?? SPARKLE, alt: "" }),
    h(doc, "span", { class: "whimsy-chat-model-name" }, who),
    h(doc, "img", { class: "whimsy-chat-model-chevron", src: CHEVRON, alt: "" })));
    if (!st.web) {
      left.push(h(doc, "span", { class: "whimsy-cmdk-hint whimsy-cmdk-apps", l10n: ["whimsy-cmdk-apps-only", { apps: listOf(st.apps.length ? st.apps : [lazy.l10n.formatValueSync("whimsy-cmdk-apps-fallback")]) }] }));
    }
    left.push(h(doc, "span", { class: "whimsy-cmdk-hint" }, key(doc, "⇥"), h(doc, "span", { l10n: "whimsy-cmdk-next-model" })));
    const right = [
      h(doc, "button", { class: "whimsy-ask-btn whimsy-cmdk-quiet", id: "cmdk-foot-cancel", "data-control": "cancel", "data-kbd-focus": kbd("cancel"), onclick: () => this.cancel(win) },
        h(doc, "span", { l10n: "whimsy-cmdk-cancel" }), key(doc, "esc")),
      controls.includes("background")
        ? h(doc, "button", { class: "whimsy-ask-btn", id: "cmdk-foot-background", "data-control": "background", "data-kbd-focus": kbd("background"), "aria-keyshortcuts": "Meta+Enter", onclick: () => this.approve(win, { background: true }) },
          h(doc, "span", { l10n: "whimsy-cmdk-run-background" }), key(doc, "⌘↩︎"))
        : null,
      h(doc, "button", { class: "whimsy-ask-btn whimsy-cmdk-approve", id: "cmdk-foot-approve", "data-control": "approve", "data-kbd-focus": kbd("approve"), "aria-keyshortcuts": "Enter", onclick: () => this.approve(win) },
        h(doc, "span", { l10n: "whimsy-cmdk-approve" }), key(doc, "↩︎")),
    ];
    const foot = h(doc, "div", { class: "whimsy-cmdk-foot" }, left, h(doc, "span", { class: "whimsy-ask-spacer" }), right);
    const body = [
      h(doc, "div", { class: "whimsy-cmdk-title", dir: "auto" }, st.title),
      steps,
      foot,
    ];
    if (st.menu) {
      body.push(this.menu(win));
    }
    el.replaceChildren(...body);
    if (fresh && !win.matchMedia(REDUCED).matches) {
      el.animate({ opacity: [0, 1], transform: ["scaleY(0.96)", "none"] }, { duration: 180, easing: "cubic-bezier(0.2, 0, 0, 1)" });
    }
    // Screen readers follow the footer's keyboard focus from the field.
    const input = win.gURLBar.inputField;
    const active = st.menu
      ? el.querySelector(".whimsy-cmdk-menu [data-active]")?.id
      : st.footIndex >= 0 ? `cmdk-foot-${controls[st.footIndex]}` : null;
    if (active) {
      input.setAttribute("aria-activedescendant", active);
    } else {
      input.removeAttribute("aria-activedescendant");
    }
    if (st.menu) {
      // The menu opens below its button.
      const anchor = el.querySelector(`[data-control="${st.menu.kind}"]`);
      const menu = el.querySelector(".whimsy-cmdk-menu");
      if (anchor && menu) {
        menu.style.marginInlineStart = `${Math.max(0, anchor.getBoundingClientRect().left - el.getBoundingClientRect().left)}px`;
      }
    }
  },

  // K.5a and K.5b: the same menu surface as chat's model menu.
  menu(win) {
    const st = stateOf(win);
    const doc = win.document;
    const pick = id => this.pickFromMenu(win, id);
    let rows;
    if (st.menu.kind == "model") {
      rows = lazy.WhimsyChatAnswer.modelOptions(doc, { selected: st.provider, onPick: pick });
    } else {
      const mode = lazy.WhimsyChatAgent.mode;
      rows = ["drive", "background"].map(m => h(doc, "div", {
        class: "whimsy-chat-option",
        role: "option",
        tabindex: "-1",
        "data-provider": m,
        "aria-selected": String(mode == m),
        onclick: () => pick(m),
      },
      h(doc, "span", { class: "whimsy-chat-option-check" }),
      h(doc, "span", { class: "whimsy-chat-option-label", l10n: `whimsy-cmdk-where-${m}` }),
      h(doc, "span", { class: "whimsy-chat-option-detail", l10n: `whimsy-cmdk-where-${m}-detail` })));
    }
    const options = rows.filter(r => r.classList?.contains("whimsy-chat-option"));
    st.menu.ids = options.map(o => o.dataset.provider);
    if (st.menu.active == null) {
      st.menu.active = Math.max(0, options.findIndex(o => o.getAttribute("aria-selected") == "true"));
    }
    options.forEach((o, i) => {
      o.id = `cmdk-option-${i}`;
      if (i == st.menu.active) {
        o.setAttribute("data-active", "");
      }
    });
    return h(doc, "div", {
      class: "whimsy-chat-menu whimsy-chat-model-menu whimsy-cmdk-menu",
      "data-menu": st.menu.kind,
      role: "listbox",
      l10n: st.menu.kind == "model" ? "whimsy-cmdk-model-menu" : "whimsy-cmdk-where-menu",
    }, rows);
  },

  toggleMenu(win, kind) {
    const st = stateOf(win);
    if (st?.phase != "plan") {
      return;
    }
    st.menu = st.menu?.kind == kind ? null : { kind, active: null };
    this.render(win);
  },

  pickFromMenu(win, id) {
    const st = stateOf(win);
    if (!st?.menu) {
      return;
    }
    const kind = st.menu.kind;
    st.menu = null;
    if (kind == "model") {
      if (id == "auto" || lazy.WhimsyAIRouter._enabled().includes(id)) {
        st.provider = id;
      }
    } else {
      // One setting: changing it here changes chat's too.
      lazy.WhimsyChatAgent.setMode(win, id);
    }
    st.footIndex = Math.min(st.footIndex, this.controls(win).length - 1);
    this.render(win);
  },

  /** Tab and ⇧Tab: the next or previous model, without opening the menu. */
  cycleModel(win, back = false) {
    const st = stateOf(win);
    const list = models();
    const at = Math.max(0, list.indexOf(st.provider));
    st.provider = list[(at + (back ? list.length - 1 : 1)) % list.length];
    this.render(win);
  },

  /** Approve (↩), or Run in background (⌘↩) this once. */
  async approve(win, { background = false } = {}) {
    const st = stateOf(win);
    if (st?.phase != "plan") {
      return;
    }
    const mode = !st.web || background ? "background" : lazy.WhimsyChatAgent.mode;
    const { taskId, provider } = st;
    this.leave(win, { keepTask: true });
    this.closeBar(win);
    this.track(win, taskId);
    await lazy.WhimsyChatAgent.start(win, taskId, { mode, provider });
  },

  // ---- Keys (from WhimsyCommandBarAI.onInputKey) ----

  /** Returns true when the key was the ⌘K agent's. */
  onInputKey(win, event) {
    const st = stateOf(win);
    const urlbar = win.gURLBar;
    const take = () => {
      event.preventDefault();
      event.stopImmediatePropagation();
      return true;
    };
    const accel = event.metaKey || event.ctrlKey;
    // An IME's Enter, or a held one, never confirms or approves.
    if (st && event.key == "Enter" && (event.isComposing || event.repeat)) {
      return take();
    }
    if (!st) {
      if (["ArrowDown", "ArrowUp", "Tab"].includes(event.key)) {
        moved.add(win);
      }
      if (event.key != "Enter" || accel || event.altKey || event.shiftKey || !urlbar.view.isOpen) {
        return false;
      }
      const row = urlbar.view.panel.querySelector(`.urlbarView-row[dynamicType="${ROW_TYPE}"]`);
      const selected = urlbar.view.selectedResult;
      const chosen = moved.has(win) || (selected && !selected.heuristic);
      if (!row || (chosen && selected?.payload?.dynamicType != ROW_TYPE)) {
        return false;
      }
      take();
      this.plan(win, urlbar.value);
      return true;
    }
    if (event.key == "Escape") {
      if (st.menu) {
        st.menu = null;
        this.render(win);
      } else {
        this.cancel(win);
      }
      return take();
    }
    if (st.phase == "planning") {
      return event.key == "Enter" || event.key == "Tab" ? take() : false;
    }
    if (st.phase == "cant") {
      if (event.key == "Enter" && !event.shiftKey && !event.altKey) {
        take();
        this.askInChat(win);
        return true;
      }
      return false;
    }
    if (st.phase == "confirm") {
      if (event.key == "Enter" && !event.shiftKey && !event.altKey) {
        take();
        const picked = urlbar.view.selectedResult?.payload;
        this.applyOne(win, picked?.kind == "confirm" ? picked.index : null, { force: accel });
        return true;
      }
      if (event.key == "ArrowDown" || event.key == "ArrowUp") {
        // The view moves its own selection; the ring follows it.
        win.setTimeout(() => {
          const picked = urlbar.view.selectedResult?.payload;
          if (stateOf(win) == st && picked?.kind == "confirm") {
            st.index = picked.index;
            this.ring(win);
          }
        }, 0);
      }
      return false;
    }
    // The plan card.
    if (st.menu) {
      const n = st.menu.ids?.length ?? 0;
      if (event.key == "ArrowDown" || event.key == "ArrowUp") {
        st.menu.active = (st.menu.active + (event.key == "ArrowDown" ? 1 : n - 1)) % Math.max(1, n);
        this.render(win);
        return take();
      }
      if (event.key == "Enter" || event.key == " ") {
        take();
        const id = st.menu.ids?.[st.menu.active];
        const option = st.el?.querySelector(`.whimsy-cmdk-menu [data-provider="${id}"]`);
        if (id && option?.getAttribute("aria-disabled") != "true") {
          this.pickFromMenu(win, id);
        }
        return true;
      }
      if (event.key == "Tab") {
        return take();
      }
      return false;
    }
    if (event.key == "Tab" && !accel && !event.altKey) {
      take();
      this.cycleModel(win, event.shiftKey);
      return true;
    }
    if (event.key == "Enter" && !event.shiftKey && !event.altKey) {
      take();
      if (accel) {
        this.approve(win, { background: true });
      } else if (st.footIndex >= 0) {
        this.activate(win, this.controls(win)[st.footIndex]);
      } else {
        this.approve(win);
      }
      return true;
    }
    const controls = this.controls(win);
    if (event.key == "ArrowDown" && st.footIndex < 0 && !accel) {
      st.footIndex = controls.indexOf("approve");
      this.render(win);
      return take();
    }
    if (st.footIndex >= 0) {
      if (event.key == "ArrowUp") {
        st.footIndex = -1;
        this.render(win);
        return take();
      }
      if (event.key == "ArrowLeft" || event.key == "ArrowRight") {
        const rtl = win.getComputedStyle(win.gURLBar).direction == "rtl";
        const step = (event.key == "ArrowRight") != rtl ? 1 : -1;
        st.footIndex = Math.min(controls.length - 1, Math.max(0, st.footIndex + step));
        this.render(win);
        return take();
      }
      if (event.key == " ") {
        take();
        this.activate(win, controls[st.footIndex]);
        return true;
      }
    }
    return false;
  },

  activate(win, control) {
    switch (control) {
      case "where":
      case "model":
        this.toggleMenu(win, control);
        break;
      case "cancel":
        this.cancel(win);
        break;
      case "background":
        this.approve(win, { background: true });
        break;
      default:
        this.approve(win);
    }
  },

  /** Editing the request drops the plan; Enter plans the new words. */
  onInput(win) {
    moved.delete(win);
    const st = stateOf(win);
    if (st && win.gURLBar.value.trim() != st.request) {
      this.leave(win);
    }
  },

  // ---- K.6–K.11: the status card where toasts appear ----

  track(win, taskId) {
    tracked.set(taskId, { win, toast: null, sig: "", hidden: false, keyEl: null });
    this.refresh(taskId);
  },

  observe(_subject, topic, data) {
    if (topic != lazy.WhimsyAgentTasks.TOPIC) {
      return;
    }
    const id = String(data).split(":")[1];
    if (tracked.has(id)) {
      this.refresh(id);
    }
  },

  refresh(taskId) {
    const t = tracked.get(taskId);
    const task = lazy.WhimsyAgentTasks.get(taskId);
    const win = t?.win;
    if (!t || !task || !win || win.closed || !win.gZenUIManager?.toasts) {
      tracked.delete(taskId);
      return;
    }
    const run = lazy.WhimsyChatAgent.runOf(taskId);
    const spec = this.statusSpec(win, task, run);
    if (!spec) {
      tracked.delete(taskId);
      t.toast?.close();
      return;
    }
    if (spec.sig == t.sig && t.toast && !t.toast.closed) {
      return;
    }
    // A running card Esc'd away stays away until something needs you.
    if (t.hidden && spec.kind == "running") {
      return;
    }
    t.sig = spec.sig;
    const { messageId, kind } = spec;
    const options = { ...spec };
    delete options.messageId;
    delete options.kind;
    delete options.sig;
    if (t.toast && !t.toast.closed && !t.toast.closing) {
      t.toast.update({ messageId, ...options });
    } else {
      t.toast = win.gZenUIManager.toasts.open(messageId, {
        key: `whimsy-cmdk-${taskId}`,
        ...options,
        onClose: reason => this.onToastClose(taskId, reason),
      });
      t.hidden = false;
    }
    const el = t.toast.element;
    el.setAttribute("whimsy-cmdk-status", kind);
    el.dataset.taskId = taskId;
    // Once per card: a card closed and opened again is a new element.
    if (t.keyEl != el) {
      t.keyEl = el;
      // Enter never answers a pause: a stray key can't send (K.8).
      el.addEventListener("keydown", event => {
        if (event.key == "Enter" && el.getAttribute("whimsy-cmdk-status") == "pause") {
          event.preventDefault();
          event.stopPropagation();
        }
      }, true);
    }
    if (kind == "pause") {
      this.notify(win, "whimsy-cmdk-notify-needs-you", task);
      if (Services.focus.activeWindow == win) {
        el.querySelector("#cmdk-pause-skip, #cmdk-pause-stop")?.focus();
      }
    } else if (kind == "done") {
      this.notify(win, "whimsy-cmdk-notify-done", task);
      tracked.delete(taskId);
    }
  },

  onToastClose(taskId, reason) {
    const t = tracked.get(taskId);
    if (!t) {
      return;
    }
    t.toast = null;
    t.sig = "";
    const task = lazy.WhimsyAgentTasks.get(taskId);
    if (!lazy.WhimsyAgentTasks.isActive(task)) {
      tracked.delete(taskId);
      return;
    }
    if (reason != "dismissed") {
      return;
    }
    // Esc on a pause is always its "Don't" answer.
    if (task?.state == "paused" && task.pause && !task.pause.choice && !task.pause.yours && task.pause.kind != "take-over") {
      const skip = task.pause.choices.includes("skip") ? "skip" : "stop";
      lazy.WhimsyAgentTasks.decide(taskId, skip);
      return;
    }
    if (task.state == "running") {
      t.hidden = true;
    }
  },

  /** What the status card shows for `task` now, or null to close it. */
  statusSpec(win, task, run) {
    const doc = win.document;
    const total = Math.max(1, run?.steps.length ?? 1);
    const index = Math.min(run?.current ?? 0, total - 1);
    const what = run?.steps[index]?.text || run?.say || "";
    const title = task.title || run?.request || "";
    const stop = { id: "whimsy-cmdk-stop", l10nId: "whimsy-cmdk-stop", keys: "⌘.", ariaKeys: "Meta+Period", command: () => (lazy.WhimsyAgentTasks.stop(task.id), "keep") };
    const cont = { id: "whimsy-cmdk-continue", l10nId: "whimsy-cmdk-continue", command: () => (lazy.WhimsyAgentTasks.resume(task.id), "keep") };
    switch (task.state) {
      case "planning":
      case "running":
        return {
          kind: "running",
          sig: `run|${index}|${what}|${task.mode}`,
          messageId: "whimsy-cmdk-text",
          l10nArgs: { text: title },
          descriptionId: "whimsy-cmdk-run-step",
          descriptionArgs: { step: index + 1, total, what },
          icon: { src: SPARKLE },
          busy: false,
          body: null,
          timeout: 0,
          closable: false,
          buttons: [stop],
        };
      case "paused": {
        const pause = task.pause ?? {};
        if (pause.kind == "take-over" || pause.yours) {
          return {
            kind: "yours",
            sig: `yours|${pause.id}`,
            messageId: pause.yours ? "whimsy-agent-chat-pause-yours" : "whimsy-cmdk-took-over",
            l10nArgs: { title: pause.preview?.title ?? title },
            descriptionId: "whimsy-cmdk-run-step",
            descriptionArgs: { step: index + 1, total, what },
            icon: { src: SPARKLE },
            body: null,
            timeout: 0,
            closable: false,
            buttons: [cont, stop],
          };
        }
        const preview = pause.preview ?? {};
        const verbs = lazy.WhimsyChatAgent.pauseVerbs({ kind: pause.kind, choices: pause.choices, preview });
        // "Don't" first and the doing verb last, as in chat's card (K.8).
        const order = { skip: 0, stop: 0, self: 1, do: 2 };
        const amount = preview.amount ?? "";
        const buttons = verbs.slice().sort((a, b) => order[a.choice] - order[b.choice]).map(v => ({
          id: `cmdk-pause-${v.choice}`,
          l10nId: v.l10n,
          l10nArgs: { amount },
          // Only this pause: a stale card's button never answers the next one.
          command: () => {
            if (lazy.WhimsyAgentTasks.get(task.id)?.pause?.id === pause.id) {
              lazy.WhimsyAgentTasks.decide(task.id, v.choice);
            }
            return "keep";
          },
        }));
        const fields = (preview.fields ?? []).filter(f => f && (f.label || f.value));
        const body = fields.length
          ? h(doc, "div", { class: "whimsy-cmdk-fields" }, fields.map(f => h(doc, "div", { class: "whimsy-cmdk-field", "data-strong": f.strong ? "" : null },
            h(doc, "span", { class: "whimsy-cmdk-field-label" }, f.label ?? ""),
            h(doc, "span", { class: "whimsy-cmdk-field-value", dir: "auto" }, f.hidden || f.sensitive ? f.note || "••••" : f.value ?? ""))))
          : null;
        const head = preview.titleL10n
          ? { messageId: preview.titleL10n.id, l10nArgs: preview.titleL10n.args }
          : preview.title ? { messageId: "whimsy-cmdk-text", l10nArgs: { text: preview.title } } : { messageId: "whimsy-agent-chat-paused", l10nArgs: undefined };
        return {
          kind: "pause",
          sig: `pause|${pause.id}`,
          ...head,
          descriptionId: "whimsy-cmdk-pause-step",
          descriptionArgs: { task: title, step: index + 1, total },
          icon: { src: SPARKLE },
          body,
          timeout: 0,
          closable: false,
          buttons,
        };
      }
      case "done": {
        if (run?.shortfall) {
          const sent = (task.approvals ?? 0) > 0 ? "yes" : "no";
          return {
            kind: "failed",
            sig: `failed|${run.shortfall}`,
            messageId: "whimsy-cmdk-failed",
            l10nArgs: { task: title },
            descriptionId: "whimsy-cmdk-failed-why",
            descriptionArgs: { why: run.shortfall, sent },
            icon: { src: "chrome://browser/skin/zen-icons/security-warning.svg" },
            body: null,
            timeout: 0,
            closable: false,
            buttons: [
              { id: "whimsy-cmdk-dismiss", l10nId: "whimsy-cmdk-dismiss", command: () => undefined },
              { id: "whimsy-cmdk-try-again", l10nId: "whimsy-cmdk-try-again", command: () => this.tryAgain(win, task.id) },
            ],
          };
        }
        return {
          kind: "done",
          sig: "done",
          ...(run?.summary ? { messageId: "whimsy-cmdk-text", l10nArgs: { text: run.summary } } : { messageId: "whimsy-cmdk-done", l10nArgs: { task: title } }),
          descriptionId: undefined,
          description: undefined,
          icon: { src: "chrome://browser/skin/zen-icons/check.svg" },
          body: null,
          timeout: undefined,
          closable: true,
          buttons: run?.threadId
            ? [{ l10nId: "whimsy-cmdbar-open-in-chat", id: "cmdk-open-chat", command: () => lazy.WhimsyChat.open(win, { threadId: run.threadId }) }]
            : null,
        };
      }
      default:
        // Stopped: chat's "Stopped" toast says so.
        return null;
    }
  },

  async tryAgain(win, taskId) {
    tracked.delete(taskId);
    const next = await lazy.WhimsyChatAgent.retry(win, taskId);
    if (next) {
      this.track(win, next);
    }
  },

  // A macOS notification when Whimsy isn't in front.
  notify(win, id, task) {
    if (Services.focus.activeWindow) {
      return;
    }
    try {
      const alerts = Cc["@mozilla.org/alerts-service;1"].getService(Ci.nsIAlertsService);
      const n = Cc["@mozilla.org/alert-notification;1"].createInstance(Ci.nsIAlertNotification);
      const run = lazy.WhimsyChatAgent.runOf(task.id);
      const body = id == "whimsy-cmdk-notify-done" ? run?.summary || "" : task.pause?.preview?.title || "";
      n.init(`whimsy-cmdk-${task.id}`, "chrome://branding/content/icon64.png", lazy.l10n.formatValueSync(id, { task: task.title || "" }), body, true, task.id);
      alerts.showAlert(n, (_s, topic) => {
        if (topic == "alertclickcallback" && !win.closed) {
          win.focus();
        }
      });
    } catch (e) {
      console.warn("Whimsy ⌘K agent: notification", e);
    }
  },

  // ---- Tests ----

  _statusToast(taskId) {
    return tracked.get(taskId)?.toast ?? null;
  },

  _resetForTesting() {
    for (const t of tracked.values()) {
      t.toast?.close({ instant: true });
    }
    tracked.clear();
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      this.leave(win);
    }
  },
};

ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyCommandBarAI: "resource:///modules/whimsy/WhimsyCommandBarAI.sys.mjs",
});
ChromeUtils.defineLazyGetter(lazy, "answer", () => ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyChatAnswer.sys.mjs"));
