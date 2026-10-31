/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Upload from the clipboard (Opera's Easy Files): the child half. Catches a
// trusted click on <input type=file> before the native file picker opens,
// asks the parent what to do (it shows a small popup: the clipboard image,
// the newest downloads, or "Choose file..."), and sets the chosen file with
// the ChromeOnly mozSetFileArray - this actor runs with chrome privileges
// even though it's attached to the content page, so it may call it.
// "Choose file..." bypasses us once and opens Firefox's own picker.
// Cmd+V (Ctrl+V elsewhere) on a focused upload button (see uploadTargetFor), sets
// the clipboard's copied file or image straight away, with no popup: no
// browser pastes into a file input, so the keystroke used to do nothing.

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

const FEATURE_PREF = "whimsy.feature.upload-clipboard";

// The file input a focused element uploads to: the input itself, or the
// <label> a site styled as its button.
function fileInputFor(element) {
  const input = element?.localName == "label" ? element.control : element;
  return input?.localName == "input" && input.type == "file" && !input.disabled ? input : null;
}

// fix7: Cmd+V did nothing on Benepass. Most sites' upload buttons aren't a
// file input or its <label>: a styled <div>/<button> calls a hidden input's
// click(), or a drop zone (react-dropzone and friends) wraps a hidden input
// and has tabindex but no label. And a clicked drop zone often isn't
// focusable at all, so the keystroke lands on <body>. The upload target is
// now also: the input an element points at (aria-controls), or the single
// file input inside the nearest enclosing widget; with nothing focused,
// the element you last clicked (within CLICK_MEMORY_MS). A widget with no
// file input at all gets the file as a drop, the way dragging it in would.
// wave7/security L1: the click is remembered for a few seconds (click, then
// Cmd+V), not a minute, and a drop zone is never picked by its aria-label
// alone (a page can label everything "upload").
const CLICK_MEMORY_MS = 5000;
const WIDGET_DEPTH = 5;

function isEditable(element) {
  if (!element) {
    return false;
  }
  if (element.isContentEditable) {
    return true;
  }
  if (element.localName == "textarea") {
    return true;
  }
  return element.localName == "input" && !["file", "button", "submit", "reset", "checkbox", "radio", "image"].includes(element.type);
}

// The single enabled file input in `root`, if there's exactly one.
function onlyFileInput(root) {
  const inputs = [...root.querySelectorAll("input[type=file]")].filter(i => !i.disabled);
  return inputs.length == 1 ? inputs[0] : null;
}

// What Cmd+V on `element` uploads to: { input } or { dropZone }, or null.
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

  // A drop zone (Dropzone.js, react-dropzone, file-dropzone): check for its associated
  // input first (Dropzone's hiddenFileInput, child file inputs, or .dz-hidden-input).
  const zone = element.closest?.(".dropzone, [class*=dropzone i], [class*=drop-zone i], [data-testid*=dropzone i]");
  if (zone) {
    const dz = zone.wrappedJSObject?.dropzone;
    const dzInput =
      fileInputFor(dz?.hiddenFileInput) ??
      onlyFileInput(zone) ??
      zone.querySelector?.("input[type=file]") ??
      zone.parentElement?.querySelector?.("input.dz-hidden-input") ??
      (doc.querySelectorAll("input.dz-hidden-input").length == 1 ? doc.querySelector("input.dz-hidden-input") : null);
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

export class WhimsyUploadChild extends JSWindowActorChild {
  handleEvent(event) {
    if (event.type == "keydown") {
      this.onKeyDown(event);
      return;
    }
    if (event.type == "click" && event.isTrusted && event.target?.nodeType == 1) {
      this.lastClick = { ref: Cu.getWeakReference(event.target), time: Date.now() };
    }
    if (
      event.type != "click" ||
      !event.isTrusted ||
      event.button != 0 ||
      event.target.tagName != "INPUT" ||
      event.target.type != "file" ||
      !Services.prefs.getBoolPref(FEATURE_PREF, true)
    ) {
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

  onKeyDown(event) {
    if (
      !event.isTrusted ||
      event.defaultPrevented ||
      event.key?.toLowerCase() != "v" ||
      !(AppConstants.platform == "macosx" ? event.metaKey : event.ctrlKey) ||
      event.altKey ||
      event.shiftKey ||
      !Services.prefs.getBoolPref(FEATURE_PREF, true)
    ) {
      return;
    }
    let element = event.target;
    // Nothing focused (a clicked drop zone usually can't take focus): the
    // element you last clicked, or a drop zone under the cursor.
    if (!element || element == this.document?.body || element == this.document?.documentElement) {
      const last = this.lastClick;
      const clicked = last && Date.now() - last.time < CLICK_MEMORY_MS ? last.ref.get() : null;
      element = clicked?.isConnected ? clicked : null;
      if (!element) {
        element = this.document?.querySelector?.(".dropzone:hover, [class*=dropzone i]:hover, [class*=drop-zone i]:hover") ?? null;
      }
    }
    const target = uploadTargetFor(element);
    if (!target) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.paste(target);
  }

  async paste(target) {
    const result = await this.sendQuery("WhimsyUpload:Paste");
    if (!result?.file) {
      return;
    }
    if (target.input) {
      this.setFile(target.input, result.file);
    } else if (target.dropZone?.isConnected) {
      this.dropFile(target.dropZone, result.file);
    }
  }

  // Hands the file to a drop zone the way dragging it in does.
  dropFile(zone, file) {
    try {
      const dz = zone.wrappedJSObject?.dropzone;
      if (dz && typeof dz.addFile == "function") {
        dz.addFile(file);
        return;
      }
      const win = this.contentWindow;
      const data = new win.DataTransfer();
      data.items.add(file);
      for (const type of ["dragenter", "dragover", "drop"]) {
        zone.dispatchEvent(new win.DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data }));
      }
      const pasteData = new win.DataTransfer();
      pasteData.items.add(file);
      zone.dispatchEvent(new win.ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: pasteData }));
    } catch (e) {
      console.error("Whimsy: upload from clipboard (drop) failed", e);
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
}
