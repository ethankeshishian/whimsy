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
  WhimsyCallPip: "resource:///modules/whimsy/WhimsyCallPip.sys.mjs",
  WhimsyCaptions: "resource:///modules/whimsy/WhimsyCaptions.sys.mjs",
  WhimsyLiveSpeech: "resource:///modules/whimsy/WhimsyLiveSpeech.sys.mjs",
  WhimsyMeetingNotes: "resource:///modules/whimsy/WhimsyMeetingNotes.sys.mjs",
  WhimsyVideoSummary: "resource:///modules/whimsy/WhimsyVideoSummary.sys.mjs",
});

// W23 video: Gecko plays media from 1/16× to 16×.
const MIN_RATE = 1 / 16;
const MAX_RATE = 16;
const inRange = value => value >= MIN_RATE && value <= MAX_RATE;
const DEFAULT_PREF = "whimsy.video.default-speed";
const DEFAULT_FEATURE_PREF = "whimsy.feature.video-default-speed";

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

  // W23 video: your default speed (Settings › Media); a site's beats it.
  get defaultRate() {
    if (!Services.prefs.getBoolPref(DEFAULT_FEATURE_PREF, true)) {
      return 1;
    }
    const value = Number(Services.prefs.getStringPref(DEFAULT_PREF, "1"));
    return Number.isFinite(value) && value > 0 ? (value <= MIN_RATE ? MIN_RATE : Math.round(Math.min(MAX_RATE, value) * 100) / 100) : 1;
  },

  // The speed remembered for the frame's site (your default when none).
  getRate(browsingContext) {
    const site = this.siteOf(browsingContext);
    const fallback = this.defaultRate;
    if (!site || !this.enabled) {
      return Promise.resolve(fallback);
    }
    return new Promise(resolve => {
      let rate = fallback;
      cps2().getByDomainAndName(site.spec, CONTENT_PREF, site.loadContext, {
        handleResult(pref) {
          const value = Number(pref.value);
          if (inRange(value)) {
            rate = value;
          }
        },
        handleCompletion: () => resolve(rate),
        handleError: () => resolve(fallback),
      });
    });
  },

  // Remembers the speed for the frame's site; your default forgets it.
  remember(browsingContext, rate) {
    const site = this.siteOf(browsingContext);
    if (!site || !this.enabled || !Number.isFinite(rate)) {
      return Promise.resolve();
    }
    if (Math.abs(rate - this.defaultRate) < 0.001) {
      return this.forget(browsingContext);
    }
    return new Promise(resolve => {
      const callback = { handleCompletion: () => resolve(), handleError: () => resolve() };
      cps2().set(site.spec, CONTENT_PREF, Math.min(MAX_RATE, Math.max(MIN_RATE, rate)), site.loadContext, callback);
    });
  },

  // Forgets the frame's site's speed (Back to default).
  forget(browsingContext) {
    const site = this.siteOf(browsingContext);
    if (!site) {
      return Promise.resolve();
    }
    return new Promise(resolve => {
      const callback = { handleCompletion: () => resolve(), handleError: () => resolve() };
      cps2().removeByDomainAndName(site.spec, CONTENT_PREF, site.loadContext, callback);
    });
  },

  // W23 video: the sites with their own speed (Settings › Media), most recent first.
  savedSites() {
    return new Promise(resolve => {
      const sites = [];
      cps2().getByName(CONTENT_PREF, Cu.createLoadContext(), {
        handleResult(pref) {
          const rate = Number(pref.value);
          if (pref.domain && inRange(rate)) {
            sites.push({ site: pref.domain, rate });
          }
        },
        handleCompletion: () => resolve(sites.reverse()),
        handleError: () => resolve(sites),
      });
    });
  },

  // Forget all: every site goes back to your default.
  forgetAll() {
    return new Promise(resolve => {
      const callback = { handleCompletion: () => resolve(), handleError: () => resolve() };
      cps2().removeByName(CONTENT_PREF, Cu.createLoadContext(), callback);
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
      case "WhimsyVideoSpeed:Forget":
        return WhimsyVideoSpeed.forget(this.browsingContext);
      // W23 video: Summarize on the video, and what a press would do.
      case "WhimsyVideoSpeed:Summarize":
        return lazy.WhimsyVideoSummary.pressed(this, String(message.data?.videoId ?? ""));
      case "WhimsyVideoSpeed:SummaryState":
        return lazy.WhimsyVideoSummary.stateFor(this, String(message.data?.videoId ?? ""));
      case "WhimsyVideoSpeed:Heard":
        lazy.WhimsyVideoSummary.heard(this, message.data ?? {});
        break;
      case "WhimsyVideoSpeed:Time":
        lazy.WhimsyVideoSummary.playing(this, message.data ?? {});
        break;
      // wave5/captions: a cue to translate (CC in the speed control).
      case "WhimsyCaptions:Translate":
        return lazy.WhimsyCaptions.translate(message.data);
      // w7native: live captions from speech (a video without captions).
      case "WhimsyCaptions:SpeechStart":
        // The call's sound for meeting notes only while Take notes is on
        // for this tab: never at a content process's asking.
        if (message.data?.notes && !lazy.WhimsyMeetingNotes.listeningTo(this.browsingContext.top?.embedderElement)) {
          return { error: "off" };
        }
        this._speechStarted = true;
        return lazy.WhimsyLiveSpeech.start(this, message.data);
      case "WhimsyCaptions:SpeechAudio":
        lazy.WhimsyLiveSpeech.audio(this, message.data);
        break;
      case "WhimsyCaptions:SpeechStop":
        lazy.WhimsyLiveSpeech.stop(this, message.data);
        break;
      // F31: a call's captions, for its picture-in-picture window too.
      case "WhimsyCaptions:CallText":
        lazy.WhimsyCallPip.showCaption(this.browsingContext.top?.embedderElement, String(message.data?.text ?? ""));
        break;
      // W25: Whimsy's own meeting notes, from the call's sound.
      case "WhimsyVideoSpeed:NotesHeard":
        if (lazy.WhimsyMeetingNotes.state?.tab?.linkedBrowser == this.browsingContext.top?.embedderElement) {
          lazy.WhimsyMeetingNotes.heard(String(message.data?.text ?? "").slice(0, 4000), "call");
        }
        break;
      case "WhimsyVideoSpeed:NotesFailed":
        if (lazy.WhimsyMeetingNotes.state?.tab?.linkedBrowser == this.browsingContext.top?.embedderElement) {
          lazy.WhimsyMeetingNotes.callFailed(String(message.data?.reason ?? ""));
        }
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
