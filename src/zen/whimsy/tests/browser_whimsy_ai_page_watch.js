/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave8/isolation: a tab lives in a space of its own profile (container),
// so a container tab is opened the way a user gets one: in a space of
// that container. The tab is moved there by the isolation guard.
async function containerSpace(userContextId) {
  const space = await gZenWorkspaces.createAndSaveWorkspace(`Container ${userContextId}`, undefined, true, userContextId);
  registerCleanupFunction(async () => {
    for (const tab of gZenWorkspaces.allStoredTabs.filter(t => t.getAttribute("zen-workspace-id") == space.uuid &&
      !t.hasAttribute("zen-essential") && !t.hasAttribute("zen-empty-tab"))) {
      BrowserTestUtils.removeTab(tab);
    }
    if (gZenWorkspaces.getWorkspaces().some(w => w.uuid == space.uuid)) {
      await gZenWorkspaces.removeWorkspace(space.uuid);
    }
  });
  return space;
}

// Watch a page (like Safari's Notify Me): right-click a tab → Watch This
// Page…, say what to look for and how often. Whimsy reads the page with the
// tab's session while it runs and asks the AI only when the text changed.
// W23: a hit posts one macOS notification (none when the page is in front),
// waits in the command bar's Updates, and goes to the watch's thread, where
// checks without a hit fold into one line. No bar in the window, no
// repeats. A fake AI provider and a fake page reader stand in.

const { WhimsyAI } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAI.sys.mjs");
const { WhimsyAIProviders } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIProviders.sys.mjs");
const { WhimsyAIReader } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIReader.sys.mjs");
const { WhimsyAIStore } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIStore.sys.mjs");
const { WhimsyAIUpdates } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIUpdates.sys.mjs");
const { WhimsyPageWatch, MAX_WATCHES } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPageWatch.sys.mjs");
const { WhimsyRoutines } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyRoutines.sys.mjs");

const PAGE = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") + "whimsy_ai_page.html";

let pageText = "The espresso machine costs $129 and is out of stock.";
let readFails = false;
const reads = [];
let asked = 0;
const notified = [];

add_setup(async () => {
  WhimsyAIReader.setTestReader((url, options) => {
    reads.push({ url, options });
    if (readFails) {
      throw new Error("The page didn't load");
    }
    return pageText;
  });
  WhimsyAIProviders.setTestProvider(({ prompt, system }) => {
    if (/Notify Me/.test(system)) {
      asked++;
      const text = prompt.split("<page>")[1] || "";
      const met = /is in stock/.test(text);
      return JSON.stringify({ met, title: met ? "Espresso machine: in stock" : "", detail: met ? "It's in stock now." : "Still out of stock." });
    }
    return "";
  });
  WhimsyPageWatch._testNotify = (watch, n) => notified.push({ id: watch.id, ...n });
  registerCleanupFunction(async () => {
    for (const watch of await WhimsyPageWatch.list()) {
      await WhimsyPageWatch.remove(watch.id);
    }
    await WhimsyAIStore.clear({ kinds: ["routineResults"] });
    WhimsyPageWatch._testNotify = null;
    WhimsyAIReader.setTestReader(null);
    WhimsyAIProviders.setTestProvider(null);
    Services.prefs.setBoolPref("whimsy.ai.enabled", true);
    await WhimsyAI.pending;
    Services.prefs.clearUserPref("whimsy.feature.page-watch");
  });
});

async function checkNow(watch) {
  watch.lastChecked = 0;
  return WhimsyPageWatch.check(watch);
}

async function threadCards(watch) {
  return (await WhimsyAIStore.messages(watch.threadId)).filter(m => m.role == "card");
}

async function hitRow(watch) {
  return (await WhimsyAIUpdates.list()).updates.find(u => u.id == `watch:${watch.id}`);
}

