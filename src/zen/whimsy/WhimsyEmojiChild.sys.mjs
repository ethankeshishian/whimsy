/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W24 emoji: the content side of typing an emoji into the page. Inserted
// with execCommand("insertText"), which goes through the field's editor
// (and its undo stack) exactly as if it had been typed — never a raw
// .value set, which Enter-to-undo couldn't see. Never into a password
// field; the parent copies instead in that case (WhimsyEmoji.sys.mjs).

function isPassword(el) {
  return el?.localName == "input" && (el.getAttribute("type") || "").toLowerCase() == "password";
}

// The deepest focused element, following same-origin iframes (a
// cross-origin one throws on .contentDocument, which just stops the walk).
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

export class WhimsyEmojiChild extends JSWindowActorChild {
  receiveMessage(message) {
    if (message.name == "WhimsyEmoji:Insert") {
      return this.insert(message.data.emoji);
    }
    if (message.name == "WhimsyEmoji:CanInsert") {
      return this.canInsert();
    }
    return null;
  }

  // The same target `insert` would use: whatever's focused, if it's an
  // editable text field and not a password. Asked ahead of time (by
  // WhimsyEmoji.checkCanInsert) so the footer can say "Type into the page"
  // vs. "Copy" before Enter is even pressed.
  canInsert() {
    const el = deepActiveElement(this.document);
    return { ok: !!el && !isPassword(el) && isEditableText(el) };
  }

  insert(emoji) {
    if (!this.canInsert().ok) {
      return { ok: false };
    }
    const el = deepActiveElement(this.document);
    const win = el.documentGlobal ?? this.contentWindow;
    try {
      el.focus();
      win.document.execCommand("insertText", false, emoji);
    } catch {
      return { ok: false };
    }
    return { ok: true };
  }
}
