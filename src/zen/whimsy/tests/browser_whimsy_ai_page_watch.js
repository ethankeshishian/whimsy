/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Watch a page (like Safari's Notify Me): right-click a tab → Watch This
// Page…, say what to look for and how often. Whimsy reads the page with the
// tab's session while it runs, asks the AI only when the text changed, and
// alerts (a bar + a macOS notification) at every check until dismissed. A
// fake AI provider and a fake page reader stand in.

const { WhimsyAIProviders } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIProviders.sys.mjs");
const { WhimsyAIReader } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIReader.sys.mjs");
const { WhimsyPageWatch } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPageWatch.sys.mjs");

const PAGE = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") + "whimsy_ai_page.html";

let pageText = "The espresso machine costs $129 and is out of stock.";
const reads = [];
let asked = 0;
const notified = [];

add_setup(async () => {
  WhimsyAIReader.setTestReader((url, options) => {
    reads.push({ url, options });
    return pageText;
  });
  WhimsyAIProviders.setTestProvider(({ prompt, system }) => {
    if (/Notify Me/.test(system)) {
      asked++;
      const text = prompt.split("<page>")[1] || "";
      const met = /is in stock/.test(text);
      return JSON.stringify({ met, detail: met ? "It's in stock now." : "Still out of stock." });
    }
    return "";
  });
  WhimsyPageWatch._testNotify = watch => notified.push(watch.id);
  registerCleanupFunction(async () => {
    for (const watch of await WhimsyPageWatch.list()) {
      await WhimsyPageWatch.remove(watch.id);
    }
    WhimsyPageWatch._testNotify = null;
    WhimsyAIReader.setTestReader(null);
    WhimsyAIProviders.setTestProvider(null);
    Services.prefs.clearUserPref("whimsy.ai.blocked");
    Services.prefs.clearUserPref("whimsy.feature.page-watch");
  });
});

function bar(watch) {
  return gNotificationBox.getNotificationWithValue(`whimsy-watch-${watch.id}`);
}

async function checkNow(watch) {
  watch.lastChecked = 0;
  return WhimsyPageWatch.check(watch);
}

add_task(async function test_watch_flow() {
  ok(Services.prefs.getBoolPref("whimsy.feature.page-watch"), "The feature switch is on");
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);

  // Right-click the tab → Watch This Page…
  const menu = document.getElementById("tabContextMenu");
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  EventUtils.synthesizeMouseAtCenter(tab, { type: "contextmenu", button: 2 });
  await shown;
  const item = document.getElementById("context_whimsyWatchPage");
  await TestUtils.waitForCondition(() => !item.hidden && item.getAttribute("label") == "Watch This Page…", "The menu offers it");
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.activateItem(item);
  await hidden;

  const panel = await TestUtils.waitForCondition(() => {
    const p = document.getElementById("whimsy-watch-panel");
    return p?.state == "open" && p;
  }, "The Notify Me dialog opens");
  const input = panel.querySelector(".whimsy-watch-condition");
  await TestUtils.waitForCondition(() => document.activeElement == input, "with the condition field focused");
  is(panel.querySelector(".whimsy-watch-interval").value, "60", "Hourly by default");
  EventUtils.sendString("the espresso machine is in stock");
  EventUtils.synthesizeKey("KEY_Enter");
  await TestUtils.waitForCondition(() => panel.state == "closed", "Enter saves it");

  const watch = await TestUtils.waitForCondition(async () => (await WhimsyPageWatch.list())[0], "The watch is saved");
  is(watch.url, PAGE, "for the page");
  is(watch.condition, "the espresso machine is in stock", "with the condition in plain words");
  is(watch.interval, 60, "and the interval");
  ok(await IOUtils.exists(PathUtils.join(PathUtils.profileDir, "whimsy-page-watches.json")), "kept in the profile");
  await TestUtils.waitForCondition(() => watch.lastChecked > 0 && !WhimsyPageWatch._checking, "Checked once right away");
  ok(!watch.met, "Not met yet");
  ok(!bar(watch), "so no alert");
  is(asked, 1, "The AI was asked once");
  ok(WhimsyPageWatch._timer, "A timer runs while there are watches");

  // Same text: the last answer stands, no AI call.
  await checkNow(watch);
  is(asked, 1, "An unchanged page doesn't ask the AI again");

  // The page changes and the condition is met: a bar and a notification.
  pageText = "The espresso machine costs $129 and is in stock.";
  await checkNow(watch);
  is(asked, 2, "A changed page is asked about");
  ok(watch.met, "Met");
  await TestUtils.waitForCondition(() => bar(watch), "An alert bar shows");
  is(notified.length, 1, "and a notification");

  // Recurring until dismissed.
  await checkNow(watch);
  is(notified.length, 2, "Next check alerts again");
  is(asked, 2, "without asking the AI again");
  bar(watch).dismiss();
  await TestUtils.waitForCondition(() => watch.dismissed, "Dismissing the bar stops the alerts");
  await checkNow(watch);
  is(notified.length, 2, "No alert after dismissing");
  ok(!bar(watch), "and no bar");

  // Stops being met, then met again: alerts again.
  pageText = "The espresso machine is out of stock.";
  await checkNow(watch);
  ok(!watch.met && !watch.dismissed, "Not met any more");
  pageText = "Back: the espresso machine is in stock.";
  await checkNow(watch);
  await TestUtils.waitForCondition(() => bar(watch), "Met again: alerts again");
  is(notified.length, 3, "with a notification");

  // The tab's menu now offers to stop.
  const shown2 = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  EventUtils.synthesizeMouseAtCenter(tab, { type: "contextmenu", button: 2 });
  await shown2;
  await TestUtils.waitForCondition(() => item.getAttribute("label") == "Stop Watching This Page", "Stop is offered");
  const hidden2 = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.activateItem(item);
  await hidden2;
  await TestUtils.waitForCondition(async () => !(await WhimsyPageWatch.list()).length, "Stopping removes it");
  ok(!bar(watch), "and its alert");
  ok(!WhimsyPageWatch._timer, "No timer with nothing to watch");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_container_session() {
  reads.length = 0;
  pageText = "The espresso machine costs $129 and is out of stock.";
  const tab = BrowserTestUtils.addTab(gBrowser, PAGE, { userContextId: 2 });
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser);
  const watch = await WhimsyPageWatch.add({
    url: PAGE,
    title: tab.label,
    condition: "in stock",
    userContextId: tab.getAttribute("usercontextid") | 0,
  });
  await TestUtils.waitForCondition(() => reads.length, "Read right away");
  is(reads[0].options.userContextId, 2, "with the tab's container (its sign-ins)");
  await WhimsyPageWatch.remove(watch.id);
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_kill_switch_and_private() {
  const watch = await WhimsyPageWatch.add({ url: PAGE, condition: "in stock" });
  await TestUtils.waitForCondition(() => !WhimsyPageWatch._checking, "First check done");
  Services.prefs.setBoolPref("whimsy.ai.blocked", true);
  await TestUtils.waitForCondition(() => !WhimsyPageWatch._timer, "Turning AI off stops the timer");
  reads.length = 0;
  is(await checkNow(watch), null, "Checks do nothing");
  is(reads.length, 0, "and read nothing");
  await Assert.rejects(WhimsyPageWatch.add({ url: PAGE, condition: "x" }), /AI is off/, "No new watches");
  Services.prefs.clearUserPref("whimsy.ai.blocked");
  await TestUtils.waitForCondition(() => WhimsyPageWatch._timer, "Back on, the timer runs again");
  await WhimsyPageWatch.remove(watch.id);

  const win = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  const tab = await BrowserTestUtils.openNewForegroundTab(win.gBrowser, PAGE);
  ok(!WhimsyPageWatch.canWatch(win, tab), "Private pages can't be watched");
  await BrowserTestUtils.closeWindow(win);
});

add_task(async function watch_controls_separate_accounts() {
  const a = await WhimsyPageWatch.add({ url: PAGE, condition: "in stock", userContextId: 1 });
  const b = await WhimsyPageWatch.add({ url: PAGE, condition: "in stock", userContextId: 2 });
  try {
    is((await WhimsyPageWatch.watchFor(PAGE, 1)).id, a.id, "Account one's watch");
    is((await WhimsyPageWatch.watchFor(PAGE, 2)).id, b.id, "Account two's independent watch");
    const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, () => {
      gBrowser.selectedTab = BrowserTestUtils.addTab(gBrowser, PAGE, { userContextId: 2 });
    });
    is(tab.linkedBrowser.browsingContext.originAttributes.userContextId, 2, "The controlled tab uses account two");
    try {
      await WhimsyPageWatch.toggleForTab(window, tab);
      is(await WhimsyPageWatch.watchFor(PAGE, 2), null, "Stop targets the tab's account");
      is((await WhimsyPageWatch.watchFor(PAGE, 1)).id, a.id, "Other account remains watched");
    } finally { BrowserTestUtils.removeTab(tab); }
  } finally {
    await WhimsyPageWatch.remove(a.id);
    await WhimsyPageWatch.remove(b.id);
  }
});
