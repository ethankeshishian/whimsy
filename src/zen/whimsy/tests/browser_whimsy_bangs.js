/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave3/cmdbar: offline bangs (WhimsyBangs) and the Settings editor.

ChromeUtils.defineESModuleGetters(this, {
  UrlbarTestUtils: "resource://testing-common/UrlbarTestUtils.sys.mjs",
  WhimsyBangs: "resource:///modules/whimsy/WhimsyBangs.sys.mjs",
});

const FEATURE = "whimsy.feature.offline-bangs";
const CUSTOM = "whimsy.bangs.custom";

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [[FEATURE, true]] });
  // Normally done by Whimsy.initWindow; calling it again is a no-op.
  WhimsyBangs.init();
  registerCleanupFunction(() => Services.prefs.clearUserPref(CUSTOM));
});

add_task(async function test_bundled_catalog() {
  Services.prefs.clearUserPref(CUSTOM);
  const table = WhimsyBangs.parse(WhimsyBangs.DEFAULT_BANGS);
  is(table.size, 100, "100 unique bundled bangs");
  for (const key of ["w", "yt", "gh", "g", "ddg", "a", "r", "so", "mdn", "maps", "imdb", "wa"]) {
    ok(table.has(key), `!${key} ships`);
  }
  for (const [key] of table) {
    const result = WhimsyBangs.resolve(`!${key} snow & 雪/#?`);
    ok(result?.url.includes(encodeURIComponent("snow & 雪/#?")), `!${key} encodes the query as data`);
    ok(/^https:\/\//.test(result.url), `!${key} goes to https`);
  }
});

add_task(async function test_resolve_forms() {
  Services.prefs.clearUserPref(CUSTOM);
  is(WhimsyBangs.resolve("!w black holes").url, "https://en.wikipedia.org/w/index.php?search=black%20holes", "Leading bang");
  is(WhimsyBangs.resolve("cats !yt").url, "https://www.youtube.com/results?search_query=cats", "Trailing bang");
  is(WhimsyBangs.resolve("  !GH whimsy  ").url, "https://github.com/search?q=whimsy", "Case and whitespace");
  is(WhimsyBangs.resolve("!gh").url, "https://github.com/", "A bare bang opens the site");
  for (const input of ["!unknown test", "ordinary search", "test!w", "!w query !gh", "", "   ", "!w \ud800", "!", "! w test"]) {
    is(WhimsyBangs.resolve(input), null, `Left to normal search: ${JSON.stringify(input)}`);
  }
  await SpecialPowers.pushPrefEnv({ set: [[FEATURE, false]] });
  is(WhimsyBangs.resolve("!w test"), null, "Switch off: no bangs");
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_editing_is_atomic() {
  WhimsyBangs.save("!w https://example.com/search?q={{{s}}}\n\n!New https://example.org/{{{s}}}");
  is(WhimsyBangs.resolve("!w new").url, "https://example.com/search?q=new", "An override applies at once");
  is(WhimsyBangs.resolve("!new x").url, "https://example.org/x", "Added bang (keys are case-insensitive)");
  is(WhimsyBangs.resolve("!gh removed"), null, "Bangs not in the list are gone");
  const bad = [
    ["!x javascript:alert({{{s}}})", "1"],
    ["!x https://user:pass@example.com/?q={{{s}}}", "1"],
    ["!x https://example.com/", "1"],
    ["!ok https://example.com/?q={{{s}}}\n!x https://example.com/{{{s}}}/{{{s}}}", "2"],
    ["!x https://example.com/?q={{{s}}}\n!X https://example.org/?q={{{s}}}", "2"],
    ["x https://example.com/?q={{{s}}}", "1"],
    ["x".repeat(100001), "limit"],
  ];
  for (const [text, where] of bad) {
    Assert.throws(() => WhimsyBangs.save(text), new RegExp(`^Error: ${where}$`), `Rejected at ${where}`);
    is(WhimsyBangs.resolve("!w new").url, "https://example.com/search?q=new", "The working list is kept");
  }
  WhimsyBangs.save("");
  is(WhimsyBangs.resolve("!w new"), null, "A saved empty list means no bangs");
  WhimsyBangs.reset();
  ok(!Services.prefs.prefHasUserValue(CUSTOM), "Restore Defaults clears the pref");
  is(WhimsyBangs.parse(WhimsyBangs.text).size, 100, "Defaults are back");
  Services.prefs.setStringPref(CUSTOM, "corrupt");
  is(WhimsyBangs.resolve("!w test"), null, "A corrupt pref falls back to normal search");
  Services.prefs.clearUserPref(CUSTOM);
});

add_task(async function test_command_bar_navigation() {
  Services.prefs.setStringPref(CUSTOM, "!local https://example.com/?bang={{{s}}}");
  try {
    for (const isPrivate of [false, true]) {
      const win = isPrivate ? await BrowserTestUtils.openNewBrowserWindow({ private: true }) : window;
      // Its own tab: navigating the window's first tab left example.com open
      // for every later test file.
      const tab = isPrivate ? null : await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
      try {
        await UrlbarTestUtils.promiseAutocompleteResultPopup({ window: win, waitForFocus: SimpleTest.waitForFocus, value: "!local red & blue" });
        const { result } = await UrlbarTestUtils.getDetailsOfResultAt(win, 0);
        is(result.providerName, "WhimsyBangs", `Bang wins the heuristic (private: ${isPrivate})`);
        ok(result.heuristic, "Enter follows it");
        is(result.payload.url, "https://example.com/?bang=red%20%26%20blue", "Query is encoded");
        is(UrlbarTestUtils.getResultCount(win), 1, "No search suggestions compete with an explicit bang");
        const loaded = BrowserTestUtils.browserLoaded(win.gBrowser.selectedBrowser, false, result.payload.url);
        EventUtils.synthesizeKey("KEY_Enter", {}, win);
        await loaded;
        is(win.gBrowser.selectedBrowser.currentURI.spec, result.payload.url, "Loads the site directly, no search engine hop");
      } finally {
        if (isPrivate) {
          await BrowserTestUtils.closeWindow(win);
        } else {
          BrowserTestUtils.removeTab(tab);
        }
      }
    }

    await UrlbarTestUtils.promiseAutocompleteResultPopup({ window, waitForFocus, value: "!nothere test" });
    const { result } = await UrlbarTestUtils.getDetailsOfResultAt(window, 0);
    isnot(result.providerName, "WhimsyBangs", "Unknown bang: normal search");
    await UrlbarTestUtils.promisePopupClose(window);

    await SpecialPowers.pushPrefEnv({ set: [[FEATURE, false]] });
    await UrlbarTestUtils.promiseAutocompleteResultPopup({ window, waitForFocus, value: "!local test" });
    const off = await UrlbarTestUtils.getDetailsOfResultAt(window, 0);
    isnot(off.result.providerName, "WhimsyBangs", "Switch off: normal search");
    await UrlbarTestUtils.promisePopupClose(window);
    await SpecialPowers.popPrefEnv();
  } finally {
    Services.prefs.clearUserPref(CUSTOM);
  }
});

add_task(async function test_settings_editor() {
  Services.prefs.clearUserPref(CUSTOM);
  await BrowserTestUtils.withNewTab("about:preferences#search", async browser => {
    const doc = browser.contentDocument;
    await TestUtils.waitForCondition(() => doc.getElementById("whimsyBangsList"), "Bangs group inserted");
    const list = doc.getElementById("whimsyBangsList");
    const status = doc.getElementById("whimsyBangsStatus");
    is(list.value, WhimsyBangs.DEFAULT_BANGS, "Shows the bundled list");

    list.value = "!local https://example.com/?q={{{s}}}";
    doc.getElementById("whimsyBangsSave").doCommand();
    is(WhimsyBangs.resolve("!local test").url, "https://example.com/?q=test", "Save applies at once");
    is(status.getAttribute("data-l10n-id"), "whimsy-bangs-saved", "Confirms the save");

    list.value = "!ok https://example.com/?q={{{s}}}\ninvalid";
    doc.getElementById("whimsyBangsSave").doCommand();
    is(list.getAttribute("aria-invalid"), "true", "Invalid list is flagged accessibly");
    is(status.getAttribute("data-l10n-id"), "whimsy-bangs-invalid", "Explains the error");
    is(JSON.parse(status.getAttribute("data-l10n-args")).line, 2, "Names the bad line");
    is(WhimsyBangs.resolve("!local test").url, "https://example.com/?q=test", "The saved list is untouched");

    doc.getElementById("whimsyBangsReset").doCommand();
    is(list.value, WhimsyBangs.DEFAULT_BANGS, "Restore Defaults refills the list");
    ok(!list.hasAttribute("aria-invalid"), "Error state cleared");
    ok(!Services.prefs.prefHasUserValue(CUSTOM), "Pref cleared");

    const checkbox = doc.getElementById("whimsyBangsEnabled");
    checkbox.click();
    await TestUtils.waitForCondition(() => !Services.prefs.getBoolPref(FEATURE), "Checkbox turns bangs off");
    ok(list.disabled, "List disabled while off");
    checkbox.click();
    await TestUtils.waitForCondition(() => Services.prefs.getBoolPref(FEATURE), "And back on");
    ok(!list.disabled, "List enabled again");
  });
});
