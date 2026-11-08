/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W23 cmdbar-ai: the top of the command bar on ⌘T and ⌘L before typing.
// Recent answer (10 minutes after leaving an Ask card), then "While Whimsy
// was closed", then "Updates" (routine, watch, research, and agent results).
// Absent when empty. Nothing is pre-selected; ↓ selects, Enter opens, Tab
// walks Open, Remind me, and Dismiss, and ⌫ dismisses. Five rows, then
// "Show N more", which scrolls inside the bar. Never in private.

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
  WhimsyAIUpdates: "resource:///modules/whimsy/WhimsyAIUpdates.sys.mjs",
  WhimsyChat: "resource:///modules/whimsy/WhimsyChat.sys.mjs",
  WhimsyCommandBarAI: "resource:///modules/whimsy/WhimsyCommandBarAI.sys.mjs",
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
  WhimsySurface: "resource:///modules/whimsy/WhimsySurface.sys.mjs",
  WhimsyUndo: "resource:///modules/whimsy/WhimsyUndo.sys.mjs",
});

const FEATURE = "whimsy.feature.ai-updates";
const TYPE = "whimsy-update";
const HEADING_TYPE = "whimsy-update-heading";
const VISIBLE = 5;
const ICONS = "chrome://browser/content/whimsy/icons/";
const SPARKLE = "chrome://browser/skin/zen-icons/sparkles.svg";
const TYPE_ICONS = {
  answer: SPARKLE,
  needs: "chrome://browser/skin/zen-icons/security-warning.svg",
  watch: `${ICONS}eye.svg`,
  research: `${ICONS}thinking.svg`,
  agent: `${ICONS}agent.svg`,
  prep: `${ICONS}google-calendar.svg`,
  routine: `${ICONS}routines.svg`,
};

// The rows on screen, by number; the payload carries the number only.
let nextTarget = 0;
const targets = new Map();
const expanded = new WeakSet();

function topWindow() {
  return lazy.BrowserWindowTracker.getTopWindow();
}

function on() {
  return Services.prefs.getBoolPref(FEATURE, true) && lazy.WhimsyAI.enabled;
}

/** Times for Remind me, as real clock times from `now`. */
export function remindTimes(now = Date.now()) {
  const d = new Date(now);
  const at = (days, hour) => {
    const t = new Date(d);
    t.setDate(t.getDate() + days);
    t.setHours(hour, 0, 0, 0);
    return t.getTime();
  };
  const evening = at(0, 18);
  const monday = (8 - d.getDay()) % 7 || 7;
  return [
    { id: "hour", at: now + 60 * 60 * 1000 },
    { id: "evening", at: evening > now ? evening : at(1, 18) },
    { id: "morning", at: at(1, 8) },
    { id: "week", at: at(monday, 8) },
  ];
}

function typeOf(u) {
  if (u.needsYou) {
    return "needs";
  }
  if (u.kind == "prep") {
    return "prep";
  }
  return { watch: "watch", research: "research", agent: "agent" }[u.source] ?? "routine";
}

