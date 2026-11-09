/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W23 video: remembers, per tab, the subtitle files (WebVTT, TTML, DFXP,
// SRT) its pages load, by content type or extension, with no site list.
// Only the addresses are kept; Summarize fetches them again through the
// tab's own frame (WhimsyVideoSpeedChild.fetchText), with the page's
// credentials. Private tabs are never recorded.

const TYPES = /^(text\/vtt|application\/ttml\+xml|application\/ttaf\+xml|application\/dfxp\+xml|application\/x-subrip|text\/srt|application\/x-srt)$/i;
const EXTENSIONS = /\.(vtt|webvtt|ttml|dfxp|srt)$/i;
const PER_TAB = 20;

// browserId -> [{url, type}]
const seen = new Map();

export const WhimsySubtitleSniffer = {
  init() {
    if (this._observing) {
      return;
    }
    this._observing = true;
    for (const topic of ["http-on-examine-response", "http-on-examine-cached-response", "http-on-examine-merged-response"]) {
      Services.obs.addObserver(this, topic);
    }
  },

  observe(subject) {
    try {
      const channel = subject.QueryInterface(Ci.nsIHttpChannel);
      if (!Services.prefs.getBoolPref("whimsy.feature.ai-video-summary", true) || channel.loadInfo.originAttributes.privateBrowsingId) {
        return;
      }
      const type = String(channel.contentType ?? "");
      const path = channel.URI.filePath ?? "";
      if (!TYPES.test(type) && !EXTENSIONS.test(path)) {
        return;
      }
      if (channel.responseStatus < 200 || channel.responseStatus >= 300) {
        return;
      }
      this.record(channel.browserId, channel.URI.spec, type);
    } catch (e) {
      // Not an HTTP response with a tab.
    }
  },

  record(browserId, url, type = "") {
    if (!browserId) {
      return;
    }
    const list = (seen.get(browserId) ?? []).filter(e => e.url != url);
    list.push({ url, type });
    seen.set(browserId, list.slice(-PER_TAB));
  },

  /** The subtitle files a tab has loaded, oldest first. */
  forBrowser(browser) {
    return [...(seen.get(browser?.browserId) ?? [])];
  },

  forget(browser) {
    seen.delete(browser?.browserId);
  },
};
