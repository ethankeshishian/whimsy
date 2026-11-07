/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { WhimsyArchive, REASON_KEY } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyArchive.sys.mjs"
);
const { WhimsyQuickWindow } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyQuickWindow.sys.mjs"
);
const { SessionStore } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs"
);
const { WhimsyFormProtection } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyFormProtection.sys.mjs"
);

const HOUR = 3600 * 1000;
const BASE = "https://example.com/?mini-archive-";
const miniWindows = new Set();
const entries = () => WhimsyArchive.listEntries(window).filter(e => e.url.startsWith(BASE));

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["whimsy.feature.quick-window", true],
      ["whimsy.feature.mini-tabs", true],
      ["whimsy.feature.auto-archive-tabs", true],
      ["whimsy.feature.archive-view", true],
      ["whimsy.mini.archive-after", "6h"],
    ],
  });
  registerCleanupFunction(async () => {
    for (const win of miniWindows) {
      if (!win.closed) {
        await BrowserTestUtils.closeWindow(win);
      }
    }
    for (const tab of [...gBrowser.tabs]) {
      if (tab.linkedBrowser.currentURI.spec.startsWith(BASE)) {
        BrowserTestUtils.removeTab(tab);
      }
    }
    for (const entry of entries()) {
      WhimsyArchive.forget(window, entry.closedId);
    }
  });
});

async function openMini(name) {
  const urls = [BASE + name + "-first", BASE + name + "-second"];
  const win = WhimsyQuickWindow.open(urls[0], { opener: window });
  miniWindows.add(win);
  await WhimsyQuickWindow.whenReady(win);
  await TestUtils.waitForCondition(
    () => win.gBrowser.selectedBrowser.currentURI.spec == urls[0],
    "Mini loaded its first page"
  );
  await SpecialPowers.spawn(win.gBrowser.selectedBrowser, [], () =>
    ContentTaskUtils.waitForCondition(() => content.document.readyState == "complete")
  );
  const added = BrowserTestUtils.waitForNewTab(win.gBrowser, urls[1], true);
  WhimsyQuickWindow.openLinkTab(win, urls[1]);
  await added;
  await SimpleTest.promiseFocus(win);
  return { win, urls };
}

async function idleMini(win, hours = 7) {
  await SimpleTest.promiseFocus(window);
  await TestUtils.waitForCondition(() => !win.document.hasFocus(), "Mini is inactive");
  win._whimsyMiniLastActive = Date.now() - hours * HOUR;
}

async function closeMini(win) {
  if (!win.closed) {
    await BrowserTestUtils.closeWindow(win);
  }
}