function timeLabel(win, ms) {
  if (!ms) {
    return "";
  }
  const then = new Date(ms);
  const today = new Date();
  if (then.toDateString() == today.toDateString()) {
    return then.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (then.toDateString() == yesterday.toDateString()) {
    return new win.Localization(["browser/whimsy.ftl"], true).formatValueSync("whimsy-cmdbar-yesterday");
  }
  return then.toLocaleDateString(undefined, { weekday: "short" });
}

export class WhimsyUpdatesProvider extends UrlbarProvider {
  get name() {
    return "WhimsyUpdates";
  }

  get type() {
    return UrlbarShared.PROVIDER_TYPE.PROFILE;
  }

  getPriority() {
    return 2;
  }

  async isActive(context) {
    const win = topWindow();
    if (!on() || !win || context.isPrivate || lazy.WhimsyAIContext.isPrivate(win.gBrowser.selectedTab)) {
      return false;
    }
    if (context.searchString?.trim() || context.searchMode || context.restrictSource || lazy.WhimsyCommandBarAI.card(win)) {
      return false;
    }
    const list = await lazy.WhimsyAIUpdates.list();
    return !!(list.recent || list.whileClosed.length || list.updates.length);
  }

  async startQuery(context, addCallback) {
    const win = topWindow();
    const query = (this._query = {});
    const list = await lazy.WhimsyAIUpdates.list();
    if (this._query != query) {
      return;
    }
    targets.clear();
    const rows = [];
    if (list.recent) {
      rows.push({ group: "recent", recent: list.recent });
    }
    list.whileClosed.forEach((u, i) => rows.push({ group: "whileClosed", update: u, first: i == 0 }));
    const isExpanded = expanded.has(win);
    const shown = isExpanded ? list.updates : list.updates.slice(0, VISIBLE);
    shown.forEach((u, i) => rows.push({ group: "updates", update: u, first: i == 0, count: list.updates.length }));
    if (!isExpanded && list.updates.length > VISIBLE) {
      rows.push({ group: "updates", more: list.updates.length - VISIBLE });
    }
    // Expanded lists scroll inside the bar instead of being cut short.
    context.maxResults = Math.max(context.maxResults ?? 0, rows.length + 4);
    win?.gURLBar?.toggleAttribute("whimsy-updates-expanded", isExpanded);
    // Zen turns Firefox's group labels off, so each section draws its own heading row.
    const withHeadings = [];
    for (const row of rows) {
      if (withHeadings.at(-1)?.group != row.group) {
        withHeadings.push({ group: row.group, heading: true });
      }
      withHeadings.push(row);
    }
    rows.splice(0, rows.length, ...withHeadings);
    context.maxResults = Math.max(context.maxResults ?? 0, rows.length + 4);
    for (const [index, row] of rows.entries()) {
      const target = ++nextTarget;
      targets.set(target, { ...row, window: new WeakRef(win) });
      addCallback(this, new lazy.UrlbarResult({
        type: UrlbarShared.RESULT_TYPE.DYNAMIC,
        source: UrlbarShared.RESULT_SOURCE.OTHER_LOCAL,
        suggestedIndex: index,
        payload: { dynamicType: row.heading ? HEADING_TYPE : TYPE, target, group: row.group, more: row.more ?? 0 },
      }));
    }
    if (list.whileClosed.length) {
      lazy.WhimsyAIUpdates.markSeen?.([]);
    }
    if (list.updates.length || list.whileClosed.length) {
      lazy.WhimsyAIHints.request(win, "updates");
    }
  }

  cancelQuery() {
    this._query = null;
  }

  getViewTemplate(result) {
    if (result.payload.dynamicType == HEADING_TYPE) {
      return {
        attributes: { role: "presentation" },
        children: [
          { name: "label", tag: "span", classList: ["whimsy-update-heading-label"] },
          { name: "dismissAll", tag: "span", classList: ["whimsy-update-dismiss-all"], attributes: { selectable: true, role: "button", "data-command": "whimsy-dismiss-all" } },
        ],
      };
    }
    return {
      attributes: { selectable: true },
      children: [
        { name: "icon", tag: "span", classList: ["whimsy-update-icon"], children: [{ name: "iconImg", tag: "img" }] },
        {
          name: "text",
          tag: "span",
          classList: ["whimsy-update-text"],
          children: [
            { name: "title", tag: "span", classList: ["urlbarView-title", "whimsy-update-title"] },
            { name: "detail", tag: "span", classList: ["whimsy-update-detail"] },
          ],
        },
        {
          name: "end",
          tag: "span",
          classList: ["whimsy-update-end"],
          children: [
            { name: "needs", tag: "span", classList: ["whimsy-update-needs"] },
            { name: "time", tag: "span", classList: ["whimsy-update-time"] },
            { name: "open", tag: "span", classList: ["whimsy-update-btn", "whimsy-update-open"], attributes: { selectable: true, role: "button", "data-command": "whimsy-open" } },
            { name: "remind", tag: "span", classList: ["whimsy-update-btn", "whimsy-update-remind"], attributes: { selectable: true, role: "button", "aria-haspopup": "menu", "data-command": "whimsy-remind" } },
            { name: "dismiss", tag: "span", classList: ["whimsy-update-btn", "whimsy-update-dismiss"], attributes: { selectable: true, role: "button", "data-command": "whimsy-dismiss" } },
          ],
        },
      ],
    };
  }

  getViewUpdate(result) {
    const target = targets.get(result.payload.target);
    const win = topWindow();
    const hide = { attributes: { hidden: true } };
    const show = attrs => ({ attributes: { hidden: null, ...attrs } });
    if (!target) {
      return {};
    }
    if (target.heading) {
      const id = { recent: "whimsy-cmdbar-section-recent", whileClosed: "whimsy-cmdbar-section-while-closed" }[target.group] ?? "whimsy-cmdbar-section-updates";
      return {
        label: { l10n: { id } },
        dismissAll: target.group == "recent" ? hide : { ...show({}), l10n: { id: "whimsy-cmdbar-dismiss-all" } },
      };
    }
    if (target.more) {
      return {
        icon: show({ "data-type": "more" }),
        iconImg: { attributes: { src: "chrome://browser/skin/zen-icons/chevron.svg" } },
        title: { l10n: { id: "whimsy-cmdbar-show-more", args: { count: target.more } } },
        detail: hide,
        needs: hide,
        time: hide,
        open: hide,
        remind: hide,
        dismiss: hide,
      };
    }
    if (target.recent) {
      const r = target.recent;
      return {
        icon: show({ "data-type": "answer" }),
        iconImg: { attributes: { src: SPARKLE } },
        title: { textContent: r.question },
        detail: show({}),
        needs: hide,
        time: { attributes: { hidden: null }, l10n: { id: "whimsy-cmdbar-minutes-ago", args: { minutes: Math.max(1, Math.round((Date.now() - (r.at ?? Date.now())) / 60000)) } } },
        open: { ...show({}), l10n: { id: "whimsy-cmdbar-open" } },
        remind: hide,
        dismiss: { ...show({ title: "" }), l10n: { id: "whimsy-cmdbar-remove" } },
        ...this.detailOfRecent(r),
      };
    }
    const u = target.update;
    const type = typeOf(u);
    const lead = u.needsYou && u.nextStep;
    return {
      icon: show({ "data-type": type }),
      iconImg: { attributes: { src: TYPE_ICONS[type] } },
      title: { textContent: u.title },
      detail: u.detail ? { attributes: { hidden: null }, textContent: u.detail } : hide,
      needs: u.needsYou ? { ...show({}), l10n: { id: "whimsy-cmdbar-needs-you" } } : hide,
      time: u.dueAt && u.dueAt > Date.now() ? { ...show({}), l10n: { id: "whimsy-cmdbar-in-minutes", args: { minutes: Math.max(1, Math.round((u.dueAt - Date.now()) / 60000)) } } } : { ...show({}), textContent: timeLabel(win, u.surfaced ?? u.posted) },
      open: lead ? { ...show({}), l10n: { id: u.nextStep.l10nId } } : { ...show({}), l10n: { id: u.dimmed ? "whimsy-cmdbar-prep-anyway" : "whimsy-cmdbar-open" } },
      remind: { ...show({}), l10n: { id: "whimsy-cmdbar-remind-me" } },
      dismiss: { ...show({}), l10n: { id: "whimsy-cmdbar-dismiss" } },
    };
  }

  detailOfRecent(r) {
    return {
      detail: {
        attributes: { hidden: null },
        l10n: r.sources
          ? { id: "whimsy-cmdbar-recent-detail-sources", args: { title: r.tabTitle ?? "", opened: r.opened?.length ?? 0, total: r.sources } }
          : { id: "whimsy-cmdbar-recent-detail", args: { title: r.tabTitle ?? "" } },
      },
    };
  }

  onEngagement(context, controller, details) {
    const target = targets.get(details.result?.payload.target);
    const win = target?.window.deref();
    if (!target || !win || win.closed || !on()) {
      return;
    }
    const el = details.element;
    const part = { "whimsy-open": "open", "whimsy-remind": "remind", "whimsy-dismiss": "dismiss", "whimsy-dismiss-all": "dismissAll" }[details.selType] ?? "row";
    if (target.more) {
      expanded.add(win);
      WhimsyCommandBarUpdates.reopen(win);
      return;
    }
    if (part == "dismissAll") {
      WhimsyCommandBarUpdates.dismissAll(win, target.group);
      return;
    }
    if (part == "dismiss") {
      WhimsyCommandBarUpdates.dismiss(win, target);
      return;
    }
    if (part == "remind") {
      WhimsyCommandBarUpdates.openRemind(win, target.update, el);
      return;
    }
    WhimsyCommandBarUpdates.open(win, target, { accel: !!(details.event?.metaKey || details.event?.ctrlKey) });
  }
}

export const WhimsyCommandBarUpdates = {
  provider: null,
  remindTimes,
  VISIBLE,

  init() {
    if (this.provider) {
      return;
    }
    const manager = lazy.ProvidersManager.getInstanceForSap("urlbar");
    this.provider = manager.getProvider("WhimsyUpdates");
    if (!this.provider) {
      this.provider = new WhimsyUpdatesProvider();
      manager.registerProvider(this.provider);
    }
  },

  initWindow(win) {
    this.init();
    win.gURLBar?.inputField?.addEventListener("keydown", event => this.onKey(win, event), true);
    win.gURLBar?.controller?.addListener({ onViewClose: () => expanded.delete(win) });
    lazy.WhimsyAIHints.register({
      id: "updates",
      isVisible: w => !!w.gURLBar?.view.isOpen && !!w.gURLBar.view.panel.querySelector(`.urlbarView-row[dynamicType="${TYPE}"]`),
    });
    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsyShowUpdates",
      l10nId: "whimsy-cmdbar-command-updates",
      icon: `${ICONS}updates.svg`,
      isAvailable: w => on() && !lazy.WhimsyAIContext.isPrivate(w.gBrowser.selectedTab),
      run: () => this.show(win),
    });
  },

  /** Opens the command bar with the Updates on top. */
  show(win) {
    if (!on()) {
      return;
    }
    win.gURLBar.focus();
    win.gURLBar.select();
    win.gURLBar.startQuery({ searchString: "", allowAutofill: false });
  },

  // Picking a whole row closes the view; these rows keep the bar going.
  reopen(win) {
    win.setTimeout(() => {
      win.gURLBar.focus();
      win.gURLBar.value = "";
      win.gURLBar.startQuery({ searchString: "", allowAutofill: false });
    }, 0);
  },

  refresh(win) {
    if (win.gURLBar?.view.isOpen) {
      win.gURLBar.startQuery({ searchString: "", allowAutofill: false });
    }
  },

  selectedTarget(win) {
    const row = win.gURLBar?.view.selectedElement?.closest(".urlbarView-row");
    if (!row || row.getAttribute("dynamicType") != TYPE) {
      return null;
    }
    const result = win.gURLBar.view.getResultFromElement(row);
    return targets.get(result?.payload.target) ?? null;
  },

  onKey(win, event) {
    // ↓ and ↑ step over section headings (Tab still reaches Dismiss all).
    const view = win.gURLBar?.view;
    if ((event.key == "ArrowDown" || event.key == "ArrowUp") && !event.metaKey && !event.altKey && !event.shiftKey &&
      view?.isOpen && view.panel.querySelector(`.urlbarView-row[dynamicType="${HEADING_TYPE}"]`)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const reverse = event.key == "ArrowUp";
      const isHeading = () => view.selectedElement?.closest(".urlbarView-row")?.getAttribute("dynamicType") == HEADING_TYPE;
      view.selectBy(1, { reverse });
      for (let i = 0; i < 2 && isHeading(); i++) {
        view.selectBy(1, { reverse });
      }
      return;
    }
    if (event.key != "Backspace" || event.metaKey || event.altKey || event.ctrlKey) {
      return;
    }
    const target = this.selectedTarget(win);
    if (!target || target.more) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    this.dismiss(win, target);
  },

  async open(win, target, { accel = false } = {}) {
    if (target.recent) {
      win.setTimeout(() => lazy.WhimsyCommandBarAI.reopen(win, target.recent), 0);
      return;
    }
    const u = target.update;
    win.gURLBar.view.close();
    win.gURLBar.handleRevert?.();
    if (u.needsYou && u.nextStep?.command) {
      win.document.getElementById(u.nextStep.command)?.doCommand();
      return;
    }
    await lazy.WhimsyAIUpdates.dismiss(u.id);
    if (u.source == "watch" && u.url && !accel) {
      const tab = win.gBrowser.tabs.find(t => t.linkedBrowser.currentURI.spec == u.url);
      if (tab) {
        win.gBrowser.selectedTab = tab;
      } else {
        win.openTrustedLinkIn(u.url, "tab");
      }
      return;
    }
    if (u.threadId) {
      await lazy.WhimsyChat.open(win, { threadId: u.threadId });
    } else if (u.url) {
      win.openTrustedLinkIn(u.url, "tab");
    }
  },

  async dismiss(win, target) {
    if (target.recent) {
      lazy.WhimsyAIUpdates.setRecentAnswer(null);
      this.refresh(win);
      return;
    }
    const u = target.update;
    if (!(await lazy.WhimsyAIUpdates.dismiss(u.id))) {
      return;
    }
    this.refresh(win);
    lazy.WhimsyUndo.showToast(win, "whimsy-cmdbar-dismissed-toast", {
      undo: () => {
        lazy.WhimsyAIUpdates.undoDismiss(u.id).then(() => this.refresh(win));
      },
    }, undefined, { detail: u.title });
  },

  async dismissAll(win, group) {
    const ids = await lazy.WhimsyAIUpdates.dismissAll(group);
    if (!ids.length) {
      return;
    }
    this.refresh(win);
    lazy.WhimsyUndo.showToast(win, "whimsy-cmdbar-dismissed-all-toast", {
      undo: async () => {
        for (const id of ids) {
          await lazy.WhimsyAIUpdates.undoDismiss(id);
        }
        this.refresh(win);
      },
    }, { count: ids.length });
  },

  openRemind(win, update, anchor) {
    const times = remindTimes();
    const clock = at => new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    const options = times.map(t => ({
      value: t.id,
      l10nId: `whimsy-cmdbar-remind-${t.id}`,
      detailL10nId: t.id == "week" ? "whimsy-cmdbar-remind-detail-week" : "whimsy-cmdbar-remind-detail",
      detailL10nArgs: { time: clock(t.at) },
    }));
    options.push({ value: "pick", l10nId: "whimsy-cmdbar-remind-pick", rule: true });
    this._menuOpen = true;
    lazy.WhimsySurface.openListbox(win, {
      id: "whimsy-cmdbar-remind-menu",
      anchor: anchor ?? win.gURLBar,
      options,
      value: null,
      width: 230,
      onHidden: () => {
        this._menuOpen = false;
      },
      onPick: value => {
        if (value == "pick") {
          this.pickTime(win, update);
          return;
        }
        this.remind(win, update, times.find(t => t.id == value).at);
      },
    });
  },

  pickTime(win, update) {
    const doc = win.document;
    const input = doc.createElementNS("http://www.w3.org/1999/xhtml", "input");
    input.type = "datetime-local";
    const soon = new Date(Date.now() + 2 * 60 * 60 * 1000);
    soon.setMinutes(0, 0, 0);
    input.value = new Date(soon.getTime() - soon.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    const parts = lazy.WhimsySurface.create(win, { id: "whimsy-cmdbar-remind-pick", width: 260 });
    const save = doc.createElementNS("http://www.w3.org/1999/xhtml", "button");
    save.className = "whimsy-surface-button";
    doc.l10n.setAttributes(save, "whimsy-cmdbar-remind-set");
    save.addEventListener("click", () => {
      const at = new Date(input.value).getTime();
      lazy.WhimsySurface.close(parts.panel);
      if (at > Date.now()) {
        this.remind(win, update, at);
      }
    });
    parts.view.append(input, save);
    lazy.WhimsySurface.open(win, parts.panel, { anchor: win.gURLBar });
  },

  async remind(win, update, at) {
    const before = await lazy.WhimsyAIUpdates.get(update.id);
    await lazy.WhimsyAIUpdates.remind(update.id, at);
    this.refresh(win);
    const time = new Date(at).toLocaleString(undefined, { weekday: new Date(at).toDateString() == new Date().toDateString() ? undefined : "short", hour: "numeric", minute: "2-digit" });
    lazy.WhimsyUndo.showToast(win, "whimsy-cmdbar-reminded-toast", {
      undo: async () => {
        if (before) {
          await lazy.WhimsyAIUpdates.post({ ...before });
        }
        this.refresh(win);
      },
    }, { time }, { detail: update.title });
  },
};
