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
// Cmd+V (Ctrl+V elsewhere) on a focused upload button, or its <label>, sets
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

export class WhimsyUploadChild extends JSWindowActorChild {
  handleEvent(event) {
    if (event.type == "keydown") {
      this.onKeyDown(event);
      return;
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
    const input = fileInputFor(event.target);
    if (!input) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.paste(input);
  }

  async paste(input) {
    const result = await this.sendQuery("WhimsyUpload:Paste");
    if (result?.path) {
      await this.setFile(input, result.path);
    }
  }

  async setFile(input, path) {
    try {
      const file = await File.createFromFileName(path);
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
    if (result.path) {
      await this.setFile(input, result.path);
    }
  }
}
