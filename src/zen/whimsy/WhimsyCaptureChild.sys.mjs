/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W15 screenshots, one viewer: after a drag, Firefox Screenshots' region
// toolbar (Cancel, Copy, Download) becomes one Capture button, which opens
// the same viewer as Visible, Full Page and Portrait. With the box drawn,
// Enter captures and Esc closes Screenshots (W16-15; Firefox's first Esc
// only dropped the box); Cmd+C and Cmd+S stay as quick copy and download. Firefox draws the
// toolbar in the page's anonymous content and rebuilds it every time the
// overlay opens, so the parent asks for the button each time
// (ScreenshotsUtils.showPanelAndOverlay).

const BUTTON_ID = "whimsy-capture-confirm";
const HIDDEN = ["cancel", "copy", "download"];
const WAIT_FRAMES = 60;

let l10n = null;
function label() {
  l10n ??= new Localization(["browser/whimsy.ftl"], true);
  try {
    const [message] = l10n.formatMessagesSync([{ id: "whimsy-capture-confirm-button" }]);
    const attrs = Object.fromEntries((message?.attributes ?? []).map(a => [a.name, a.value]));
    return { text: message?.value || "Capture", title: attrs.title || "" };
  } catch {
    return { text: "Capture", title: "" };
  }
}

export class WhimsyCaptureChild extends JSWindowActorChild {
  receiveMessage(message) {
    switch (message.name) {
      case "WhimsyCapture:Decorate":
        this.#waitForOverlay(0);
        break;
    }
    return null;
  }

  get #screenshots() {
    try {
      return this.manager.getActor("ScreenshotsComponent");
    } catch {
      return null;
    }
  }

  // Firefox starts the overlay once the document is ready, so look for its
  // toolbar for a second or so.
  #waitForOverlay(frame) {
    const overlay = this.#screenshots?.overlay;
    if (overlay?.initialized && overlay.buttonsContainer && this.#inject(overlay)) {
      return;
    }
    if (frame < WAIT_FRAMES && this.contentWindow) {
      this.contentWindow.requestAnimationFrame(() => this.#waitForOverlay(frame + 1));
    }
  }

  #inject(overlay) {
    const copy = overlay.getElementById("copy");
    // Mini window mode has its own toolbar.
    if (!copy) {
      return false;
    }
    if (overlay.getElementById(BUTTON_ID)) {
      return true;
    }
    for (const id of HIDDEN) {
      const el = overlay.getElementById(id);
      if (el) {
        el.style.display = "none";
      }
    }
    const doc = copy.ownerDocument;
    const button = doc.createElement("button");
    button.id = BUTTON_ID;
    button.className = "screenshots-button primary";
    const { text, title } = label();
    if (title) {
      button.title = title;
    }
    button.setAttribute("aria-label", text);
    const img = doc.createElement("img");
    img.src = "chrome://browser/skin/zen-icons/check.svg";
    img.alt = "";
    const labelEl = doc.createElement("label");
    labelEl.textContent = text;
    button.append(img, labelEl);
    copy.parentElement.append(button);

    if (!overlay._whimsyCaptureWrapped) {
      overlay._whimsyCaptureWrapped = true;
      const ours = event => event.originalTarget?.closest?.(`#${BUTTON_ID}`);
      // Firefox routes the toolbar's clicks and Return/Space by button id.
      const click = overlay.handleClick;
      overlay.handleClick = event => {
        if (ours(event)) {
          this.#confirm(overlay);
          return;
        }
        click.call(overlay, event);
      };
      const key = overlay.handleKeyDownOnButton;
      overlay.handleKeyDownOnButton = event => {
        if (ours(event)) {
          this.#confirm(overlay);
          return;
        }
        key.call(overlay, event);
      };
      // W16-15: with a box drawn and the Capture button there, Enter
      // captures wherever focus is, and Esc closes Screenshots. Crosshairs,
      // dragging and resizing keep Firefox's keys, and so does an overlay
      // without Whimsy's button.
      const keyDown = overlay.handleKeyDown;
      overlay.handleKeyDown = event => {
        if (overlay.state == "selected" && overlay.getElementById(BUTTON_ID)) {
          if (event.key == "Escape") {
            event.preventDefault?.();
            overlay.cancelOverlay();
            return;
          }
          if (event.key == "Enter") {
            event.preventDefault?.();
            if (!event.repeat) {
              this.#confirm(overlay);
            }
            return;
          }
        }
        keyDown.call(overlay, event);
      };
      // Tab cycles between the selection and the one button (Firefox's
      // last button, Download, is hidden).
      const lock = overlay.maybeLockFocus;
      overlay.maybeLockFocus = event => {
        const button = overlay.getElementById(BUTTON_ID);
        if (overlay.state == "selected" && button) {
          if (ours(event) && !event.shiftKey) {
            event.preventDefault();
            overlay.highlightEl.focus({ focusVisible: true });
            return;
          }
          if (event.originalTarget?.id == "highlight" && event.shiftKey) {
            event.preventDefault();
            button.focus({ focusVisible: true });
            return;
          }
        }
        lock.call(overlay, event);
      };
    }
    return true;
  }

  #confirm(overlay) {
    const region = overlay.selectionRegion?.dimensions;
    if (!region) {
      return;
    }
    this.sendAsyncMessage("WhimsyCapture:Confirm", {
      region: { ...region, devicePixelRatio: this.contentWindow.devicePixelRatio },
    });
    // Like Firefox's Copy and Download: the page's overlay closes at once.
    this.#screenshots?.endScreenshotsOverlay?.({ doNotResetMethods: true });
  }
}
