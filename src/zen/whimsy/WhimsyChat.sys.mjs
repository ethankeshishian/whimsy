/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W23: the chat facade. Every lane talks to chat through these names; the
// panel (lane chat-shell, WhimsyChatPanel) attaches its implementation per
// window. Calls made before a window's panel attaches are queued and
// replayed in order once it does. Cards, answer actions, and task sources
// are registered globally and read by the panel.
//
// impl: {open(opts), toggle(), close(opts), isOpen()}.

const registry = {
  cards: new Map(),
  actions: new Map(),
  taskSources: new Map(),
};
const impls = new WeakMap();
const pending = new WeakMap();
const TOPIC = "whimsy-chat-registry-changed";

function notify(what) {
  Services.obs.notifyObservers(null, TOPIC, what);
}

function call(win, method, args) {
  const impl = impls.get(win);
  if (impl) {
    return impl[method]?.(...args);
  }
  return new Promise((resolve, reject) => {
    if (!pending.has(win)) {
      pending.set(win, []);
    }
    pending.get(win).push({ method, args, resolve, reject });
  });
}

export const WhimsyChat = {
  TOPIC,

  /** The panel of `win` takes over; queued calls run now, in order. */
  attach(win, impl) {
    impls.set(win, impl);
    const queued = pending.get(win) ?? [];
    pending.delete(win);
    for (const { method, args, resolve, reject } of queued) {
      try {
        resolve(impl[method]?.(...args));
      } catch (e) {
        reject(e);
      }
    }
    return () => {
      if (impls.get(win) == impl) {
        impls.delete(win);
      }
    };
  },

  isAttached(win) {
    return impls.has(win);
  },

  /**
   * Opens chat. opts: {threadId?, tab?, prompt?, send?, chips?, focus?:
   * "composer"|"card", card?}.
   */
  open(win, opts = {}) {
    return call(win, "open", [opts]);
  },

  toggle(win) {
    return call(win, "toggle", []);
  },

  /** reason: "key" (⌘E), "hide" (the header's button), or "video" (Summarize again). */
  close(win, opts = {}) {
    return call(win, "close", [opts]);
  },

  isOpen(win) {
    return !!impls.get(win)?.isOpen?.();
  },

  /** A card kind in the thread: render(doc, msg, ctx) -> Element. */
  registerCard(kind, render) {
    registry.cards.set(kind, render);
    notify("cards");
    return () => registry.cards.get(kind) == render && registry.cards.delete(kind);
  },

  cardRenderer(kind) {
    return registry.cards.get(kind) ?? null;
  },

  /** A button under each answer: {id, l10nId, icon, isAvailable(msg), run(win, msg)}. */
  registerAnswerAction(action) {
    if (!action?.id || !action.l10nId || !action.icon || typeof action.run != "function") {
      throw new Error("An answer action needs id, l10nId, icon, and run");
    }
    registry.actions.set(action.id, action);
    notify("actions");
    return () => registry.actions.get(action.id) == action && registry.actions.delete(action.id);
  },

  /** The actions that apply to `msg`, in the order they were registered. */
  answerActions(msg) {
    return [...registry.actions.values()].filter(a => {
      try {
        return a.isAvailable ? a.isAvailable(msg) : true;
      } catch {
        return false;
      }
    });
  },

  /** What the Tasks strip lists: {id, list(win) -> Task[], show(win, task), stop(task)}. */
  registerTaskSource(source) {
    if (!source?.id || typeof source.list != "function") {
      throw new Error("A task source needs id and list");
    }
    registry.taskSources.set(source.id, source);
    notify("tasks");
    return () => registry.taskSources.get(source.id) == source && registry.taskSources.delete(source.id);
  },

  /** Every running task, each with its source. */
  tasks(win) {
    const out = [];
    for (const source of registry.taskSources.values()) {
      try {
        for (const task of source.list(win) ?? []) {
          out.push({ ...task, source: source.id });
        }
      } catch (e) {
        console.error(`WhimsyChat: task source ${source.id} failed`, e);
      }
    }
    return out;
  },

  taskSource(id) {
    return registry.taskSources.get(id) ?? null;
  },

  /** Tasks changed (a source calls this so the strip refreshes). */
  tasksChanged() {
    notify("tasks");
  },
};
