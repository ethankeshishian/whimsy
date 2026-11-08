/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W23 chat-shell: which chat a tab shows, the conversation list, and a
// thread outliving its tab. Threads live in WhimsyAIStore; a tab's chat is
// tied to it by WhimsyAIContext.tabKey (kept across restarts). A tab with no
// chat yet gets a draft that's stored only once you ask something.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  SessionStore: "resource:///modules/sessionstore/SessionStore.sys.mjs",
  WhimsyAIContext: "resource:///modules/whimsy/WhimsyAIContext.sys.mjs",
  WhimsyAIStore: "resource:///modules/whimsy/WhimsyAIStore.sys.mjs",
});

const ROUTINE_KINDS = new Set(["routine", "watch"]);
// What a closed tab's chat can still answer from (characters).
const SAVED_PAGE_CHARS = 100000;

function tabLabel(tab) {
  return tab?.label || tab?.linkedBrowser?.contentTitle || "";
}

function openTabByKey(key) {
  if (!key) {
    return null;
  }
  for (const win of Services.wm.getEnumerator("navigator:browser")) {
    const tab = win.gBrowser?.tabs.find(t => t.getAttribute("whimsy-ai-key") == key);
    if (tab) {
      return tab;
    }
  }
  return null;
}

export const WhimsyChatThreads = {
  ROUTINE_KINDS,

  /** A draft for `tab`: the thread a new chat becomes once you ask. */
  draft(tab) {
    return { id: null, draft: true, kind: "tab", tabKey: lazy.WhimsyAIContext.tabKey(tab), title: tabLabel(tab) };
  },

  /** The tab's most recent chat, or a draft. Private tabs get nothing. */
  async forTab(tab) {
    if (!tab || lazy.WhimsyAIContext.isPrivate(tab)) {
      return null;
    }
    const tabKey = lazy.WhimsyAIContext.tabKey(tab);
    const [latest] = await lazy.WhimsyAIStore.threads({ kind: "tab", tabKey });
    if (!latest) {
      return this.draft(tab);
    }
    if (latest.closedTab) {
      // The tab came back (undo close, restore): the chat is tied to it again.
      return lazy.WhimsyAIStore.updateThread(latest.id, { closedTab: null, updated: latest.updated });
    }
    return latest;
  },

  /** Stores a draft (the first message makes it real). */
  async persist(thread, tab) {
    if (!thread?.draft) {
      return thread;
    }
    const url = tab?.linkedBrowser?.currentURI?.spec ?? "";
    return lazy.WhimsyAIStore.createThread({
      kind: "tab",
      tabKey: thread.tabKey,
      title: thread.title || tabLabel(tab),
      url,
    });
  },

  /** The open tab a thread belongs to, in any window. */
  tabOf(thread) {
    return thread?.kind == "tab" ? openTabByKey(thread.tabKey) : null;
  },

  /**
   * The conversation list: this tab's chats, then routine and watch
   * threads, then everything else by date. With a query, every thread
   * whose title or text matches, newest first, in `all`.
   */
  async list(win, { query = "" } = {}) {
    const q = String(query ?? "").trim();
    if (q) {
      return { query: q, thisTab: [], routines: [], all: await lazy.WhimsyAIStore.search(q) };
    }
    const tab = win.gBrowser?.selectedTab;
    const key = tab && !lazy.WhimsyAIContext.isPrivate(tab) ? lazy.WhimsyAIContext.tabKey(tab) : null;
    const thisTab = [];
    const routines = [];
    const all = [];
    for (const thread of await lazy.WhimsyAIStore.threads()) {
      if (key && thread.kind == "tab" && thread.tabKey == key) {
        thisTab.push(thread);
      } else if (ROUTINE_KINDS.has(thread.kind)) {
        routines.push(thread);
      } else {
        all.push(thread);
      }
    }
    return { query: "", thisTab, routines, all };
  },

  /** What follow-ups read once the tab is gone: the last copy of the page. */
  async savePage(threadId, { url, title, text }) {
    const page = { url, title, text: String(text ?? "").slice(0, SAVED_PAGE_CHARS), at: Date.now() };
    const kept = (await lazy.WhimsyAIStore.messages(threadId)).find(m => m.role == "page");
    if (kept) {
      await lazy.WhimsyAIStore.updateMessage(threadId, kept.id, { page });
    } else {
      await lazy.WhimsyAIStore.append(threadId, { role: "page", page });
    }
  },

  async savedPage(threadId) {
    return (await lazy.WhimsyAIStore.messages(threadId)).find(m => m.role == "page")?.page ?? null;
  },

  /** A tab closed for good: its chats say so and keep what they read. */
  async tabClosed(tab) {
    if (!tab || lazy.WhimsyAIContext.isPrivate(tab)) {
      return;
    }
    const tabKey = tab.getAttribute("whimsy-ai-key");
    if (!tabKey) {
      return;
    }
    const closedTab = { url: tab.linkedBrowser?.currentURI?.spec ?? "", title: tabLabel(tab), at: Date.now() };
    for (const thread of await lazy.WhimsyAIStore.threads({ kind: "tab", tabKey })) {
      await lazy.WhimsyAIStore.updateThread(thread.id, { closedTab, updated: thread.updated });
    }
  },

  /** Brings a closed thread's tab back (from recently closed, else anew). */
  async reopenTab(win, thread) {
    const url = thread?.closedTab?.url;
    if (!url) {
      return null;
    }
    let tab = null;
    try {
      const closed = lazy.SessionStore.getClosedTabDataForWindow(win);
      const index = closed.findIndex(c => c.state?.entries?.at(-1)?.url == url || c.state?.attributes?.["whimsy-ai-key"] == thread.tabKey);
      if (index >= 0) {
        tab = lazy.SessionStore.undoCloseTab(win, index);
      }
    } catch (e) {
      console.error("Whimsy chat: reopen from recently closed", e);
    }
    tab ??= win.gBrowser.addTrustedTab(url);
    win.gBrowser.selectedTab = tab;
    const tabKey = lazy.WhimsyAIContext.tabKey(tab);
    return lazy.WhimsyAIStore.updateThread(thread.id, { tabKey, closedTab: null, updated: thread.updated });
  },
};