function noBar() {
  return !gNotificationBox.allNotifications.some(n => n.getAttribute("value")?.startsWith("whimsy-watch-"));
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
  ok(panel.classList.contains("whimsy-surface"), "a WhimsySurface panel");
  await document.l10n.translateFragment(panel);
  is(panel.querySelector(".whimsy-watch-interval .whimsy-surface-dropdown-value").textContent, "Every hour", "Hourly by default");
  EventUtils.sendString("the espresso machine is in stock");
  EventUtils.synthesizeKey("KEY_Enter");
  await TestUtils.waitForCondition(() => panel.state == "closed", "Enter saves it");

  const watch = await TestUtils.waitForCondition(async () => (await WhimsyPageWatch.list())[0], "The watch is saved");
  is(watch.url, PAGE, "for the page");
  is(watch.condition, "the espresso machine is in stock", "with the condition in plain words");
  is(watch.interval, 60, "and the interval");
  const file = PathUtils.join(PathUtils.profileDir, "whimsy-page-watches.json");
  is((await IOUtils.stat(file)).permissions, 0o600, "kept in the profile, owner-only");
  await TestUtils.waitForCondition(() => watch.lastChecked > 0 && !WhimsyPageWatch._checking, "Checked once right away");
  ok(!watch.met, "Not met yet");
  is(asked, 1, "The AI was asked once");
  ok(WhimsyPageWatch._timer, "A timer runs while there are watches");
  is((await WhimsyRoutines.get(watch.id))?.trigger.kind, "page", "A watch is a routine with trigger page");

  // Hits notify only when the page isn't in front of you.
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");

  // no_change_folds: unchanged text, no AI call, one folded line.
  await TestUtils.waitForCondition(async () => watch.threadId && (await threadCards(watch)).length, "The watch has a thread");
  await checkNow(watch);
  is(asked, 1, "An unchanged page doesn't ask the AI again");
  let cards = await threadCards(watch);
  is(cards.length, 1, "Checks without a hit fold into one line");
  is(cards[0].kind, "watch-quiet", "that counts them");
  is(cards[0].count, 2, "twice so far");

  // one_notification_per_hit_no_repeat, hit_in_updates_and_thread, no_bar.
  pageText = "The espresso machine costs $129 and is in stock.";
  await checkNow(watch);
  is(asked, 2, "A changed page is asked about");
  ok(watch.met, "Met");
  is(notified.length, 1, "One notification");
  is(notified[0].title, "Espresso machine: in stock", "titled with the finding");
  is(notified[0].body, "“the espresso machine is in stock”: It's in stock now.", "with the condition and what changed");
  ok(noBar(), "No bar in the window");
  const row = await hitRow(watch);
  ok(row, "The hit waits in Updates");
  is(row.url, PAGE, "↩ opens the page");
  is(row.threadId, watch.threadId, "⌘↩ opens the watch's thread");
  cards = await threadCards(watch);
  ok(cards.at(-1).kind == "routine-run" && cards.at(-1).found, "The hit is written to the thread");
  await checkNow(watch);
  is(notified.length, 1, "Still met: no repeat");
  is(asked, 2, "without asking the AI again");

  // realert_after_false_then_true.
  pageText = "The espresso machine is out of stock.";
  await checkNow(watch);
  ok(!watch.met, "Not met any more");
  is(notified.length, 1, "Nothing when it stops");
  pageText = "Back: the espresso machine is in stock.";
  await checkNow(watch);
  is(notified.length, 2, "Met again: one more notification");

  // Clicking the notification opens the page and marks the hit seen.
  WhimsyPageWatch.openHit(watch);
  await TestUtils.waitForCondition(() => gBrowser.selectedTab == tab, "The notification switches to the page");
  await TestUtils.waitForCondition(async () => !(await hitRow(watch)), "and the hit is seen");

  // no_notification_when_page_in_front.
  pageText = "Out of stock again.";
  await checkNow(watch);
  pageText = "Now the espresso machine is in stock.";
  await checkNow(watch);
  is(notified.length, 2, "No notification while the page is the tab in front");
  ok(await hitRow(watch), "but the hit still waits in Updates");
  BrowserTestUtils.removeTab(other);

  // The tab's menu now offers to stop.
  const shown2 = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  EventUtils.synthesizeMouseAtCenter(tab, { type: "contextmenu", button: 2 });
  await shown2;
  await TestUtils.waitForCondition(() => item.getAttribute("label") == "Stop Watching This Page", "Stop is offered");
  const hidden2 = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.activateItem(item);
  await hidden2;
  await TestUtils.waitForCondition(async () => !(await WhimsyPageWatch.list()).length, "Stopping removes it");
  ok(!(await hitRow(watch)), "and its hit");
  ok((await WhimsyAIStore.thread(watch.threadId))?.routineDeleted, "Its thread stays, marked deleted");
  ok(!WhimsyPageWatch._timer, "No timer with nothing to watch");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function fifty_cap_shared_with_routines() {
  pageText = "Nothing here.";
  const ids = [];
  for (let i = 0; i < MAX_WATCHES; i++) {
    ids.push((await WhimsyPageWatch.add({ url: `${PAGE}?n=${i}`, condition: "in stock" })).id);
  }
  await TestUtils.waitForCondition(() => !WhimsyPageWatch._checking, "Checks done");
  await Assert.rejects(
    WhimsyRoutines.save({ title: "Price", prompt: "below $900", trigger: { kind: "page", url: `${PAGE}?n=x`, interval: 60 } }, { confirmed: true }),
    /Too many watches/,
    "A page-changes routine counts toward the same 50"
  );
  await Assert.rejects(WhimsyPageWatch.add({ url: `${PAGE}?n=y`, condition: "x" }), /Too many watches/, "and so does a watch");
  const r = await WhimsyRoutines.save({ title: "Brief", prompt: "Brief me", trigger: { kind: "schedule", days: [1], hour: 8, minute: 0 } }, { confirmed: true });
  ok(r.id, "Other routines don't count toward it");
  await WhimsyRoutines.remove(r.id);
  for (const id of ids) {
    await WhimsyPageWatch.remove(id);
  }
});

