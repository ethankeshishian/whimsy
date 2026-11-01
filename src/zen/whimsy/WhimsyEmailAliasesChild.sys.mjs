/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Email aliases, page side: finds email fields and shows a small filled
// mail button at the right edge of the focused one (fix7/tabs: filled, not
// an outline, so it reads on any field; and it steps left of a password
// manager's own inline button, 1Password's, Bitwarden's, LastPass's...,
// instead of hiding under it). The button lives in a closed
// shadow root, styled through CSSOM only (so page CSPs can't block it) and
// accepts trusted clicks only. Clicking it asks the parent to open the
// alias menu, which lives in the browser chrome; the parent sends back the
// address to fill. Nothing here talks to iCloud or Relay.

const lazy = {};
ChromeUtils.defineLazyGetter(lazy, "l10n", () => new Localization(["browser/whimsy.ftl"], true));
const FEATURE_PREF = "whimsy.feature.email-aliases";
const BUTTON_PREF = "whimsy.email-aliases.button";
const HOST_ID = "whimsy-email-aliases-host";
const BUTTON_SIZE = 24;
const EDGE_GAP = 6; // from the field's end, and between neighbours
// Inline buttons other password managers put at a field's end. Anything
// else small sitting there is found by hit-testing (#overlayAt).
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
// W10-49: the page is watched for as long as the button shows (managers
// and sites add, move and swap their icons whenever they like: on hover,
// after typing, when the eye toggles), at most once per this many ms.
const REPOSITION_MS = 200;
// What the page watch reacts to: nodes added or removed, a style or class
// changed, something shown or hidden.
const WATCH_OPTIONS = { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "class", "hidden"] };
const SVG_NS = "http://www.w3.org/2000/svg";

const EXCLUDED_TYPES = new Set([
  "hidden", "password", "submit", "button", "checkbox", "radio", "file",
  "range", "color", "date", "datetime-local", "month", "week", "time",
  "image", "reset", "number", "tel", "url", "search",
]);
const EMAIL_HINT = /e-?mail|邮箱|correo|courriel/i;

export function isEmailField(element) {
  if (!HTMLInputElement.isInstance(element)) {
    return false;
  }
  const type = (element.type || "text").toLowerCase();
  if (EXCLUDED_TYPES.has(type) || element.readOnly || element.disabled) {
    return false;
  }
  if (type == "email") {
    return true;
  }
  const autocomplete = (element.getAttribute("autocomplete") || "").toLowerCase();
  if (autocomplete.split(/\s+/).includes("email")) {
    return true;
  }
  return [element.name, element.id, element.placeholder, element.getAttribute("aria-label")].some(
    value => value && EMAIL_HINT.test(value)
  );
}

export class WhimsyEmailAliasesChild extends JSWindowActorChild {
  #input = null; // WeakRef to the field the button belongs to
  #host = null;
  #cleanup = [];
  // W10-49: watches the page, and the shadow roots of icons the button
  // steps around, while the button shows.
  #observer = null;
  #watchedRoots = new WeakSet();

  handleEvent(event) {
    switch (event.type) {
      case "focusin":
        this.#onFocusIn(event);
        break;
      case "pagehide":
        this.#remove();
        break;
    }
  }

  receiveMessage(message) {
    if (message.name == "WhimsyEmailAliases:Fill") {
      return this.#fill(message.data.address);
    }
    // wave7/small: the command bar's Create Email Alias.
    if (message.name == "WhimsyEmailAliases:FocusedField") {
      return this.#focusedField();
    }
    return undefined;
  }

  didDestroy() {
    this.#remove();
  }

