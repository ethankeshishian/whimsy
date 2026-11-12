/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W24 emoji: emoji from the command bar (Raycast/Yab style). Typing ":" as
// the bar's first character (or running the "Emoji" command) switches to a
// searchable 8-across grid, drawn as a single dynamic urlbar row — the
// text keeps being typed into the real urlbar input, exactly like
// WhimsyBangs's "!bang" and WhimsyCommandBarAI's Ask card. Arrow keys move
// the grid's own selection (not the urlbar's row selection, which this
// turns off while the grid is up); Enter types the selected emoji into
// whatever was focused when the bar opened (via the WhimsyEmoji actor, so
// it's undoable), or copies it when nothing was focused or it was a
// password field; ⌘↵ always copies. Tab shows the skin tones of a
// tone-capable emoji (the same choice and pref as the space icon picker,
// WhimsySpaceIcons). Picks are remembered as frequent emoji
// (WhimsyEmojiFrequent), never from a private window. A query with no
// match offers a web search, like any other command bar search.
import { UrlbarProvider } from "moz-src:///browser/components/urlbar/UrlbarUtils.sys.mjs";
import { UrlbarShared } from "chrome://browser/content/urlbar/UrlbarShared.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  ProvidersManager: "moz-src:///browser/components/urlbar/UrlbarProvidersManager.sys.mjs",
  UrlbarResult: "chrome://browser/content/urlbar/UrlbarResult.mjs",
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
  WhimsyEmojiFrequent: "resource:///modules/whimsy/WhimsyEmojiFrequent.sys.mjs",
  WhimsyEmojiIndex: "resource:///modules/whimsy/WhimsyEmojiIndex.sys.mjs",
  WhimsySpaceIcons: "resource:///modules/whimsy/WhimsySpaceIcons.sys.mjs",
});

const HTML_NS = "http://www.w3.org/1999/xhtml";
const FEATURE = "whimsy.feature.command-bar-emoji";
const TONE_PREF = "whimsy.spaces.emoji-skin-tone";
const SHEET = "chrome://browser/content/whimsy/whimsy-emoji.css";
const GRID_TYPE = "whimsy-emoji-grid";
const COLUMNS = 8;
const MAX_TONE = 5;
const TOAST_MS = 4000;

// A small, fixed seed shown under "Smileys" with nothing typed yet (the
// same eight, in the same order, every time — not computed from Zen's
// order field, which drifts as Zen's data changes).
// prettier-ignore
const SMILEYS_DEFAULT = ["😀", "😃", "😄", "😁", "😆", "🥹", "😅", "🤣"];

let nextQuery = 0;
// Per-window grid state, set by startQuery and read by the keyboard
// handler and renderer. Never put in the UrlbarResult payload: like
// WhimsyCommandBarAI's Ask card, the grid is drawn straight into the row's
// element rather than through the view's Fluent-attribute diffing.
const states = new WeakMap();
// The mounted card element and pending render, per window — a WeakMap
// rather than properties on the chrome window, which a test's leak check
// flags as left behind.
const mounts = new WeakMap();
// Whether Enter will type into the page (vs. copy), per window: checked
// once per bar session (whatever was focused when the bar opened, like the
// actual insert), not per keystroke, and used only to pick the footer's ↵
// label. Defaults to true (optimistic) until the actor answers.
const insertTargets = new WeakMap();

// options.private, when given, is exact: `"private" in options` alone (even
// undefined) would stop BrowserWindowTracker from matching any window, so
// the key is only present when the caller actually knows which side.
function topWindow(isPrivate) {
  return lazy.BrowserWindowTracker.getTopWindow(typeof isPrivate == "boolean" ? { private: isPrivate } : {});
}

function featureOn() {
  return Services.prefs.getBoolPref(FEATURE, true);
}

function tonePref() {
  const tone = Services.prefs.getIntPref(TONE_PREF, 0);
  return tone >= 0 && tone <= MAX_TONE ? tone : 0;
}