add_task(async function unreadable_page_needs_you_after_two_checks() {
  pageText = "Nothing here.";
  notified.length = 0;
  const watch = await WhimsyPageWatch.add({ url: PAGE, title: "Espresso machine", condition: "in stock" });
  await TestUtils.waitForCondition(() => watch.lastChecked && !WhimsyPageWatch._checking, "Checked once");
  const failRow = async () => (await WhimsyAIUpdates.list()).updates.find(u => u.id == `watch:${watch.id}:fail`);

  readFails = true;
  await checkNow(watch);
  is(watch.error, "unreadable", "The first failed check is kept on the watch");
  ok(!(await failRow()), "but one failure might pass: no row yet");
  is(notified.length, 0, "and no notification");

  await checkNow(watch);
  const row = await failRow();
  ok(row?.needsYou, "Twice in a row: a row in Updates that needs you");
  is(row.title, "Espresso machine: can’t read the page", "naming the page");
  is(row.nextStep?.action, "open-page", "led by Open page");
  is(notified.filter(n => n.failed).length, 1, "and one notification");
  const fail = (await threadCards(watch)).find(m => m.kind == "routine-fail");
  ok(fail, "The watch's thread says so too");
  await checkNow(watch);
  is(notified.filter(n => n.failed).length, 1, "A third failure doesn't notify again");

  // Open page: the page, in front.
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
  const before = new Set(gBrowser.tabs);
  ok(await WhimsyAIUpdates.handle(window, row, {}), "The watch handles its Open page");
  await TestUtils.waitForCondition(() => gBrowser.selectedBrowser.currentURI.spec == PAGE, "The page opens");
  ok(!(await failRow()), "and the row is cleared");
  if (!before.has(gBrowser.selectedTab)) {
    BrowserTestUtils.removeTab(gBrowser.selectedTab);
  }
  BrowserTestUtils.removeTab(other);

  readFails = false;
  await checkNow(watch);
  is(watch.failures, 0, "A good check starts the count over");
  is(watch.error, "", "and clears the error");
  await WhimsyPageWatch.remove(watch.id);
});

