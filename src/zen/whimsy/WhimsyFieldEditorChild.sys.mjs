/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W27: Edit Field in Text Editor, page side. Reads the plain-text value of
// whatever's focused (an input, a textarea, or a contenteditable) so the
// parent can hand it to the Mac's text editor, then writes edits back the
// same field, dispatching "input" so the page's own listeners see it
// (WhimsyFieldEditor.sys.mjs does the temp file and the editor). Never a
// password field, and a contenteditable is always read and written as
// plain text (textContent, never innerHTML), so a file full of
// attacker-controlled markup can't inject anything into the page.

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

function isEditableText(el) {
  if (!el) {
    return false;
  }
  if (el.localName == "textarea") {
    return !el.readOnly && !el.disabled;
  }
  if (el.localName == "input") {
    const type = (el.getAttribute("type") || "text").toLowerCase();
    return !el.readOnly && !el.disabled && ["text", "search", "email", "url", "tel", ""].includes(type);
  }
  return !!el.isContentEditable;
}

function fieldValue(el) {
  return el.localName == "input" || el.localName == "textarea" ? el.value : el.textContent;
}

function setFieldValue(el, text) {
  if (el.localName == "input" || el.localName == "textarea") {
    el.value = text;
  } else {
    el.textContent = text;
  }
  // The field's own global, not the actor's: a dispatched event must come
  // from the target's own window (this engine has no Element.ownerGlobal;
  // WhimsyAISensitive.sys.mjs:163 uses documentGlobal the same way).
  el.dispatchEvent(new el.documentGlobal.Event("input", { bubbles: true }));
}

export class WhimsyFieldEditorChild extends JSWindowActorChild {
  // A WeakRef to the field "Read" last found, so "Write" lands on it even
  // if the page's focus moves on while the editor is open.
  #field = null;

  receiveMessage(message) {
    if (message.name == "WhimsyFieldEditor:Read") {
      return this.#read();
    }
    if (message.name == "WhimsyFieldEditor:Write") {
      return this.#write(message.data.text);
    }
    return null;
  }

  #read() {
    const el = deepActiveElement(this.document);
    if (!el || isPassword(el) || !isEditableText(el)) {
      return null;
    }
    this.#field = new WeakRef(el);
    return { value: fieldValue(el) };
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
}