function hasTone(emoji) {
  return lazy.WhimsySpaceIcons.withTone(emoji, 1) != emoji;
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

// Computed fresh from the query text each time it changes (never kept
// across keystrokes): the grid's sections, its flattened emoji in display
// order, and whether nothing matched.
function computeState(query) {
  const text = query.trim();
  if (!text) {
    const frequent = lazy.WhimsyEmojiFrequent.top(COLUMNS * 2);
    const sections = [];
    if (frequent.length) {
      sections.push({ labelId: "whimsy-emoji-section-frequent", items: frequent });
    }
    sections.push({ labelId: "whimsy-emoji-section-smileys", items: SMILEYS_DEFAULT });
    return { query: text, sections, flat: sections.flatMap(s => s.items), selected: 0, tones: false, stop: "grid", toneIndex: tonePref(), noMatch: false };
  }
  const results = lazy.WhimsyEmojiIndex.search(text);
  const sections = results.length ? [{ labelId: "whimsy-emoji-section-results", items: results }] : [];
  return { query: text, sections, flat: results, selected: 0, tones: false, stop: "grid", toneIndex: tonePref(), noMatch: !results.length };
}

export class WhimsyEmojiProvider extends UrlbarProvider {
  get name() {
    return "WhimsyEmoji";
  }

  get type() {
    return UrlbarShared.PROVIDER_TYPE.HEURISTIC;
  }

  // Above everything else while active, like WhimsyBangs: ":" is an
  // explicit switch into the emoji surface, not a normal search term.
  getPriority() {
    return 100;
  }

  async isActive(context) {
    return (
      featureOn() &&
      !context.searchMode &&
      !context.restrictSource &&
      typeof context.searchString == "string" &&
      context.searchString.startsWith(":")
    );
  }

  async startQuery(context, addCallback) {
    const win = topWindow(context.isPrivate);
    // A session boundary is "states didn't already have this window" —
    // checked before the `states.set` below, not via `insertTargets.has`:
    // that WeakMap is only cleared on popuphidden, and if that event is
    // ever late or missed (it's not a real XUL popup in this floating-bar
    // UI), a stale `false` left over from an earlier, field-less session
    // would permanently skip re-checking and wedge the footer on "Copy".
    // `states` is set unconditionally below every call, so it can't go
    // stale the same way.
    const resuming = win && states.has(win);
    const state = computeState(context.searchString.slice(1));
    if (win) {
      states.set(win, state);
      WhimsyEmoji.scheduleRender(win);
      // Checked once per bar session, not per keystroke: `resuming` is
      // already true after the first call, win (no await) before the
      // promise below settles.
      if (!resuming) {
        insertTargets.set(win, true);
        WhimsyEmoji.checkCanInsert(win).then(canInsert => {
          insertTargets.set(win, canInsert);
          const current = states.get(win);
          if (current) {
            WhimsyEmoji.render(win, current);
          }
        });
      }
    }
    addCallback(
      this,
      new lazy.UrlbarResult({
        type: UrlbarShared.RESULT_TYPE.DYNAMIC,
        source: UrlbarShared.RESULT_SOURCE.OTHER_LOCAL,
        heuristic: true,
        payload: { dynamicType: GRID_TYPE, query: ++nextQuery },
      })
    );
  }

  getViewTemplate() {
    return { attributes: { role: "presentation" }, children: [{ name: "card", tag: "div", classList: ["whimsy-emoji-card"] }] };
  }

  getViewUpdate() {
    // The grid is drawn straight into the card element (WhimsyEmoji.render),
    // not through the view's attribute diffing.
    return {};
  }
}

export const WhimsyEmoji = {
  FEATURE,
  provider: null,

  init() {
    if (this.provider) {
      return;
    }
    const manager = lazy.ProvidersManager.getInstanceForSap("urlbar");
    this.provider = manager.getProvider("WhimsyEmoji");
    if (!this.provider) {
      this.provider = new WhimsyEmojiProvider();
      manager.registerProvider(this.provider);
    }
  },

  initWindow(win) {
    this.init();
    win.windowUtils.loadSheetUsingURIString(SHEET, win.windowUtils.AUTHOR_SHEET);
    const urlbar = win.gURLBar;
    if (urlbar?.inputField && !urlbar.inputField._whimsyEmojiKeys) {
      urlbar.inputField._whimsyEmojiKeys = true;
      urlbar.inputField.addEventListener("keydown", event => this.onInputKey(win, event), true);
    }
    // The most reliable close signal of all: wrap view.close() itself, the
    // one method every close path funnels through (Escape, clicking away,
    // our own pick/runWebSearch/closeBar) — not "popuphidden", which
    // doesn't fire for this floating-bar view (it isn't a real XUL popup),
    // and not a MutationObserver on the panel, which only catches a close
    // that happens to remove DOM nodes (e.g. a later query replacing the
    // row), not one that doesn't.
    if (urlbar?.view && !urlbar.view._whimsyEmojiClosePatched) {
      urlbar.view._whimsyEmojiClosePatched = true;
      const origClose = urlbar.view.close.bind(urlbar.view);
      urlbar.view.close = (...args) => {
        const result = origClose(...args);
        this.unmountGrid(win);
        return result;
      };
    }
    const panel = urlbar?.view?.panel;
    if (panel && !panel._whimsyEmojiObserver) {
      panel._whimsyEmojiObserver = new win.MutationObserver(() => {
        const card = panel.querySelector(".whimsy-emoji-card");
        if (card && card != mounts.get(win)?.el) {
          this.mountGrid(win, card);
        } else if (!card && mounts.get(win)?.el) {
          // The DOM, not "popuphidden", is the reliable signal here: this
          // floating-bar view isn't a real XUL popup, so popuphidden (kept
          // below too, belt-and-suspenders) isn't guaranteed to fire —
          // without this, the grid's card is removed from the results but
          // `states`/`insertTargets` never clear, so the NEXT bar session
          // reads them as "still resuming" and skips re-checking canInsert,
          // permanently wedging the footer's label on whatever the very
          // first session ever found.
          this.unmountGrid(win);
        }
      });
      panel._whimsyEmojiObserver.observe(panel, { childList: true, subtree: true });
      panel.addEventListener("popuphidden", event => {
        if (event.target == panel) {
          this.unmountGrid(win);
        }
      });
    }
    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsyEmoji",
      l10nId: "whimsy-action-emoji",
      icon: "chrome://browser/skin/zen-icons/face-sun.svg",
      run: w => this.openForEmoji(w),
      isAvailable: () => featureOn(),
    });
  },

  openForEmoji(win) {
    const urlbar = win.gURLBar;
    if (!urlbar) {
      return;
    }
    urlbar.searchMode = null;
    urlbar.focus();
    urlbar.value = ":";
    urlbar.startQuery({ allowAutofill: false });
  },

  mountGrid(win, el) {
    mounts.set(win, { ...mounts.get(win), el });
    // Marks #urlbar itself (whimsy-emoji.css), rather than relying on
    // `#urlbar:has(.urlbarView-row[dynamicType=...])`: the urlbarView's
    // panel isn't a DOM descendant of #urlbar (gURLBar.contains() checks
    // the input and the view panel separately), so that :has() selector
    // never actually matched and never hid the page's real identity icon.
    win.document.getElementById("urlbar")?.setAttribute("whimsy-emoji-open", "");
    // A query that finishes after the bar closed can still insert the card
    // into the (closed) view, and the observer then mounts it here. Results
    // and the panel opening land in the same task, so by the next frame a
    // live session's view is open; a stale mount is undone, or the identity
    // icon would stay hidden on the page after the bar is gone.
    win.requestAnimationFrame(() => {
      if (!win.gURLBar?.view.isOpen && mounts.get(win)?.el == el) {
        this.unmountGrid(win);
      }
    });
    const state = states.get(win);
    if (state) {
      this.render(win, state);
    }
  },

  // The end of a bar session, however it ends: picked, reverted, backspaced
  // past ":", or the panel genuinely closed. Idempotent (every caller is
  // fine running this more than once for the same session).
  unmountGrid(win) {
    states.delete(win);
    mounts.delete(win);
    insertTargets.delete(win);
    win.document.getElementById("urlbar")?.removeAttribute("whimsy-emoji-open");
  },

  scheduleRender(win) {
    if (mounts.get(win)?.raf) {
      return;
    }
    const raf = win.requestAnimationFrame(() => {
      mounts.set(win, { ...mounts.get(win), raf: 0 });
      const state = states.get(win);
      const el = mounts.get(win)?.el;
      if (state && el?.isConnected) {
        this.render(win, state);
      }
    });
    mounts.set(win, { ...mounts.get(win), raf });
  },

  render(win, state) {
    const el = mounts.get(win)?.el;
    if (!el?.isConnected) {
      return;
    }
    const doc = el.ownerDocument;
    el.replaceChildren();
    el.setAttribute("role", "group");
    el.dataset.stop = state.stop ?? "grid";
    if (state.noMatch) {
      el.append(
        h(doc, "div", { class: "whimsy-emoji-empty", l10n: ["whimsy-emoji-no-match", { query: state.query }] }),
        h(doc, "div", {
          class: "whimsy-emoji-search-web",
          onclick: () => this.runWebSearch(win, state.query),
          l10n: ["whimsy-emoji-search-web", { query: state.query }],
        })
      );
      return;
    }
    let index = 0;
    for (const section of state.sections) {
      el.append(h(doc, "div", { class: "whimsy-emoji-sec", l10n: section.labelId }));
      const grid = h(doc, "div", { class: "whimsy-emoji-grid", role: "listbox" });
      for (const emoji of section.items) {
        const at = index++;
        grid.append(
          h(doc, "span", {
            class: "whimsy-emoji-cell" + (at == state.selected ? " on" : ""),
            role: "option",
            "aria-selected": at == state.selected,
            onclick: () => this.pick(win, state, emoji, { copy: false }),
          }, emoji)
        );
      }
      el.append(grid);
    }
    const selected = state.flat[state.selected];
    if (!selected) {
      return;
    }
    if (state.tones) {
      const tones = h(doc, "div", { class: "whimsy-emoji-tones" });
      for (let tone = 0; tone <= MAX_TONE; tone++) {
        tones.append(
          h(doc, "span", {
            class: "whimsy-emoji-tone" + (tone == state.toneIndex ? " on" : ""),
            onclick: () => this.pickTone(win, state, selected, tone),
          }, lazy.WhimsySpaceIcons.withTone(selected, tone))
        );
      }
      el.append(tones);
    }
    const shown = state.tones ? lazy.WhimsySpaceIcons.withTone(selected, state.toneIndex) : selected;
    // ↵ either types into whatever was focused when the bar opened, or
    // copies when there's no field to type into (a password field, or
    // nothing focused at all) — insertTargets reflects that same check
    // (WhimsyEmoji.checkCanInsert), not just a generic label.
    const canType = insertTargets.get(win) ?? true;
    // With no field to type into, ⌘↵ would copy exactly what ↵ already
    // does — a duplicate control — so it's left out entirely rather than
    // shown twice; ⌘↵ only appears alongside ↵'s "Type into the page" when
    // there's actually a field to bypass it for.
    el.append(
      h(doc, "div", { class: "whimsy-emoji-footer" },
        h(doc, "span", { class: "whimsy-emoji-footer-icon" }, shown),
        h(doc, "b", {}, lazy.WhimsyEmojiIndex.nameOf(selected)),
        h(doc, "span", { class: "whimsy-emoji-footer-keys" },
          h(doc, "span", {}, h(doc, "kbd", {}, "↵"), h(doc, "span", { l10n: canType ? "whimsy-emoji-footer-type" : "whimsy-emoji-footer-copy" })),
          canType ? h(doc, "span", {}, h(doc, "kbd", {}, "⌘↵"), h(doc, "span", { l10n: "whimsy-emoji-footer-copy" })) : null
        )
      )
    );
    this.revealSelection(el);
  },

  // W25 designfix (owner: "every arrow-key move glitches and jumps", and
  // the bottom row's selection went off screen). Root cause: every move
  // re-ran render(), which rebuilt the whole card; its section headings and
  // footer are localized asynchronously, so for a frame they were empty and
  // the rows above the selection collapsed and sprang back, and nothing
  // ever scrolled the selection into view. A move now only moves the
  // highlight and the footer's name, then scrolls the results by the least
  // amount that shows the cell (none when it's already visible).
  moveSelection(win, state) {
    const el = mounts.get(win)?.el;
    if (!el?.isConnected) {
      return;
    }
    const cells = el.querySelectorAll(".whimsy-emoji-cell");
    for (const cell of el.querySelectorAll(".whimsy-emoji-cell.on")) {
      cell.classList.remove("on");
      cell.setAttribute("aria-selected", "false");
    }
    const cell = cells[state.selected];
    const selected = state.flat[state.selected];
    if (!cell || !selected) {
      return;
    }
    cell.classList.add("on");
    cell.setAttribute("aria-selected", "true");
    const icon = el.querySelector(".whimsy-emoji-footer-icon");
    if (icon) {
      icon.textContent = state.tones ? lazy.WhimsySpaceIcons.withTone(selected, state.toneIndex) : selected;
    }
    const name = el.querySelector(".whimsy-emoji-footer > b");
    if (name) {
      name.textContent = lazy.WhimsyEmojiIndex.nameOf(selected);
    }
    this.revealSelection(el);
  },

  revealSelection(el) {
    el.querySelector(".whimsy-emoji-cell.on")?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
  },

  // Tab and ⇧Tab move between the card's stops (the grid, the skin-tone
  // row when the selected emoji has tones, and the search field), with
  // focus kept in the field and the stop shown by a ring: the command
  // bar's own footer pattern (WhimsyCommandBarAgent.sys.mjs, data-kbd-focus).
  stopsOf(state) {
    const selected = state.flat[state.selected];
    return ["grid", ...(selected && hasTone(selected) ? ["tones"] : []), "field"];
  },

  onInputKey(win, event) {
    const state = states.get(win);
    if (!state) {
      return;
    }
    // `states` is only cleared on pick/runWebSearch and on popuphidden —
    // neither fires when the query simply stops matching isActive() (e.g.
    // backspacing past the ":" to a plain search, or Zen reusing the same
    // input for the private bar). Without this check, this capture-phase
    // listener keeps firing on every keystroke in the window and would
    // hijack a later, unrelated Enter (e.g. loading a typed URL) with a
    // stale grid. Never act on state that isn't the bar's current query.
    if (!win.gURLBar?.value?.startsWith(":")) {
      // Also undoes mountGrid's identity-icon hiding (whimsy-emoji.css):
      // without this, backspacing past ":" into some other active row
      // (bangs, a plain search) would leave the real page's identity icon
      // hidden — and our stand-in search glyph showing — behind a row that
      // isn't ours anymore.
      this.unmountGrid(win);
      return;
    }
    if (event.key == "Tab" && !event.metaKey && !event.ctrlKey && !event.altKey) {
      if (state.noMatch || !state.flat.length) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      const stops = this.stopsOf(state);
      const at = Math.max(0, stops.indexOf(state.stop ?? "grid"));
      state.stop = stops[(at + (event.shiftKey ? -1 : 1) + stops.length) % stops.length];
      state.tones = state.stop == "tones";
      this.render(win, state);
      return;
    }
    if (state.stop == "field" && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      // The field's own caret.
      return;
    }
    if (state.tones && (event.key == "ArrowLeft" || event.key == "ArrowRight")) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const dir = event.key == "ArrowRight" ? 1 : -1;
      state.toneIndex = Math.max(0, Math.min(MAX_TONE, state.toneIndex + dir));
      // In place, like a grid move (see moveSelection).
      const card = mounts.get(win)?.el;
      const tones = card?.querySelectorAll(".whimsy-emoji-tone") ?? [];
      tones.forEach((t, i) => t.classList.toggle("on", i == state.toneIndex));
      const icon = card?.querySelector(".whimsy-emoji-footer-icon");
      if (icon) {
        icon.textContent = lazy.WhimsySpaceIcons.withTone(state.flat[state.selected], state.toneIndex);
      }
      return;
    }
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      if (!state.flat.length) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      let next = state.selected;
      if (event.key == "ArrowRight") {
        next++;
      } else if (event.key == "ArrowLeft") {
        next--;
      } else if (event.key == "ArrowDown") {
        next += COLUMNS;
      } else {
        next -= COLUMNS;
      }
      state.selected = Math.max(0, Math.min(state.flat.length - 1, next));
      state.stop = "grid";
      if (state.tones) {
        state.tones = false;
        this.render(win, state);
      } else {
        const card = mounts.get(win)?.el;
        if (card) {
          card.dataset.stop = "grid";
        }
        this.moveSelection(win, state);
      }
      return;
    }
    if (event.key == "Enter") {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (state.noMatch) {
        this.runWebSearch(win, state.query);
        return;
      }
      const selected = state.flat[state.selected];
      if (!selected) {
        return;
      }
      this.pick(win, state, selected, { copy: event.metaKey || event.ctrlKey });
    }
  },

  pickTone(win, state, baseEmoji, tone) {
    state.toneIndex = tone;
    Services.prefs.setIntPref(TONE_PREF, tone);
    this.pick(win, state, baseEmoji, { copy: false });
  },

  async pick(win, state, baseEmoji, { copy }) {
    // state.toneIndex always starts from the skin-tone pref (computeState),
    // so a deduped cell picked straight from the grid — without opening the
    // tone row — still inserts the preferred tone, not the bare default.
    // withTone no-ops for tone 0 or an emoji that has no tone variants.
    const toned = lazy.WhimsySpaceIcons.withTone(baseEmoji, state.toneIndex);
    lazy.WhimsyEmojiFrequent.record(win, baseEmoji);
    this.unmountGrid(win);
    win.gURLBar?.view.close();
    win.gURLBar?.handleRevert();
    if (!copy && (await this.insertInPage(win, toned))) {
      return;
    }
    this.copyAndToast(win, toned);
  },

  async insertInPage(win, emoji) {
    try {
      const actor = win.gBrowser?.selectedBrowser?.browsingContext?.currentWindowGlobal?.getActor("WhimsyEmoji");
      const result = await actor?.sendQuery("WhimsyEmoji:Insert", { emoji });
      return !!result?.ok;
    } catch {
      return false;
    }
  },

  // Whether Enter would type into the page right now (vs. copy): the same
  // check WhimsyEmojiChild.insert makes, asked ahead of time so the footer
  // can say the right thing. Defaults to false (copy) on any failure.
  async checkCanInsert(win) {
    try {
      const actor = win.gBrowser?.selectedBrowser?.browsingContext?.currentWindowGlobal?.getActor("WhimsyEmoji");
      const result = await actor?.sendQuery("WhimsyEmoji:CanInsert");
      return !!result?.ok;
    } catch {
      return false;
    }
  },

  copyAndToast(win, emoji) {
    Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper).copyString(emoji);
    const name = lazy.WhimsyEmojiIndex.nameOf(emoji);
    win.gZenUIManager?.showToast?.("whimsy-emoji-copied-toast", { l10nArgs: { name }, timeout: TOAST_MS });
  },

  runWebSearch(win, query) {
    this.unmountGrid(win);
    win.gURLBar?.view.close();
    win.gURLBar?.handleRevert();
    const engine = Services.search.defaultEngine;
    const submission = engine?.getSubmission(query);
    if (submission) {
      win.openTrustedLinkIn(submission.uri.spec, "current");
    }
  },
};

// The parent side of inserting into the page (WhimsyEmojiChild.sys.mjs).
export class WhimsyEmojiParent extends JSWindowActorParent {}