add_task(async function test_container_session() {
  reads.length = 0;
  pageText = "The espresso machine costs $129 and is out of stock.";
  const home = gZenWorkspaces.getActiveWorkspace();
  await gZenWorkspaces.changeWorkspace(await containerSpace(2));
  const tab = BrowserTestUtils.addTab(gBrowser, PAGE, { userContextId: 2 });
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser);
  is(tab.getAttribute("zen-workspace-id"), gZenWorkspaces.activeWorkspace, "The container tab stays in its space");
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
  await gZenWorkspaces.changeWorkspace(home);
});

add_task(async function test_kill_switch_and_private() {
  const watch = await WhimsyPageWatch.add({ url: PAGE, condition: "in stock" });
  await TestUtils.waitForCondition(() => !WhimsyPageWatch._checking, "First check done");
  Services.prefs.setBoolPref("whimsy.ai.enabled", false);
  await WhimsyAI.pending;
  await TestUtils.waitForCondition(() => !WhimsyPageWatch._timer, "Turning AI off stops the timer");
  reads.length = 0;
  is(await checkNow(watch), null, "Checks do nothing");
  is(reads.length, 0, "and read nothing");
  await Assert.rejects(WhimsyPageWatch.add({ url: PAGE, condition: "x" }), /AI is off/, "No new watches");
  Services.prefs.setBoolPref("whimsy.ai.enabled", true);
  await WhimsyAI.pending;
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
    const home = gZenWorkspaces.getActiveWorkspace();
    await gZenWorkspaces.changeWorkspace(await containerSpace(2));
    const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, () => {
      gBrowser.selectedTab = BrowserTestUtils.addTab(gBrowser, PAGE, { userContextId: 2 });
    });
    is(tab.linkedBrowser.browsingContext.originAttributes.userContextId, 2, "The controlled tab uses account two");
    try {
      await WhimsyPageWatch.toggleForTab(window, tab);
      is(await WhimsyPageWatch.watchFor(PAGE, 2), null, "Stop targets the tab's account");
      is((await WhimsyPageWatch.watchFor(PAGE, 1)).id, a.id, "Other account remains watched");
    } finally {
      BrowserTestUtils.removeTab(tab);
      await gZenWorkspaces.changeWorkspace(home);
    }
  } finally {
    await WhimsyPageWatch.remove(a.id);
    await WhimsyPageWatch.remove(b.id);
  }
});

// W23 routines-ui: the panel is a WhimsySurface with a styled interval
// menu, Watch shows a toast with Undo, the 50-watch cap says so in place,
// chat opens it filled and outlined, and the list left Settings.
async function openPanel(tab, opts) {
  await WhimsyPageWatch.openDialog(window, tab, opts);
  return TestUtils.waitForCondition(() => {
    const p = document.getElementById("whimsy-watch-panel");
    return p?.state == "open" && p;
  }, "The panel opens");
}

add_task(async function watch_panel_is_surface_with_dropdown() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const panel = await openPanel(tab);
  const dropdown = panel.querySelector(".whimsy-watch-interval");
  ok(dropdown.classList.contains("whimsy-surface-dropdown"), "The interval is a WhimsySurface dropdown");
  EventUtils.synthesizeMouseAtCenter(dropdown, {});
  const list = await TestUtils.waitForCondition(() => document.getElementById("whimsy-watch-interval-list")?.state == "open" && document.getElementById("whimsy-watch-interval-list"), "Its menu opens");
  is(list.querySelectorAll("[role=option]").length, 4, "15 minutes, an hour, 6 hours, or a day");
  const option = list.querySelector("[role=option][data-value='15']");
  EventUtils.synthesizeMouseAtCenter(option, {});
  await BrowserTestUtils.waitForPopupEvent(list, "hidden");
  const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
  EventUtils.synthesizeKey("KEY_Escape");
  await hidden;
  BrowserTestUtils.removeTab(tab);
});

