/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W27: Edit Field in Text Editor, page side. Reads the plain-text value of
// whatever's focused (a textarea or a contenteditable) so the parent can
// hand it to the Mac's text editor, then writes edits back the same field,
// dispatching "input" so the page's own listeners see it
// (WhimsyFieldEditor.sys.mjs does the temp file and the editor). A
// contenteditable is always read and written as plain text (textContent,
// never innerHTML), so a file full of attacker-controlled markup can't
// inject anything into the page.
//
// W29: a button in the box's own bottom-end corner, shown while a
// qualifying field (qualifies(), below) has focus. qualifies() is the one
// check the button and the command both use, so they can never disagree:
// the command's isAvailable (WhimsyFieldEditor.sys.mjs) follows this
// child's "Qualified" reports, not its own copy of the rule.
//
// The button itself is the alias button's own design, moved to the box's
// bottom-end corner instead of a one-line field's vertical middle:
// WhimsyEmailAliasesChild.sys.mjs's host, shadow root, positioning,
// overlay-stepping and observers are duplicated here (not shared through a
// helper module) so this new, less-proven code can't regress the alias
// button's own tests.

// The deepest focused element, following same-origin iframes (a
// cross-origin one throws on .contentDocument, which just stops the walk).
// Copied from WhimsyEmojiChild.sys.mjs, the same "type into whatever's
// focused" problem.
function deepActiveElement(doc) {
  let el = doc.activeElement;
  while (el?.localName == "iframe") {
    let inner;
    try {
      inner = el.contentDocument;
    } catch {
      break;
    }
    if (!inner?.activeElement || inner.activeElement == inner.body) {
      break;
    }
    el = inner.activeElement;
    doc = inner;
  }
  return el;
}

function isPassword(el) {
  return el?.localName == "input" && (el.getAttribute("type") || "").toLowerCase() == "password";
}

// A multi-line box only (Q1): a textarea, or a contenteditable region's own
// editing host (an element with isContentEditable true whose parent isn't
// also contentEditable — a child of the host doesn't count).
function isMultilineBox(el) {
  if (!el) {
    return false;
  }
  if (el.localName == "textarea") {
    return true;
  }
  return !!el.isContentEditable && !el.parentElement?.isContentEditable;
}

function fieldValue(el) {
  return el.localName == "textarea" ? el.value : el.textContent;
}

function setFieldValue(el, text) {
  if (el.localName == "textarea") {
    el.value = text;
  } else {
    el.textContent = text;
  }
  // The field's own global, not the actor's: a dispatched event must come
  // from the target's own window (this engine has no Element.ownerGlobal;
  // WhimsyAISensitive.sys.mjs:163 uses documentGlobal the same way).
  el.dispatchEvent(new el.documentGlobal.Event("input", { bubbles: true }));
}

const MIN_WIDTH = 120;
const MIN_HEIGHT = 40; // two lines, roughly

// The field button's one check (Q1, Q2): a field qualifies when all of
// these hold. The button shows and the command runs for exactly the same
// fields, because both read this.
export function qualifies(el) {
  if (!isMultilineBox(el)) {
    return false;
  }
  if (isPassword(el) || el.readOnly || el.disabled || el.closest?.("[inert], [aria-hidden='true']")) {
    return false;
  }
  const tokens = (el.getAttribute("autocomplete") || "").toLowerCase().split(/\s+/);
  if (tokens.includes("one-time-code") || tokens.some(t => t.startsWith("cc-"))) {
    return false;
  }
  const win = el.ownerDocument?.defaultView;
  if (!win || win.browsingContext?.usePrivateBrowsing) {
    return false;
  }
  const rect = el.getBoundingClientRect();
  if (rect.width < MIN_WIDTH || rect.height < MIN_HEIGHT) {
    return false;
  }
  // At least partly in the viewport.
  if (rect.bottom <= 0 || rect.top >= win.innerHeight || rect.right <= 0 || rect.left >= win.innerWidth) {
    return false;
  }
  if (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) {
    return false;
  }
  return true;
}

