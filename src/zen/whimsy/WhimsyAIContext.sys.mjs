/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W23: what AI may see, and the rules every AI surface shares.
//
// - Private is a wall, checked per tab (a private tab in a normal window
//   counts), never only per window. A private tab gives no context, and a
//   widening path ("all my tabs") leaves it out and counts it.
// - A hidden space is used only when the person's own message names it:
//   an exact, case-insensitive, whole-name match.
// - A locked space is checked on every call (WhimsySpaceLock), even when
//   named. AI never starts an unlock.
// - Page text comes from the WhimsyAIContext actor, already redacted;
//   withMask() covers secret fields with solid boxes for a capture.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  Downloads: "resource://gre/modules/Downloads.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  SessionStore: "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
  WhimsyHiddenSpaces: "resource:///modules/whimsy/WhimsyHiddenSpaces.sys.mjs",
  WhimsyPrivate: "resource:///modules/whimsy/WhimsyPrivate.sys.mjs",
  WhimsySpaceLock: "resource:///modules/whimsy/WhimsySpaceLock.sys.mjs",
});

const ACTOR = "WhimsyAIContext";
const KEY_ATTR = "whimsy-ai-key";
const MAX_WIDE_TABS = 50;
const ALL_TABS = /\b(all|every|each)\s+(of\s+)?(my\s+|the\s+|these\s+|those\s+|open\s+)*tabs\b|\bacross\s+(my\s+)?tabs\b/i;
const DOWNLOADED_PDF = /\b(the\s+)?pdf\s+(that\s+)?I\s+(just\s+)?downloaded\b|\b(last|latest|newest|recent)\s+(downloaded\s+)?pdf\b|\bdownloaded\s+pdf\b/i;
const LOCAL_PROVIDERS = new Set(["apple", "ollama"]);
const PLAN_AUTH = { claude: "whimsy.ai.claude.auth", openai: "whimsy.ai.openai.auth" };

const sources = new Map();

function emptyLeftOut() {
  return { private: 0, hidden: 0, locked: 0 };
}

// A tab that hasn't loaded since a restart still has its address.
function tabUrl(tab) {
  const spec = tab?.linkedBrowser?.currentURI?.spec ?? "";
  if (spec && spec != "about:blank") {
    return spec;
  }
  try {
    const state = JSON.parse(lazy.SessionStore.getTabState(tab));
    return state.entries?.[(state.index ?? state.entries.length) - 1]?.url ?? spec;
  } catch {
    return spec;
  }
}

