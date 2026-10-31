/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Hex colors in the theme picker (whimsy.feature.hex-colors).
//
// Zen's custom color row is a draft: a native color well and a 0-1 opacity
// spinner hold a color that reaches the space's theme only when you press
// the bare + button. Whimsy's first hex field (wave 2) kept that model, so
// a color picked in the well, or typed in the field, did nothing until you
// went back into the field and pressed Return (W8-40). Arc has no draft:
// every change to a space's colors shows on the window as you make it.
//
// Now the row edits a live color. The first valid color you type, paste or
// pick is added to the space's custom colors at once; later edits change
// that same color in place, so the sidebar follows every keystroke and
// every drag in the system color panel. Return or + ("New color") keeps it
// and empties the field for another; Esc puts back what was there before
// (removes a color that was new, restores one you were editing); closing
// the picker keeps it, as Zen's picker always does. Click a color in the
// list below to edit it.
//
// The field takes #RGB, #RGBA, #RRGGBB and #RRGGBBAA, with or without #,
// and pulls a hex out of pasted text ("color: #5B8CFF;"). Six and eight
// digits apply at once; three and four wait a beat, so typing #5B8CFF
// doesn't flash #55BB88 on the way. Text that can't become a color is
// flagged quietly (border and aria-invalid) and never touches the theme;
// leaving the field puts the last good color back. A copy button (and
// Cmd+C with nothing selected) copies the hex.

const FEATURE_PREF = "whimsy.feature.hex-colors";
export const FIELD_ID = "whimsy-hex-input";
const COPY_ID = "whimsy-hex-copy";
const STATUS_ID = "whimsy-hex-status";
const WELL_ID = "PanelUI-zen-gradient-generator-custom-input";
const OPACITY_ID = "PanelUI-zen-gradient-generator-custom-opacity";
const ADD_ID = "PanelUI-zen-gradient-generator-color-custom-add";
const LIST_ID = "PanelUI-zen-gradient-generator-custom-list";
const PANEL_ID = "PanelUI-zen-gradient-generator";
const ITEM = ".zen-theme-picker-custom-list-item";
const DOT_VAR = "--zen-theme-picker-dot-color";
const HTML_NS = "http://www.w3.org/1999/xhtml";
// How long a 3- or 4-digit hex waits before it applies (more digits may come).
const SHORT_DELAY_MS = 450;
const COPIED_MS = 1200;

function featureOn() {
  return Services.prefs.getBoolPref(FEATURE_PREF, true);
}

// "#abc", "abc", "#aabbcc", "#aabbccdd" → { rgb: "#aabbcc", alpha: 0..1,
// hex: "#aabbcc" or "#aabbccdd" (opaque drops the alpha) }, else null.
export function parseHex(text) {
  const match = /^#?([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(String(text ?? "").trim());
  if (!match) {
    return null;
  }
  let hex = match[1].toLowerCase();
  if (hex.length <= 4) {
    hex = [...hex].map(c => c + c).join("");
  }
  const rgb = `#${hex.slice(0, 6)}`;
  const a = hex.length == 8 ? hex.slice(6) : "ff";
  const alpha = Math.round((parseInt(a, 16) / 255) * 100) / 100;
  return { rgb, alpha, hex: a == "ff" ? rgb : `${rgb}${a}` };
}

// Whether text could still become a hex as more digits are typed.
export function couldBeHex(text) {
  return /^#?[0-9a-f]{0,8}$/i.test(String(text ?? "").trim());
}

// A hex from pasted text: the whole thing, or the first "#..." inside it.
export function extractHex(text) {
  const whole = parseHex(text);
  if (whole) {
    return whole;
  }
  const inside = /#([0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![0-9a-f])/i.exec(String(text ?? ""));
  return inside ? parseHex(inside[1]) : null;
}

function display(hex) {
  return String(hex).toUpperCase();
}

class HexPicker {
  // { uuid, index, original: hex or null when new, current: hex }
  session = null;
  shortTimer = 0;
  frame = 0;
  pending = null;
  picking = false;
  copiedTimer = 0;

  constructor(win) {
    this.win = win;
    const { document } = win;
    this.document = document;
    this.well = document.getElementById(WELL_ID);
    this.opacity = document.getElementById(OPACITY_ID);
    this.add = document.getElementById(ADD_ID);
    this.list = document.getElementById(LIST_ID);
    this.panel = document.getElementById(PANEL_ID);
  }

  get picker() {
    const tp = this.win.gZenThemePicker;
    return tp?.promiseInitialized ? tp : null;
  }

