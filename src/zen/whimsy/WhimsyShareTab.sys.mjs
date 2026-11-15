/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W29: Call Options › Share this tab (and the Share This Tab in Call
// command). Whimsy presses the web call's own share button; Firefox's
// sharing prompt then opens on the tab you were looking at, with that tab
// already picked. Allow is always yours to click: nothing here grants or
// skips the prompt. Stop works from any tab, for whatever the call shares.
// Design: whimsy-handoff/intake-w29/designs/share-a-tab.md.
//
// Firefox's side (whimsy-WebRTCParent-sys-mjs.patch) asks this module:
// - promptBrowser(): which tab to show the prompt on;
// - preselect(): which tab to pick in the prompt's list;
// - promptTarget(): where a redirected prompt lives, to remove it.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  webrtcUI: "resource:///modules/webrtcUI.sys.mjs",
});

// A pending share is for the call page's next screen request only, and only
// for a short while (the page may not ask at all, or ask for something
// else first).
const PENDING_MS = 30000;

export const WhimsyShareTab = {
  // call <browser> -> { target: weak <browser>, browserId, expires }
  _pending: new WeakMap(),
  // a prompt's callID -> { target: weak <browser> or null, browserId }
  _prompts: new Map(),

  // Presses `callBrowser`'s own share button for the selected tab of
  // `win`. Resolves to whether there was a button to press.
  async share(win, callBrowser) {
    const target = win?.gBrowser?.selectedBrowser;
    const actor = callBrowser?.browsingContext?.currentWindowGlobal?.getActor("WhimsyPage");
    if (!target || !actor) {
      return false;
    }
    this._pending.set(callBrowser, {
      target: Cu.getWeakReference(target),
      browserId: String(target.browserId),
      expires: Date.now() + PENDING_MS,
    });
    // Firefox lists tabs from each window's cached visible tabs, which can
    // still miss a tab opened a moment ago (and keep one just closed).
    // Refresh them so the prompt can list and pick this one.
    for (const w of Services.wm.getEnumerator("navigator:browser")) {
      w.gBrowser?.tabContainer?._invalidateCachedVisibleTabs?.();
    }
    let pressed = false;
    try {
      pressed = !!(await actor.sendQuery("Whimsy:CallShare"));
    } catch (e) {}
    if (!pressed) {
      this._pending.delete(callBrowser);
    }
    return pressed;
  },

  // The pending share for this request, taken once per prompt.
  _take(aBrowser, aRequest) {
    const callID = aRequest?.callID;
    if (callID && this._prompts.has(callID)) {
      return this._prompts.get(callID);
    }
    const pending = aBrowser && this._pending.get(aBrowser);
    if (!pending || !aRequest?.sharingScreen) {
      return null;
    }
    this._pending.delete(aBrowser);
    if (pending.expires < Date.now()) {
      return null;
    }
    const target = pending.target.get();
    const entry = {
      target: target && target != aBrowser && target.isConnected ? pending.target : null,
      browserId: target?.isConnected ? pending.browserId : null,
    };
    if (callID) {
      this._prompts.set(callID, entry);
      // The map only ever holds prompts that are on screen or just gone.
      while (this._prompts.size > 8) {
        this._prompts.delete(this._prompts.keys().next().value);
      }
    }
    return entry;
  },

  // The tab to show the call's screen-sharing prompt on, or null for the
  // call tab (Firefox's default).
  promptBrowser(aBrowser, aRequest) {
    return this._take(aBrowser, aRequest)?.target?.get() ?? null;
  },

  // The tab's device id (its browserId) to pick in the prompt, or null.
  preselect(aBrowser, aRequest) {
    return this._take(aBrowser, aRequest)?.browserId ?? null;
  },

  // The browser a redirected prompt was shown on.
  promptTarget(aCallId) {
    return this._prompts.get(aCallId)?.target?.get() ?? null;
  },

  // Whether `callBrowser` is sharing a tab, window, or screen.
  isSharing(callBrowser) {
    return !!callBrowser?._sharingState?.webRTC?.screen;
  },

  // The title of the tab the call shares, or null (a window or screen, or
  // nothing).
  sharedTitle(callBrowser) {
    if (!this.isSharing(callBrowser)) {
      return null;
    }
    try {
      for (const { browsingContext, state } of lazy.webrtcUI._streams) {
        if (browsingContext?.top?.embedderElement != callBrowser) {
          continue;
        }
        for (const { mediaSource, rawId } of state?.devices ?? []) {
          if (mediaSource == "browser") {
            const bc = BrowsingContext.getCurrentTopByBrowserId(Number(rawId));
            const title = bc?.embedderElement?.contentTitle;
            if (title) {
              return title;
            }
          }
        }
      }
    } catch (e) {}
    return null;
  },

  // Stops what the call shares, whichever tab this is run from.
  stop(callBrowser) {
    if (!callBrowser) {
      return;
    }
    this._pending.delete(callBrowser);
    lazy.webrtcUI.clearPermissionsAndStopSharing(["screen"], callBrowser);
  },

  // The call ended or its tab went away.
  forget(callBrowser) {
    if (callBrowser) {
      this._pending.delete(callBrowser);
    }
  },
};
