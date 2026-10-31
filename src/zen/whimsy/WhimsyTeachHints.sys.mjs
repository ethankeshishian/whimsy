/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave7/small: two more Teach once hints (WhimsyTeach, wave7/teach), kept
// in their own file so they register only when WhimsyTeach exists:
// - Link hints (WhimsyLinkHints, Cmd+J): someone went looking for a link
//   with the keyboard: Firefox's Quick Find (links only), or Find then
//   Enter to follow the link it found.
// - Instant result (WhimsySearchDeck, Shift+Enter): someone pressed plain
//   Enter on a search in the command bar, the step Shift+Enter skips.
// Pressing the hint's own shortcut retires it, as with every hint.

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsySearchDeck: "resource:///modules/whimsy/WhimsySearchDeck.sys.mjs",
});

const TEACH_URL = "resource:///modules/whimsy/WhimsyTeach.sys.mjs";
// Find, then Enter on the found link: the page it opens counts if it
// starts loading within this long.
const FOLLOW_MS = 3000;

function featureOn(id) {
  return Services.prefs.getBoolPref(`whimsy.feature.${id}`, true);
}

function plainEnter(event) {
  return (
    event.key == "Enter" &&
    !event.shiftKey &&
    !event.altKey &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.isComposing &&
    !event.repeat
  );
}

function shiftEnter(event) {
  return event.key == "Enter" && event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey;
}

function inFindbar(event) {
  const target = event.originalTarget ?? event.target;
  return !!target?.closest?.("findbar");
}

// The trigger for link hints: (win, show) => cleanup.
export function linkHintsTrigger(win, show) {
  const { gBrowser } = win;
  if (!gBrowser) {
    return null;
  }
  let enterAt = 0;
  const onOpen = event => {
    const bar = event.target;
    if (bar?.localName == "findbar" && bar.findMode == bar.FIND_LINKS) {
      show({});
    }
  };
  const onKeyDown = event => {
    if (plainEnter(event) && inFindbar(event)) {
      enterAt = Date.now();
    }
  };
  const listener = {
    onLocationChange(browser, webProgress, request, location, flags) {
      if (
        enterAt &&
        webProgress?.isTopLevel &&
        browser == gBrowser.selectedBrowser &&
        !(flags & Ci.nsIWebProgressListener.LOCATION_CHANGE_SAME_DOCUMENT) &&
        Date.now() - enterAt <= FOLLOW_MS
      ) {
        enterAt = 0;
        show({});
      }
    },
  };
  win.addEventListener("findbaropen", onOpen, true);
  win.addEventListener("keydown", onKeyDown, true);
  gBrowser.addProgressListener(listener);
  return () => {
    win.removeEventListener("findbaropen", onOpen, true);
    win.removeEventListener("keydown", onKeyDown, true);
    gBrowser.removeProgressListener(listener);
  };
}

// The trigger for Instant result: plain Enter on what Shift+Enter would
// have opened straight away.
export function instantTrigger(win, show) {
  const input = win.gURLBar?.inputField;
  if (!input) {
    return null;
  }
  const onKeyDown = event => {
    if (!plainEnter(event) || win.gURLBar.view?.isResultMenuOpen?.()) {
      return;
    }
    let target = null;
    try {
      target = lazy.WhimsySearchDeck.instantQuery(win);
    } catch (e) {
      console.error("Whimsy: teach instant", e);
    }
    if (target) {
      show({});
    }
  };
  // Capture, so the command bar's own Enter (which may close it) runs after.
  input.addEventListener("keydown", onKeyDown, true);
  return () => input.removeEventListener("keydown", onKeyDown, true);
}

// Shift+Enter used for real: that person already knows it.
export function instantUsed(win, used) {
  const input = win.gURLBar?.inputField;
  if (!input) {
    return null;
  }
  // Search Deck handles Shift+Enter on the window and stops the key there,
  // so it also announces it; a Shift+Enter it didn't take still counts.
  const onKeyDown = event => shiftEnter(event) && used();
  const onInstant = () => used();
  input.addEventListener("keydown", onKeyDown, true);
  win.addEventListener("WhimsyInstantResultUsed", onInstant);
  return () => {
    input.removeEventListener("keydown", onKeyDown, true);
    win.removeEventListener("WhimsyInstantResultUsed", onInstant);
  };
}

function urlbarAnchor(win) {
  return win.gURLBar ?? win.document.getElementById("urlbar");
}

export const HINTS = [
  {
    id: "link-hints",
    l10nId: "whimsy-teach-link-hints",
    key: "key_whimsyLinkHints",
    isAvailable: () => featureOn("link-hints"),
    anchor: win => {
      const bar = win.gBrowser?.isFindBarInitialized?.() ? win.gBrowser.getCachedFindBar() : null;
      return bar && !bar.hidden ? bar : urlbarAnchor(win);
    },
    delay: 600,
    trigger: linkHintsTrigger,
  },
  {
    id: "instant-result",
    l10nId: "whimsy-teach-instant",
    key: () => (AppConstants.platform == "macosx" ? "⇧↵" : "Shift+Enter"),
    isAvailable: win => featureOn("instant-result") && !lazy.WhimsySearchDeck.isPrivate(win),
    anchor: urlbarAnchor,
    // Let the results page start loading and the command bar close.
    delay: 900,
    trigger: instantTrigger,
    usedWhen: instantUsed,
  },
];

export const WhimsyTeachHints = {
  registered: false,

  // Registers the hints once; false when this build has no WhimsyTeach.
  init() {
    if (this.registered) {
      return true;
    }
    let teach = null;
    try {
      teach = ChromeUtils.importESModule(TEACH_URL).WhimsyTeach;
    } catch (e) {
      return false;
    }
    if (!teach?.register) {
      return false;
    }
    for (const hint of HINTS) {
      teach.register(hint);
    }
    this.registered = true;
    return true;
  },
};