  build() {
    const { document, well } = this;
    const field = document.createElementNS(HTML_NS, "input");
    field.id = FIELD_ID;
    field.type = "text";
    field.setAttribute("spellcheck", "false");
    field.setAttribute("autocomplete", "off");
    field.setAttribute("maxlength", "9");
    field.setAttribute("aria-invalid", "false");
    document.l10n.setAttributes(field, "whimsy-hex-input");
    well.after(field);
    document.l10n.setAttributes(well, "whimsy-hex-well");
    this.field = field;

    const copy = document.createXULElement("toolbarbutton");
    copy.id = COPY_ID;
    copy.className = "subviewbutton";
    document.l10n.setAttributes(copy, "whimsy-hex-copy");
    field.after(copy);
    this.copyButton = copy;

    // Announces copies to VoiceOver; visually hidden.
    const status = document.createElementNS(HTML_NS, "span");
    status.id = STATUS_ID;
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    copy.after(status);
    this.status = status;

    if (this.add) {
      document.l10n.setAttributes(this.add, "whimsy-hex-add");
    }
  }

  init() {
    if (!this.well || this.document.getElementById(FIELD_ID)) {
      return;
    }
    this.build();
    const { win, field, well } = this;
    field.addEventListener("input", () => this.onInput());
    field.addEventListener("paste", e => this.onPaste(e));
    field.addEventListener("keydown", e => this.onFieldKey(e));
    field.addEventListener("blur", () => this.onBlur());
    // Esc has to beat the popup manager, which closes the panel from a
    // capturing listener on the document.
    win.addEventListener("keydown", e => this.onWindowKey(e), true);

    well.addEventListener("click", () => featureOn() && (this.picking = true));
    well.addEventListener("input", () => this.onWell());
    well.addEventListener("change", () => {
      this.onWell();
      this.picking = false;
    });
    // On the button itself, so it runs before Zen's panel-level command
    // handler and can stop it adding the well's color a second time.
    this.add?.addEventListener("command", e => this.onAdd(e));
    this.copyButton.addEventListener("command", () => this.copy());

    if (this.list) {
      this.list.addEventListener("click", e => this.onListClick(e));
      this.list.addEventListener("keydown", e => this.onListKey(e));
      // Zen rebuilds the list on every theme update; label each rebuild.
      const observer = new win.MutationObserver(() => this.decorate());
      observer.observe(this.list, { childList: true });
      win.addEventListener("unload", () => observer.disconnect(), { once: true });
    }

    this.panel?.addEventListener("popupshowing", e => {
      if (e.target == this.panel && !this.picking) {
        this.end();
      }
    });
    this.panel?.addEventListener("popuphiding", e => e.target == this.panel && this.flush());
    // The system color panel can take focus from the popup; a pick in
    // progress keeps its color live across that.
    this.panel?.addEventListener("popuphidden", e => {
      if (e.target == this.panel && !this.picking) {
        this.end();
      }
    });

    const update = () => {
      const on = featureOn();
      field.hidden = !on;
      this.copyButton.hidden = !on;
      if (!on) {
        this.end();
      }
      this.decorate();
    };
    Services.prefs.addObserver(FEATURE_PREF, update);
    win.addEventListener("unload", () => Services.prefs.removeObserver(FEATURE_PREF, update), { once: true });
    update();
  }

  // --- Field ---

  setInvalid(invalid) {
    this.field.toggleAttribute("invalid", invalid);
    this.field.setAttribute("aria-invalid", String(invalid));
  }

