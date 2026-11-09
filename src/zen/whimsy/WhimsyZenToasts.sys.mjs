/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave13/toast: Zen's toast, extended. There is one toast in Whimsy, Zen's
// (the ⌘⇧C toast: hbox.zen-toast in #zen-toast-container, Zen's look and
// spring). This is Zen's nsZenToastManager (ZenToasts.mjs) with what Whimsy
// needs added, every addition opt-in:
//
//   - open() returns the toast at once: toast.update(changes), close()
//   - timeout 0 keeps it until its owner closes it or you dismiss it
//   - buttons that show their words (Undo ⌘Z), several per toast
//   - a close button on hover, Esc when focused
//   - a leading icon (an image or an SVG mark, with a badge)
//   - a toast about one tab goes when you leave the tab
//   - toasts with the same key are one toast, updated in place
//
// and two fixes for every toast: they stack in the corner instead of
// overlapping, and Reduce Motion gets a short fade instead of the spring.
//
// The overlay (whimsy/overlay.py, hotfix "zen-toasts-extended") makes
// gZenUIManager build this instead of Zen's manager and adds
// gZenUIManager.toasts. gZenUIManager.showToast() keeps Zen's contract, so
// Zen's own callers see Zen's toast exactly as before unless they pass one
// of the new options. Design: whimsy-handoff/wave13/toast-design.md.

const DEFAULT_TOAST_TIMEOUT_MS = 2000;
// Toasts with buttons stay long enough to reach them.
const BUTTONS_TOAST_TIMEOUT_MS = 6000;
// Persistent toasts shown before the rest fold into "+k more".
const MAX_PERSISTENT_TOASTS = 3;
const STACK_GAP_PX = 8;
const REDUCED_MOTION_FADE_S = 0.15;
const HTML_NS = "http://www.w3.org/1999/xhtml";