add_task(async function test_idle_mini_archives_all_pages_and_restores_in_main_window() {
  const { win, urls } = await openMini("idle");
  await idleMini(win);
  const closed = BrowserTestUtils.domWindowClosed(win);
  WhimsyArchive.sweepTick(win);
  await closed;
  ok(win.closed, "Seven hours inactive closes Mini");
  const archived = entries().filter(e => urls.includes(e.url));
  is(archived.length, 2, "Both pages are in the Archive, including the selected page");
  ok(archived.every(e => e.reason == "mini"), "Both pages have the Mini reason");
  ok(archived[0].groupId.startsWith("mini-"), "The window has a Mini archive group");
  is(archived[0].groupId, archived[1].groupId, "Both pages share the group");

  const tab = WhimsyArchive.restore(window, archived[0].closedId);
  ok(tab, "A Mini page can be restored from the Archive");
  is(tab.documentGlobal, window, "It restores into the main window");
  await TestUtils.waitForCondition(
    () => tab.linkedBrowser.currentURI.spec == archived[0].url,
    "The stored page is restored"
  );
  ok(!entries().some(e => e.closedId == archived[0].closedId), "Restoring removes the entry");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_audio_and_picture_in_picture_protect_the_whole_mini() {
  for (const attr of ["soundplaying", "pictureinpicture"]) {
    const { win, urls } = await openMini(attr);
    const tab = win.gBrowser.selectedTab;
    try {
      tab.setAttribute(attr, "true");
      ok(attr == "soundplaying" ? tab.soundPlaying : tab.pictureinpicture, "The media exemption is active");
      await idleMini(win);
      WhimsyArchive.sweepTick(win);
      ok(!win.closed, "A Mini with protected media stays open");
      is(WhimsyQuickWindow.pages(win).length, 2, "Neither page is swept");
      ok(!entries().some(e => urls.includes(e.url)), "No page was archived");
    } finally {
      tab.removeAttribute(attr);
      await closeMini(win);
    }
  }
});

add_task(async function test_form_protection_keeps_the_whole_mini() {
  const { win, urls } = await openMini("form");
  const protectedTab = win.gBrowser.selectedTab;
  const original = WhimsyFormProtection.isFormProtected;
  WhimsyFormProtection.isFormProtected = tab => tab == protectedTab || original.call(WhimsyFormProtection, tab);
  try {
    await idleMini(win);
    WhimsyArchive.sweepTick(win);
    ok(!win.closed, "A form-protected Mini stays open");
    is(WhimsyQuickWindow.pages(win).length, 2, "Both pages stay");
    ok(!entries().some(e => urls.includes(e.url)), "Neither page is archived");
  } finally {
    WhimsyFormProtection.isFormProtected = original;
    await closeMini(win);
  }
});

add_task(async function test_recently_active_and_focused_minis_stay_open() {
  const { win, urls } = await openMini("recent");
  try {
    ok(Number.isFinite(win._whimsyMiniLastActive), "Opening Mini initializes its clock");
    win._whimsyMiniLastActive = Date.now() - 7 * HOUR;
    WhimsyArchive.sweepTick(win);
    ok(!win.closed, "The Mini being viewed never archives");
    await SimpleTest.promiseFocus(window);
    await TestUtils.waitForCondition(
      () => Date.now() - win._whimsyMiniLastActive < HOUR,
      "Deactivating Mini resets its clock"
    );
    await idleMini(win, 1);
    // An old background tab must not trigger the ordinary per-tab sweep.
    for (const tab of win.gBrowser.tabs) {
      Object.defineProperty(tab, "lastAccessed", {
        configurable: true,
        value: Date.now() - 48 * HOUR,
      });
    }
    WhimsyArchive.sweepTick(win);
    WhimsyArchive.sweepWindow(win);
    ok(!win.closed, "One hour of inactivity is below the six-hour threshold");
    is(WhimsyQuickWindow.pages(win).length, 2, "Mini bypasses the per-tab sweep");
    ok(!entries().some(e => urls.includes(e.url)), "Neither page is archived");
  } finally {
    await closeMini(win);
  }
});

add_task(async function test_never_disables_mini_auto_archive() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.mini.archive-after", "never"]] });
  const { win, urls } = await openMini("never");
  try {
    await idleMini(win, 48);
    WhimsyArchive.sweepTick(win);
    ok(!win.closed, "Never leaves an inactive Mini open");
    is(WhimsyQuickWindow.pages(win).length, 2, "Both pages stay");
    ok(!entries().some(e => urls.includes(e.url)), "Neither page is archived");
  } finally {
    await closeMini(win);
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_cmd_w_and_window_close_use_the_mini_reason() {
  const { win, urls } = await openMini("manual");
  try {
    // Mini overrides any old archive tag only when the page actually closes.
    SessionStore.setCustomTabValue(win.gBrowser.selectedTab, REASON_KEY, "tree");
    EventUtils.synthesizeKey("w", { accelKey: true }, win);
    await TestUtils.waitForCondition(() => entries().some(e => e.url == urls[1]), "Cmd+W archives the page");
    is(entries().find(e => e.url == urls[1]).reason, "mini", "Cmd+W uses the Mini reason");
    ok(!win.closed, "The other page keeps Mini open");
    await closeMini(win);
    const remaining = entries().filter(e => urls.includes(e.url));
    is(remaining.length, 2, "Closing Mini also archives its remaining page exactly once");
    ok(remaining.every(e => e.reason == "mini"), "Window close uses the Mini reason too");
  } finally {
    await closeMini(win);
  }
});

add_task(async function test_cmd_o_adopts_without_archiving() {
  const { win, urls } = await openMini("adopt");
  const before = new Set(gBrowser.tabs);
  try {
    EventUtils.synthesizeKey("o", { accelKey: true }, win);
    await TestUtils.waitForCondition(() => win.closed, "Cmd+O moves the pages and closes Mini");
    const landed = [...gBrowser.tabs].filter(tab => !before.has(tab));
    is(landed.length, 2, "Both pages were adopted into the main window");
    ok(!entries().some(e => urls.includes(e.url)), "Adoption creates no Archive entries");
    ok(landed.every(tab => !SessionStore.getCustomTabValue(tab, REASON_KEY)), "Adopted pages carry no Mini tag");
  } finally {
    await closeMini(win);
    for (const tab of [...gBrowser.tabs].filter(tab => !before.has(tab))) {
      BrowserTestUtils.removeTab(tab);
    }
  }
});
