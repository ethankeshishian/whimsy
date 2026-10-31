/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave9/secfix (security-full-1 L2, L3): page tools the person starts react
// only to the person's own input. A page's synthetic click must not drive a
// follower pane, synthetic mouse events must not draw a link lasso, and
// synthetic keys must not pick a link hint.

const { WhimsyFollowerTabs } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyFollowerTabs.sys.mjs");
const { WhimsyLinkHints } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyLinkHints.sys.mjs");

const ROOT = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com");
const SOURCE_PAGE = "https://example.com/document-builder.sjs?html=" +
  encodeURIComponent("<a id=link href='https://example.org/followed'>next</a>");

// Runs `code` as the page's own script (untrusted events, like an attacker's).
function pageRun(browser, code) {
  return SpecialPowers.spawn(browser, [code], source => {
    const script = content.document.createElement("script");
    script.textContent = source;
    content.document.body.append(script);
    script.remove();
  });
}

add_task(async function a_synthetic_click_doesnt_drive_the_follower_pane() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.follower-tabs", true]] });
  const source = await BrowserTestUtils.openNewForegroundTab(gBrowser, SOURCE_PAGE);
  const follower = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
  gBrowser.selectedTab = source;
  gZenViewSplitter.splitTabs([source, follower], "vsep");
  await TestUtils.waitForCondition(() => gZenViewSplitter._data.some(g => g.tabs.includes(source)), "A split");
  await WhimsyFollowerTabs.toggle(window, source);
  ok(WhimsyFollowerTabs.isSource(source), "Follow mode is on");

  // The page clicks its own link: Firefox follows it in the page's own
  // pane, as without Whimsy; the follower pane isn't touched.
  const loaded = BrowserTestUtils.browserLoaded(source.linkedBrowser, false, "https://example.org/followed");
  await pageRun(source.linkedBrowser,
    "document.getElementById('link').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));");
  await loaded;
  is(follower.linkedBrowser.currentURI.spec, "about:blank", "The follower pane didn't move");

  BrowserTestUtils.removeTab(source);
  BrowserTestUtils.removeTab(follower);
  await SpecialPowers.popPrefEnv();
});

add_task(async function synthetic_mouse_events_dont_draw_a_lasso() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, ROOT + "whimsy_lasso.html");
  const browser = tab.linkedBrowser;
  await pageRun(browser, `
    for (const [type, x] of [["mousedown", 5], ["mousemove", 200], ["mousemove", 400]]) {
      document.body.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, altKey: true, buttons: 1, clientX: x, clientY: x,
      }));
    }`);
  const state = await SpecialPowers.spawn(browser, [], async () => {
    await new Promise(r => content.requestAnimationFrame(() => content.requestAnimationFrame(r)));
    const lasso = content.windowGlobalChild.getActor("WhimsyLasso").lasso;
    return lasso ? { started: !!lasso.started, count: lasso.selected?.length ?? 0 } : null;
  });
  ok(!state?.started && !state?.count, "No lasso from the page's own events");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function synthetic_keys_dont_pick_a_hint() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.link-hints", true]] });
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, ROOT + "whimsy_link_hints.html");
  const browser = tab.linkedBrowser;
  const peek = () => browser.browsingContext.currentWindowGlobal.getActor("WhimsyLinkHints").sendQuery("Whimsy:Hints:Peek");
  document.getElementById(WhimsyLinkHints.COMMAND_ID).doCommand();
  await TestUtils.waitForCondition(async () => (await peek()).active, "Hints show");
  const { labels } = await peek();
  const label = labels[0];
  ok(label, `A hint to type (${label})`);
  await pageRun(browser, `
    for (const key of ${JSON.stringify([...label])}) {
      for (const type of ["keydown", "keypress", "keyup"]) {
        document.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true, cancelable: true }));
      }
    }`);
  await new Promise(r => setTimeout(r, 300));
  ok((await peek()).active, "The page's keys didn't pick the hint");
  is(browser.currentURI.spec, ROOT + "whimsy_link_hints.html", "…and nothing was followed");
  EventUtils.synthesizeKey("KEY_Escape", {}, window);
  await TestUtils.waitForCondition(async () => !(await peek()).active, "Esc closes the hints");
  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
});
