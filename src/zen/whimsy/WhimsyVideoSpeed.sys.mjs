/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave3/speed: the speed control on videos (WhimsyVideoSpeedChild draws it)
// and the speed remembered per site. The speed lives in content prefs, keyed
// by the tab's site, like per-site zoom: private windows keep it in memory
// only, and Clear Site Data / Forget About This Site remove it. The
// Cmd+Opt+. / , / 0 shortcuts (WhimsyMedia) remember the speed they set too.

const FEATURE_PREF = "whimsy.feature.video-speed";
const CONTENT_PREF = "whimsy.video-speed";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyCaptions: "resource:///modules/whimsy/WhimsyCaptions.sys.mjs",
  WhimsyLiveSpeech: "resource:///modules/whimsy/WhimsyLiveSpeech.sys.mjs",
});

const cps2 = () => Cc["@mozilla.org/content-pref/service;1"].getService(Ci.nsIContentPrefService2);

export const WhimsyVideoSpeed = {
  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  // Registered once per session even when off: the child checks the switch
  // on every event, so turning it on or off needs no restart.
  init() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;
    const quiet = { capture: true, mozSystemGroup: true, createActor: false };
    // Pointer and key events aimed at the control are stopped before the
    // page's own capturing listeners see them, so these are in the default
    // group; they never create the actor.
    const guard = { capture: true, createActor: false };
    ChromeUtils.registerWindowActor("WhimsyVideoSpeed", {
      parent: { esModuleURI: "resource:///modules/whimsy/WhimsyVideoSpeed.sys.mjs" },
      child: {
        esModuleURI: "resource:///modules/whimsy/WhimsyVideoSpeedChild.sys.mjs",
        events: {
          loadstart: { capture: true, mozSystemGroup: true },
          loadedmetadata: { capture: true, mozSystemGroup: true },
          play: { capture: true, mozSystemGroup: true },
          ratechange: quiet,
          mousemove: quiet,
          mouseout: quiet,
          fullscreenchange: quiet,
          pointerdown: guard,
          mousedown: guard,
          pointerup: guard,
          mouseup: guard,
          click: guard,
          dblclick: guard,
          contextmenu: guard,
          keydown: guard,
          keypress: guard,
          keyup: guard,
        },
      },
      allFrames: true,
      // The child only touches its own page's videos, and the parent only
      // stores a number for the tab's own site.
      safeForUntrustedWebProcess: true,
    });
  },

  // The tab's site and load context for a frame, or null where there's no
  // site to remember (about: pages, files).
  siteOf(browsingContext) {
    const top = browsingContext?.top;
    const browser = top?.embedderElement;
    const uri = browser?.currentURI ?? top?.currentWindowGlobal?.documentURI;
    if (!uri || !["http", "https"].includes(uri.scheme)) {
      return null;
    }
    const loadContext =
      browser?.loadContext ?? (top.usePrivateBrowsing ? Cu.createPrivateLoadContext() : Cu.createLoadContext());
    return { spec: uri.spec, loadContext };
  },

  // The speed remembered for the frame's site (1 when none).
  getRate(browsingContext) {
    const site = this.siteOf(browsingContext);
    if (!site || !this.enabled) {
      return Promise.resolve(1);
    }
    return new Promise(resolve => {
      let rate = 1;
      cps2().getByDomainAndName(site.spec, CONTENT_PREF, site.loadContext, {
        handleResult(pref) {
          const value = Number(pref.value);
          if (value >= 0.25 && value <= 4) {
            rate = value;
          }
        },
        handleCompletion: () => resolve(rate),
        handleError: () => resolve(1),
      });
    });
  },

  // Remembers the speed for the frame's site; 1× forgets it.
  remember(browsingContext, rate) {
    const site = this.siteOf(browsingContext);
    if (!site || !this.enabled || !Number.isFinite(rate)) {
      return Promise.resolve();
    }
    return new Promise(resolve => {
      const callback = { handleCompletion: () => resolve(), handleError: () => resolve() };
      if (rate == 1) {
        cps2().removeByDomainAndName(site.spec, CONTENT_PREF, site.loadContext, callback);
      } else {
        cps2().set(site.spec, CONTENT_PREF, Math.min(4, Math.max(0.25, rate)), site.loadContext, callback);
      }
    });
  },
};

export class WhimsyVideoSpeedParent extends JSWindowActorParent {
  receiveMessage(message) {
    switch (message.name) {
      case "WhimsyVideoSpeed:Get":
        return WhimsyVideoSpeed.getRate(this.browsingContext);
      case "WhimsyVideoSpeed:Set":
        return WhimsyVideoSpeed.remember(this.browsingContext, Number(message.data?.rate));
      // wave5/captions: a cue to translate (CC in the speed control).
      case "WhimsyCaptions:Translate":
        return lazy.WhimsyCaptions.translate(message.data);
      // w7native: live captions from speech (a video without captions).
      case "WhimsyCaptions:SpeechStart":
        this._speechStarted = true;
        return lazy.WhimsyLiveSpeech.start(this, message.data);
      case "WhimsyCaptions:SpeechAudio":
        lazy.WhimsyLiveSpeech.audio(this, message.data);
        break;
      case "WhimsyCaptions:SpeechStop":
        lazy.WhimsyLiveSpeech.stop(this, message.data);
        break;
    }
    return null;
  }

  didDestroy() {
    // Only loaded if a session ever started.
    if (this._speechStarted) {
      lazy.WhimsyLiveSpeech.stopAll(this);
    }
  }
}
