/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Fire button, W23 redesign: one row ("Fire Button…") replaces the old
// three (This Profile / Everywhere / Forget About This Site), with settings
// remembered in whimsy.fire.last (range, spaces, items, AI data included).
// "Forget About This Site…" is unrelated (it doesn't end a session) and
// keeps its own small surface. The real ForgetAboutSite / Services.clearData
// calls are stubbed or recorded so the shared test profile isn't wiped.

const { WhimsyFireButton } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyFireButton.sys.mjs");
const { WhimsySurface } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySurface.sys.mjs");
const { WhimsyProfiles } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyProfiles.sys.mjs");
const { WhimsyAIStore } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIStore.sys.mjs");
const { WhimsySpaceLock } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySpaceLock.sys.mjs");
const { PrivateBrowsingUtils } = ChromeUtils.importESModule("resource://gre/modules/PrivateBrowsingUtils.sys.mjs");

const LAST_PREF = "whimsy.fire.last";
const startTabs = new Set(gBrowser.tabs);
registerCleanupFunction(() => {
  Services.prefs.clearUserPref(LAST_PREF);
  for (const tab of gBrowser.tabs.filter(t => !startTabs.has(t))) {
    if (tab.isConnected && !tab.closing) {
      if (tab.pinned) {
        gBrowser.unpinTab(tab);
      }
      BrowserTestUtils.removeTab(tab);
    }
  }
});

// W14 21.5: a prompt that asks lands in the middle of the page, both ways.
async function atSizes(fn) {
  for (const size of [null, [800, 500]]) {
    const was = [window.outerWidth, window.outerHeight];
    if (size) {
      window.resizeTo(...size);
      await TestUtils.waitForCondition(() => Math.abs(window.outerHeight - Math.max(size[1], 495)) < 40,
        `The window is about ${size.join("x")}`);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }
    try {
      await fn(size ? size.join("x") : "full-size");
    } finally {
      if (size) {
        window.resizeTo(...was);
        await TestUtils.waitForCondition(() => Math.abs(window.outerHeight - was[1]) < 2, "The window is its size again");
      }
    }
  }
}

async function assertCentred(panel, what) {
  const gaps = () => {
    const box = panel.getOuterScreenRect();
    const left = box.left - window.mozInnerScreenX;
    const top = box.top - window.mozInnerScreenY;
    return { start: left, end: window.innerWidth - left - box.width, top, bottom: window.innerHeight - top - box.height };
  };
  await TestUtils.waitForCondition(() => Math.abs(gaps().top - gaps().bottom) < 3 && Math.abs(gaps().start - gaps().end) < 3,
    `${what}: settles in the middle`).catch(() => {});
  const g = gaps();
  Assert.less(Math.abs(g.start - g.end), 3, `${what}: centred horizontally`);
  Assert.less(Math.abs(g.top - g.bottom), 3, `${what}: centred vertically`);
}

async function openFire(win = window, options) {
  const shown = BrowserTestUtils.waitForEvent(win.document, "popupshown", true, e => e.target.id == "whimsyFirePanel");
  WhimsyFireButton.openPanel(win, options);
  await shown;
  const panel = win.document.getElementById("whimsyFirePanel");
  await win.document.l10n.translateFragment(panel);
  return panel;
}
async function closeFire(panel) {
  if (panel.state == "open") {
    const hidden = BrowserTestUtils.waitForEvent(panel, "popuphidden");
    panel.hidePopup();
    await hidden;
  }
}

function itemInput(panel, id) {
  return panel.querySelector(`.whimsy-fire-items [data-l10n-id="whimsy-fire-item-${id}"]`)?.closest("label")?.querySelector("input");
}

async function pickRange(panel, win, value) {
  const button = panel.querySelector("#whimsy-fire-range");
  const shown = BrowserTestUtils.waitForEvent(win.document, "popupshown", true, e => e.target.id == "whimsy-fire-range-list");
  button.click();
  await shown;
  const list = win.document.getElementById("whimsy-fire-range-list");
  list.querySelector(`[role="option"][data-value="${value}"]`).click();
  await TestUtils.waitForCondition(() => !list.isConnected, "The range picker closes on a pick");
}

add_task(function test_closable_tabs_excludes_pinned_and_essentials() {
  const fakeEssential = { pinned: false, closing: false, hasAttribute: name => name == "zen-essential" };
  const fakePinned = { pinned: true, closing: false, hasAttribute: () => false };
  const fakeNormal = { pinned: false, closing: false, hasAttribute: () => false };
  const result = WhimsyFireButton.closableTabs(window, [fakeEssential, fakePinned, fakeNormal]);
  is(result.length, 1, "Only the plain tab is closable");
  is(result[0], fakeNormal, "...and it's the right one");
});