  #onFocusIn(event) {
    const input = event.composedTarget ?? event.target;
    if (
      !Services.prefs.getBoolPref(FEATURE_PREF, true) ||
      !Services.prefs.getBoolPref(BUTTON_PREF, true) ||
      this.browsingContext.usePrivateBrowsing
    ) {
      return;
    }
    if (!isEmailField(input)) {
      return;
    }
    if (this.#input?.deref() == input && this.#host?.isConnected) {
      this.#position();
      return;
    }
    this.#attach(input);
  }

  #attach(input) {
    this.#remove();
    const doc = input.ownerDocument;
    const win = doc.defaultView;
    if (!doc.documentElement || !win) {
      return;
    }
    this.#input = new WeakRef(input);

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
    button.setAttribute("aria-label", lazy.l10n.formatValueSync("whimsy-email-aliases-field-button")); // wave9/designfix (L6)
    Object.assign(button.style, {
      all: "initial",
      boxSizing: "border-box",
      width: `${BUTTON_SIZE}px`,
      height: `${BUTTON_SIZE}px`,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      borderRadius: "7px",
      cursor: "pointer",
      // Filled like Safari's Hide My Email key: white on #0064d2 is 5.4:1,
      // and the white ring keeps it apart from any field colour.
      color: "#ffffff",
      backgroundColor: "#0064d2",
      boxShadow: "0 0 0 1px rgba(255, 255, 255, 0.9), 0 1px 3px rgba(0, 0, 0, 0.3)",
      transition: "background-color 120ms ease-out",
    });
    button.addEventListener("mouseenter", () => (button.style.backgroundColor = "#0050a8"));
    button.addEventListener("mouseleave", () => (button.style.backgroundColor = "#0064d2"));
    button.append(this.#icon(doc));
    shadow.append(button);

    // Keep focus (and the page's own field state) on the input.
    button.addEventListener("mousedown", e => e.isTrusted && e.preventDefault());
    button.addEventListener("click", e => {
      if (!e.isTrusted) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      this.#openMenu();
    });

    doc.documentElement.append(host);
    this.#host = host;
    this.#position();

    const reposition = () => this.#position();
    // Password managers add their button after focus, often a beat later,
    // and sites move theirs: look again whenever the page changes (nodes
    // added or removed, a style or class changed), a beat later at most.
    // W10-49: this used to stop after 3 seconds and only noticed nodes
    // being added, so an icon that showed up later or moved was covered.
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
    resize.observe(input);
    const settle = [150, 600, 1500].map(ms => win.setTimeout(reposition, ms));
    const onFocusOut = e => {
      // Focus moving to something else in the page hides the button. Focus
      // leaving the page (relatedTarget null) keeps it: that's the chrome
      // menu opening.
      if (e.target == input && e.relatedTarget && e.relatedTarget != host) {
        this.#remove();
      }
    };
    win.addEventListener("scroll", reposition, { capture: true, passive: true });
    win.addEventListener("resize", reposition, { passive: true });
    doc.addEventListener("focusout", onFocusOut, true);
    this.#cleanup.push(() => {
      win.removeEventListener("scroll", reposition, { capture: true });
      win.removeEventListener("resize", reposition);
      doc.removeEventListener("focusout", onFocusOut, true);
      observer.disconnect();
      this.#observer = null;
      this.#watchedRoots = new WeakSet();
      resize.disconnect();
      win.clearTimeout(pending);
      settle.forEach(id => win.clearTimeout(id));
    });
  }

  // A mask glyph, drawn as SVG nodes (no inline style or image for a CSP to
  // block).
  #icon(doc) {
    const svg = doc.createElementNS(SVG_NS, "svg");
    for (const [k, v] of Object.entries({
      width: "16",
      height: "16",
      viewBox: "0 0 16 16",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "1.6",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
    })) {
      svg.setAttribute(k, v);
    }
    const path = doc.createElementNS(SVG_NS, "path");
    path.setAttribute("d", "M2 4.5h12v7H2zM2.5 5l5.5 4 5.5-4");
    svg.append(path);
    return svg;
  }

  #position() {
    const input = this.#input?.deref();
    const host = this.#host;
    if (!input || !host) {
      return;
    }
    const rect = input.getBoundingClientRect();
    if (!input.isConnected || !rect.width || !rect.height) {
      host.style.display = "none";
      return;
    }
    const win = input.ownerDocument.defaultView;
    host.style.display = "block";
    const top = rect.top + (rect.height - BUTTON_SIZE) / 2;
    host.style.top = `${top + win.scrollY}px`;
    host.style.left = `${this.#slotLeft(input, rect) + win.scrollX}px`;
  }

  // Where the button goes, in viewport x: at the field's end, then left of
  // anything another extension (or the page) draws there.
  #slotLeft(input, rect) {
    let right = rect.right - EDGE_GAP;
    // A field that reserves its end for an icon of its own (padding with a
    // background image, the way LastPass and many sites draw theirs).
    const style = input.ownerDocument.defaultView.getComputedStyle(input);
    const padEnd = parseFloat(style.paddingRight) || 0;
    if (style.backgroundImage != "none" && padEnd >= BUTTON_SIZE) {
      right = rect.right - padEnd;
    }
    for (let i = 0; i < 4; i++) {
      const overlay = this.#overlayAt(input, rect, right - BUTTON_SIZE, right);
      if (!overlay) {
        break;
      }
      right = overlay.left - EDGE_GAP;
    }
    return Math.max(rect.left + EDGE_GAP, right - BUTTON_SIZE);
  }

  // W10-49: what an element actually draws. 1Password's and other
  // managers' inline buttons are custom elements with no box of their own
  // (display: contents, or a zero-size host) whose icon lives in a closed
  // shadow root, so their own box was empty and they were never stepped
  // around. This actor may open closed roots (openOrClosedShadowRoot).
  #visualBox(el) {
    const box = el.getBoundingClientRect();
    if (box.width > 0 && box.height > 0) {
      return box;
    }
    const root = el.openOrClosedShadowRoot;
    if (!root) {
      return box;
    }
    // An icon drawn in a shadow root moves without the page changing (the
    // document's observer can't see into the root): watch the root too.
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
  // field's row, if any: a known password manager's, or any small element
  // stacked over the field there.
  #overlayAt(input, rect, left, right) {
    const doc = input.ownerDocument;
    const overlaps = box =>
      box.width > 0 && box.height > 0 && box.width <= 80 &&
      box.left < right && box.right > left &&
      box.top < rect.bottom && box.bottom > rect.top;
    for (const el of doc.querySelectorAll(OVERLAY_SELECTOR)) {
      if (el == this.#host || el == input || el.contains(input)) {
        continue;
      }
      const candidate = el.closest("button, [role='button'], a") || el;
      const box = this.#visualBox(candidate);
      if (overlaps(box)) {
        return box;
      }
    }

    const container =
      input.closest("form, .field, [class*='field' i], [class*='input' i], [class*='group' i]") ||
      input.parentElement;
    if (container) {
      const controls = container.querySelectorAll(
        "button, [role='button'], svg, img, input[type='button'], input[type='image'], [class*='eye' i], [class*='toggle' i], [class*='reveal' i], [class*='icon' i]"
      );
      for (const el of controls) {
        if (el == this.#host || el == input || el.contains(input)) {
          continue;
        }
        const candidate = el.closest("button, [role='button'], a") || el;
        const box = candidate.getBoundingClientRect();
        if (overlaps(box) && box.left >= rect.left + rect.width / 3) {
          return box;
        }
      }
    }

    // Whatever is drawn there. W10-49: elementsFromPoint stops at a shadow
    // host, so an icon inside a shadow root was seen as its (often
    // box-less) host; nodesFromRect sees the drawn nodes themselves.
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
          if (!el || el.isNativeAnonymous || input.contains(el) || el == input || this.#isOwn(el) || el.contains(input) || el.getRootNode()?.host?.contains?.(input)) {
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

  #openMenu() {
    const input = this.#input?.deref();
    if (!input) {
      return;
    }
    const rect = input.getBoundingClientRect();
    const win = input.ownerDocument.defaultView;
    this.sendAsyncMessage("WhimsyEmailAliases:OpenMenu", {
      screenX: win.mozInnerScreenX + rect.left,
      screenY: win.mozInnerScreenY + rect.bottom,
    });
  }

  // wave7/small: the email field focused in this frame (through open shadow
  // roots), remembered as the one to fill; where the menu opens, or null.
  #focusedField() {
    if (!Services.prefs.getBoolPref(FEATURE_PREF, true) || this.browsingContext.usePrivateBrowsing) {
      return null;
    }
    let active = this.document?.activeElement ?? null;
    while (active?.shadowRoot?.activeElement) {
      active = active.shadowRoot.activeElement;
    }
    if (!active || !isEmailField(active)) {
      return null;
    }
    if (this.#input?.deref() != active) {
      this.#remove();
      this.#input = new WeakRef(active);
    }
    const rect = active.getBoundingClientRect();
    const win = active.ownerDocument.defaultView;
    return {
      screenX: win.mozInnerScreenX + rect.left,
      screenY: win.mozInnerScreenY + rect.bottom,
    };
  }

  // Fills the field the menu was opened for, like typing would.
  #fill(address) {
    const input = this.#input?.deref();
    if (!input?.isConnected || typeof address != "string") {
      return false;
    }
    input.focus();
    input.setUserInput(address);
    this.#remove();
    return true;
  }

  #remove() {
    for (const fn of this.#cleanup.splice(0)) {
      try {
        fn();
      } catch {}
    }
    this.#host?.remove();
    this.#host = null;
    this.#input = null;
  }
}