function isWebTab(tab) {
  if (!tab || tab.closing || tab.hasAttribute("zen-empty-tab")) {
    return false;
  }
  return /^(https?|file):/.test(tabUrl(tab));
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function browserWindows() {
  return [...Services.wm.getEnumerator("navigator:browser")].filter(w => !w.closed && w.gBrowser);
}

function frames(browser) {
  const top = browser?.browsingContext;
  if (!top) {
    return [];
  }
  return top.getAllBrowsingContextsInSubtree()
    .map(bc => bc.currentWindowGlobal)
    .filter(wg => wg && !wg.isClosed);
}

function actorOf(windowGlobal) {
  try {
    return windowGlobal.getActor(ACTOR);
  } catch {
    return null;
  }
}

function tabIcon(tab) {
  return tab.getAttribute("image") || tab.documentGlobal?.gBrowser?.getIcon?.(tab) || "";
}

function isPdf(tab) {
  const browser = tab.linkedBrowser;
  return browser?.documentContentType == "application/pdf" ||
    /\.pdf($|[?#])/i.test(browser?.currentURI?.spec ?? "");
}

function chipFor(tab, data, kind) {
  const key = WhimsyAIContext.tabKey(tab);
  return {
    id: `${kind}:${key}`,
    kind,
    label: tab.label ?? data?.title ?? "",
    icon: tabIcon(tab),
    counts: {
      text: data?.text?.length || undefined,
      images: data?.images?.length || undefined,
      videos: data?.videos?.length || undefined,
    },
    sourceId: key,
    url: tabUrl(tab),
  };
}

function partsFor(chipId, data) {
  const parts = [];
  if (data?.text) {
    parts.push({ chipId, kind: "text", size: data.text.length, text: data.text });
  }
  for (const image of data?.images ?? []) {
    parts.push({ chipId, kind: "image", size: 1, url: image.src, alt: image.alt, w: image.w, h: image.h });
  }
  for (const video of data?.videos ?? []) {
    parts.push({ chipId, kind: "video", size: 1, url: video.src, duration: video.duration, title: video.title });
  }
  return parts;
}

function merge(base, others) {
  const out = { ...base, chips: [...base.chips], parts: [...base.parts], leftOut: { ...base.leftOut }, widened: [...(base.widened ?? [])] };
  const seen = new Set(out.chips.map(c => c.id));
  for (const other of others) {
    for (const chip of other.chips) {
      if (!seen.has(chip.id)) {
        seen.add(chip.id);
        out.chips.push(chip);
        out.parts.push(...other.parts.filter(p => p.chipId == chip.id));
      }
    }
    for (const k of Object.keys(out.leftOut)) {
      out.leftOut[k] += other.leftOut?.[k] ?? 0;
    }
    out.widened.push(...(other.widened ?? []));
  }
  return out;
}

export const WhimsyAIContext = {
  ACTOR,

  // --- The rules ---

  isPrivate(tab) {
    if (!tab) {
      return false;
    }
    if (lazy.WhimsyPrivate.isPrivateTab(tab)) {
      return true;
    }
    const browser = tab.linkedBrowser;
    if (browser && lazy.WhimsyPrivate.isPrivateBrowser(browser)) {
      return true;
    }
    if (browser?.browsingContext?.usePrivateBrowsing) {
      return true;
    }
    // Belt and braces for a tab whose browser hasn't been created yet.
    return !!tab.documentGlobal && lazy.PrivateBrowsingUtils.isWindowPrivate(tab.documentGlobal);
  },

  spaceOf(tab) {
    return tab?.getAttribute?.("zen-workspace-id") || null;
  },

  isHiddenSpace(win, uuid) {
    if (!uuid || !win?.gZenWorkspaces) {
      return false;
    }
    try {
      return lazy.WhimsyHiddenSpaces.hidden(win).some(space => space.uuid == uuid);
    } catch {
      return false;
    }
  },

  isLockedTab(tab) {
    try {
      return !!lazy.WhimsySpaceLock.coveringSpace(tab);
    } catch {
      return false;
    }
  },

  /**
   * @param {MozTabbrowserTab} tab
   * @param {{namedSpaceIds?: string[]}} [options]
   * @returns {false|"private"|"hidden"|"locked"}
   */
  isOffLimits(tab, { namedSpaceIds = [] } = {}) {
    if (this.isPrivate(tab)) {
      return "private";
    }
    if (this.isLockedTab(tab)) {
      return "locked";
    }
    const uuid = this.spaceOf(tab);
    if (this.isHiddenSpace(tab?.documentGlobal, uuid) && !namedSpaceIds.includes(uuid)) {
      return "hidden";
    }
    return false;
  },

  /**
   * The spaces a message names: a whole, case-insensitive match of the
   * space's full name, never part of one ("work" isn't "Work stuff").
   *
   * @param {string} text
   * @param {Window} win
   * @returns {string[]} space uuids
   */
  spacesNamedIn(text, win) {
    const said = String(text ?? "").normalize("NFC");
    const out = [];
    for (const space of this.spaces(win)) {
      const name = String(space.name ?? "").normalize("NFC").trim();
      if (!name) {
        continue;
      }
      const words = name.split(/\s+/).map(escapeRegExp).join("\\s+");
      const rx = new RegExp(`(^|[^\\p{L}\\p{N}])${words}($|[^\\p{L}\\p{N}])`, "iu");
      if (rx.test(said)) {
        out.push(space.uuid);
      }
    }
    return out;
  },

  // Overridable in tests.
  spaces(win) {
    return win?.gZenWorkspaces?.getWorkspaces?.() ?? [];
  },

  /** A key for a tab that survives restarts (per-tab chats use it). */
  tabKey(tab) {
    if (!tab) {
      return null;
    }
    let key = tab.getAttribute(KEY_ATTR);
    if (!key) {
      key = Services.uuid.generateUUID().toString().slice(1, -1);
      tab.setAttribute(KEY_ATTR, key);
      try {
        lazy.SessionStore.persistTabAttribute(KEY_ATTR);
      } catch {}
    }
    return key;
  },

  // --- Extraction and masking (WhimsyAIContext actor) ---



  /**
   * Everything a page shows, from every frame, already redacted. Payment
   * frames give nothing but their mask rect.
   *
   * @param {Element} browser
   * @param {{redact?: boolean}} [opts]
   */
  async extract(browser, { redact = true } = {}) {
    const result = { text: "", images: [], videos: [], title: "", lang: "", headings: [], sensitiveRects: [], truncated: false };
    if (!browser || lazy.WhimsyPrivate.isPrivateBrowser(browser) || browser.browsingContext?.usePrivateBrowsing) {
      return result;
    }
    const frames = frames(browser);
    const answers = await Promise.all(frames.map(async wg => {
      try {
        return { wg, data: await actorOf(wg)?.sendQuery(`${ACTOR}:Extract`, { redact }) };
      } catch {
        return { wg, data: null };
      }
    }));
    const texts = [];
    for (const { wg, data } of answers) {
      if (!data) {
        continue;
      }
      const top = wg.browsingContext == browser.browsingContext;
      result.sensitiveRects.push(...(data.sensitiveRects ?? []).map(r => ({ ...r, frame: wg.browsingContext.id })));
      if (data.sensitiveFrame) {
        continue;
      }
      if (data.text) {
        texts.push(data.text);
      }
      result.images.push(...data.images);
      result.videos.push(...data.videos);
      result.headings.push(...(top ? data.headings : []));
      result.truncated ||= !!data.truncated;
      if (top) {
        result.title = data.title;
        result.lang = data.lang;
      }
    }
    result.text = texts.join("\n\n");
    return result;
  },

  /**
   * Covers every secret field (and every payment frame) with a solid box,
   * runs `fn`, then lifts the masks, also when `fn` throws.
   *
   * @param {Element} browser
   * @param {Function} fn
   */
  async withMask(browser, fn) {
    const actors = frames(browser).map(wg => actorOf(wg)).filter(Boolean);
    const send = on => Promise.all(actors.map(actor =>
      actor.sendQuery(`${ACTOR}:Mask`, { on }).catch(() => [])));
    try {
      await send(true);
      // The boxes are painted before anything is captured.
      await new Promise(resolve => browser.documentGlobal.requestAnimationFrame(() =>
        browser.documentGlobal.requestAnimationFrame(resolve)));
      return await fn();
    } finally {
      await send(false);
    }
  },

  // --- Context ---





  /**
   * The whole tab (all its text, images, and videos), or nothing when it's
   * off limits.
   *
   * @param {MozTabbrowserTab} tab
   * @param {{pane?: boolean, namedSpaceIds?: string[]}} [opts]
   * @returns {Promise<object>} Context
   */
  async forTab(tab, { pane = false, namedSpaceIds = [] } = {}) {
    const context = { chips: [], parts: [], leftOut: emptyLeftOut(), destination: null, widened: [] };
    const off = this.isOffLimits(tab, { namedSpaceIds });
    if (off) {
      context.leftOut[off]++;
      context.offLimits = off;
      return context;
    }
    if (!tab || !isWebTab(tab)) {
      return context;
    }
    const data = await this.extract(tab.linkedBrowser);
    // Checked again after the wait: a space may have locked meanwhile.
    const after = this.isOffLimits(tab, { namedSpaceIds });
    if (after) {
      context.leftOut[after]++;
      context.offLimits = after;
      return context;
    }
    const kind = pane ? "pane" : isPdf(tab) ? "pdf" : "tab";
    const chip = chipFor(tab, data, kind);
    context.chips.push(chip);
    context.parts.push(...partsFor(chip.id, data));
    context.title = data.title;
    context.lang = data.lang;
    return context;
  },

  /** One chip per pane of the split `tab` is in (or just the tab). */
  async forSplit(tab) {
    const win = tab?.documentGlobal;
    const group = tab?.splitView && win?.gZenViewSplitter?._data?.find(g => g.tabs.includes(tab));
    if (!group) {
      return this.forTab(tab);
    }
    const each = await Promise.all(group.tabs.map(t => this.forTab(t, { pane: true })));
    return merge({ chips: [], parts: [], leftOut: emptyLeftOut(), destination: null, widened: [] }, each);
  },


  /** Every web tab in every open (not hidden) space, in every window. */
  async allTabs(prompt, win) {
    const context = { chips: [], parts: [], leftOut: emptyLeftOut(), destination: null, widened: [] };
    const tabs = [];
    for (const w of browserWindows()) {
      const named = this.spacesNamedIn(prompt, w);
      for (const tab of w.gZenWorkspaces?.allStoredTabs ?? w.gBrowser.tabs) {
        if (!isWebTab(tab)) {
          continue;
        }
        const off = this.isOffLimits(tab, { namedSpaceIds: named });
        if (off) {
          context.leftOut[off]++;
        } else {
          tabs.push(tab);
        }
      }
    }
    const kept = tabs.slice(0, MAX_WIDE_TABS);
    const chipId = `tabs:${win ? this.tabKey(win.gBrowser.selectedTab) : "all"}`;
    const pages = [];
    for (const tab of kept) {
      const browser = tab.linkedBrowser;
      const loaded = !tab.hasAttribute("pending") && browser?.browsingContext?.currentWindowGlobal;
      const data = loaded ? await this.extract(browser) : null;
      if (this.isOffLimits(tab)) {
        continue;
      }
      pages.push({
        chipId,
        kind: "page",
        size: data?.text?.length ?? 0,
        text: data?.text ?? "",
        title: tab.label,
        url: tabUrl(tab),
        tabKey: this.tabKey(tab),
      });
    }
    context.chips.push({
      id: chipId,
      kind: "tabs",
      label: "",
      icon: "chrome://browser/content/whimsy/icons/tabs-all.svg",
      counts: { pages: pages.length },
      sourceId: "all-tabs",
    });
    context.parts.push(...pages);
    context.widened.push({ kind: "tabs", count: pages.length, leftOut: { ...context.leftOut }, more: Math.max(0, tabs.length - kept.length) });
    return context;
  },

  // Overridable in tests.
  async downloadList() {
    const list = await lazy.Downloads.getList(lazy.Downloads.ALL);
    return list.getAll();
  },

  /** The newest finished PDF download that still exists (never a private one). */
  async newestPdf() {
    const downloads = (await this.downloadList()).filter(d =>
      d.succeeded && !d.source?.isPrivate &&
      (/\.pdf$/i.test(d.target?.path ?? "") || d.contentType == "application/pdf"));
    downloads.sort((a, b) => (b.endTime ?? b.startTime ?? 0) - (a.endTime ?? a.startTime ?? 0));
    for (const d of downloads) {
      if (d.target?.exists !== false && await IOUtils.exists(d.target.path).catch(() => false)) {
        return d;
      }
    }
    return null;
  },

  /**
   * A connector or other source of context (Drive, Granola). `fn(prompt,
   * win, context)` resolves to {chips, parts} or null.
   */
  registerSource(kind, fn) {
    sources.set(kind, fn);
    return () => sources.get(kind) == fn && sources.delete(kind);
  },

  /**
   * Widens a context when the prompt asks for more: "all my tabs", "the
   * PDF I downloaded", and every registered source.
   */
  async widen(context, prompt, win) {
    const more = [];
    if (ALL_TABS.test(prompt ?? "")) {
      more.push(await this.allTabs(prompt, win));
    }
    if (DOWNLOADED_PDF.test(prompt ?? "")) {
      const pdf = await this.newestPdf();
      if (pdf) {
        const chipId = `pdf:${pdf.target.path}`;
        more.push({
          chips: [{ id: chipId, kind: "pdf", label: PathUtils.filename(pdf.target.path), icon: "chrome://browser/content/whimsy/icons/pdf.svg", counts: { pages: 1 }, sourceId: pdf.target.path }],
          parts: [{ chipId, kind: "pdf", size: pdf.target.size ?? pdf.totalBytes ?? 0, path: pdf.target.path, url: pdf.source?.url ?? "" }],
          leftOut: emptyLeftOut(),
          widened: [{ kind: "pdf", label: PathUtils.filename(pdf.target.path) }],
        });
      }
    }
    for (const [kind, fn] of sources) {
      try {
        const got = await fn(prompt, win, context);
        if (got?.chips?.length) {
          more.push({ leftOut: emptyLeftOut(), widened: [{ kind, label: got.chips[0].label }], ...got });
        }
      } catch (e) {
        console.error(`WhimsyAIContext: source ${kind} failed`, e);
      }
    }
    return more.length ? merge(context, more) : context;
  },

  /**
   * Where a request goes, for What AI sees.
   *
   * @returns {{provider: string, model: string, method: "plan"|"key"|"local", leavesMac: boolean}}
   */
  describeDestination(provider, model) {
    let method = "key";
    let leavesMac = true;
    if (LOCAL_PROVIDERS.has(provider)) {
      method = "local";
      leavesMac = false;
      if (provider == "ollama") {
        const endpoint = Services.prefs.getStringPref("whimsy.ai.ollama.endpoint", "") || "http://127.0.0.1:11434";
        try {
          const host = new URL(endpoint).hostname;
          leavesMac = !["127.0.0.1", "localhost", "[::1]", "::1"].includes(host);
        } catch {}
      }
    } else if (PLAN_AUTH[provider] && Services.prefs.getStringPref(PLAN_AUTH[provider], "") == "plan") {
      method = "plan";
    }
    return { provider, model: model ?? "", method, leavesMac };
  },
};
