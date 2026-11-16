/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// W29 focus sessions: about:whimsy?focus&url=<the site>, shown in place of
// a paused site (WhimsyFocusSession). A trusted parent-process page:
// "x.com is paused during your focus session" / "It opens again at 3:40 PM,
// when the session ends." / Go back · Open anyway.

(() => {
  const { WhimsyFocusSession } = ChromeUtils.importESModule(
    "resource:///modules/whimsy/WhimsyFocusSession.sys.mjs"
  );
  const browser = window.browsingContext?.top?.embedderElement ?? null;
  const url = new URLSearchParams(window.location.search).get("url") || "";
  const uri = WhimsyFocusSession.validURL(url);

  // The session ended (or this was reopened later): just go there.
  if (uri && !WhimsyFocusSession.isActive && browser) {
    WhimsyFocusSession.loadIn(browser, uri);
    return;
  }

  const heading = document.getElementById("whimsy-focus-heading");
  const text = document.getElementById("whimsy-focus-text");
  let host = "";
  try {
    host = uri ? uri.host.replace(/^www\./, "") : "";
  } catch (e) {
    host = "";
  }
  const time = new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(
    new Date(WhimsyFocusSession.endsAt || Date.now())
  );
  const show = site => {
    document.l10n.setAttributes(heading, "whimsy-focus-page-heading", { site });
    document.l10n.setAttributes(text, "whimsy-focus-page-text", { time });
  };
  if (host) {
    show(host);
  } else {
    document.l10n.formatValue("whimsy-focus-page-this-site").then(show);
  }

  const open = document.getElementById("whimsy-focus-open");
  open.hidden = !uri;
  open.addEventListener("click", () => WhimsyFocusSession.openAnyway(browser, url));
  document.getElementById("whimsy-focus-back").addEventListener("click", () => WhimsyFocusSession.goBack(browser));
})();