function prefersReducedMotion(win) {
  return win.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function timeoutFor(options) {
  if (options.timeout === 0) {
    return 0;
  }
  return (
    options.timeout ||
    (options.buttons?.length
      ? BUTTONS_TOAST_TIMEOUT_MS
      : DEFAULT_TOAST_TIMEOUT_MS)
  );
}

/**
 * One toast on screen. ZenToastManager.open() returns it, so its owner can
 * change it in place and close it.
 */
class ZenToast {
  /** @type {Element} hbox.zen-toast */
  element;
  messageId;
  key;
  /** @type {Promise} Settles once the toast has finished arriving. */
  shown = Promise.resolve();

  #win;
  #host;
  #timeout;
  #timer = null;
  #pauses = new Set();
  #entered = false;
  #busy = false;
  #closable = false;
  // Counts reshows and updates, so a button whose command replaced its own
  // toast (Stop -> "Casting stopped") doesn't then close the replacement.
  #generation = 0;
  #closing = null;
  #closed = false;
  #onClose = null;
  #removeOwner = null;
  #removeWindowListeners = null;

  /**
   * @param {Window} win
   * @param {object} host - { layout(), removed(toast) } from the manager.
   * @param {string} messageId
   * @param {object} options - See ZenToastManager.open.
   */
  constructor(win, host, messageId, options) {
    this.#win = win;
    this.#host = host;
    this.messageId = messageId;
    this.key = options.key ?? messageId;
    this.#timeout = timeoutFor(options);
    this.#onClose = options.onClose ?? null;
    this.element = this.#createElement(messageId, options);
    this.#apply({
      ...("icon" in options && { icon: options.icon }),
      ...("buttons" in options && { buttons: options.buttons }),
      ...("busy" in options && { busy: options.busy }),
      ...("browser" in options && { browser: options.browser }),
      closable: options.closable ?? this.persistent,
    });
    this.#updateRole();
  }

  get persistent() {
    return this.#timeout === 0;
  }

  get closing() {
    return !!this.#closing;
  }

  get closed() {
    return this.#closed;
  }

  /** Whether the auto-hide is held (hover, focus, background window). */
  get paused() {
    return this.#pauses.size > 0;
  }

  get busy() {
    return this.#busy;
  }

  get #document() {
    return this.#win.document;
  }

  // The message and its second line. Not firstElementChild: the icon slot
  // goes before it.
  get #textBox() {
    return this.element.querySelector(":scope > vbox");
  }

  get #label() {
    return this.#textBox.querySelector(":scope > label:not(.description)");
  }

  // Toasts someone may act on: they wait while focused or while the window
  // is in the background, and Esc dismisses them. Zen's own toasts (an icon
  // button at most) keep Zen's behaviour.
  get #interactive() {
    return this.persistent || this.#closable || this.#textButtons().length > 0;
  }

  #createElement(messageId, options) {
    const document = this.#document;
    const wrapper = document.createXULElement("hbox");
    const element = document.createXULElement("vbox");
    const label = document.createXULElement("label");
    document.l10n.setAttributes(label, messageId, options.l10nArgs);
    element.appendChild(label);
    wrapper.appendChild(element);
    wrapper.classList.add("zen-toast");
    wrapper._messageId = messageId;
    this.element = wrapper;
    this.#setDescription(options, { legacyArgs: true });
    if (options.button) {
      this.#setIconButton(options.button);
    }

    wrapper.addEventListener("mouseover", () => this.#pause("hover"));
    wrapper.addEventListener("mouseout", () => this.#resume("hover"));
    wrapper.addEventListener("focusin", () => {
      if (this.#interactive) {
        this.#pause("focus");
      }
    });
    wrapper.addEventListener("focusout", event => {
      if (!wrapper.contains(event.relatedTarget)) {
        this.#resume("focus");
      }
    });
    wrapper.addEventListener("keydown", event => {
      if (event.key == "Escape" && this.#interactive) {
        event.preventDefault();
        event.stopPropagation();
        this.close({ reason: "dismissed" });
      }
    });
    // Nobody reads a toast in a window that's in the background.
    const onDeactivate = () => this.#interactive && this.#pause("window");
    const onActivate = () => this.#resume("window");
    this.#win.addEventListener("deactivate", onDeactivate);
    this.#win.addEventListener("activate", onActivate);
    this.#removeWindowListeners = () => {
      this.#win.removeEventListener("deactivate", onDeactivate);
      this.#win.removeEventListener("activate", onActivate);
    };
    return wrapper;
  }

  get #motion() {
    return this.#win.gZenUIManager.motion;
  }

  /**
   * Arrives: Zen's spring from the top centre, or a short fade with Reduce
   * Motion.
   */
  async enter() {
    if (this.#document.hasFocus() === false && this.#interactive) {
      this.#pause("window");
    }
    if (prefersReducedMotion(this.#win)) {
      await this.#motion.animate(
        this.element,
        { opacity: [0, 1] },
        { duration: REDUCED_MOTION_FADE_S, bounce: 0, reduceMotion: false }
      );
    } else {
      if (!this.element.style.transform) {
        this.element.style.transform = "scale(0)";
      }
      await this.#motion.animate(
        this.element,
        { scale: 1 },
        { type: "spring", bounce: 0.2, duration: 0.5, reduceMotion: false }
      );
    }
    this.#entered = true;
    this.#schedule();
  }

  /**
   * The same key shown again while this toast is up. Without a key (Zen's
   * callers) it's Zen's reuse: new text and button, and a pulse. With a key
   * the toast becomes the new one in place, without motion.
   *
   * @param {string} messageId
   * @param {object} options - As for ZenToastManager.open.
   */
  async reshow(messageId, options) {
    // A pending auto-hide must not fire while the toast is being
    // (re)animated below, or it would remove the element mid-animation.
    this.#win.clearTimeout(this.#timer);
    this.#timer = null;
    this.#generation++;
    const keyed = "key" in options;
    this.messageId = messageId;
    this.element._messageId = messageId;
    this.#document.l10n.setAttributes(this.#label, messageId, options.l10nArgs);
    this.element.removeAttribute("button");
    if (options.button) {
      this.#setIconButton(options.button);
    }
    const changes = { timeout: options.timeout };
    for (const name of [
      "description",
      "descriptionId",
      "buttons",
      "icon",
      "closable",
      "browser",
      "busy",
    ]) {
      if (keyed || name in options) {
        changes[name] = options[name];
      }
    }
    if (keyed) {
      changes.buttons ??= null;
      changes.closable ??= options.timeout === 0;
      this.#onClose = options.onClose ?? null;
    }
    this.#apply(changes, options, { legacyArgs: !keyed });
    this.#host.layout();

    if (!keyed && !this.persistent && !prefersReducedMotion(this.#win)) {
      await this.#motion.animate(
        this.element,
        { scale: 0.2 },
        { duration: 0.1, bounce: 0, reduceMotion: false }
      );
      await this.#motion.animate(
        this.element,
        { scale: 1 },
        { type: "spring", bounce: 0.2, duration: 0.5, reduceMotion: false }
      );
    }
    this.#schedule();
  }

  /**
   * Changes the toast in place, without animating it again.
   *
   * @param {object} changes - Any of messageId, l10nArgs, description,
   *   descriptionId, descriptionArgs, buttons (null removes them), icon
   *   (null removes it), closable, browser, timeout, busy.
   */
  update(changes = {}) {
    if (this.#closing || this.#closed) {
      return;
    }
    this.#generation++;
    if (changes.messageId) {
      this.messageId = changes.messageId;
      this.element._messageId = changes.messageId;
    }
    if (changes.messageId || "l10nArgs" in changes) {
      this.#document.l10n.setAttributes(this.#label, this.messageId, changes.l10nArgs);
    }
    this.#apply(changes);
    this.#host.layout();
    this.#schedule();
  }

  #apply(changes, options = changes, { legacyArgs = false } = {}) {
    if ("description" in changes || "descriptionId" in changes) {
      this.#setDescription(options, { legacyArgs });
    }
    if ("icon" in changes) {
      this.#setIcon(changes.icon);
    }
    if ("buttons" in changes) {
      this.#setButtons(changes.buttons);
    }
    if ("closable" in changes) {
      this.#setClosable(!!changes.closable);
    }
    if ("browser" in changes) {
      this.#setOwner(changes.browser);
    }
    if ("timeout" in changes) {
      this.#timeout = timeoutFor({
        timeout: changes.timeout,
        buttons: this.#textButtons(),
      });
      this.#updateRole();
    }
    if ("busy" in changes) {
      this.#busy = !!changes.busy;
      this.element.toggleAttribute("busy", this.#busy);
      this.element.setAttribute("aria-busy", this.#busy);
      for (const button of this.#textButtons()) {
        button.disabled = this.#busy;
      }
    }
  }

  #textButtons() {
    return [
      ...this.element.querySelectorAll(":scope > .whimsy-toast-button"),
    ];
  }

  #updateRole() {
    this.element.setAttribute("role", this.persistent ? "alert" : "status");
    this.element.setAttribute("aria-atomic", "true");
  }

  #setDescription(options, { legacyArgs = false } = {}) {
    const document = this.#document;
    const box = this.#textBox;
    let description = box.querySelector(":scope > .description");
    if (!options.descriptionId && !options.description) {
      description?.remove();
      return;
    }
    if (!description) {
      description = document.createXULElement("label");
      description.classList.add("description");
      box.appendChild(description);
    }
    if (options.descriptionId) {
      let args = options.descriptionArgs;
      if (!args && legacyArgs) {
        // Zen passes the options themselves as the description's args.
        // Fluent takes only strings and numbers (an object, such as
        // l10nArgs, fails the whole translation), so only those go.
        args = Object.fromEntries(
          Object.entries(options).filter(
            ([, value]) => typeof value == "string" || typeof value == "number"
          )
        );
      }
      document.l10n.setAttributes(description, options.descriptionId, args);
      description.removeAttribute("tooltiptext");
    } else {
      description.removeAttribute("data-l10n-id");
      description.removeAttribute("data-l10n-args");
      description.textContent = options.description;
      // Cropped to one line; the whole text on hover.
      description.setAttribute("tooltiptext", options.description);
    }
  }

  // Zen's own button: an icon, its text hidden (zen-popup.css).
  #setIconButton({ id, command }) {
    this.element.querySelector(":scope > button.footer-button")?.remove();
    const button = this.#document.createXULElement("button");
    button.id = id;
    button.classList.add("footer-button", "primary");
    button.addEventListener("command", command);
    this.element.appendChild(button);
    this.element.setAttribute("button", true);
  }

  /**
   * @param {Array<object>|null} buttons - { id, l10nId, l10nArgs, label,
   *   keys, ariaKeys, command }. command(event, toast) may return "keep";
   *   otherwise the toast closes, unless the command changed it.
   */
  #setButtons(buttons) {
    const document = this.#document;
    for (const old of this.#textButtons()) {
      old.remove();
    }
    const close = this.element.querySelector(":scope > .whimsy-toast-close");
    for (const spec of buttons ?? []) {
      const button = document.createElementNS(HTML_NS, "button");
      button.type = "button";
      button.className = "whimsy-toast-button";
      if (spec.id) {
        const other = document.getElementById(spec.id);
        if (other?.classList.contains("whimsy-toast-button")) {
          other.removeAttribute("id");
        }
        button.id = spec.id;
      }
      const spinner = document.createElementNS(HTML_NS, "span");
      spinner.className = "whimsy-toast-spinner";
      spinner.setAttribute("aria-hidden", "true");
      const label = document.createElementNS(HTML_NS, "span");
      label.className = "whimsy-toast-button-label";
      if (spec.l10nId) {
        document.l10n.setAttributes(label, spec.l10nId, spec.l10nArgs);
      } else {
        label.textContent = spec.label ?? "";
      }
      button.append(spinner, label);
      if (spec.keys) {
        const keys = document.createElementNS(HTML_NS, "kbd");
        keys.className = "whimsy-toast-keys";
        keys.setAttribute("aria-hidden", "true");
        keys.textContent = spec.keys;
        button.append(keys);
      }
      if (spec.ariaKeys) {
        button.setAttribute("aria-keyshortcuts", spec.ariaKeys);
      }
      button.disabled = this.#busy;
      button.addEventListener("click", event => {
        event.stopPropagation();
        if (this.#busy || this.#closing) {
          return;
        }
        const generation = this.#generation;
        if (spec.command?.(event, this) !== "keep" && generation == this.#generation) {
          this.close();
        }
      });
      this.element.insertBefore(button, close);
    }
  }

  #setClosable(closable) {
    this.#closable = closable;
    let close = this.element.querySelector(":scope > .whimsy-toast-close");
    if (!closable) {
      close?.remove();
      return;
    }
    if (close) {
      return;
    }
    close = this.#document.createElementNS(HTML_NS, "button");
    close.type = "button";
    close.className = "whimsy-toast-close";
    this.#document.l10n.setAttributes(close, "whimsy-toast-close-button");
    close.addEventListener("click", event => {
      event.stopPropagation();
      this.close({ reason: "dismissed" });
    });
    this.element.appendChild(close);
  }

  /**
   * @param {string|Element|object|null} icon - A url, an element (an SVG
   *   mark), or { src, badge, size }.
   */
  #setIcon(icon) {
    const document = this.#document;
    this.element.querySelector(":scope > .whimsy-toast-icon")?.remove();
    if (!icon) {
      return;
    }
    const isElement = value => this.#win.Element.isInstance(value);
    const spec = typeof icon == "string" || isElement(icon) ? { src: icon } : icon;
    const image = src => {
      if (isElement(src)) {
        return src;
      }
      const img = document.createElementNS(HTML_NS, "img");
      img.setAttribute("alt", "");
      img.src = src;
      return img;
    };
    const slot = document.createElementNS(HTML_NS, "span");
    slot.className = "whimsy-toast-icon";
    slot.setAttribute("aria-hidden", "true");
    if (spec.size) {
      slot.style.setProperty("--whimsy-toast-icon-size", `${spec.size}px`);
    }
    slot.append(image(spec.src));
    if (spec.badge) {
      const badge = image(spec.badge);
      badge.classList.add("whimsy-toast-icon-badge");
      slot.append(badge);
    }
    this.element.prepend(slot);
  }

  // A toast about one tab belongs to it: it goes at once when you switch
  // away or the tab navigates.
  #setOwner(browser) {
    this.#removeOwner?.();
    this.#removeOwner = null;
    const gBrowser = this.#win.gBrowser;
    if (!browser || !gBrowser) {
      return;
    }
    const onTabSelect = () => {
      if (gBrowser.selectedBrowser != browser) {
        this.close({ instant: true, reason: "owner" });
      }
    };
    const listener = {
      onLocationChange: (b, progress, request, location, flags) => {
        if (
          b == browser &&
          progress?.isTopLevel &&
          !(flags & Ci.nsIWebProgressListener.LOCATION_CHANGE_SAME_DOCUMENT)
        ) {
          this.close({ instant: true, reason: "owner" });
        }
      },
    };
    gBrowser.tabContainer.addEventListener("TabSelect", onTabSelect);
    gBrowser.addTabsProgressListener(listener);
    this.#removeOwner = () => {
      gBrowser.tabContainer.removeEventListener("TabSelect", onTabSelect);
      gBrowser.removeTabsProgressListener(listener);
    };
  }

  #pause(reason) {
    this.#pauses.add(reason);
    this.#win.clearTimeout(this.#timer);
    this.#timer = null;
    this.element.setAttribute("paused", true);
  }

  #resume(reason) {
    if (!this.#pauses.delete(reason) || this.#pauses.size) {
      return;
    }
    this.element.removeAttribute("paused");
    this.#schedule();
  }

  #schedule() {
    this.#win.clearTimeout(this.#timer);
    this.#timer = null;
    if (
      !this.#entered ||
      this.#closing ||
      this.#closed ||
      this.persistent ||
      this.#busy ||
      this.#pauses.size
    ) {
      return;
    }
    this.#timer = this.#win.setTimeout(() => {
      this.#timer = null;
      if (
        !this.element.isConnected ||
        Services.prefs.getBoolPref("ui.popup.disable_autohide", false)
      ) {
        return;
      }
      this.close({ reason: "timeout" });
    }, this.#timeout);
  }

  /**
   * Hides the toast (Zen's shrink and fade, or a short fade with Reduce
   * Motion), then removes it.
   *
   * @param {object} [options]
   * @param {boolean} [options.instant] - Remove it now, without motion.
   * @param {string} [options.reason] - Passed to onClose.
   * @returns {Promise}
   */
  close({ instant = false, reason = "closed" } = {}) {
    if (this.#closed) {
      return Promise.resolve();
    }
    if (this.#closing && !instant) {
      return this.#closing;
    }
    this.#win.clearTimeout(this.#timer);
    this.#timer = null;
    this.#removeOwner?.();
    this.#removeOwner = null;
    this.#removeWindowListeners?.();
    this.#removeWindowListeners = null;
    // Keyboard focus in a vanishing toast would be lost: back to the page.
    if (this.element.contains(this.#document.activeElement)) {
      this.#win.gBrowser?.selectedBrowser?.focus();
    }
    this.element.setAttribute("closing", true);
    if (instant || !this.element.isConnected) {
      this.#finish(reason);
      return Promise.resolve();
    }
    const exit = prefersReducedMotion(this.#win)
      ? this.#motion.animate(
          this.element,
          { opacity: [1, 0] },
          { duration: REDUCED_MOTION_FADE_S, bounce: 0, reduceMotion: false }
        )
      : this.#motion.animate(
          this.element,
          { opacity: [1, 0], scale: [1, 0.5] },
          { duration: 0.2, bounce: 0, reduceMotion: false }
        );
    this.#closing = Promise.resolve(exit).then(() => this.#finish(reason));
    return this.#closing;
  }

  #finish(reason) {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#closing ??= Promise.resolve();
    this.element.remove();
    this.#host.removed(this);
    try {
      this.#onClose?.(reason);
    } catch (e) {
      console.error(e);
    }
  }
}

