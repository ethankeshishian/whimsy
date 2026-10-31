/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave9/secfix (security-full-2 L4): two commands wrote a private page's
// site or content somewhere lasting. Developer Mode's toggle saved the site
// to permissions.sqlite forever; in private browsing it's now a session-only
// private permission. The Calendar verb sent the selection and the page's
// URL to Calendar (which syncs); it isn't offered in private browsing.

const { WhimsyPrivate } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPrivate.sys.mjs");
const { WhimsyDevMode } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyDevMode.sys.mjs");
const { WhimsyVerbs, parseEvent } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyVerbs.sys.mjs");

const URL = "https://example.org/?secfix-l4";
const uri = Services.io.newURI(URL);
const normalPrincipal = Services.scriptSecurityManager.createContentPrincipal(uri, {});
const privatePrincipal = Services.scriptSecurityManager.createContentPrincipal(uri, { privateBrowsingId: 1 });

function permission(principal) {
  return Services.perms.getPermissionObject(principal, "whimsy-devmode", false);
}

async function openPrivate() {
  const tab = WhimsyPrivate.openPrivateTab(window, { url: URL, force: true });
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, URL);
  gBrowser.selectedTab = tab;
  return tab;
}

add_task(async function developer_mode_in_private_is_session_only() {
  registerCleanupFunction(() => {
    Services.perms.removeFromPrincipal(normalPrincipal, "whimsy-devmode");
    Services.perms.removeFromPrincipal(privatePrincipal, "whimsy-devmode");
  });
  const tab = await openPrivate();
  const command = document.getElementById("whimsy-devmode-toggle-site");
  ok(command, "The Developer Mode command exists");
  command.doCommand();
  await TestUtils.waitForCondition(() => permission(privatePrincipal), "Turned on for the private tab");
  ok(!permission(normalPrincipal), "Nothing was saved for normal browsing (permissions.sqlite)");
  is(permission(privatePrincipal).expireType, Services.perms.EXPIRE_SESSION, "…and the private choice ends with the session");
  ok(WhimsyDevMode.isDevMode(uri, true), "The private tab is in Developer Mode");
  ok(!WhimsyDevMode.isDevMode(uri, false), "…normal tabs of the site aren't");
  command.doCommand();
  await TestUtils.waitForCondition(() => !permission(privatePrincipal), "Turned off again");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function the_calendar_verb_isnt_offered_in_private() {
  const text = "Lunch tomorrow at noon";
  const subject = { kind: "selection", text, title: "Plans", url: URL, event: parseEvent(text) };
  ok(subject.event, "The selection reads as an event");

  const normal = await BrowserTestUtils.openNewForegroundTab(gBrowser, URL);
  ok(WhimsyVerbs.verbsFor(window, subject).some(v => v.id == "calendar"), "A normal tab offers Add to Calendar");
  const priv = await openPrivate();
  ok(!WhimsyVerbs.verbsFor(window, subject).some(v => v.id == "calendar"), "A private tab doesn't");
  BrowserTestUtils.removeTab(priv);
  BrowserTestUtils.removeTab(normal);
});