const lazy = {};
ChromeUtils.defineLazyGetter(lazy, "l10n", () => new Localization(["browser/whimsy.ftl"], true));
const BUTTON_PREF = "whimsy.field-editor.button";
const HOST_ID = "whimsy-field-editor-host";
const BUTTON_SIZE = 24;
const EDGE_GAP = 6; // from the field's edges, and between neighbours
const RESIZE_GRIP_INSET = 14; // clear of a textarea's own resize grip
// Owner's note (r4): icon B, "open elsewhere" — a box with an arrow leaving
// its corner, approved over the command's old menu icon (code.svg). Drawn
// on Whimsy's 16px icon grid (1.4 stroke, round caps/joins, no fill), like
// content/icons/pencil.svg and split-pane.svg. Swapping the glyph is
// changing these two constants AND content/icons/edit-field.svg (the
// command's own copy, used for its command-bar row) to match — a
// content-process button can't load that chrome:// file directly, so this
// inline copy is the one other spot, not a third.
const ICON_VIEW_BOX = "0 0 16 16";
const ICON_PATH_D =
  "M7 3H4.6A2 2 0 0 0 2.6 5v6.4a2 2 0 0 0 2 2H11a2 2 0 0 0 2-2V9 M9.6 2.6h3.8v3.8M13.4 2.6 7.8 8.2";
// Inline buttons other password managers (and sites) put at a field's end.
// Anything else small sitting there is found by hit-testing (#overlayAt).
// Ported from WhimsyEmailAliasesChild.sys.mjs:24-68.
const OVERLAY_SELECTOR = [
  "com-1password-button",
  "com-onepassword-button",
  "[data-1p-ignore]",
  "[data-onepassword-root]",
  "[data-com-onepassword-filled]",
  "div[id^='onepassword']",
  "[class*='onepassword' i]",
  "[class*='1password' i]",
  "[data-lastpass-icon-root]",
  "[data-lastpass-root]",
  "div[id^='__lpform_']",
  "[data-bitwarden-autofill-button]",
  "bitwarden-inline-menu",
  "[class*='bitwarden' i]",
  "[id*='bitwarden' i]",
  "[data-dashlanecreated]",
  "dashlane-inline",
  "[data-dashlane-frame]",
  "[class*='dashlane' i]",
  "[id*='dashlane' i]",
  "keeper-lock",
  "protonpass-root",
  "[data-protonpass-role='icon']",
  "nordpass-icon",
  "[data-np-icon]",
  "button[class*='eye' i]",
  "button[class*='reveal' i]",
  "button[class*='password' i]",
  "button[class*='toggle' i]",
  "button[aria-label*='password' i]",
  "button[aria-label*='show' i]",
  "button[aria-label*='hide' i]",
  "button[aria-label*='reveal' i]",
  "button[aria-label*='eye' i]",
  "[role='button'][class*='eye' i]",
  "[role='button'][aria-label*='password' i]",
  "[role='button'][aria-label*='show' i]",
  "[role='button'][aria-label*='hide' i]",
  "[data-toggle='password']",
  "[class*='password-toggle' i]",
  "[class*='show-password' i]",
  "[class*='toggle-password' i]",
  "[class*='password-eye' i]",
].join(",");
const REPOSITION_MS = 200;
const WATCH_OPTIONS = { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "class", "hidden"] };
const SVG_NS = "http://www.w3.org/2000/svg";

export class WhimsyFieldEditorChild extends JSWindowActorChild {
  // The write-back target: a WeakRef to the field "Read" last found, kept
  // steady for #write() even if the page's own focus moves on while the
  // editor is open. Only #read() ever changes these two.
  #field = null;
  #token = 0;
  // Which field the button is currently showing for (display only; never
  // used for the write-back target, so a recheck triggered by focus moving
  // elsewhere can never corrupt an editor session already open on another
  // field).
  #liveField = null;
  #qualified = false;
  // The field the parent says is under edit right now (its WeakRef, from
  // #field at the moment "Editing" arrived), so the button can show pressed
  // again if focus returns to it.
  #editingField = null;
  #button = null;
  #host = null;
  #cleanup = [];
  #observer = null;
  #watchedRoots = new WeakSet();

  handleEvent(event) {
    switch (event.type) {
      case "focusin":
      case "focusout":
        this.#recheck();
        break;
      case "pagehide":
        this.#detachButton();
        this.#reportQualified(false);
        break;
    }
  }

