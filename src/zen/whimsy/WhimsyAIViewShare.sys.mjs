/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W23 ⌘K: the view's make-up when ⌘K opens (WhimsyAIViewShareChild), plus
// which images in view have text (WhimsyImageText, when it's built in).

let imageText;
function imageTextModule() {
  if (imageText === undefined) {
    try {
      imageText = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyImageText.sys.mjs").WhimsyImageText ?? null;
    } catch {
      imageText = null;
    }
  }
  return imageText;
}

// Right-click targets' secret-field check, per tab: {sensitive, at}.
const contextTargets = new WeakMap();

export class WhimsyAIViewShareParent extends JSWindowActorParent {
  receiveMessage(message) {
    if (message.name == "Whimsy:CardUndone") {
      ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAISelectionCard.sys.mjs").WhimsyAISelectionCard.onUndone(this.browsingContext);
      return;
    }
    if (message.name == "Whimsy:ContextTarget") {
      const browser = this.browsingContext.top.embedderElement;
      if (browser) {
        contextTargets.set(browser, { sensitive: message.data?.sensitive ?? null, at: Date.now() });
      }
    }
  }
}

export const WhimsyAIViewShare = {
  // Tests stand in for WhimsyImageText: {hasText(src) -> boolean|Promise}.
  imageText: null,

  /**
   * The selected tab's view: {shares: {article, video, image}, images:
   * [{src, alt, area, hasText}], underPointer, product, textChars, lang},
   * or null where it can't be read.
   */
  async measure(win) {
    const actor = win?.gBrowser?.selectedBrowser?.browsingContext?.currentWindowGlobal?.getActor("WhimsyAIViewShare");
    let view = null;
    try {
      view = await actor?.sendQuery("Whimsy:ViewShare");
    } catch (e) {
      return null;
    }
    if (!view) {
      return null;
    }
    const reader = this.imageText ?? imageTextModule();
    for (const image of view.images) {
      try {
        image.hasText = reader?.hasText ? !!(await reader.hasText(image.src)) : false;
      } catch {
        image.hasText = false;
      }
    }
    return view;
  },

  /** The last right-click's target in a tab: {sensitive, at}, or null. */
  contextTarget(browser) {
    const found = browser ? contextTargets.get(browser) : null;
    return found && Date.now() - found.at < 5000 ? found : null;
  },

  /** {editable, sensitive} for the selection in a frame. */
  async selectionInfo(context) {
    try {
      return (await context?.currentWindowGlobal?.getActor("WhimsyAIViewShare").sendQuery("Whimsy:SelectionInfo")) ?? null;
    } catch {
      return null;
    }
  },

  /**
   * The images a group is about (fu-media 3.5): the one under the pointer;
   * else one at least twice the next one's visible area; else up to ten,
   * biggest first.
   */
  pickImages(view) {
    const images = view?.images ?? [];
    if (!images.length) {
      return [];
    }
    if (view.underPointer != null && images[view.underPointer]) {
      return [images[view.underPointer]];
    }
    if (images.length == 1 || images[0].area >= 2 * images[1].area) {
      return [images[0]];
    }
    return images.slice(0, 10);
  },
};