add_task(async function test_burn_tabs_closes_only_closable_ones() {
  const pinned = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?pinned-survivor");
  gBrowser.pinTab(pinned);
  const plain = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?burn-me");
  const before = gBrowser.tabs.length;
  WhimsyFireButton.burnTabs(window, [pinned, plain], "test");
  await TestUtils.waitForCondition(() => gBrowser.tabs.length == before - 1, "Only the plain tab closed");
  ok(pinned.isConnected, "The pinned tab survived");
  ok(!plain.isConnected, "The plain tab didn't");
  gBrowser.unpinTab(pinned);
  BrowserTestUtils.removeTab(pinned);
});

add_task(function test_everything_flags() {
  const C = Ci.nsIClearDataService;
  is(WhimsyFireButton.forgetFlags,
    C.CLEAR_HISTORY | C.CLEAR_COOKIES_AND_SITE_DATA | C.CLEAR_ALL_CACHES | C.CLEAR_DOWNLOADS,
    "History, cookies, site data, cache and the download list");
  is(WhimsyFireButton.siteFlags, C.CLEAR_COOKIES_AND_SITE_DATA | C.CLEAR_ALL_CACHES,
    "Fire in This Profile clears a site's cookies, site data and cache");
});

add_task(function test_first_time_defaults() {
  Services.prefs.clearUserPref(LAST_PREF);
  const settings = WhimsyFireButton.lastSettings();
  is(settings.range, "hour", "Last hour by default");
  is(settings.allSpaces, false, "This profile, not every space");
  Assert.deepEqual(
    settings.items,
    { tabs: true, history: true, aiChats: true, agentActivity: true, index: true, memory: false, routineResults: false, downloads: false },
    "Today's browsing items plus that hour's AI chats, agent activity and the index; memory, routine results and downloads start off");
});

