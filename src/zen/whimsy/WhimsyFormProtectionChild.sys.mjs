/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Content side of Form Protection (W9-03).
// Monitors form inputs in content pages. When a user has typed or edited text
// in a form, tells the parent so the tab can be marked as protected from
// auto-archive and show a subtle indicator.

export class WhimsyFormProtectionChild extends JSWindowActorChild {
  handleEvent(event) {
    switch (event.type) {
      case "input":
      case "change":
      case "pageshow":
        this.checkFormState();
        break;
    }
  }

  checkFormState() {
    try {
      const doc = this.document;
      if (!doc || doc.nodeType !== doc.DOCUMENT_NODE) {
        return;
      }
      const hasForm = this.hasFilledForm(doc);
      this.sendAsyncMessage("Whimsy:FormProtectionState", { hasForm });
    } catch (e) {
      // Content may be in transition or detached.
    }
  }

  hasFilledForm(doc) {
    if (!doc) {
      return false;
    }
    const inputs = doc.querySelectorAll(
      "input:not([type=hidden]):not([type=submit]):not([type=reset]):not([type=button]):not([type=image]), textarea"
    );
    for (const input of inputs) {
      if (input.type === "checkbox" || input.type === "radio") {
        if (input.checked !== input.defaultChecked) {
          return true;
        }
      } else {
        if (input.value && input.value !== input.defaultValue && input.value.trim().length > 0) {
          return true;
        }
      }
    }
    const selects = doc.querySelectorAll("select");
    for (const select of selects) {
      for (const option of select.options) {
        if (option.selected !== option.defaultSelected) {
          return true;
        }
      }
    }
    return false;
  }
}