/**
 * Zen's toast manager (nsZenToastManager), extended: one per window, owned
 * by gZenUIManager. Toasts stack in the corner, transient ones first, then
 * persistent ones, newest first within each.
 */
export class ZenToastManager {
  /** @type {ZenToast[]} Toasts on screen, oldest first. */
  #toasts = [];
  #win;
  #container = null;
  #more = null;
  #expanded = false;
  #host = {
    layout: () => this.#layout(),
    removed: toast => {
      this.#toasts = this.#toasts.filter(t => t != toast);
      this.#layout();
    },
  };

  /** @param {Window} win - The browser window (gZenUIManager's). */
  constructor(win) {
    this.#win = win;
  }

  get #toastContainer() {
    if (!this.#container) {
      this.#container = this.#win.document.getElementById(
        "zen-toast-container"
      );
    }
    return this.#container;
  }

  /**
   * Zen's showToast(): shows a toast and resolves once it has arrived.
   *
   * @param {string} messageId - Fluent id of the toast label.
   * @param {object} [options] - See open().
   */
  async show(messageId, options = {}) {
    await this.open(messageId, options).shown;
  }

  /**
   * Shows a toast and returns it at once.
   *
   * @param {string} messageId - Fluent id of the toast label.
   * @param {object} [options]
   * @param {object} [options.l10nArgs] - Fluent args for the label.
   * @param {string} [options.descriptionId] - Fluent id of a second line.
   * @param {object} [options.descriptionArgs] - Its Fluent args.
   * @param {string} [options.description] - A plain-text second line.
   * @param {number} [options.timeout] - Auto-hide delay in milliseconds
   *   (2000, or 6000 with buttons); 0 keeps the toast until it's closed or
   *   dismissed.
   * @param {{id: string, command: Function}} [options.button] - Zen's icon
   *   button.
   * @param {Array<object>} [options.buttons] - Buttons that show their
   *   words: { id, l10nId, l10nArgs, label, keys, ariaKeys, command }.
   * @param {boolean} [options.closable] - A close button and Esc; on by
   *   default for persistent toasts.
   * @param {string|Element|object} [options.icon] - A leading mark: a url,
   *   an element, or { src, badge, size }.
   * @param {Element} [options.browser] - The tab the toast is about.
   * @param {string} [options.key] - Toasts with the same key are one toast,
   *   replaced in place. Defaults to the message id (Zen's reuse).
   * @param {boolean} [options.busy] - Holds the toast, buttons disabled.
   * @param {Function} [options.onClose] - Called with why it went:
   *   "timeout", "dismissed", "owner" or "closed".
   * @returns {ZenToast}
   */
  open(messageId, options = {}) {
    this.#prune();
    const key = options.key ?? messageId;
    const existing = this.#toasts.find(t => t.key == key && !t.closing);
    if (existing) {
      // Shown again, it's the newest news: it moves to the corner (the
      // rest slide), as a new toast would.
      this.#toasts = this.#toasts.filter(t => t != existing);
      this.#toasts.push(existing);
      existing.shown = existing.reshow(messageId, options);
      return existing;
    }
    const toast = new ZenToast(this.#win, this.#host, messageId, options);
    this.#toasts.push(toast);
    const container = this.#toastContainer;
    container.removeAttribute("hidden");
    container.appendChild(toast.element);
    this.#layout();
    toast.shown = toast.enter();
    return toast;
  }

  /**
   * @param {object} [options]
   * @param {boolean} [options.includeClosing] - Also the toasts still
   *   fading out.
   * @returns {ZenToast[]} Toasts on screen, newest first.
   */
  getToasts({ includeClosing = false } = {}) {
    this.#prune();
    return this.#toasts.filter(t => includeClosing || !t.closing).reverse();
  }

  /** @returns {ZenToast|null} The toast on screen with this key. */
  getToast(key) {
    return this.getToasts().find(t => t.key == key) ?? null;
  }

  // Toasts someone else took out of the DOM.
  #prune() {
    for (const toast of this.#toasts) {
      if (!toast.element.isConnected) {
        toast.close({ instant: true });
      }
    }
  }

  // Newest at the corner, 8px apart; a leaving toast keeps its place until
  // it's gone, then the rest slide up (whimsy-browser.css; they jump with
  // Reduce Motion).
  #layout() {
    const container = this.#toastContainer;
    const transient = this.#toasts.filter(t => !t.persistent).reverse();
    const persistent = this.#toasts.filter(t => t.persistent).reverse();
    if (persistent.length <= MAX_PERSISTENT_TOASTS) {
      this.#expanded = false;
    }
    const folded = this.#expanded
      ? []
      : persistent.slice(MAX_PERSISTENT_TOASTS);
    let top = 0;
    for (const toast of [...transient, ...persistent]) {
      if (folded.includes(toast)) {
        toast.element.setAttribute("stacked-away", true);
        continue;
      }
      toast.element.removeAttribute("stacked-away");
      toast.element.style.top = `${top}px`;
      top += toast.element.clientHeight + STACK_GAP_PX;
    }
    this.#updateMore(folded.length, top);
    if (!container.children.length) {
      container.setAttribute("hidden", true);
    }
  }

  // "+2 more": the persistent toasts past the first three. Click shows them.
  #updateMore(count, top) {
    if (!count) {
      this.#more?.remove();
      this.#more = null;
      return;
    }
    const document = this.#win.document;
    if (!this.#more) {
      this.#more = document.createElementNS(HTML_NS, "button");
      this.#more.type = "button";
      this.#more.className = "whimsy-toast-more";
      this.#more.addEventListener("click", () => {
        this.#expanded = true;
        this.#layout();
      });
      this.#toastContainer.appendChild(this.#more);
    }
    document.l10n.setAttributes(this.#more, "whimsy-toast-more", { count });
    this.#more.style.top = `${top}px`;
  }
}