  receiveMessage(message) {
    if (message.name == "WhimsyFieldEditor:Colors") {
      this.#setColors(message.data);
    }
    if (message.name == "WhimsyFieldEditor:Read") {
      return this.#read();
    }
    if (message.name == "WhimsyFieldEditor:Write") {
      return this.#write(message.data.text);
    }
    if (message.name == "WhimsyFieldEditor:Editing") {
      this.#setPressed(message.data.on, message.data.token);
    }
    return null;
  }

  didDestroy() {
    this.#detachButton();
  }

  #read() {
    const el = deepActiveElement(this.document);
    if (!qualifies(el)) {
      return null;
    }
    if (this.#field?.deref() != el) {
      this.#field = new WeakRef(el);
      this.#token++;
    }
    return { value: fieldValue(el), token: this.#token };
  }

  #write(text) {
    const el = this.#field?.deref();
    if (!el?.isConnected) {
      return { ok: false };
    }
    try {
      setFieldValue(el, text);
    } catch (e) {
      return { ok: false };
    }
    return { ok: true };
  }

  // Which field is being edited right now, if "token" still names the
  // field #read() last reported (a stale message about a field that's no
  // longer the write-back target is ignored).
  #setPressed(on, token) {
    if (on && token == this.#token) {
      this.#editingField = this.#field;
    } else if (!on) {
      this.#editingField = null;
    } else {
      return; // a stale "on" for a field that's no longer current
    }
    this.#applyPressed();
  }

  #applyPressed() {
    const pressed = !!this.#editingField && this.#liveField?.deref() == this.#editingField.deref();
    if (!this.#button) {
      return;
    }
    this.#button.setAttribute("aria-pressed", String(pressed));
  }

  #setColors({ accent, ink }) {
    this.#button?.style.setProperty("--hint-bg", accent);
    this.#button?.style.setProperty("--hint-ink", ink);
  }

  #reportQualified(on) {
    on = !!on;
    if (on == this.#qualified) {
      return;
    }
    this.#qualified = on;
    try {
      this.sendAsyncMessage("WhimsyFieldEditor:Qualified", { on });
    } catch (e) {
      // The actor may already be going away.
    }
  }

  // The live check driving both the "Qualified" report and the button:
  // focus moving, the field shrinking, scrolling off, or turning read-only
  // all come through here. Never touches #field/#token (the write-back
  // target), only #liveField (display).
  #recheck() {
    const el = deepActiveElement(this.document);
    const ok = qualifies(el);
    this.#reportQualified(ok);
    if (!ok || !Services.prefs.getBoolPref(BUTTON_PREF, true)) {
      this.#detachButton();
      return;
    }
    if (this.#liveField?.deref() == el && this.#host?.isConnected) {
      this.#position(el);
      return;
    }
    this.#attachButton(el);
  }

  #attachButton(el) {
    this.#detachButton();
    const doc = el.ownerDocument;
    const win = doc.defaultView;
    if (!doc.documentElement || !win) {
      return;
    }
    this.#liveField = new WeakRef(el);

    const host = doc.createElement("div");
    host.id = HOST_ID;
    Object.assign(host.style, {
      position: "absolute",
      zIndex: "2147483647",
      width: `${BUTTON_SIZE}px`,
      height: `${BUTTON_SIZE}px`,
      margin: "0",
      padding: "0",
      border: "0",
    });
    const shadow = host.attachShadow({ mode: "closed" });
    const button = doc.createElement("button");
    button.type = "button";
    button.tabIndex = -1;
    const label = lazy.l10n.formatValueSync("whimsy-action-edit-field-in-editor");
    button.setAttribute("aria-label", label);
    button.title = label; // Q3: a tooltip on hover, after the system delay.
    Object.assign(button.style, {
      boxSizing: "border-box",
      width: `${BUTTON_SIZE}px`,
      height: `${BUTTON_SIZE}px`,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      cursor: "pointer",
    });
    button.className = "whimsy-keycap";
    button.append(this.#icon(doc));
    shadow.append(button);

    // Keep focus (and the page's own field state) on the field.
    button.addEventListener("mousedown", e => e.isTrusted && e.preventDefault());
    button.addEventListener("click", e => {
      if (!e.isTrusted) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      this.#press();
    });

    doc.documentElement.append(host);
    this.#host = host;
    this.#button = button;
    // Load through chrome and adopt into this shadow root: the page cannot
    // fetch chrome URLs, and its CSP must not decide whether our keycap draws.
    this.sendQuery("WhimsyFieldEditor:Style").then(({ css, ...colors }) => {
      if (this.#button == button) {
        const sheet = new win.CSSStyleSheet();
        sheet.replaceSync(css);
        shadow.adoptedStyleSheets = [sheet];
        this.#setColors(colors);
      }
    }).catch(() => {});
    this.#applyPressed();
    this.#position(el);

    const reposition = () => this.#position(el);
    let pending = null;
    const soon = () => {
      if (pending == null) {
        pending = win.setTimeout(() => {
          pending = null;
          reposition();
        }, REPOSITION_MS);
      }
    };
    const observer = new win.MutationObserver(records => {
      if (records.some(r => r.target != host && !host.contains(r.target))) {
        soon();
      }
    });
    observer.observe(doc.documentElement, WATCH_OPTIONS);
    this.#observer = observer;
    const resize = new win.ResizeObserver(soon);
    resize.observe(el);
    const intersection = new win.IntersectionObserver(soon);
    intersection.observe(el);
    const settle = [150, 600, 1500].map(ms => win.setTimeout(reposition, ms));
    win.addEventListener("scroll", reposition, { capture: true, passive: true });
    win.addEventListener("resize", reposition, { passive: true });
    this.#cleanup.push(() => {
      win.removeEventListener("scroll", reposition, { capture: true });
      win.removeEventListener("resize", reposition);
      observer.disconnect();
      this.#observer = null;
      this.#watchedRoots = new WeakSet();
      resize.disconnect();
      intersection.disconnect();
      win.clearTimeout(pending);
      settle.forEach(id => win.clearTimeout(id));
    });
  }

  // The glyph, as SVG nodes (no inline style or image for a CSP to block).
  // Stroke-based, like the alias button's own icon (WhimsyEmailAliasesChild
  // #icon): no fill, round caps and joins, matching content/icons/*.svg.
  #icon(doc) {
    const svg = doc.createElementNS(SVG_NS, "svg");
    for (const [k, v] of Object.entries({
      width: "16",
      height: "16",
      viewBox: ICON_VIEW_BOX,
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "1.4",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
    })) {
      svg.setAttribute(k, v);
    }
    const path = doc.createElementNS(SVG_NS, "path");
    path.setAttribute("d", ICON_PATH_D);
    svg.append(path);
    return svg;
  }

  #position(el) {
    const host = this.#host;
    if (!el || !host) {
      return;
    }
    const rect = el.getBoundingClientRect();
    if (!el.isConnected || !rect.width || !rect.height) {
      host.style.display = "none";
      return;
    }
    const win = el.ownerDocument.defaultView;
    host.style.display = "block";
    const top = rect.bottom - BUTTON_SIZE - EDGE_GAP;
    host.style.top = `${top + win.scrollY}px`;
    host.style.left = `${this.#slotLeft(el, rect) + win.scrollX}px`;
  }

  // Where the button goes, in viewport x: inside the box's bottom-end
  // corner, measured from the client area (so it never covers a vertical
  // scroll bar), clear of a resize grip, then left of anything another
  // extension (or the page) draws there. Ported from
  // WhimsyEmailAliasesChild.sys.mjs:312-329 (#slotLeft), with the box's own
  // client-area edge instead of its border box.
  #slotLeft(el, rect) {
    const win = el.ownerDocument.defaultView;
    const style = win.getComputedStyle(el);
    let right = rect.left + el.clientLeft + el.clientWidth - EDGE_GAP;
    if (style.resize && style.resize != "none") {
      right -= RESIZE_GRIP_INSET;
    }
    for (let i = 0; i < 4; i++) {
      const overlay = this.#overlayAt(el, rect, right - BUTTON_SIZE, right);
      if (!overlay) {
        break;
      }
      right = overlay.left - EDGE_GAP;
    }
    return Math.max(rect.left + EDGE_GAP, right - BUTTON_SIZE);
  }

  // What an element actually draws. 1Password's and other managers' inline
  // buttons are custom elements with no box of their own (display:
  // contents, or a zero-size host) whose icon lives in a closed shadow
  // root, so their own box would otherwise be empty. Ported from
  // WhimsyEmailAliasesChild.sys.mjs:336-369 (#visualBox).
  #visualBox(el) {
    const box = el.getBoundingClientRect();
    if (box.width > 0 && box.height > 0) {
      return box;
    }
    const root = el.openOrClosedShadowRoot;
    if (!root) {
      return box;
    }
    if (this.#observer && !this.#watchedRoots.has(root)) {
      this.#watchedRoots.add(root);
      this.#observer.observe(root, WATCH_OPTIONS);
    }
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const child of root.querySelectorAll("*")) {
      const r = child.getBoundingClientRect();
      if (!r.width || !r.height || r.width > 80) {
        continue;
      }
      left = Math.min(left, r.left);
      top = Math.min(top, r.top);
      right = Math.max(right, r.right);
      bottom = Math.max(bottom, r.bottom);
    }
    if (left == Infinity) {
      return box;
    }
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }

  // Ours: the host, or anything in its shadow root.
  #isOwn(node) {
    return node == this.#host || node.getRootNode?.()?.host == this.#host;
  }

  // The box of another inline button overlapping [left, right] on the
  // field's row, if any. Ported from WhimsyEmailAliasesChild.sys.mjs:379-442
  // (#overlayAt), field renamed from "input".
  #overlayAt(field, rect, left, right) {
    const doc = field.ownerDocument;
    const overlaps = box =>
      box.width > 0 && box.height > 0 && box.width <= 80 &&
      box.left < right && box.right > left &&
      box.top < rect.bottom && box.bottom > rect.top;
    for (const el of doc.querySelectorAll(OVERLAY_SELECTOR)) {
      if (el == this.#host || el == field || el.contains(field)) {
        continue;
      }
      const candidate = el.closest("button, [role='button'], a") || el;
      const box = this.#visualBox(candidate);
      if (overlaps(box)) {
        return box;
      }
    }

    const container =
      field.closest("form, .field, [class*='field' i], [class*='input' i], [class*='group' i]") ||
      field.parentElement;
    if (container) {
      const controls = container.querySelectorAll(
        "button, [role='button'], svg, img, input[type='button'], input[type='image'], [class*='eye' i], [class*='toggle' i], [class*='reveal' i], [class*='icon' i]"
      );
      for (const el of controls) {
        if (el == this.#host || el == field || el.contains(field)) {
          continue;
        }
        const candidate = el.closest("button, [role='button'], a") || el;
        const box = candidate.getBoundingClientRect();
        if (overlaps(box) && box.left >= rect.left + rect.width / 3) {
          return box;
        }
      }
    }

    const utils = doc.defaultView?.windowUtils;
    for (const frac of [0.5, 0.3, 0.7]) {
      const y = rect.top + rect.height * frac;
      for (const x of [right - 2, (left + right) / 2, left + 2]) {
        let nodes = [];
        try {
          nodes = [...(utils?.nodesFromRect(x, y, 0, 0, 0, 0, true, false, false) ?? [])];
        } catch (e) {
          // Fall back to the page's view below.
        }
        for (const node of [...nodes, ...doc.elementsFromPoint(x, y)]) {
          const el = node.nodeType == 1 ? node : node.parentElement;
          if (!el || el.isNativeAnonymous || field.contains(el) || el == field || this.#isOwn(el) || el.contains(field) || el.getRootNode()?.host?.contains?.(field)) {
            continue;
          }
          const candidate = el.closest("button, [role='button'], a, [class*='button' i]") || el;
          const box = this.#visualBox(candidate);
          if (overlaps(box) && box.height <= rect.height + 16) {
            return box;
          }
        }
      }
    }
    return null;
  }

  #press() {
    this.sendAsyncMessage("WhimsyFieldEditor:Press");
  }

  #detachButton() {
    for (const fn of this.#cleanup.splice(0)) {
      try {
        fn();
      } catch {}
    }
    this.#host?.remove();
    this.#host = null;
    this.#button = null;
    this.#liveField = null;
  }
}
