/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave9/secfix (security-full-1 M5): Whimsy:SplitLink and Zen's
// ZenGlance:OpenGlance used the principal the content process sent, and
// checked the load with it. A compromised renderer could send the system
// principal and open file:, about:config or chrome: URLs. The parents now
// use their own principal for the page. This test plays the compromised
// renderer: the child actors send a system principal with a file: URL.

const PAGE = "https://example.com/?secfix-m5";
const PRIVILEGED = "file:///";
const ALLOWED = "https://example.org/?secfix-m5-allowed";

function anyTabAt(url) {
  return (gZenWorkspaces?.allStoredTabs ?? gBrowser.tabs).some(tab =>
    tab.linkedBrowser?.currentURI?.spec == url || tab.linkedBrowser?.getAttribute?.("src") == url);
}

async function send(browser, actorName, messageName, data) {
  await SpecialPowers.spawn(browser, [actorName, messageName, data], (actor, name, d) => {
    const system = Services.scriptSecurityManager.getSystemPrincipal();
    content.windowGlobalChild.getActor(actor).sendAsyncMessage(name, { ...d, triggeringPrincipal: system });
  });
}

add_task(async function split_link_ignores_a_content_supplied_principal() {
  await SpecialPowers.pushPrefEnv({
    set: [["whimsy.feature.split-link-click", true], ["whimsy.splitlink.shift-click", true]],
  });
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  await send(tab.linkedBrowser, "WhimsyPage", "Whimsy:SplitLink", { href: PRIVILEGED });
  // A link the page may open still splits, so the message path works.
  const opened = BrowserTestUtils.waitForNewTab(gBrowser, ALLOWED, true);
  await send(tab.linkedBrowser, "WhimsyPage", "Whimsy:SplitLink", { href: ALLOWED });
  const split = await opened;
  ok(!anyTabAt(PRIVILEGED), "The file: URL never opened with a system principal");
  ok(split.linkedBrowser.contentPrincipal.isContentPrincipal, "The allowed link opened as a web page");
  gZenViewSplitter.removeTabFromSplit?.(split);
  BrowserTestUtils.removeTab(split);
  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
});

add_task(async function glance_ignores_a_content_supplied_principal() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  await send(tab.linkedBrowser, "ZenGlance", "ZenGlance:OpenGlance", { url: PRIVILEGED });
  const opened = BrowserTestUtils.waitForNewTab(gBrowser, ALLOWED, true);
  await send(tab.linkedBrowser, "ZenGlance", "ZenGlance:OpenGlance", { url: ALLOWED });
  const glance = await opened;
  ok(glance.hasAttribute("zen-glance-tab"), "The allowed link opened as a Glance");
  ok(!anyTabAt(PRIVILEGED), "The file: URL never opened with a system principal");
  await gZenGlanceManager.closeGlance({ onTabClose: true });
  BrowserTestUtils.removeTab(tab);
});