  onInput() {
    if (!featureOn()) {
      return;
    }
    const text = this.field.value.trim();
    const parsed = parseHex(text);
    this.cancelShort();
    if (!parsed) {
      // Only flag what can't become a color; "#5B8C" is just unfinished.
      this.setInvalid(!!text && !couldBeHex(text));
      return;
    }
    this.setInvalid(false);
    this.well.value = parsed.rgb;
    const digits = text.replace(/^#/, "").length;
    if (digits >= 6) {
      this.schedule(parsed.hex);
    } else {
      this.shortTimer = this.win.setTimeout(() => {
        this.shortTimer = 0;
        this.schedule(parsed.hex);
      }, SHORT_DELAY_MS);
    }
  }

  onPaste(event) {
    if (!featureOn()) {
      return;
    }
    const text = event.clipboardData?.getData("text/plain") ?? "";
    const parsed = extractHex(text);
    if (!parsed) {
      return; // Pasted as is; onInput flags it.
    }
    event.preventDefault();
    this.field.value = display(parsed.hex);
    this.onInput();
    this.flushShort();
  }

  onFieldKey(event) {
    if (!featureOn()) {
      return;
    }
    if (event.key == "Enter") {
      event.preventDefault();
      event.stopPropagation();
      this.flushShort();
      const text = this.field.value.trim();
      if (text && !parseHex(text)) {
        this.setInvalid(true);
        return;
      }
      this.commit();
    } else if (event.key.toLowerCase() == "c" && event.getModifierState("Accel") && !event.shiftKey) {
      // Cmd+C with nothing selected copies the whole hex.
      if (this.field.selectionStart == this.field.selectionEnd) {
        event.preventDefault();
        this.copy();
      }
    }
  }

  onWindowKey(event) {
    if (event.key != "Escape" || event.target != this.field || !featureOn()) {
      return;
    }
    if (!this.session && !this.field.value) {
      return; // Nothing to undo: Esc closes the picker as usual.
    }
    event.preventDefault();
    event.stopPropagation();
    this.revert();
  }

  onBlur() {
    if (!featureOn()) {
      return;
    }
    this.flushShort();
    const text = this.field.value.trim();
    if (text && !parseHex(text)) {
      // Never leave a bad value showing over a good color.
      this.field.value = this.session ? display(this.session.current) : "";
      this.setInvalid(false);
    }
  }

  // --- Well, + and copy ---

  onWell() {
    if (!featureOn()) {
      return;
    }
    const parsed = parseHex(this.well.value);
    if (!parsed) {
      return;
    }
    // The well has no alpha; keep the live color's.
    const alpha = this.session?.current.length == 9 ? this.session.current.slice(7) : "";
    const hex = parsed.rgb + alpha;
    this.cancelShort();
    this.field.value = display(hex);
    this.setInvalid(false);
    this.schedule(hex);
  }

  onAdd(event) {
    if (!featureOn()) {
      return;
    }
    event.stopPropagation();
    this.flushShort();
    const parsed = parseHex(this.field.value);
    if (!this.session && parsed) {
      this.apply(parsed.hex);
    }
    this.commit();
    this.field.focus();
  }

  copy() {
    const hex = this.session?.current ?? parseHex(this.field.value)?.hex ?? parseHex(this.well.value)?.hex;
    if (!hex) {
      return;
    }
    const text = display(hex);
    Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper).copyString(text);
    this.copyButton.setAttribute("copied", "true");
    this.document.l10n.setAttributes(this.status, "whimsy-hex-copied", { hex: text });
    this.win.clearTimeout(this.copiedTimer);
    this.copiedTimer = this.win.setTimeout(() => this.copyButton.removeAttribute("copied"), COPIED_MS);
  }

  // --- The custom color list ---

  items() {
    return this.list ? [...this.list.querySelectorAll(ITEM)] : [];
  }

  onListClick(event) {
    if (!featureOn() || event.target.closest(".zen-theme-picker-custom-list-item-remove")) {
      return;
    }
    const item = event.target.closest(ITEM);
    if (item) {
      this.edit(item);
    }
  }

  onListKey(event) {
    if (!featureOn() || (event.key != "Enter" && event.key != " ")) {
      return;
    }
    const item = event.target.closest(ITEM);
    if (item && event.target.classList.contains("zen-theme-picker-dot")) {
      event.preventDefault();
      this.edit(item);
    }
  }

  // Start editing a color already in the list.
  edit(item) {
    const picker = this.picker;
    const color = item.getAttribute("data-color");
    if (!picker || !color) {
      return;
    }
    this.flush();
    this.session = {
      uuid: picker.workspaceBeingEdited?.uuid,
      index: this.items().indexOf(item),
      original: color,
      current: color,
    };
    const parsed = parseHex(color);
    this.field.value = parsed ? display(parsed.hex) : color;
    if (parsed) {
      this.well.value = parsed.rgb;
    }
    this.setInvalid(false);
    this.decorate();
    this.field.focus();
    this.field.select();
  }

  // Labels, focusability and the "editing" mark, after each rebuild.
  decorate() {
    const on = featureOn();
    const items = this.items();
    const live = this.liveItem(items);
    for (const item of items) {
      const color = item.getAttribute("data-color") ?? "";
      const dot = item.querySelector(".zen-theme-picker-dot");
      item.toggleAttribute("whimsy-editing", on && item == live);
      if (dot && on) {
        dot.setAttribute("role", "button");
        dot.setAttribute("tabindex", "0");
        this.document.l10n.setAttributes(dot, "whimsy-hex-edit-color", { hex: display(color) });
      }
      const remove = item.querySelector(".zen-theme-picker-custom-list-item-remove");
      if (remove && on) {
        this.document.l10n.setAttributes(remove, "whimsy-hex-remove-color", { hex: display(color) });
      }
    }
  }