add_task(async function undo_toast() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const panel = await openPanel(tab);
  panel.querySelector(".whimsy-watch-condition").focus();
  EventUtils.sendString("the price drops");
  EventUtils.synthesizeKey("KEY_Enter");
  await TestUtils.waitForCondition(() => panel.state == "closed", "Watch closes the panel");
  const watch = await TestUtils.waitForCondition(async () => (await WhimsyPageWatch.list()).find(w => w.condition == "the price drops"), "The watch is saved");
  const undo = await TestUtils.waitForCondition(() => document.querySelector(".zen-toast #whimsy-undo-toast-button"), "The toast offers Undo");
  await TestUtils.waitForCondition(() => undo.getBoundingClientRect().width > 0, "laid out");
  await TestUtils.waitForCondition(() => !WhimsyPageWatch._checking, "The first check is done");
  EventUtils.synthesizeMouseAtCenter(undo, {});
  await TestUtils.waitForCondition(async () => !(await WhimsyPageWatch.list()).some(w => w.id == watch.id), "Undo stops watching");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function cap_shown_in_place() {
  const real = WhimsyPageWatch.list;
  // Whole watches: the routines list (Library, chat's routine bar) shows each
  // stand-in with its condition and how often.
  WhimsyPageWatch.list = async () => Array.from({ length: MAX_WATCHES }, (_, i) => ({ id: `w${i}`, url: `https://example.org/${i}`, condition: "the price drops", interval: 60, userContextId: 0 }));
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  try {
    const panel = await openPanel(tab);
    const error = panel.querySelector(".whimsy-watch-error");
    ok(!error.hidden, "At 50 the panel says so in place");
    await document.l10n.translateFragment(panel);
    ok(error.textContent.includes("50 pages"), "with the count");
    ok(document.getElementById("whimsy-watch-done").disabled, "Watch is off");
    ok(!document.getElementById("whimsy-watch-show").hidden, "Show watches is offered");
    const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
    EventUtils.synthesizeKey("KEY_Escape");
    await hidden;
  } finally {
    WhimsyPageWatch.list = real;
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function not_offered_private() {
  const win = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  const tab = await BrowserTestUtils.openNewForegroundTab(win.gBrowser, PAGE);
  is(await WhimsyPageWatch.openDialog(win, tab), null, "No panel for a private tab");
  ok(!win.document.getElementById("whimsy-watch-panel"), "and nothing opened");
  await BrowserTestUtils.closeWindow(win);
});

add_task(async function from_chat_filled_outlined() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const panel = await openPanel(tab, { condition: "tickets go on sale", interval: 15, outlined: true });
  const input = panel.querySelector(".whimsy-watch-condition");
  is(input.value, "tickets go on sale", "Chat fills what to look for");
  ok(input.classList.contains("is-filled"), "outlined");
  ok(panel.querySelector(".whimsy-watch-interval").classList.contains("is-filled"), "and how often");
  await document.l10n.translateFragment(panel);
  is(panel.querySelector(".whimsy-watch-interval .whimsy-surface-dropdown-value").textContent, "Every 15 minutes", "every 15 minutes");
  is((await WhimsyPageWatch.list()).filter(w => w.condition == "tickets go on sale").length, 0, "Nothing is watched until Watch");
  const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
  EventUtils.synthesizeKey("KEY_Escape");
  await hidden;
  BrowserTestUtils.removeTab(tab);
});

add_task(async function settings_list_gone() {
  await BrowserTestUtils.withNewTab("about:preferences#paneWhimsyAI", async browser => {
    const doc = browser.contentDocument;
    await TestUtils.waitForCondition(() => doc.getElementById("whimsyAIPage"), "Settings › AI is up");
    ok(!doc.getElementById("whimsyAIWatchList"), "The watch list left Settings");
  });
});