add_task(async function test_one_row_repeats_last_settings() {
  const { WhimsyCommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommands.sys.mjs");
  ok(WhimsyCommands.get("cmd_whimsyFireButton"), "One Fire Button… row");
  ok(!WhimsyCommands.get("cmd_whimsyFireProfile"), "Fire in This Profile is gone");
  ok(!WhimsyCommands.get("cmd_whimsyFireEverywhere"), "Fire Everywhere is gone");
  ok(WhimsyCommands.get("cmd_whimsyForgetSite"), "Forget About This Site… stays, on its own");
  const title = WhimsyCommands.title(WhimsyCommands.get("cmd_whimsyFireButton"));
  ok(title.startsWith("Fire Button…"), "The row names itself");
  const args = WhimsyFireButton.summaryArgs(window);
  is(title, await document.l10n.formatValue("whimsy-action-fire-button", args), "...and its tag shows what the last settings will do");
  ok(/\(.+, .+\)$/.test(title), "(range, scope), in Fluent's words");
});

add_task(async function test_fire_surface_shows_range_scope_and_items() {
  Services.prefs.clearUserPref(LAST_PREF);
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?fire-sheet");
  const panel = await openFire();
  try {
    ok(panel.classList.contains("whimsy-surface"), "It is a Whimsy surface");
    ok(!panel.querySelector("menupopup, menuitem, toolbarseparator"), "and no native rows");
    ok(panel.querySelector("#whimsy-fire-range"), "A range dropdown");
    ok(panel.querySelector('[data-l10n-id="whimsy-fire-all-spaces"]'), "An all-spaces row");
    for (const [id, on] of Object.entries(WhimsyFireButton.lastSettings().items)) {
      const input = itemInput(panel, id);
      ok(input, `An item row for ${id}`);
      is(input.checked, on, `${id} starts ${on ? "ticked" : "unticked"} to match the defaults`);
    }
    const kept = panel.querySelector("#whimsy-fire-kept");
    ok(kept.textContent.includes("AI settings"), "Always kept now names AI settings too");
    ok(panel.querySelector(".whimsy-fire-undone-note"), "Can't be undone is spelled out before the press");
    const forget = panel.querySelector("#whimsy-fire-forget");
    ok(forget, "The red Fire button");

    // Unticking every item disables it (fire-2.6).
    for (const id of WhimsyFireButton.ITEM_IDS) {
      const input = itemInput(panel, id);
      if (input.checked) {
        input.click();
      }
    }
    await TestUtils.waitForCondition(() => forget.disabled, "Nothing selected: Fire disables itself");
  } finally {
    await closeFire(panel);
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function test_second_ask_only_for_all_time_all_spaces_memory() {
  Services.prefs.clearUserPref(LAST_PREF);
  const original = WhimsyFireButton.burn;
  let burned = 0;
  WhimsyFireButton.burn = async () => (burned++, {});
  try {
    // Defaults (Last hour, this profile, no memory): no second ask.
    let panel = await openFire();
    panel.querySelector("#whimsy-fire-forget").click();
    is(panel.dataset.step, undefined, "The default choice runs without a second step");
    await TestUtils.waitForCondition(() => burned == 1, "It ran");
    await closeFire(panel);

    // All time: asks once more.
    panel = await openFire();
    await pickRange(panel, window, "all");
    panel.querySelector("#whimsy-fire-forget").click();
    is(panel.dataset.step, "confirm", "All time asks again, in the same surface");
    is(panel.state, "open", "...without closing");
    panel.querySelector("#whimsy-fire-back").click();
    await closeFire(panel);

    // All spaces: asks once more.
    panel = await openFire();
    panel.querySelector('[data-l10n-id="whimsy-fire-all-spaces"]')?.closest("label")?.querySelector("input")?.click();
    panel.querySelector("#whimsy-fire-forget").click();
    is(panel.dataset.step, "confirm", "All spaces asks again");
    panel.querySelector("#whimsy-fire-back").click();
    await closeFire(panel);

    // Memory ticked: asks once more.
    panel = await openFire();
    itemInput(panel, "memory").click();
    panel.querySelector("#whimsy-fire-forget").click();
    is(panel.dataset.step, "confirm", "Ticking Memory asks again");
    const accept = panel.querySelector("#whimsy-fire-confirm-accept");
    ok(accept, "...with its own accept button");
    accept.click();
    await TestUtils.waitForCondition(() => burned == 2, "Confirming runs it");
  } finally {
    WhimsyFireButton.burn = original;
  }
});

add_task(async function test_ai_items_respect_range() {
  const calls = [];
  const original = WhimsyAIStore.clear;
  WhimsyAIStore.clear = async opts => calls.push(opts);
  const stubs = {
    burnTabs: () => 0, purgeClosed: async () => {}, profileVisits: async () => [],
    clearSiteData: async () => {}, removeVisit: () => {}, clearData: async () => {}, clearFormHistory: async () => {},
  };
  const originals = {};
  for (const [name, fn] of Object.entries(stubs)) {
    originals[name] = WhimsyFireButton[name];
    WhimsyFireButton[name] = fn;
  }
  try {
    await WhimsyFireButton.burn(window, {
      range: "today", allSpaces: false, spaceIds: null,
      items: { tabs: false, history: false, aiChats: true, agentActivity: false, index: false, memory: true, routineResults: false, downloads: false },
    });
    is(calls.length, 1, "AI items clear in one WhimsyAIStore.clear call");
    ok(calls[0].since > 0, "...scoped to the chosen range (not all time)");
    Assert.deepEqual(new Set(calls[0].kinds), new Set(["chats", "reports", "memory"]), "...only the ticked kinds");
  } finally {
    WhimsyAIStore.clear = original;
    Object.assign(WhimsyFireButton, originals);
  }
});

add_task(function test_hidden_space_listed_only_unlocked() {
  const profileId = WhimsyFireButton.profileId(window);
  const space = { uuid: "fire-test-hidden-space", whimsyHidden: true, whimsyScratch: false };
  const originalSpaces = WhimsyProfiles.spaces;
  const originalProfileOf = WhimsyProfiles.profileIdOfSpace;
  WhimsyProfiles.spaces = () => [space];
  WhimsyProfiles.profileIdOfSpace = () => profileId;
  const originalCovered = WhimsySpaceLock.isCovered;
  try {
    WhimsySpaceLock.isCovered = () => true;
    is(WhimsyFireButton.profileSpaces(window, profileId).length, 0, "A locked hidden space is left out");
    WhimsySpaceLock.isCovered = () => false;
    is(WhimsyFireButton.profileSpaces(window, profileId).length, 1, "...but listed once unlocked");
  } finally {
    WhimsyProfiles.spaces = originalSpaces;
    WhimsyProfiles.profileIdOfSpace = originalProfileOf;
    WhimsySpaceLock.isCovered = originalCovered;
  }
});

// "Forget About This Site…": its own small surface, unrelated to Fire's
// settings since it isn't ending a session. Nothing runs until its button.
add_task(async function test_forget_site_opens_separate_surface() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://www.example.com/?forget-site");
  const original = WhimsyFireButton.burnSite;
  let burned = 0;
  WhimsyFireButton.burnSite = async () => (burned++, { tabs: 0 });
  let dialogs = 0;
  const onDialog = () => dialogs++;
  Services.obs.addObserver(onDialog, "common-dialog-loaded");
  try {
    const shown = BrowserTestUtils.waitForEvent(document, "popupshown", true, e => e.target.id == "whimsyFirePanel");
    WhimsyFireButton.forgetSite(window);
    await shown;
    const panel = document.getElementById("whimsyFirePanel");
    const forget = panel.querySelector("#whimsy-fire-forget");
    Assert.deepEqual(document.l10n.getAttributes(forget), { id: "whimsy-fire-run-site", args: { site: "example.com" } },
      "The red button names the site");
    EventUtils.synthesizeKey("KEY_Enter", {}, window);
    is(burned, 0, "Return alone forgets nothing");
    is(panel.state, "open", "...and keeps it open");
    const toastShown = TestUtils.waitForCondition(() => toastFor("whimsy-fire-done-site-title"), "A toast says it forgot the site");
    forget.doCommand();
    await toastShown;
    is(burned, 1, "The red button forgets it");
    is(dialogs, 0, "No system dialog");
  } finally {
    Services.obs.removeObserver(onDialog, "common-dialog-loaded");
    WhimsyFireButton.burnSite = original;
    closeToasts();
    BrowserTestUtils.removeTab(tab);
  }
});

// Private window: closes just that window's tabs; never reaches another
// private window's shared browsing-session jar (there's no per-window id
// to scope a clear to, so burnPrivateWindow no longer tries to).
add_task(async function test_private_window_only_itself() {
  const win1 = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  const win2 = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  try {
    ok(PrivateBrowsingUtils.isWindowPrivate(win1), "A real private window");
    const panel = win1.document;
    const shown = BrowserTestUtils.waitForEvent(panel, "popupshown", true, e => e.target.id == "whimsyFirePanel");
    WhimsyFireButton.openPanel(win1);
    await shown;
    const surface = panel.getElementById("whimsyFirePanel");
    ok(!surface.querySelector("#whimsy-fire-range"), "No range/items picker for a private window");
    ok(surface.querySelector("#whimsy-fire-forget"), "Just one question and one button");
    await closeFire(surface);

    const before = win2.gBrowser.tabs.length;
    const result = await WhimsyFireButton.burnPrivateWindow(win1);
    ok(typeof result.tabs == "number", "burnPrivateWindow reports how many tabs it closed");
    is(win2.gBrowser.tabs.length, before, "The other private window's tabs are untouched");
    ok(!win1.closed, "This window stays open, with a fresh session");
  } finally {
    await BrowserTestUtils.closeWindow(win1);
    await BrowserTestUtils.closeWindow(win2);
  }
});

// Settings › AI, turned off: "Forget everything…" opens Fire with only the
// AI items ticked (not tabs/history/downloads).
add_task(async function test_forget_everything_opens_ai_items() {
  Services.prefs.clearUserPref(LAST_PREF);
  const panel = await openFire(window, { aiOnly: true });
  try {
    const AI_IDS = ["aiChats", "agentActivity", "index", "memory", "routineResults"];
    for (const id of WhimsyFireButton.ITEM_IDS) {
      const input = itemInput(panel, id);
      is(input.checked, AI_IDS.includes(id), `${id}: ${AI_IDS.includes(id) ? "ticked (an AI item)" : "unticked"}`);
    }
  } finally {
    await closeFire(panel);
  }
});

// wave5/uxfix: the flame flash stays under Zen's toasts, and reduced motion
// drops it entirely (the toast confirms instead).
add_task(async function test_fire_flash_layering_and_reduced_motion() {
  const root = document.documentElement;
  root.setAttribute("whimsy-fire-burning", "");
  try {
    const flash = getComputedStyle(root, "::after");
    Assert.less(Number(flash.zIndex), 1000, "The flash sits below Zen's toast layer");
    await SpecialPowers.pushPrefEnv({ set: [["ui.prefersReducedMotion", 1]] });
    await TestUtils.waitForCondition(() => getComputedStyle(root, "::after").animationName == "none",
      "Reduced motion drops the flash");
    is(getComputedStyle(root, "::after").opacity, "0", "...so nothing shows");
    await SpecialPowers.popPrefEnv();
  } finally {
    root.removeAttribute("whimsy-fire-burning");
  }
});

add_task(async function test_fire_flash_never_closes_a_surface() {
  const root = document.documentElement;
  const shown = BrowserTestUtils.waitForEvent(document, "popupshown", true, e => e.target.id == "whimsyFirePanel");
  const panel = WhimsyFireButton.openPanel(window);
  root.setAttribute("whimsy-fire-burning", "");
  root.getBoundingClientRect();
  root.removeAttribute("whimsy-fire-burning");
  await shown;
  is(panel.state, "open", "The surface opened through the flash");
  await closeFire(panel);
});

// Security review H2: burned tabs never come back. burn() closes tabs
// first, with no closed-tab entry, forgets closed tabs in scope already
// there, writes the session file, and only then clears. Data clearing is
// stubbed (the shared profile keeps its data).
add_task(async function test_fire_leaves_nothing_restorable() {
  const { SessionStore } = ChromeUtils.importESModule("moz-src:///browser/components/sessionstore/SessionStore.sys.mjs");
  const { TabStateFlusher } = ChromeUtils.importESModule("moz-src:///browser/components/sessionstore/TabStateFlusher.sys.mjs");
  const closedURLs = () => SessionStore.getClosedTabDataForWindow(window)
    .flatMap(item => (item.state?.entries ?? []).map(entry => entry.url));
  const stubs = { profileVisits: async () => [], clearSiteData: async () => {}, removeVisit: () => {},
    clearData: async () => {}, clearFormHistory: async () => {} };
  const originals = {};
  for (const [name, fn] of Object.entries(stubs)) {
    originals[name] = WhimsyFireButton[name];
    WhimsyFireButton[name] = fn;
  }
  const originalTabsOfSpaces = WhimsyFireButton.tabsOfSpaces;
  try {
    const BURNED = "https://example.com/?fire-h2-burned";
    const burned = await BrowserTestUtils.openNewForegroundTab(gBrowser, BURNED);
    await TabStateFlusher.flush(burned.linkedBrowser);
    WhimsyFireButton.tabsOfSpaces = () => [[window, [burned]]];
    await WhimsyFireButton.burn(window, {
      range: "hour", allSpaces: false, spaceIds: null,
      items: { tabs: true, history: false, aiChats: false, agentActivity: false, index: false, memory: false, routineResults: false, downloads: false },
    });
    ok(!burned.isConnected, "The burned tab closed");
    ok(!closedURLs().includes(BURNED), "It never entered the closed-tab list (Cmd+Shift+T brings it back nothing)");
  } finally {
    Object.assign(WhimsyFireButton, originals);
    WhimsyFireButton.tabsOfSpaces = originalTabsOfSpaces;
  }
});

// W10-58: the result toast replaces "Clearing…" in place, stays past Zen's
// usual timeout, and a failure offers Try Again.
add_task(async function test_fire_confirms_at_once_then_shows_the_result() {
  let finish;
  const slowBurn = () => new Promise(resolve => (finish = resolve));
  const running = WhimsyFireButton.run(window, slowBurn, "burn");
  const working = currentToast();
  ok(working, "A toast shows as soon as Fire runs, before clearing is done");
  is(working.messageId, "whimsy-fire-working-burn", "It says it's clearing");
  finish({ tabs: 2, items: ["aiChats"] });
  await running;
  const done = currentToast();
  is(done, working, "The result takes its place, without a second entrance");
  const message = done.element.querySelector("label");
  is(document.l10n.getAttributes(message).id, "whimsy-fire-done-burn-title", "and says it's done");
  const detail = done.element.querySelector(".description");
  await TestUtils.waitForCondition(() => detail.textContent.includes("tab") && detail.textContent.includes("AI chats"),
    "The second line, in Fluent, lists what went");
  await new Promise(resolve => setTimeout(resolve, 2500));
  ok(!done.closing && !done.closed, "and is still there after Zen's 2 seconds");
  done.close({ instant: true });

  let attempts = 0;
  const failing = WhimsyFireButton.run(window, async () => {
    attempts++;
    throw new Error("test");
  }, "burn");
  await failing;
  const failed = currentToast();
  is(failed.messageId, "whimsy-fire-failed-title", "A failure replaces it");
  const retry = failed.element.querySelector(".whimsy-toast-button");
  is(document.l10n.getAttributes(retry.querySelector(".whimsy-toast-button-label")).id, "whimsy-fire-retry", "with Try Again");
  await failed.shown;
  EventUtils.synthesizeMouseAtCenter(retry, {});
  await TestUtils.waitForCondition(() => attempts == 2, "Try Again runs it again");
  closeToasts();
});

add_task(async function test_fire_popup_opens_centred_on_the_window() {
  await atSizes(async size => {
    const panel = await openFire();
    await assertCentred(panel, `Fire (${size})`);
    await closeFire(panel);
  });
});
