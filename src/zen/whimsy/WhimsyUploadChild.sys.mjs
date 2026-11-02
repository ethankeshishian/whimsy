/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Upload from the clipboard (Opera's Easy Files): the child half.
//
// - A trusted click on <input type=file> asks the parent for its small popup
//   (the clipboard image, the newest downloads, "Choose file...") before the
//   native picker opens (batch7).
// - Paste to upload (W13-R2, wave13/r2-paste-design.md): Cmd+V (Ctrl+V
//   elsewhere) on an upload target puts the clipboard's copied file or image
//   in it, exactly once. Whimsy never takes the keystroke: the browser's own
//   paste reaches the page first, and Whimsy delivers only if the page
//   didn't take it (defaultPrevented, or a file arrived at the target).
//   Delivery uses the target's own entry point: its file input's change,
//   Dropzone.js's addFile, or a drop.
// - The "⌘V Paste" badges (option D): the parent draws them above the page;
//   this side lists the on-screen targets (scanTargets) with the same
//   function the paste uses (uploadTargetFor), so a badge can't promise an
//   upload that Cmd+V wouldn't do.
//
// This actor runs with chrome privileges on the page, so it may call the
// ChromeOnly mozSetFileArray.

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import { clearTimeout, setTimeout } from "resource://gre/modules/Timer.sys.mjs";

const FEATURE_PREF = "whimsy.feature.upload-clipboard";
// W13-R2: each paste decision in the Browser Console, for hand checks.
const LOG_PREF = "whimsy.uploadClipboard.log";

// wave7/security L1: a click is remembered for a few seconds (click, then
// Cmd+V), not a minute. W13-R2: cancelling a file picker restarts it (the
// picker is what took those seconds).
const CLICK_MEMORY_MS = 5000;
const WIDGET_DEPTH = 5;
// A page paste listener ran and didn't prevent the paste: how long a file
// has to show up at the target before Whimsy delivers it.
const PAGE_SETTLE_MS = 500;
// No paste event after the key (it never happened in testing, but a page
// can swallow one): Whimsy delivers after this long.
const NO_PASTE_MS = 1000;
// Targets reported to the parent (it badges at most 3 of them).
const MAX_REPORTED = 20;
// While nothing is armed, pointing at a target asks the parent to check the
// clipboard's type, at most this often.
const NEAR_CHECK_MS = 1000;

const ZONE_SELECTOR = ".dropzone, [class*=dropzone i], [class*=drop-zone i], [data-testid*=dropzone i]";
const CANDIDATE_SELECTOR = `input[type=file], ${ZONE_SELECTOR}`;
const EDITABLE_SELECTOR =
  "textarea, [contenteditable]:not([contenteditable=false]), input:not([type]), " +
  "input[type=text], input[type=search], input[type=email], input[type=url], " +
  "input[type=tel], input[type=password], input[type=number]";
// A zone smaller than this is decoration inside a zone (an icon).
const MIN_ZONE_W = 40;
const MIN_ZONE_H = 24;
const DOCUMENT_POSITION_FOLLOWING = 4;

function log(...args) {
  if (Services.prefs.getBoolPref(LOG_PREF, false)) {
    console.log("Whimsy paste to upload:", ...args);
  }
}

const featureOn = () => Services.prefs.getBoolPref(FEATURE_PREF, true);

const isPasteKey = event =>
  event.key?.toLowerCase() == "v" &&
  (AppConstants.platform == "macosx" ? event.metaKey : event.ctrlKey) &&
  !event.altKey &&
  !event.shiftKey;

// The file input a focused element uploads to: the input itself, or the
// <label> a site styled as its button.
function fileInputFor(element) {
  const input = element?.localName == "label" ? element.control : element;
  return input?.localName == "input" && input.type == "file" && !input.disabled ? input : null;
}

function isEditable(element) {
  if (!element) {
    return false;
  }
  if (element.isContentEditable || element.ownerDocument?.designMode == "on") {
    return true;
  }
  if (element.localName == "textarea") {
    return true;
  }
  return element.localName == "input" && !["file", "button", "submit", "reset", "checkbox", "radio", "image"].includes(element.type);
}

// The focused element, inside open and closed shadow roots.
function deepActive(doc) {
  let element = doc?.activeElement ?? null;
  while (element?.openOrClosedShadowRoot?.activeElement) {
    element = element.openOrClosedShadowRoot.activeElement;
  }
  return element;
}

// The single enabled file input in `root`, if there's exactly one.
function onlyFileInput(root) {
  const inputs = [...root.querySelectorAll("input[type=file]")].filter(i => !i.disabled);
  return inputs.length == 1 ? inputs[0] : null;
}

// The page's Dropzone.js instance on `element` (Dropzone sets
// element.dropzone), seen through the waiver, or null.
function dropzoneOf(element) {
  try {
    return element?.wrappedJSObject?.dropzone ?? null;
  } catch (e) {
    return null;
  }
}

// How many files a Dropzone instance holds, or null.
function dropzoneCount(dz) {
  try {
    const count = dz?.files?.length;
    return typeof count == "number" ? count : null;
  } catch (e) {
    return null;
  }
}

function rectOf(element) {
  try {
    return element.getBoundingClientRect();
  } catch (e) {
    return null;
  }
}

// Laid out (has a box) and not visibility:hidden.
function isShown(element, minW = 8, minH = 8) {
  const rect = rectOf(element);
  if (!rect || rect.width < minW || rect.height < minH) {
    return false;
  }
  try {
    return element.checkVisibility({ visibilityProperty: true });
  } catch (e) {
    return true;
  }
}

function inView(rect, win) {
  const visibleW = Math.min(rect.right, win.innerWidth) - Math.max(rect.left, 0);
  const visibleH = Math.min(rect.bottom, win.innerHeight) - Math.max(rect.top, 0);
  return visibleW >= 12 && visibleH >= 12;
}

// What Cmd+V on `element` uploads to: { input } or { dropZone }, or null.
// The one rule for what is an upload target: the paste, the badges and the
// command all go through it.
export function uploadTargetFor(element) {
  if (!element || isEditable(element)) {
    return null;
  }
  const direct = fileInputFor(element) ?? fileInputFor(element.closest?.("label"));
  if (direct) {
    return { input: direct };
  }
  const doc = element.ownerDocument;
  for (const id of (element.getAttribute?.("aria-controls") ?? "").split(/\s+/).filter(Boolean)) {
    const input = fileInputFor(doc.getElementById(id));
    if (input) {
      return { input };
    }
  }

  // A drop zone (Dropzone.js, react-dropzone, file-dropzone): its own input
  // first (Dropzone's hiddenFileInput, a child file input, or
  // .dz-hidden-input).
  let zone = element.closest?.(ZONE_SELECTOR);
  // W10-48: a wrapper (dropzone.dev's .dropzone-container) matched before
  // the Dropzone.js element inside it. Prefer the element holding a
  // Dropzone instance.
  if (zone && !dropzoneOf(zone)) {
    const inner = [...zone.querySelectorAll(".dropzone, .dz-clickable")].find(el => dropzoneOf(el));
    if (inner) {
      zone = inner;
    }
  }
  if (zone) {
    const dz = dropzoneOf(zone);
    // W10-48: the page's own input comes back through the waiver without
    // the chrome-only mozSetFileArray: use the privileged (Xray) view.
    let dzHidden = null;
    try {
      dzHidden = dz?.hiddenFileInput ? Cu.unwaiveXrays(dz.hiddenFileInput) : null;
    } catch (e) {
      // Not a DOM node.
    }
    // Dropzone.js keeps its input out of the zone, as body's one
    // .dz-hidden-input; other drop zones never borrow an input from
    // elsewhere on the page.
    const isDropzoneJS = zone.classList?.contains("dropzone") || zone.classList?.contains("dz-clickable");
    const hidden = isDropzoneJS ? zone.ownerDocument.querySelectorAll("input.dz-hidden-input") : [];
    const dzInput = fileInputFor(dzHidden) ?? onlyFileInput(zone) ?? (hidden.length == 1 ? hidden[0] : null);
    if (dzInput && !dzInput.disabled) {
      return { input: dzInput };
    }
    return { dropZone: zone };
  }

  // The nearest enclosing widget with exactly one file input. Stops before
  // <body>/<form> level so an unrelated input elsewhere on the page or form
  // isn't picked.
  let node = element;
  for (let depth = 0; node && depth <= WIDGET_DEPTH; depth++, node = node.parentElement) {
    if (["body", "html", "form"].includes(node.localName)) {
      break;
    }
    const input = onlyFileInput(node);
    if (input) {
      return { input };
    }
    if (node.querySelector("input[type=file]")) {
      return null; // Several inputs: ambiguous.
    }
  }
  return null;
}

// The element a badge marks for a file input: the input when it has a box,
// else its visible label, else the visible element whose aria-controls
// names it, else the nearest visible ancestor that holds only this input
// (react-dropzone's root, a styled upload button's wrapper).
function boxForInput(input) {
  const doc = input.ownerDocument;
  const win = doc.defaultView;
  if (isShown(input, 1, 1)) {
    return input;
  }
  for (const label of input.labels ?? []) {
    if (isShown(label)) {
      return label;
    }
  }
  if (input.id) {
    for (const el of doc.querySelectorAll("[aria-controls]")) {
      if (el.getAttribute("aria-controls").split(/\s+/).includes(input.id) && isShown(el)) {
        return el;
      }
    }
  }
  const maxArea = (win.innerWidth * win.innerHeight) / 2;
  let node = input.parentElement;
  for (let depth = 0; node && depth < WIDGET_DEPTH; depth++, node = node.parentElement) {
    if (["body", "html", "form"].includes(node.localName) || node.querySelectorAll("input[type=file]").length > 1) {
      break;
    }
    if (isShown(node)) {
      const rect = rectOf(node);
      return rect.width * rect.height <= maxArea ? node : null;
    }
  }
  return null;
}

// Every upload target in `doc`, in reading order, as the element a badge
// marks. A box is kept only if uploadTargetFor(box) resolves (the paste's
// own rule) and it holds no text field (that's a composer: its paste is
// the page's).
export function scanTargets(doc) {
  const boxes = [];
  const seen = new Set();
  const add = box => {
    if (!box || boxes.includes(box) || isEditable(box) || box.querySelector?.(EDITABLE_SELECTOR)) {
      return;
    }
    const target = uploadTargetFor(box);
    const key = target?.input ?? target?.dropZone;
    if (!key || seen.has(key)) {
      return;
    }
    seen.add(key);
    boxes.push(box);
  };
  // Drop zones: the innermost one big enough to be the zone itself (a
  // wrapper and an icon inside can share the class).
  const zones = [...doc.querySelectorAll(ZONE_SELECTOR)].filter(zone => isShown(zone, MIN_ZONE_W, MIN_ZONE_H));
  for (const zone of zones) {
    if (!zones.some(other => other != zone && zone.contains(other))) {
      add(zone);
    }
  }
  for (const input of doc.querySelectorAll("input[type=file]")) {
    // Dropzone's own input belongs to its zone, above.
    if (!input.disabled && !input.classList.contains("dz-hidden-input")) {
      add(boxForInput(input));
    }
  }
  return boxes.sort((a, b) => (a.compareDocumentPosition(b) & DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
}

// The innermost box in `boxes` that is or contains `element`.
function boxContaining(boxes, element) {
  if (!element) {
    return null;
  }
  let best = null;
  for (const box of boxes) {
    if ((box == element || box.contains(element)) && (!best || best.contains(box))) {
      best = box;
    }
  }
  return best;
}

// The event's path, for checking who listens.
function eventPath(event) {
  try {
    const path = event.composedPath();
    if (path.length) {
      return path;
    }
  } catch (e) {
    // Fall through.
  }
  return pathOf(event.target);
}

// Whether a page (not Whimsy or Firefox) listens for any of `types` on
// `path`. For a paste it only says whether to wait for the page; whether it
// took the file comes from what happened (baseline().took).
function pageListens(path, types) {
  for (const node of path) {
    let infos = [];
    try {
      infos = Services.els.getListenerInfoFor(node);
    } catch (e) {
      continue;
    }
    for (const info of infos) {
      if (!types.includes(info.type) || info.inSystemEventGroup) {
        continue;
      }
      let chrome = false;
      try {
        chrome = !!info.listenerObject && Cu.getObjectPrincipal(info.listenerObject).isSystemPrincipal;
      } catch (e) {
        // A page listener.
      }
      if (!chrome) {
        return true;
      }
    }
  }
  return false;
}

// `node`, its ancestors (through shadow hosts) and its window.
function pathOf(node) {
  const path = [];
  for (let n = node; n; n = n.parentNode ?? n.host) {
    path.push(n);
  }
  const win = node?.ownerDocument?.defaultView;
  if (win) {
    path.push(win);
  }
  return path;
}

export class WhimsyUploadChild extends JSWindowActorChild {
  // The Cmd+V in flight: { resolved, baseline, filePromise, timer }.
  pending = null;
  // The parent's indicator mode for this page: "off", "badges" or "pill".
  mode = "off";
  // Whether this page may show the indicator at all (setting, private).
  allowed = false;
  // The last scan (reading order), and what the parent knows them by.
  boxes = [];
  known = new Map();
  ids = new WeakMap();
  nextId = 1;
  // The box the pointer or focus is in, which of them moved last, and the
  // badge the pointer is on (in the parent's layer).
  pointerBox = null;
  focusBox = null;
  hotBy = null;
  badgeHoverId = null;
  hotId = null;
  lastNear = 0;
  listeningNear = false;
  reportQueued = false;
  observer = null;
  mutationTimer = null;
  tabFrom = null;

  get isTop() {
    return this.browsingContext && this.browsingContext == this.browsingContext.top;
  }

  didDestroy() {
    this.cancelPending();
    this.disarm();
    this.unlistenNear();
  }

  handleEvent(event) {
    switch (event.type) {
      case "keydown":
        this.onKeyDown(event);
        break;
      case "click":
        this.onClick(event);
        break;
      case "paste":
        this.onPaste(event);
        break;
      case "cancel":
        this.onPickerCancel(event);
        break;
      case "pageshow":
        this.onPageShow(event);
        break;
      case "pagehide":
        if (event.target == this.document) {
          this.cancelPending();
          this.disarm();
        }
        break;
      case "mouseover":
      case "mouseout":
      case "focusin":
      case "focusout":
        this.onPointerOrFocus(event);
        break;
      case "scroll":
      case "resize":
        this.scheduleReport();
        break;
    }
  }

  // batch7: a trusted click on a file input shows Whimsy's popup first.
  onClick(event) {
    if (!event.isTrusted) {
      return;
    }
    if (event.target?.nodeType == 1) {
      this.lastClick = { ref: Cu.getWeakReference(event.target), time: Date.now() };
    }
    if (event.button != 0 || event.target.tagName != "INPUT" || event.target.type != "file" || !featureOn()) {
      return;
    }
    const input = event.target;
    if (this.bypass == input) {
      this.bypass = null;
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.pick(input, event.screenX, event.screenY);
  }

  // W13-R2: a cancelled file picker (Dropzone.js opens one when you click
  // its box) restarts the click memory: the picker took those seconds.
  onPickerCancel(event) {
    if (event.isTrusted && event.target?.localName == "input" && event.target.type == "file" && this.lastClick) {
      this.lastClick.time = Date.now();
    }
  }

  onKeyDown(event) {
    if (event.key == "Tab") {
      this.onTab(event);
      return;
    }
    if (!event.isTrusted || event.defaultPrevented || !isPasteKey(event) || !featureOn()) {
      return;
    }
    const resolved = this.resolveTarget();
    if (!resolved) {
      log("no upload target; the page's own paste only");
      return;
    }
    log("target", resolved.why, resolved.element);
    this.startPending(resolved);
  }

  // Where Cmd+V, the command and a badge's keyboard paste go: an entry
  // { element, box, id, why } (element is what uploadTargetFor resolves),
  // or null. Order: a text field keeps its paste; the box last pointed at
  // or focused while the indicator shows (it's the one showing the pill);
  // the focused element; the last click; the hovered box; the first badge.
  resolveTarget() {
    const doc = this.document;
    if (!doc) {
      return null;
    }
    const active = deepActive(doc);
    if (isEditable(active)) {
      return null;
    }
    this.boxes = scanTargets(doc);
    const entry = (element, why) => {
      if (!element?.isConnected || !uploadTargetFor(element)) {
        return null;
      }
      const box = this.boxes.includes(element) ? element : null;
      return { element, box, id: this.idOf(element), why };
    };
    const inBox = (element, why) => entry(boxContaining(this.boxes, element), why);

    if (this.mode != "off") {
      const hot = this.hotBox();
      const found = hot && entry(hot, "hot");
      if (found) {
        return found;
      }
    }
    const isRoot = el => !el || el == doc.body || el == doc.documentElement;
    if (!isRoot(active)) {
      const found = inBox(active, "focus") ?? entry(active, "focus");
      if (found) {
        return found;
      }
    }
    const last = this.lastClick;
    const clicked = last && Date.now() - last.time < CLICK_MEMORY_MS ? last.ref.get() : null;
    if (clicked?.isConnected) {
      const found = inBox(clicked, "click") ?? entry(clicked, "click");
      if (found) {
        return found;
      }
    }
    const hovered = [...doc.querySelectorAll(":hover")].pop();
    const found = inBox(hovered, "hover");
    if (found) {
      return found;
    }
    if (this.mode == "badges") {
      const first = this.badgedBoxes()[0];
      return first ? entry(first, "first badge") : null;
    }
    return null;
  }

  idOf(element) {
    let id = this.ids.get(element);
    if (!id) {
      id = this.nextId++;
      this.ids.set(element, id);
    }
    this.known.set(id, element);
    return id;
  }

  // ── Cmd+V ────────────────────────────────────────────────────────────

  startPending(resolved) {
    this.cancelPending();
    const pending = {
      resolved,
      baseline: this.baseline(resolved.element),
      // Read now, while the Cmd+V is fresh for the parent's gesture check;
      // used only if Whimsy delivers.
      filePromise: this.sendQuery("WhimsyUpload:Paste").then(
        result => result?.file ?? null,
        () => null
      ),
    };
    pending.timer = setTimeout(() => {
      if (this.pending == pending) {
        this.pending = null;
        this.deliverPending(pending, "no paste event");
      }
    }, NO_PASTE_MS);
    this.pending = pending;
  }

  cancelPending() {
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.baseline.stop();
      this.pending = null;
    }
  }

  // Whimsy's paste listener: system group, on the chrome event target, so
  // it runs after every page listener. The page has had its turn.
  onPaste(event) {
    const pending = this.pending;
    if (!event.isTrusted || !pending) {
      return;
    }
    this.pending = null;
    clearTimeout(pending.timer);
    const took = event.defaultPrevented ? "the page prevented the paste" : pending.baseline.took();
    if (took) {
      this.pageTook(pending, took);
      return;
    }
    if (!pageListens(eventPath(event), ["paste"])) {
      this.deliverPending(pending, "no page paste listener");
      return;
    }
    // A page listener ran and showed no sign yet (React's root listens for
    // every event): give it a moment to add the file itself.
    setTimeout(() => {
      const late = pending.baseline.took();
      if (late) {
        this.pageTook(pending, late);
      } else {
        this.deliverPending(pending, "the page's paste listener didn't take it");
      }
    }, PAGE_SETTLE_MS);
  }

  pageTook(pending, why) {
    pending.baseline.stop();
    log("the page took the paste:", why);
    this.reportStatus(pending.resolved, "done");
  }

  async deliverPending(pending, why) {
    pending.baseline.stop();
    const file = await pending.filePromise;
    if (!file) {
      log("nothing to upload on the clipboard (or the Cmd+V wasn't the parent's)");
      return;
    }
    log("Whimsy delivers:", why);
    this.reportStatus(pending.resolved, "uploading");
    const ok = await this.deliver(pending.resolved.element, file);
    this.reportStatus(pending.resolved, ok ? "done" : "failed");
  }

  // What shows the page took a paste itself, from just before it: its
  // Dropzone holds another file, the target input changed or went, or
  // nodes were added inside the target.
  baseline(element) {
    const target = uploadTargetFor(element) ?? {};
    const zone = target.dropZone ?? element;
    const dz = dropzoneOf(zone) ?? dropzoneOf(element.closest?.(ZONE_SELECTOR));
    const count = dropzoneCount(dz);
    const input = target.input ?? null;
    const file = input?.files?.[0] ?? null;
    const state = { added: false, observer: null };
    try {
      state.observer = new this.contentWindow.MutationObserver(records => {
        if (records.some(r => r.addedNodes.length)) {
          state.added = true;
        }
      });
      state.observer.observe(element, { childList: true, subtree: true });
    } catch (e) {
      state.observer = null;
    }
    return {
      took() {
        if (dz && count != null && (dropzoneCount(dz) ?? count) > count) {
          return "its Dropzone added a file";
        }
        if (input && (!input.isConnected || (input.files?.[0] ?? null) != file)) {
          return "the target input changed";
        }
        if (state.observer?.takeRecords().some(r => r.addedNodes.length)) {
          state.added = true;
        }
        return state.added ? "nodes were added in the target" : null;
      },
      stop() {
        state.observer?.disconnect();
        state.observer = null;
      },
    };
  }

  // ── Delivery ─────────────────────────────────────────────────────────

  // Puts `file` in what `element` uploads to, resolved now (Dropzone.js
  // replaces its input after every change). One channel only. Resolves to
  // whether the page accepted it.
  async deliver(element, file) {
    const target = element?.isConnected ? uploadTargetFor(element) : null;
    if (target?.input) {
      return this.deliverToInput(target.input, element, file);
    }
    if (target?.dropZone?.isConnected) {
      return this.deliverToZone(target.dropZone, file);
    }
    log("the target is gone");
    return false;
  }

  deliverToInput(input, box, file) {
    const win = this.contentWindow;
    const dz = dropzoneOf(box) ?? dropzoneOf(box?.closest?.(ZONE_SELECTOR));
    const count = dropzoneCount(dz);
    try {
      input.mozSetFileArray([file]);
      input.dispatchEvent(new win.Event("input", { bubbles: true }));
      input.dispatchEvent(new win.Event("change", { bubbles: true }));
    } catch (e) {
      console.error("Whimsy: upload from clipboard failed", e);
      return false;
    }
    // Dropzone.js: only its file count says it kept the file (it replaces
    // the input either way; dropzone.dev's addFile refuses a fifth).
    if (count != null) {
      return dropzoneCount(dz) > count;
    }
    // A visible input shows the file it holds; a form submits it; otherwise
    // the page has to be listening for it.
    if ((isShown(input, 1, 1) && input.files?.length) || input.form) {
      return true;
    }
    return pageListens(pathOf(input), ["change", "input"]);
  }

  deliverToZone(zone, file) {
    const win = this.contentWindow;
    const dz = dropzoneOf(zone);
    if (dz && typeof dz.addFile == "function") {
      // Dropzone.js without a hidden input (clickable: false): its own API.
      // W10-48: a File from here is a chrome object the page can't read;
      // hand it the page's own copy.
      const count = dropzoneCount(dz);
      try {
        dz.addFile(Cu.cloneInto(file, win));
      } catch (e) {
        console.error("Whimsy: upload from clipboard (Dropzone) failed", e);
        return false;
      }
      return count == null || dropzoneCount(dz) == null || dropzoneCount(dz) > count;
    }
    try {
      const data = new win.DataTransfer();
      data.items.add(file);
      const fire = type => zone.dispatchEvent(new win.DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data }));
      fire("dragenter");
      fire("dragover");
      // A zone that takes a drop prevents its default.
      return !fire("drop");
    } catch (e) {
      console.error("Whimsy: upload from clipboard (drop) failed", e);
      return false;
    }
  }

  reportStatus(resolved, state) {
    if (resolved.id != null && this.isTop && this.mode != "off") {
      this.sendAsyncMessage("WhimsyUpload:Status", { id: resolved.id, state });
    }
  }

  // `file` comes from the parent (see WhimsyUploadParent's withFile).
  setFile(input, file) {
    try {
      input.mozSetFileArray([file]);
      input.dispatchEvent(new this.contentWindow.Event("input", { bubbles: true }));
      input.dispatchEvent(new this.contentWindow.Event("change", { bubbles: true }));
    } catch (e) {
      console.error("Whimsy: upload from clipboard failed", e);
    }
  }

  async pick(input, screenX, screenY) {
    const result = await this.sendQuery("WhimsyUpload:Pick", {
      accept: input.accept,
      multiple: input.multiple,
      screenX,
      screenY,
    });
    if (!result) {
      return;
    }
    if (result.useNativePicker) {
      this.bypass = input;
      input.showPicker();
      return;
    }
    if (result.file) {
      this.setFile(input, result.file);
    }
  }

  // ── The indicator (the parent draws it) ──────────────────────────────

  async receiveMessage(message) {
    switch (message.name) {
      case "WhimsyUpload:Arm":
        this.applyState(message.data);
        return null;
      case "WhimsyUpload:Deliver": {
        // A click on a badge or the command, in the parent: a trusted
        // gesture there, so no paste to wait for.
        const element = this.known.get(message.data.id);
        if (!element?.isConnected || !message.data.file) {
          return { ok: false };
        }
        log("Whimsy delivers: badge or command");
        return { ok: await this.deliver(element, message.data.file) };
      }
      case "WhimsyUpload:Resolve": {
        const resolved = this.resolveTarget();
        return resolved ? { id: resolved.id, why: resolved.why } : null;
      }
      case "WhimsyUpload:BadgeHover":
        this.badgeHoverId = message.data.id ?? null;
        this.updateHot();
        return null;
      case "WhimsyUpload:Refocus": {
        // From a focused badge: back to its box, or on to what follows it.
        const from = this.tabFrom?.isConnected ? this.tabFrom : this.known.get(message.data.id);
        this.tabFrom = null;
        if (!from?.isConnected) {
          return null;
        }
        if (message.data.after) {
          Services.focus.moveFocus(this.contentWindow, from, Services.focus.MOVEFOCUS_FORWARD, Services.focus.FLAG_BYKEY);
        } else {
          from.focus();
        }
        return null;
      }
    }
    return null;
  }

  onPageShow(event) {
    if (event.target != this.document || !this.isTop || !featureOn()) {
      return;
    }
    this.sendQuery("WhimsyUpload:Hello").then(
      state => this.applyState(state),
      () => {}
    );
  }

  applyState(state) {
    if (!this.isTop || !this.document) {
      return;
    }
    this.allowed = !!state?.allowed && featureOn();
    if (this.allowed) {
      this.listenNear();
    } else {
      this.unlistenNear();
    }
    const mode = this.allowed ? state.mode ?? "off" : "off";
    if (mode == "off") {
      if (this.mode != "off") {
        this.disarm();
      }
      return;
    }
    const wasOff = this.mode == "off";
    this.mode = mode;
    if (wasOff) {
      this.arm();
    } else {
      this.scheduleReport();
    }
  }

  get listenerOptions() {
    return { capture: true, passive: true, mozSystemGroup: true };
  }

  // Pointer and focus, while the page may show the indicator: they make a
  // box hot, and with nothing armed they ask for a clipboard check.
  listenNear() {
    const win = this.contentWindow;
    if (this.listeningNear || !win) {
      return;
    }
    for (const type of ["mouseover", "mouseout", "focusin", "focusout"]) {
      win.addEventListener(type, this, this.listenerOptions);
    }
    this.listeningNear = true;
  }

  unlistenNear() {
    const win = this.contentWindow;
    if (!this.listeningNear) {
      return;
    }
    for (const type of ["mouseover", "mouseout", "focusin", "focusout"]) {
      win?.removeEventListener(type, this, this.listenerOptions);
    }
    this.listeningNear = false;
  }

  arm() {
    const win = this.contentWindow;
    if (!win) {
      return;
    }
    win.addEventListener("scroll", this, this.listenerOptions);
    win.addEventListener("resize", this, this.listenerOptions);
    try {
      this.observer = new win.MutationObserver(() => {
        clearTimeout(this.mutationTimer);
        this.mutationTimer = setTimeout(() => this.scheduleReport(), 150);
      });
      this.observer.observe(this.document.documentElement, { childList: true, subtree: true });
    } catch (e) {
      this.observer = null;
    }
    this.scheduleReport();
  }

  disarm() {
    const wasArmed = this.mode != "off";
    this.mode = "off";
    const win = this.contentWindow;
    win?.removeEventListener("scroll", this, this.listenerOptions);
    win?.removeEventListener("resize", this, this.listenerOptions);
    this.observer?.disconnect();
    this.observer = null;
    clearTimeout(this.mutationTimer);
    this.boxes = [];
    this.pointerBox = this.focusBox = this.hotBy = null;
    this.badgeHoverId = this.hotId = null;
    if (wasArmed && this.isTop) {
      try {
        this.sendAsyncMessage("WhimsyUpload:Targets", { targets: [], viewport: null, avoid: null });
      } catch (e) {
        // The actor is going away.
      }
    }
  }

  scheduleReport() {
    if (this.reportQueued || this.mode == "off" || !this.contentWindow) {
      return;
    }
    this.reportQueued = true;
    this.contentWindow.requestAnimationFrame(() => {
      this.reportQueued = false;
      this.report();
    });
  }

  // The in-view targets (the parent badges the first 3), in the page's
  // viewport coordinates, and the focused text field (never covered).
  report() {
    const doc = this.document;
    const win = this.contentWindow;
    if (!doc || !win || this.mode == "off") {
      return;
    }
    this.boxes = scanTargets(doc);
    for (const [id, element] of this.known) {
      if (!element.isConnected) {
        this.known.delete(id);
      }
    }
    const targets = [];
    const zoomed = win.visualViewport && Math.abs(win.visualViewport.scale - 1) > 0.01;
    if (!zoomed) {
      for (const box of this.boxes) {
        const rect = rectOf(box);
        if (rect && inView(rect, win)) {
          targets.push({ id: this.idOf(box), x: rect.left, y: rect.top, w: rect.width, h: rect.height });
          if (targets.length >= MAX_REPORTED) {
            break;
          }
        }
      }
    }
    const active = deepActive(doc);
    const rect = isEditable(active) ? rectOf(active) : null;
    const avoid = rect ? { x: rect.left, y: rect.top, w: rect.width, h: rect.height } : null;
    this.reported = new Set(targets.map(t => t.id));
    this.sendAsyncMessage("WhimsyUpload:Targets", {
      targets,
      viewport: { w: win.innerWidth, h: win.innerHeight },
      avoid,
    });
    this.pointerBox = boxContaining(this.boxes, this.pointerBox);
    this.focusBox = boxContaining(this.boxes, this.focusBox);
    this.updateHot();
  }

  // The boxes the parent badges in "badges" mode: the first 3 in view.
  badgedBoxes() {
    const win = this.contentWindow;
    return this.boxes.filter(box => {
      const rect = rectOf(box);
      return rect && inView(rect, win);
    }).slice(0, 3);
  }

  hotBox() {
    const badge = this.badgeHoverId != null ? this.known.get(this.badgeHoverId) : null;
    if (badge?.isConnected) {
      return badge;
    }
    // Whichever moved last. Focus that moved last onto something that isn't
    // a box (a text field, a target too small to badge) leaves nothing hot,
    // so an older hover can't take the paste from it.
    return this.hotBy == "pointer" ? this.pointerBox ?? this.focusBox : this.focusBox;
  }

  updateHot() {
    if (this.mode == "off") {
      return;
    }
    const hot = this.hotBox();
    const id = hot?.isConnected ? this.idOf(hot) : null;
    if (id != this.hotId) {
      this.hotId = id;
      this.sendAsyncMessage("WhimsyUpload:Hot", { id });
    }
  }

  onPointerOrFocus(event) {
    if (!event.isTrusted) {
      return;
    }
    if (this.mode == "off") {
      if (event.type == "mouseover" || event.type == "focusin") {
        this.maybeNear(event.target);
      }
      return;
    }
    const before = this.hotBox();
    switch (event.type) {
      case "mouseover":
        this.pointerBox = boxContaining(this.boxes, event.target);
        this.hotBy = "pointer";
        break;
      case "mouseout":
        // Leaving the page (onto Whimsy's badge, say): no pointer box.
        if (!event.relatedTarget) {
          this.pointerBox = null;
        }
        break;
      case "focusin":
        this.focusBox = boxContaining(this.boxes, deepActive(this.document));
        this.hotBy = "focus";
        break;
      case "focusout":
        if (!event.relatedTarget) {
          this.focusBox = null;
        }
        break;
    }
    // Past the badges' 5 minutes, entering a box still checks the clipboard:
    // a new screenshot brings the badges back.
    const hot = this.hotBox();
    if (this.mode == "pill" && hot && hot != before && Date.now() - this.lastNear >= NEAR_CHECK_MS) {
      this.lastNear = Date.now();
      this.sendAsyncMessage("WhimsyUpload:Near");
    }
    this.updateHot();
  }

  // Nothing armed: pointing at or focusing an upload target asks the parent
  // to check the clipboard's type (a screenshot taken while Whimsy stayed
  // in front). At most once a second; no timer runs.
  maybeNear(element) {
    const doc = this.document;
    if (Date.now() - this.lastNear < NEAR_CHECK_MS || !doc?.querySelector(CANDIDATE_SELECTOR)) {
      return;
    }
    this.lastNear = Date.now();
    if (boxContaining(scanTargets(doc), element)) {
      this.sendAsyncMessage("WhimsyUpload:Near");
    }
  }

  // Tab on a focused box moves to its badge (in the parent's layer); the
  // badge's own Tab comes back through Refocus.
  onTab(event) {
    if (
      !event.isTrusted ||
      event.defaultPrevented ||
      event.shiftKey ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      this.mode == "off" ||
      !this.isTop
    ) {
      return;
    }
    const active = deepActive(this.document);
    const box = this.boxes.find(b => b == active || (b.localName == "label" && b.control == active));
    if (!box || !this.reported?.has(this.idOf(box))) {
      return;
    }
    event.preventDefault();
    this.tabFrom = active;
    this.sendAsyncMessage("WhimsyUpload:FocusBadge", { id: this.idOf(box) });
  }
}
