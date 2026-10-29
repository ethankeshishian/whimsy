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

const FEATURE_PREF = "whimsy.feature.upload-clipboard";

export class WhimsyUploadChild extends JSWindowActorChild {
  handleEvent(event) {
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
      try {
        const file = await File.createFromFileName(result.path);
        input.mozSetFileArray([file]);
        input.dispatchEvent(new this.contentWindow.Event("input", { bubbles: true }));
        input.dispatchEvent(new this.contentWindow.Event("change", { bubbles: true }));
      } catch (e) {
        console.error("Whimsy: upload from clipboard failed", e);
      }
    }
  }
}
