/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Content side of Form Protection. W13-R1 rewrite, then R1 v2 (save instead
// of ask): the design (what counts as unsaved input, what clears it, the
// draft messages and their filtering) is whimsy-handoff/wave13/r1-forms-design.md
// and whimsy-handoff/wave13/r1-v2-design.md.
//
// A document has unsaved input when a field the person edited themselves
// differs from what it held before they started. Only trusted edits made
// with user activation track a field; script-set values, hidden, search,
// password and autofilled fields never do. A submit, a save the
// parent attributes to this document (Whimsy:FormSaved), returning to the
// starting value, or the field leaving the page clears it. The parent hears
// one boolean per document, only when it changes.
//
// Drafts (R1 v2 §2, §5): while the top document is typed, the child sends
// Whimsy:FormDraft { url, data } debounced 400ms, filtered so a password,
// hidden field, card number, one-time code or autocomplete=off secret-
// looking field never crosses IPC. beforeunload and pagehide flush a
// pending send at once. Clearing (a save, a submit, back to the start)
// sends { url, data: null }, once.
//
// Refill (W10-25, F08, kept by R1 v2): when the same address loads again,
// it asks the parent for the draft (Whimsy:FormSnapshotFor), counts the
// empty fields it could fill, and the parent offers a toast. Only Refill
// fills.

const HIGHLIGHT_MS = 2000;
const FADE_MS = 400;
const EDITABLE_CHECK_MS = 250;
// R1 v2 (wave13/r1-v2-design.md §2): how long after a trusted edit the
// child sends the parent a draft of the typed answers.
const DRAFT_DEBOUNCE_MS = 400;

// WebSocket frames that carry data (a save), not keep-alive control frames.
const WS_DATA_OPCODES = new Set([
  Ci.nsIWebSocketFrame.OPCODE_CONTINUATION,
  Ci.nsIWebSocketFrame.OPCODE_TEXT,
  Ci.nsIWebSocketFrame.OPCODE_BINARY,
]);

const SKIPPED_INPUT_TYPES = new Set([
  "hidden",
  "password",
  "file",
  "submit",
  "reset",
  "button",
  "image",
  "range",
  "color",
  "search",
]);
const SEARCH_WORDS = /(^|[\s_\-[\]])(search|query|filter)($|[\s_\-[\]])|^q$|^s$/i;

function addressOf(location) {
  try {
    const url = new URL(location.href);
    url.hash = "";
    return url.href;
  } catch (e) {
    return "";
  }
}

// R1 v2 §5: fields that look like they hold a PIN, a security code and
// the like, when the page itself turned autocomplete off for them.
const SECRET_WORDS = /\b(pin|cvv|cvc|csc|otp|code|passcode|ssn|security)\b/i;

function looksSecretByName(el) {
  for (const attr of ["name", "id"]) {
    if (SECRET_WORDS.test(el.getAttribute?.(attr) ?? "")) {
      return true;
    }
  }
  const label = el.labels?.[0]?.textContent ?? el.getAttribute?.("aria-label") ?? el.placeholder ?? "";
  return SECRET_WORDS.test(label);
}

// Never tracked, refilled or stored in a draft, whatever a snapshot says
// (design §5).
export function isSecret(el) {
  if (el.localName == "input" && (el.type == "password" || el.type == "hidden" || el.type == "file")) {
    return true;
  }
  const autocomplete = (el.getAttribute?.("autocomplete") ?? "").toLowerCase();
  if (/\bcc-|one-time-code|current-password|new-password/.test(autocomplete)) {
    return true;
  }
  if (autocomplete == "off" && looksSecretByName(el)) {
    return true;
  }
  const form = el.form ?? el.closest?.("form");
  return !!form && (form.getAttribute("autocomplete") ?? "").toLowerCase() == "off" && looksSecretByName(el);
}

function isSearch(el) {
  if (el.closest?.("[role=search], search")) {
    return true;
  }
  const form = el.form ?? el.closest?.("form");
  if (form && /search/i.test(form.getAttribute("action") ?? "")) {
    return true;
  }
  if ((el.getAttribute("role") ?? "") == "searchbox") {
    return true;
  }
  if (el.getAttribute("inputmode") == "search" || el.getAttribute("enterkeyhint") == "search") {
    return true;
  }
  for (const attr of ["name", "id", "aria-label", "placeholder", "title"]) {
    const value = el.getAttribute(attr);
    if (value && SEARCH_WORDS.test(value.trim())) {
      return true;
    }
  }
  return false;
}

// The editing host of a contenteditable region (the body in designMode).
function editingHost(node) {
  let el = node?.nodeType == 1 ? node : node?.parentElement;
  if (!el?.isContentEditable) {
    return null;
  }
  while (el.parentElement?.isContentEditable) {
    el = el.parentElement;
  }
  return el;
}

/**
 * What kind of answer field `node` is ("text", "check", "radio", "select",
 * "editable"), with the element to track; null when it never counts.
 */
export function answerField(node) {
  const el = node?.nodeType == 1 ? node : node?.parentElement;
  if (!el) {
    return null;
  }
  let kind = null;
  let field = el;
  if (el.localName == "textarea") {
    kind = "text";
  } else if (el.localName == "select") {
    kind = "select";
  } else if (el.localName == "input") {
    if (SKIPPED_INPUT_TYPES.has(el.type)) {
      return null;
    }
    kind = el.type == "checkbox" ? "check" : el.type == "radio" ? "radio" : "text";
  } else {
    field = editingHost(el);
    kind = field ? "editable" : null;
  }
  if (!kind || field.disabled || field.readOnly || isSecret(field) || isSearch(field)) {
    return null;
  }
  return { kind, field };
}

function currentValue(el, kind) {
  switch (kind) {
    case "check":
    case "radio":
      return el.checked;
    case "select":
      return [...el.options].filter(o => o.selected).map(o => o.index).join(",");
    case "editable":
      return el.textContent;
    default:
      return el.value;
  }
}

function defaultValue(el, kind) {
  switch (kind) {
    case "check":
    case "radio":
      return el.defaultChecked;
    case "select": {
      const picked = [...el.options].filter(o => o.defaultSelected).map(o => o.index);
      if (!picked.length && !el.multiple && el.options.length) {
        return "0";
      }
      return picked.join(",");
    }
    case "editable":
      return el.textContent;
    default:
      return el.defaultValue;
  }
}

function socketEvents() {
  return Cc["@mozilla.org/websocketevent/service;1"].getService(Ci.nsIWebSocketEventService);
}

// Session store's form paths name elements as xhtml:… and xul:… (XPathGenerator).
const XPATH_NAMESPACES = {
  xhtml: "http://www.w3.org/1999/xhtml",
  xul: "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul",
};
function sessionStoreNamespace(prefix) {
  return XPATH_NAMESPACES[prefix] ?? null;
}

// W16-5: a path _targets can resolve (session store's xhtml: form), for a
// field with no unique id.
function xpathOf(el) {
  const steps = [];
  for (let node = el; node && node.nodeType == 1; node = node.parentElement) {
    let index = 1;
    for (let sib = node.previousElementSibling; sib; sib = sib.previousElementSibling) {
      if (sib.localName == node.localName) {
        index++;
      }
    }
    steps.unshift(`xhtml:${node.localName}[${index}]`);
  }
  return "/" + steps.join("/");
}

// W16-5: a tracked field's value in session store's format.
function draftValue(el, kind) {
  switch (kind) {
    case "check":
      return el.checked;
    case "select":
      return { selectedIndex: el.selectedIndex, value: el.value };
    case "text":
      return el.value;
  }
  return undefined;
}

// Drops every id/xpath entry that resolves to a secret or search field
// (design §5), before anything crosses IPC.
function filterCollected(doc, data) {
  const out = { id: {}, xpath: {} };
  for (const [key, value] of Object.entries(data.id ?? {})) {
    let el;
    try {
      el = doc.getElementById(key);
    } catch (e) {}
    if (el && !isSecret(el) && !isSearch(el)) {
      out.id[key] = value;
    }
  }
  for (const [key, value] of Object.entries(data.xpath ?? {})) {
    let el;
    try {
      el = doc.evaluate(key, doc, sessionStoreNamespace, 9 /* FIRST_ORDERED_NODE_TYPE */, null).singleNodeValue;
    } catch (e) {}
    if (el && !isSecret(el) && !isSearch(el)) {
      out.xpath[key] = value;
    }
  }
  return out;
}

export class WhimsyFormProtectionChild extends JSWindowActorChild {
  // The snapshot offered for this document, and what Fill In filled.
  _offer = null;
  // element -> { kind, baseline }: fields the person edited themselves.
  _tracked = new Map();
  // What the parent was last told.
  _reported = false;
  _editableTimer = null;
  // { innerWindowId, listener } while listening for WebSocket saves.
  _socketListener = null;
  // R1 v2 (design §2): the debounced Whimsy:FormDraft send, top document
  // only. _draftSent tracks whether the parent currently holds a draft from
  // this document, so clearing it sends exactly one "data: null".
  _draftTimer = null;
  _draftPending = false;
  _draftSent = false;

  // A real edit: trusted, and with user activation (a page's own trusted
  // edits, such as execCommand while it loads, have none).
  _userMade(event, kind) {
    if (!event.isTrusted) {
      return false;
    }
    const doc = this.document;
    if (kind == "text" || kind == "editable") {
      return !!doc?.hasValidTransientUserGestureActivation;
    }
    return !!doc?.hasBeenUserGestureActivated;
  }

  handleEvent(event) {
    switch (event.type) {
      case "beforeinput":
        this._onBeforeInput(event);
        break;
      case "input":
      case "change":
        this._onEdit(event);
        break;
      case "submit":
        this._onSubmit(event);
        break;
      case "pageshow":
        this._report();
        if (!event.persisted) {
          this.offerRefill();
        }
        break;
      case "beforeunload":
      case "pagehide":
        // The last keystrokes may still be inside the debounce window; a
        // page going away (closing or navigating) flushes it at once.
        this._flushDraft();
        break;
    }
  }

  // The value just before the person's first edit is the baseline (a
  // draft the site restored by script is "saved", not "").
  _onBeforeInput(event) {
    const found = answerField(event.composedTarget ?? event.target);
    if (!found || this._tracked.has(found.field) || !this._userMade(event, found.kind)) {
      return;
    }
    if (found.field.matches?.(":autofill")) {
      return;
    }
    this._tracked.set(found.field, { kind: found.kind, baseline: currentValue(found.field, found.kind) });
  }

  _onEdit(event) {
    const found = answerField(event.composedTarget ?? event.target);
    if (!found || !this._userMade(event, found.kind)) {
      return;
    }
    const { field, kind } = found;
    if (field.matches?.(":autofill")) {
      return;
    }
    if (!this._tracked.has(field)) {
      // No beforeinput came (select, checkbox, radio, some pickers).
      const baseline = kind == "check" ? !field.checked : defaultValue(field, kind);
      this._tracked.set(field, { kind, baseline });
    }
    // From the first edit on, a save over a socket counts (it may leave
    // before the next report).
    this._watchSocketSaves(true);
    if (kind == "editable") {
      // The first edit is reported at once, so a save that follows it is
      // never missed; after that, textContent of a big editor on every
      // keystroke is wasteful.
      if (!this._reported) {
        this._report();
        return;
      }
      if (!this._editableTimer) {
        this._editableTimer = this.contentWindow.setTimeout(() => {
          this._editableTimer = null;
          this._report();
        }, EDITABLE_CHECK_MS);
      }
      return;
    }
    this._report();
  }

  // A submit that went ahead saved every tracked field in that form. One
  // the page prevented is left to the network rule (it may still fail).
  _onSubmit(event) {
    const form = event.target;
    if (event.defaultPrevented || form?.localName != "form") {
      return;
    }
    this._markSaved(el => el.form == form || form.contains(el));
  }

  _markSaved(which = () => true) {
    for (const [el, entry] of this._tracked) {
      if (which(el)) {
        entry.baseline = currentValue(el, entry.kind);
      }
    }
    this._report({ saved: true });
  }

  _isRadioDirty(el) {
    // A radio group is one answer: dirty if any tracked radio of the group
    // differs from where it started.
    const name = el.name;
    if (!name) {
      return el.checked != this._tracked.get(el).baseline;
    }
    for (const [other, entry] of this._tracked) {
      if (entry.kind == "radio" && other.name == name && other.form == el.form && other.checked != entry.baseline) {
        return true;
      }
    }
    return false;
  }

  /** Whether this document has unsaved input now (drops fields that left). */
  hasUnsavedInput() {
    let dirty = false;
    for (const [el, entry] of this._tracked) {
      if (!el.isConnected) {
        this._tracked.delete(el);
        continue;
      }
      if (dirty) {
        continue;
      }
      if (entry.kind == "radio") {
        dirty = this._isRadioDirty(el);
      } else if (entry.kind == "text") {
        const value = currentValue(el, entry.kind);
        dirty = value != entry.baseline && value.trim() != String(entry.baseline).trim();
      } else {
        dirty = currentValue(el, entry.kind) != entry.baseline;
      }
    }
    return dirty;
  }

  _report({ saved = false } = {}) {
    try {
      const dirty = this.hasUnsavedInput();
      this._watchSocketSaves(dirty);
      // R1 v2 §2: the draft tracks the document's dirty state continuously,
      // independent of whether the parent's own report changed.
      if (dirty) {
        this._scheduleDraftSend();
      } else {
        this._clearDraft();
      }
      if (dirty == this._reported && !saved) {
        return;
      }
      this._reported = dirty;
      this.sendAsyncMessage("Whimsy:FormState", { dirty, saved });
    } catch (e) {
      // Content may be in transition or detached.
    }
  }

  _isTopDocument() {
    const win = this.contentWindow;
    return !!win && win.top == win;
  }

  // Frames are out of scope for drafts (design §4): only the top document's
  // typing is ever sent.
  _scheduleDraftSend() {
    if (!this._isTopDocument()) {
      return;
    }
    this._draftPending = true;
    const win = this.contentWindow;
    win.clearTimeout(this._draftTimer);
    this._draftTimer = win.setTimeout(() => this._flushDraft(), DRAFT_DEBOUNCE_MS);
  }

  _flushDraft() {
    const win = this.contentWindow;
    win?.clearTimeout(this._draftTimer);
    this._draftTimer = null;
    if (!this._draftPending || !this._isTopDocument()) {
      return;
    }
    this._draftPending = false;
    const draft = this._collectDraft();
    if (!draft) {
      this._clearDraft();
      return;
    }
    this._draftSent = true;
    try {
      this.sendAsyncMessage("Whimsy:FormDraft", draft);
    } catch (e) {
      // The tab is going away.
    }
  }

  // Tells the parent to delete whatever draft it holds for this document
  // (a save, a submit, back to the start): sent once, not on every clean
  // report.
  _clearDraft() {
    const win = this.contentWindow;
    win?.clearTimeout(this._draftTimer);
    this._draftTimer = null;
    this._draftPending = false;
    if (!this._draftSent || !this._isTopDocument()) {
      this._draftSent = false;
      return;
    }
    this._draftSent = false;
    try {
      this.sendAsyncMessage("Whimsy:FormDraft", { url: addressOf(win.location), data: null });
    } catch (e) {
      // The tab is going away.
    }
  }

  // The top document's typed answers, filtered (design §5). Null when
  // there's nothing safe to keep.
  _collectDraft() {
    const win = this.contentWindow;
    try {
      const data = SessionStoreUtils.collectFormData(win) ?? {};
      const filtered = filterCollected(this.document, { id: data.id ?? {}, xpath: data.xpath ?? {} });
      this._addDirtyFields(filtered);
      if (!Object.keys(filtered.id).length && !Object.keys(filtered.xpath).length) {
        return null;
      }
      return { url: addressOf(win.location), data: filtered };
    } catch (e) {
      // A page going away can't always be read.
      return null;
    }
  }

  // W16-5: Gecko's collector skips a text field whose value attribute
  // equals its value (a speed rule), and frameworks that keep a
  // controlled field's attribute in step with what's typed (React) make
  // every typed field look like that. The fields the person edited and
  // that still differ from their baseline go in too, by id or by path.
  _addDirtyFields(filtered) {
    const doc = this.document;
    const covered = new Set(this._targets(filtered).map(([el]) => el));
    for (const [el, entry] of this._tracked) {
      if (!el.isConnected || covered.has(el) || !["text", "check", "select"].includes(entry.kind)) {
        continue;
      }
      if (el.ownerDocument != doc || isSecret(el) || isSearch(el)) {
        continue;
      }
      const value = currentValue(el, entry.kind);
      if (value == entry.baseline || (entry.kind == "text" && !String(value).trim())) {
        continue;
      }
      const id = el.id;
      if (id && doc.getElementById(id) == el) {
        filtered.id[id] = draftValue(el, entry.kind);
      } else {
        filtered.xpath[xpathOf(el)] = draftValue(el, entry.kind);
      }
    }
  }

  // A save over a WebSocket (editors that sync over a socket): while this
  // document has unsaved input, a data frame it sends is a save, the same
  // rule as the parent's for fetch/XHR/beacon (design §2). Listening only
  // while dirty; DevTools uses the same service in the content process.
  _watchSocketSaves(on) {
    let innerWindowId = 0;
    try {
      innerWindowId = this.manager?.innerWindowId ?? 0;
    } catch (e) {}
    if (on && !this._socketListener && innerWindowId) {
      const listener = {
        QueryInterface: ChromeUtils.generateQI(["nsIWebSocketEventListener"]),
        webSocketCreated() {},
        webSocketOpened() {},
        webSocketMessageAvailable() {},
        webSocketClosed() {},
        frameReceived() {},
        frameSent: (serial, channelId, frame) => {
          if (WS_DATA_OPCODES.has(frame.opCode) && this._tracked.size) {
            this._markSaved();
          }
        },
      };
      try {
        socketEvents().addListener(innerWindowId, listener);
        this._socketListener = { innerWindowId, listener };
      } catch (e) {
        this._socketListener = null;
      }
    } else if (!on && this._socketListener) {
      const { innerWindowId: id, listener } = this._socketListener;
      this._socketListener = null;
      try {
        socketEvents().removeListener(id, listener);
      } catch (e) {
        // The window is already gone.
      }
    }
  }

  didDestroy() {
    this._watchSocketSaves(false);
  }

  receiveMessage(message) {
    switch (message.name) {
      case "Whimsy:FormIsDirty": {
        const dirty = this.hasUnsavedInput();
        if (dirty != this._reported) {
          this._report();
        }
        return dirty;
      }
      case "Whimsy:FormSaved":
        // The parent saw this page send a request after the last edit
        // (an autosave or a save button's fetch).
        if (this._tracked.size) {
          this._markSaved();
        }
        return null;
      case "Whimsy:FormRefill":
        return this.refill();
    }
    return null;
  }

  // The elements a snapshot names, with the values for them.
  _targets(data) {
    const doc = this.document;
    const targets = [];
    for (const [key, value] of Object.entries(data?.id ?? {})) {
      const el = doc.getElementById(key);
      if (el) {
        targets.push([el, value]);
      }
    }
    for (const [xpath, value] of Object.entries(data?.xpath ?? {})) {
      try {
        const el = doc.evaluate(xpath, doc, sessionStoreNamespace, 9 /* FIRST_ORDERED_NODE_TYPE */, null).singleNodeValue;
        if (el) {
          targets.push([el, value]);
        }
      } catch (e) {
        // Not a valid path in this document.
      }
    }
    return targets;
  }

  // Whether `el` is empty enough to take `value` (never overwriting what's
  // there now).
  _fillable(el, value) {
    if (isSecret(el) || el.disabled || el.readOnly) {
      return false;
    }
    if (el.localName == "input" && (el.type == "checkbox" || el.type == "radio")) {
      return typeof value == "boolean" && value && el.checked == el.defaultChecked && !el.checked;
    }
    if (el.localName == "select") {
      // With no option marked selected, a single select starts on its first.
      let initial = [...el.options].findIndex(o => o.defaultSelected);
      if (initial < 0 && !el.multiple && el.options.length) {
        initial = 0;
      }
      return typeof value == "object" && value != null && el.selectedIndex == initial;
    }
    if (el.localName == "textarea" || el.localName == "input") {
      return typeof value == "string" && value.length > 0 && !el.value;
    }
    return false;
  }

  async offerRefill() {
    try {
      const win = this.contentWindow;
      if (!win || win.top != win) {
        return;
      }
      const url = addressOf(win.location);
      const snapshot = await this.sendQuery("Whimsy:FormSnapshotFor", { url });
      if (!snapshot?.data) {
        return;
      }
      const countNow = () => this._targets(snapshot.data).filter(([el, value]) => this._fillable(el, value)).length;
      const offer = count => {
        this._offer = { url, data: snapshot.data };
        this.sendAsyncMessage("Whimsy:FormRefillReady", { url, count });
      };
      const count = countNow();
      if (count) {
        offer(count);
        return;
      }
      // F08: most sites build their form after the page has loaded. Wait
      // for the fields to appear, a while.
      const doc = this.document;
      let timer = null;
      const observer = new win.MutationObserver(() => {
        if (timer) {
          return;
        }
        timer = win.setTimeout(() => {
          timer = null;
          const found = countNow();
          if (found) {
            observer.disconnect();
            offer(found);
          }
        }, 200);
      });
      observer.observe(doc.documentElement, { childList: true, subtree: true });
      win.setTimeout(() => observer.disconnect(), 15000);
    } catch (e) {
      // The page went away first.
    }
  }

  // Fill In: only the fields that are still empty; each lights up briefly.
  // What it fills is unsaved again, so it's tracked from the empty value.
  refill() {
    const offer = this._offer;
    this._offer = null;
    if (!offer || addressOf(this.contentWindow.location) != offer.url) {
      return { filled: 0 };
    }
    const filled = [];
    for (const [el, value] of this._targets(offer.data)) {
      if (!this._fillable(el, value)) {
        continue;
      }
      const found = answerField(el);
      if (found && !this._tracked.has(found.field)) {
        this._tracked.set(found.field, { kind: found.kind, baseline: currentValue(found.field, found.kind) });
      }
      if (el.localName == "select") {
        const index = typeof value.selectedIndex == "number" ? value.selectedIndex : -1;
        const byValue = [...el.options].findIndex(o => o.value == value.value);
        el.selectedIndex = byValue >= 0 ? byValue : index;
      } else if (el.type == "checkbox" || el.type == "radio") {
        el.checked = true;
      } else {
        el.value = value;
      }
      // W16-5: an input event as typing makes it, so framework-controlled
      // fields (React) take the value too. (Setting value through this
      // chrome-side wrapper uses the native setter, so the page's own
      // value tracking sees a change.)
      const win = this.contentWindow;
      const text = typeof value == "string";
      el.dispatchEvent(text
        ? new win.InputEvent("input", { bubbles: true, composed: true, inputType: "insertReplacementText", data: value })
        : new win.Event("input", { bubbles: true, composed: true }));
      el.dispatchEvent(new win.Event("change", { bubbles: true }));
      filled.push(el);
    }
    this.highlight(filled);
    this._report();
    return { filled: filled.length };
  }

  // A 2s outline on each filled field, fading out (none with reduced
  // motion). Inline styles: a page can't load chrome:// sheets.
  highlight(elements) {
    const win = this.contentWindow;
    const reduce = win.matchMedia("(prefers-reduced-motion: reduce)").matches;
    for (const el of elements) {
      const old = { outline: el.style.outline, background: el.style.backgroundColor, transition: el.style.transition };
      el.style.outline = "2px solid color-mix(in srgb, AccentColor 70%, transparent)";
      el.style.backgroundColor = "color-mix(in srgb, AccentColor 8%, transparent)";
      win.setTimeout(() => {
        if (!reduce) {
          el.style.transition = `outline-color ${FADE_MS}ms ease-out, background-color ${FADE_MS}ms ease-out`;
        }
        el.style.outline = old.outline;
        el.style.backgroundColor = old.background;
        win.setTimeout(() => (el.style.transition = old.transition), reduce ? 0 : FADE_MS);
      }, HIGHLIGHT_MS);
    }
  }
}
