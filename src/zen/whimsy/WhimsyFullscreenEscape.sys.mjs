/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W27: Press Esc twice to leave full screen (Settings → Look and Feel,
// whimsy.fullscreen.double-escape, off by default).
//
// The keys are handled in C++ (whimsy-PresShell-cpp.patch): with the setting
// on, the first Esc in a page's full screen goes to the page and the parent
// fires MozDOMFullscreen:WhimsyEscapeAgain at the window; a second Esc within
// a second exits as usual. This module only answers that event: it shows
// Firefox's own full-screen notice (PointerlockFsWarning, the one that says
// "Exit Full Screen (Esc)" on entering) with its button saying "Press Esc
// again to exit full screen".

const EVENT = "MozDOMFullscreen:WhimsyEscapeAgain";
const BUTTON_L10N_ID = "whimsy-fullscreen-press-esc-again";

export const WhimsyFullscreenEscape = {
  initWindow(win) {
    win.addEventListener(
      EVENT,
      () => this.showHint(win),
      /* useCapture */ true,
      /* wantsUntrusted */ false
    );
  },

  showHint(win) {
    const warning = win.PointerlockFsWarning;
    const browsingContext = win.gBrowser?.selectedBrowser?.browsingContext;
    if (!warning || !browsingContext?.top?.currentWindowGlobal) {
      return;
    }
    warning.showFullScreen(browsingContext, false);
    const button = win.document.getElementById("fullscreen-exit-button");
    if (button) {
      win.document.l10n.setAttributes(button, BUTTON_L10N_ID);
    }
  },
};
