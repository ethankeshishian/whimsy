/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave9/secfix (security-full-1 M1): a sandboxed page in a private tab has a
// null principal that still carries privateBrowsingId. Glance, split links
// and space routing open tabs with only that principal (and, for Glance, the
// private tab as owner), so they must open private tabs, not normal ones
// that write history and use the normal cookie jar.

const { WhimsyPrivate } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPrivate.sys.mjs");

const SOURCE = "https://example.com/?secfix-m1-source";
const TARGET = "https://example.com/?secfix-m1-target";

// Waits for a tab's page by its state. Mid-suite, BrowserTestUtils' load
// event for a just-opened tab now and then never arrives although the page
// has loaded (seen here and in screens_3), and browserLoaded waits until the
// test times out.
async function loadedPage(tab, url) {
  await TestUtils.waitForCondition(
    () => tab.linkedBrowser.currentURI.spec == url && !tab.hasAttribute("busy"),
    `${url} loaded`
  );
  await SpecialPowers.spawn(tab.linkedBrowser, [], () =>
    ContentTaskUtils.waitForCondition(() => content.document.readyState == "complete", "Its document is complete")
  );
}

async function openWith(options) {
  const tab = gBrowser.addTab(TARGET, { inBackground: true, ...options });
  await loadedPage(tab, TARGET);
  return tab;
}

add_task(async function a_private_sandboxed_principal_opens_private() {
  // What a CSP-sandboxed private page's document principal looks like.
  const sandboxed = Services.scriptSecurityManager.createNullPrincipal({ privateBrowsingId: 1 });
  ok(sandboxed.isNullPrincipal && !sandboxed.isContentPrincipal, "A null principal");
  const tab = await openWith({ triggeringPrincipal: sandboxed });
  ok(WhimsyPrivate.isPrivateTab(tab), "It opens a private tab");
  ok(tab.linkedBrowser.browsingContext.usePrivateBrowsing, "…browsing privately");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function a_normal_sandboxed_principal_stays_normal() {
  const sandboxed = Services.scriptSecurityManager.createNullPrincipal({});
  const tab = await openWith({ triggeringPrincipal: sandboxed });
  ok(!WhimsyPrivate.isPrivateTab(tab), "A normal sandboxed page opens a normal tab");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function a_page_open_owned_by_a_private_tab_is_private() {
  const source = WhimsyPrivate.openPrivateTab(window, { url: SOURCE, force: true });
  await loadedPage(source, SOURCE);
  // Glance passes the private tab as owner with the page's principal.
  const page = Services.scriptSecurityManager.createContentPrincipal(Services.io.newURI(SOURCE), {});
  const glance = await openWith({ ownerTab: source, triggeringPrincipal: page });
  ok(WhimsyPrivate.isPrivateTab(glance), "A page-started open owned by a private tab is private");
  BrowserTestUtils.removeTab(glance);

  // Chrome's own opens with the private tab selected (Open All in Tabs,
  // captive portal) keep their rules.
  const chrome = await openWith({
    ownerTab: source,
    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
  });
  ok(!WhimsyPrivate.isPrivateTab(chrome), "A chrome open owned by a private tab stays normal");
  BrowserTestUtils.removeTab(chrome);
  BrowserTestUtils.removeTab(source);
});
