/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave5: Easel. Adds "Add to Easel" to Firefox Screenshots' region toolbar
// (Cancel, Copy, Download), like Arc's capture tool. Firefox draws that
// toolbar in the page's anonymous content and rebuilds it every time the
// overlay opens, so the parent asks for the button each time
// (ScreenshotsUtils.showPanelAndOverlay). The button is added before Copy;
// a click sends the selected region to the parent, which takes the
// screenshot and asks which easel it goes to.

const BUTTON_ID = "whimsy-easel-add";
const WAIT_FRAMES = 60;

let l10n = null;
function label() {
  l10n ??= new Localization(["browser/whimsy.ftl"], true);
  try {
    const [message] = l10n.formatMessagesSync([{ id: "whimsy-easel-capture-button" }]);
    const attrs = Object.fromEntries((message?.attributes ?? []).map(a => [a.name, a.value]));
    return { text: message?.value || "Add to Easel", title: attrs.title || "" };
  } catch {
    return { text: "Add to Easel", title: "" };
  }
}

export class WhimsyEaselChild extends JSWindowActorChild {
  receiveMessage(message) {
    if (message.name == "WhimsyEasel:OfferButton") {
      this.#waitForOverlay(0);
    }
    if (message.name == "WhimsyEasel:PageBounds") {
      // wave7: "Add Page to Easel". Sizes only; the parent draws the page.
      const win = this.contentWindow;
      const doc = this.document;
      if (!win || !doc?.documentElement) {
        return null;
      }
      return {
        width: Math.max(doc.documentElement.scrollWidth, doc.documentElement.clientWidth),
        height: Math.max(doc.documentElement.scrollHeight, doc.documentElement.clientHeight),
        viewportWidth: doc.documentElement.clientWidth,
        viewportHeight: doc.documentElement.clientHeight,
        devicePixelRatio: win.devicePixelRatio,
      };
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
    if (!copy) {
      return false;
    }
    if (overlay.getElementById(BUTTON_ID)) {
      return true;
    }
    const doc = copy.ownerDocument;
    const button = doc.createElement("button");
    button.id = BUTTON_ID;
    button.className = "screenshots-button";
    const { text, title } = label();
    if (title) {
      button.title = title;
    }
    button.setAttribute("aria-label", text);
    const img = doc.createElement("img");
    img.src = "chrome://browser/skin/zen-icons/paintbrush.svg";
    img.alt = "";
    const labelEl = doc.createElement("label");
    labelEl.textContent = text;
    button.append(img, labelEl);
    copy.before(button);

    // Firefox routes the toolbar's clicks through overlay.handleClick by
    // button id; take ours first and pass everything else through.
    if (!overlay._whimsyEaselClick) {
      const original = overlay.handleClick;
      overlay._whimsyEaselClick = true;
      overlay.handleClick = event => {
        if (event.originalTarget?.closest?.(`#${BUTTON_ID}`)) {
          this.#send(overlay, event);
          return;
        }
        original.call(overlay, event);
      };
    }
    return true;
  }

  #send(overlay, event) {
    const region = overlay.selectionRegion?.dimensions;
    if (!region) {
      return;
    }
    const win = this.contentWindow;
    const rect = event.originalTarget.closest(`#${BUTTON_ID}`)?.getBoundingClientRect();
    this.sendAsyncMessage("WhimsyEasel:AddCapture", {
      region,
      devicePixelRatio: win.devicePixelRatio,
      viewportWidth: overlay.windowDimensions?.clientWidth ?? win.innerWidth,
      viewportHeight: overlay.windowDimensions?.clientHeight ?? win.innerHeight,
      anchor: rect ? { x: Math.round(rect.left), y: Math.round(rect.bottom + 4) } : null,
    });
    // Like Copy and Download: the page's overlay closes right away.
    this.#screenshots?.endScreenshotsOverlay?.({ doNotResetMethods: true });
  }
}