  // The list item holding the live color, if it's still there.
  liveItem(items = this.items()) {
    const s = this.session;
    if (!s || s.uuid != this.picker?.workspaceBeingEdited?.uuid) {
      return null;
    }
    const at = items[s.index];
    if (at?.getAttribute("data-color") == s.current) {
      return at;
    }
    // Something else moved the list (a removal): find the color itself.
    const found = items.find(item => item.getAttribute("data-color") == s.current);
    if (found) {
      s.index = items.indexOf(found);
    }
    return found ?? null;
  }

  // --- Applying ---

  // Coalesce to one theme update a frame (the system panel streams input).
  schedule(hex) {
    this.pending = hex;
    if (!this.frame) {
      this.frame = this.win.requestAnimationFrame(() => {
        this.frame = 0;
        this.flush();
      });
    }
  }

  flush() {
    if (this.frame) {
      this.win.cancelAnimationFrame(this.frame);
      this.frame = 0;
    }
    const hex = this.pending;
    this.pending = null;
    if (hex) {
      this.apply(hex);
    }
  }

  flushShort() {
    if (this.shortTimer) {
      this.cancelShort();
      const parsed = parseHex(this.field.value);
      if (parsed) {
        this.schedule(parsed.hex);
      }
    }
    this.flush();
  }

  cancelShort() {
    if (this.shortTimer) {
      this.win.clearTimeout(this.shortTimer);
      this.shortTimer = 0;
    }
  }

  // Put hex into the theme: change the live color, or add a new one.
  apply(hex) {
    const picker = this.picker;
    if (!picker) {
      return;
    }
    const item = this.liveItem();
    if (item) {
      if (this.session.current == hex) {
        return;
      }
      this.setItemColor(item, hex);
      this.session.current = hex;
      picker.updateCurrentWorkspace();
      return;
    }
    // Zen's own add: it reads the well (and the opacity spinner, which it
    // can only round), prepends the color and repaints. Alpha is set on the
    // new item afterwards so it's exact.
    const parsed = parseHex(hex);
    this.well.value = parsed.rgb;
    if (this.opacity) {
      this.opacity.value = 1;
    }
    picker.addCustomColor();
    // Zen empties the well after adding (it shows black); show the color.
    this.well.value = parsed.rgb;
    let items = this.items();
    let index = items.findIndex(i => i.getAttribute("data-color") == parsed.rgb);
    if (index < 0) {
      return;
    }
    if (hex != parsed.rgb) {
      this.setItemColor(items[index], hex);
      picker.updateCurrentWorkspace();
      items = this.items();
      index = items.findIndex(i => i.getAttribute("data-color") == hex);
    }
    this.session = {
      uuid: picker.workspaceBeingEdited?.uuid,
      index,
      original: null,
      current: hex,
    };
    this.decorate();
  }

  setItemColor(item, hex) {
    item.setAttribute("data-color", hex);
    item.querySelector(".zen-theme-picker-dot")?.style.setProperty(DOT_VAR, hex);
  }

  // Keep the live color and empty the field for the next one.
  commit() {
    this.flush();
    this.end();
  }

  // Esc: put the list back the way it was before this color.
  revert() {
    this.cancelShort();
    if (this.frame) {
      this.win.cancelAnimationFrame(this.frame);
      this.frame = 0;
    }
    this.pending = null;
    const picker = this.picker;
    const item = this.liveItem();
    if (picker && item) {
      if (this.session.original === null) {
        item.querySelector(".zen-theme-picker-dot")?.remove();
        item.remove();
      } else {
        this.setItemColor(item, this.session.original);
      }
      picker.updateCurrentWorkspace();
    }
    this.end();
  }

  end() {
    this.cancelShort();
    this.session = null;
    if (this.field) {
      this.field.value = "";
      this.setInvalid(false);
    }
    this.decorate();
  }
}

const pickers = new WeakMap();

export const WhimsyHexPicker = {
  initWindow(win) {
    if (pickers.has(win)) {
      return;
    }
    const picker = new HexPicker(win);
    picker.init();
    if (picker.field) {
      pickers.set(win, picker);
    }
  },

  // Tests: the window's picker.
  forWindow(win) {
    return pickers.get(win) ?? null;
  },
};
