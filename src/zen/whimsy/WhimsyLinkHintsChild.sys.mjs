/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave6/zap: Link hints, the page side (see WhimsyLinkHints.sys.mjs).
//
// Drawn in the document's anonymous content (like Screenshots and Whimsy's
// video speed control), so the page can't see, restyle or click the badges.
// Keys are caught on the frame's chrome event handler, before the page's
// own listeners, and only while hints are showing.

const lazy = {};
ChromeUtils.defineLazyGetter(lazy, "l10n", () => new Localization(["browser/whimsy.ftl"], true));

const STYLESHEET = "chrome://browser/content/whimsy/whimsy-link-hints.css";
// Vimium's home-row-first alphabet: the easiest letters come first.
export const ALPHABET = "sadfjklewcmpgh";
const MAX_HINTS = 700;
const LEAVE_MS = 130;

const CLICKABLE = [
  "a[href]",
  "area[href]",
  "button",
  "input:not([type='hidden'])",
  "select",
  "textarea",
  "summary",
  "[role='button']",
  "[role='link']",
  "[role='checkbox']",
  "[role='radio']",
  "[role='switch']",
  "[role='tab']",
  "[role='menuitem']",
  "[role='menuitemcheckbox']",
  "[role='menuitemradio']",
  "[role='option']",
  "[role='treeitem']",
  "[contenteditable='']",
  "[contenteditable='true']",
  "[onclick]",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

// Prefix-free labels, shortest first (Vimium's scheme): no label is the
// start of another, so a label is chosen the moment it's complete.
export function hintLabels(count, alphabet = ALPHABET) {
  if (count <= 0) {
    return [];
  }
  const labels = [""];
  let offset = 0;
  while (labels.length - offset < count || labels.length == 1) {
    const label = labels[offset++];
    for (const ch of alphabet) {
      labels.push(ch + label);
    }
  }
  return labels
    .slice(offset, offset + count)
    .sort()
    .map(label => [...label].reverse().join(""));
}

// The letter a key types, whatever the keyboard layout: the typed letter on
// Latin layouts (QWERTY, Dvorak, Colemak...), and the key's position
// otherwise (Cyrillic, Greek...), so the labels can always be typed.
export function keyLetter(event) {
  if (/^[a-z]$/i.test(event.key ?? "")) {
    return event.key.toLowerCase();
  }
  const match = /^Key([A-Z])$/.exec(event.code ?? "");
  return match ? match[1].toLowerCase() : null;
}

function isTextField(el) {
  if (el.isContentEditable || el.localName == "textarea" || el.localName == "select") {
    return true;
  }
  if (el.localName != "input") {
    return false;
  }
  const type = (el.getAttribute("type") || "text").toLowerCase();
  return !["checkbox", "radio", "button", "submit", "reset", "file", "image", "color", "range"].includes(type);
}

export class WhimsyLinkHintsChild extends JSWindowActorChild {
  hints = null;
  typed = "";
  anon = null;
  swallow = false;

  get active() {
    return !!this.hints;
  }

  receiveMessage(message) {
    switch (message.name) {
      case "Whimsy:Hints:Toggle":
        if (this.active) {
          this.exit("cancel");
        } else {
          this.enter(message.data ?? {});
        }
        return null;
      case "Whimsy:Hints:Exit":
        this.exit("cancel");
        return null;
      // For tests: what's showing.
      case "Whimsy:Hints:Peek":
        return {
          active: this.active,
          typed: this.typed,
          labels: (this.hints ?? []).filter(h => !h.node.hidden).map(h => h.label),
          ids: (this.hints ?? []).filter(h => !h.node.hidden).map(h => h.el.id),
        };
    }
    return null;
  }

  didDestroy() {
    this.exit(null, true);
  }

  handleEvent(event) {
    if (!this.active) {
      return;
    }
    switch (event.type) {
      case "keydown":
        this.onKeyDown(event);
        break;
      case "keypress":
      case "keyup":
        if (this.swallow) {
          event.preventDefault();
          event.stopImmediatePropagation();
          if (event.type == "keyup") {
            this.swallow = false;
          }
        }
        break;
      case "mousedown":
      case "resize":
      case "blur":
      case "pagehide":
        this.exit("cancel");
        break;
      case "scroll":
        // The badges are pinned to where things were; a scroll moves them.
        this.exit("cancel");
        break;
    }
  }

  // Everything clickable that's on screen and not covered by something else.
  collect() {
    const win = this.contentWindow;
    const doc = this.document;
    if (!win || !doc?.documentElement) {
      return [];
    }
    const vw = win.innerWidth;
    const vh = win.innerHeight;
    const found = [];
    const taken = new Set();
    for (const el of doc.querySelectorAll(CLICKABLE)) {
      if (found.length >= MAX_HINTS) {
        break;
      }
      if (el.disabled || el.closest("[inert], [aria-hidden='true']")) {
        continue;
      }
      // One badge for a link or button, not one more for each child inside.
      const outer = el.parentElement?.closest("a[href], button, [role='button'], [role='link']");
      if (outer && taken.has(outer)) {
        continue;
      }
      const rect = [...el.getClientRects()].find(
        r => r.width >= 2 && r.height >= 2 && r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw
      );
      if (!rect) {
        continue;
      }
      const style = win.getComputedStyle(el);
      if (style.visibility != "visible" || parseFloat(style.opacity) == 0) {
        continue;
      }
      const left = Math.max(0, rect.left);
      const top = Math.max(0, rect.top);
      const right = Math.min(vw, rect.right);
      const bottom = Math.min(vh, rect.bottom);
      const points = [
        [(left + right) / 2, (top + bottom) / 2],
        [left + 2, top + 2],
      ];
      const visible = points.some(([x, y]) => {
        const hit = doc.elementFromPoint(x, y);
        return hit && (hit == el || el.contains(hit) || (el.localName == "area" && hit.localName == "img"));
      });
      if (!visible) {
        continue;
      }
      taken.add(el);
      found.push({ el, x: left, y: top });
    }
    return found;
  }

  enter({ accent = "", ink = "" } = {}) {
    const targets = this.collect();
    if (!targets.length) {
      this.sendAsyncMessage("Whimsy:Hints:State", { state: "none" });
      return;
    }
    const doc = this.document;
    let anon;
    try {
      anon = doc.insertAnonymousContent();
    } catch (e) {
      return;
    }
    this.anon = anon;
    const root = anon.root;
    const link = doc.createElement("link");
    link.rel = "stylesheet";
    link.href = STYLESHEET;
    const layer = doc.createElement("div");
    layer.id = "whimsy-hints";
    if (accent) {
      layer.style.setProperty("--hint-bg", accent);
    }
    if (ink) {
      layer.style.setProperty("--hint-ink", ink);
    }
    const win = this.contentWindow;
    const labels = hintLabels(targets.length);
    this.hints = targets.map((target, i) => {
      const node = doc.createElement("span");
      node.className = "hint";
      node.style.left = `${Math.min(target.x, win.innerWidth - 8 - labels[i].length * 9)}px`;
      node.style.top = `${Math.min(target.y, win.innerHeight - 18)}px`;
      const typed = doc.createElement("span");
      typed.className = "typed";
      const rest = doc.createElement("span");
      rest.textContent = labels[i];
      node.append(typed, rest);
      layer.append(node);
      return { el: target.el, label: labels[i], node, typedNode: typed, restNode: rest };
    });
    const help = doc.createElement("div");
    help.id = "whimsy-hints-help";
    help.textContent = this.helpText();
    layer.append(help);
    root.append(link, layer);
    this.layer = layer;
    this.typed = "";

    const handler = this.docShell.chromeEventHandler;
    for (const type of ["keydown", "keypress", "keyup"]) {
      handler.addEventListener(type, this, true);
    }
    win.addEventListener("mousedown", this, true);
    win.addEventListener("resize", this);
    win.addEventListener("blur", this);
    win.addEventListener("pagehide", this);
    doc.addEventListener("scroll", this, { capture: true, passive: true });
    this.sendAsyncMessage("Whimsy:Hints:State", { state: "open", count: targets.length });
  }

  helpText() {
    try {
      return lazy.l10n.formatValueSync("whimsy-link-hints-help");
    } catch (e) {
      return "Type a hint · Shift opens in a new tab · Esc cancels";
    }
  }

  onKeyDown(event) {
    if (event.isComposing || ["Shift", "CapsLock"].includes(event.key)) {
      return;
    }
    // Shortcuts go through untouched (Cmd+J again closes the hints).
    if (event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }
    const stop = () => {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.swallow = true;
    };
    if (event.key == "Escape") {
      stop();
      this.exit("cancel");
      return;
    }
    if (event.key == "Backspace") {
      stop();
      this.typed = this.typed.slice(0, -1);
      this.render();
      return;
    }
    const letter = keyLetter(event);
    if (!letter || !ALPHABET.includes(letter)) {
      // Any other key (Space, arrows, Tab) leaves hint mode and does its job.
      this.exit("cancel");
      return;
    }
    stop();
    const typed = this.typed + letter;
    const matches = this.hints.filter(h => h.label.startsWith(typed));
    if (!matches.length) {
      return; // Not a hint: ignore the key.
    }
    this.typed = typed;
    if (matches.length == 1 && matches[0].label == typed) {
      this.activate(matches[0], event.shiftKey);
      return;
    }
    this.render();
  }

  render() {
    for (const hint of this.hints ?? []) {
      const match = hint.label.startsWith(this.typed);
      hint.node.hidden = !match;
      if (match) {
        hint.typedNode.textContent = this.typed;
        hint.restNode.textContent = hint.label.slice(this.typed.length);
      }
    }
  }

  activate(hint, newTab) {
    hint.node.classList.add("chosen");
    const el = hint.el;
    this.exit("activate");
    if (!el.isConnected) {
      return;
    }
    const link = el.closest("a[href], area[href]");
    if (newTab && link?.href) {
      const href = link.href;
      if (Services.io.extractScheme(href) == "javascript") {
        return;
      }
      const principal = this.document.nodePrincipal;
      try {
        Services.scriptSecurityManager.checkLoadURIStrWithPrincipal(principal, href);
      } catch (e) {
        return;
      }
      // The parent uses its own copy of the page's principal.
      this.sendAsyncMessage("Whimsy:Hints:OpenTab", { href });
      return;
    }
    el.focus?.({ preventScroll: true });
    if (isTextField(el)) {
      return;
    }
    // The events a real click sends, for pages that act on pointerdown or
    // mousedown (menus, custom buttons), then the click itself.
    const win = this.contentWindow;
    const rect = el.getBoundingClientRect();
    const init = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: win,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      button: 0,
    };
    el.dispatchEvent(new win.PointerEvent("pointerdown", { ...init, pointerType: "mouse", isPrimary: true, buttons: 1 }));
    el.dispatchEvent(new win.MouseEvent("mousedown", { ...init, buttons: 1 }));
    el.dispatchEvent(new win.PointerEvent("pointerup", { ...init, pointerType: "mouse", isPrimary: true }));
    el.dispatchEvent(new win.MouseEvent("mouseup", init));
    el.click();
  }

  exit(reason, destroyed = false) {
    if (!this.hints) {
      return;
    }
    this.hints = null;
    this.typed = "";
    this.swallow = reason == "activate" || this.swallow;
    const anon = this.anon;
    const layer = this.layer;
    this.anon = null;
    this.layer = null;
    if (!destroyed) {
      try {
        const handler = this.docShell.chromeEventHandler;
        // keyup stays a moment longer so the key that chose a hint doesn't
        // reach the page; it removes itself once that key is up.
        for (const type of ["keydown", "keypress"]) {
          handler.removeEventListener(type, this, true);
        }
        const keyup = event => {
          if (this.swallow) {
            event.preventDefault();
            event.stopImmediatePropagation();
          }
          this.swallow = false;
          handler.removeEventListener("keyup", keyup, true);
        };
        handler.removeEventListener("keyup", this, true);
        if (this.swallow) {
          handler.addEventListener("keyup", keyup, true);
        }
        const win = this.contentWindow;
        win?.removeEventListener("mousedown", this, true);
        win?.removeEventListener("resize", this);
        win?.removeEventListener("blur", this);
        win?.removeEventListener("pagehide", this);
        this.document?.removeEventListener("scroll", this, { capture: true });
      } catch (e) {
        // The window is going away.
      }
    }
    const remove = () => {
      try {
        if (anon && !Cu.isDeadWrapper(anon)) {
          this.document?.removeAnonymousContent(anon);
        }
      } catch (e) {
        // Already gone with its document.
      }
    };
    const reduced = this.contentWindow?.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (destroyed || reduced || !layer) {
      remove();
    } else {
      layer.classList.add("leaving");
      this.contentWindow.setTimeout(remove, LEAVE_MS);
    }
    if (!destroyed && reason) {
      try {
        this.sendAsyncMessage("Whimsy:Hints:State", { state: reason == "activate" ? "done" : "closed" });
      } catch (e) {
        // The actor is shutting down.
      }
    }
  }
}
