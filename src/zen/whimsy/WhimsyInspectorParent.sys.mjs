/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave9: Inspector (Font Inspector & Element Inspector Lite) parent side actor.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyInspector: "resource:///modules/whimsy/WhimsyInspector.sys.mjs",
  WhimsyZap: "resource:///modules/whimsy/WhimsyZap.sys.mjs",
  gZenBoostsManager: "resource:///modules/zen/boosts/ZenBoostsManager.sys.mjs",
});

export class WhimsyInspectorParent extends JSWindowActorParent {
  receiveMessage(message) {
    const browser = this.browsingContext.top.embedderElement;
    const win = browser?.documentGlobal;

    switch (message.name) {
      case "Whimsy:FontInspected":
        if (win && message.data) {
          lazy.WhimsyInspector.showFontPopover(win, message.data);
        }
        break;

      case "Whimsy:ElementInspected":
        if (win && message.data) {
          lazy.WhimsyInspector.showElementPopover(win, message.data);
        }
        break;

      case "Whimsy:GapMeasured":
        if (win && message.data) {
          lazy.WhimsyInspector.onGapMeasured(win, message.data);
        }
        break;

      case "Whimsy:ZapElement":
        if (message.data?.selector) {
          const domain = lazy.WhimsyZap.domainFor?.(browser);
          if (domain) {
            lazy.WhimsyZap.ensureBoost?.(domain);
            lazy.gZenBoostsManager?.addZapSelectorToActive?.(message.data.selector, domain, "zap");
          }
        }
        break;

      case "Whimsy:PickerClosed":
        if (win) {
          lazy.WhimsyInspector.onPickerClosed(win);
        }
        break;
    }
    return null;
  }
}
