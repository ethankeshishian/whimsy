/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W29/help: whimsy://help, the built-in manual. A left rail of sections plus
// What's new, a row per feature (name, sentence, live shortcut, settings
// link, dimmed when off), search that matches name/sentence/pane and
// highlights, and three ways in: F1, the Help menu, and the command bar.

const { WhimsyCommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommands.sys.mjs");
const { WhimsyProtocol } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyProtocol.sys.mjs");

const TAB_FEATURE = "cmd-tab-numbers"; // has a Settings pane (Tabs).
const TAB_PREF = `whimsy.feature.${TAB_FEATURE}`;
const TAB_PANE_ID = "paneZenTabManagement";
const NO_PANE_FEATURE = "ctrl-tab"; // on, but no individual Settings row.
const NO_PANE_PREF = `whimsy.feature.${NO_PANE_FEATURE}`;

async function openHelp() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:whimsy?help");
  const browser = gBrowser.selectedBrowser;
  const doc = browser.contentDocument;
  await TestUtils.waitForCondition(
    () => doc.getElementById("whimsy-help-list").children.length > 0,
    "The help page renders its rows"
  );
  return { tab, browser, doc };
}

registerCleanupFunction(() => {
  Services.prefs.clearUserPref(TAB_PREF);
  Services.prefs.clearUserPref(NO_PANE_PREF);
});

add_task(function test_command_is_registered() {
  const entry = WhimsyCommands.get("cmd_whimsyHelp");
  ok(entry, "cmd_whimsyHelp is registered");
  is(WhimsyCommands.title(entry), "Whimsy Help", "Its title is Whimsy Help");
  is(entry.inCommandBar, true, "It's in the command bar, so typing “help” finds it");
  Assert.deepEqual(
    WhimsyCommands.keywords("whimsy-keywords-help"),
    ["Help", "Manual", "Docs", "Documentation"],
    "Its search keywords"
  );
  const keyEl = entry.keyId && document.getElementById(entry.keyId);
  ok(keyEl, "It has a <key>");
  is(keyEl.getAttribute("keycode"), "VK_F1", "bound to F1 by default");
  is(WhimsyProtocol.route("whimsy://help").url, "about:whimsy?help", "whimsy://help opens the manual");
});

add_task(async function test_f1_opens_the_manual() {
  const opened = BrowserTestUtils.waitForNewTab(gBrowser, "about:whimsy?help", true);
  document.getElementById("cmd_whimsyHelp").doCommand();
  const tab = await opened;
  is(gBrowser.selectedBrowser.currentURI.spec, "about:whimsy?help", "F1 (cmd_whimsyHelp) opens the manual in a tab");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_page_lists_every_feature() {
  const { tab, browser, doc } = await openHelp();
  const data = await (await browser.contentWindow.fetch("chrome://browser/content/whimsy/whimsy-help.json")).json();
  ok(data.sections.length, "The generated content has sections");
  ok(data.features.length > 200, "and a row for (nearly) every FEATURES entry");
  for (const feature of data.features) {
    ok(feature.name, `${feature.id} has a name`);
    ok(feature.text, `${feature.id} has a sentence (overlay.py fails the build otherwise)`);
  }

  const $ = id => doc.getElementById(id);
  const counts = $("whimsy-help-rail").querySelectorAll(".whimsy-help-rail-count");
  is(
    Number(counts[0].textContent),
    data.features.length,
    "“All features” counts every row"
  );
  let total = 0;
  for (let i = 1; i <= data.sections.length; i++) {
    total += Number(counts[i].textContent);
  }
  is(total, data.features.length, "The section counts add up to the total");
  is($("whimsy-help-list").children.length, data.features.length, "Every feature is listed under All features");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_search_filters_and_highlights() {
  const { tab, doc } = await openHelp();
  const $ = id => doc.getElementById(id);
  const search = $("whimsy-help-search");

  search.value = "offline bang";
  search.dispatchEvent(new doc.defaultView.Event("input"));
  const rows = [...$("whimsy-help-list").children];
  ok(rows.length >= 1, "A matching query filters the list");
  ok(rows.every(row => /bang/i.test(row.textContent)), "Only matching rows show");
  ok(rows[0].querySelector("mark.whimsy-help-match"), "The match is highlighted");
  is($("whimsy-help-empty").hidden, true, "No empty state while something matches");

  search.value = "zzz-nothing-matches-this-zzz";
  search.dispatchEvent(new doc.defaultView.Event("input"));
  is($("whimsy-help-list").children.length, 0, "Nothing matches an unlikely query");
  is($("whimsy-help-empty").hidden, false, "The empty state shows");
  is(
    doc.l10n.getAttributes($("whimsy-help-empty")).id,
    "whimsy-help-empty-search",
    "with the empty-search message"
  );
  is(
    doc.l10n.getAttributes($("whimsy-help-empty")).args.query,
    "zzz-nothing-matches-this-zzz",
    "naming the query"
  );

  // Searching by a Settings pane name matches too (feature.pane).
  search.value = "Tabs";
  search.dispatchEvent(new doc.defaultView.Event("input"));
  ok(
    [...$("whimsy-help-list").children].some(row => row.textContent.includes("Cmd Tab Numbers")),
    "Searching a pane's name matches the features linked to it"
  );

  search.value = "";
  search.dispatchEvent(new doc.defaultView.Event("input"));
  is($("whimsy-help-list").children.length > 1, true, "Clearing the query restores the full list");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_whats_new_rail() {
  const { tab, doc } = await openHelp();
  const $ = id => doc.getElementById(id);
  const rail = $("whimsy-help-rail").querySelectorAll(".whimsy-help-rail-item");
  const whatsNew = [...rail].find(b => doc.l10n.getAttributes(b.querySelector(".whimsy-help-rail-name"))?.id == "whimsy-help-rail-whats-new");
  ok(whatsNew, "What's new is a rail row");

  whatsNew.click();
  is($("whimsy-help-list").hidden, true, "Selecting What's new hides the feature list");
  is($("whimsy-help-changelog").hidden, false, "and shows the changelog");
  const entries = $("whimsy-help-changelog").children;
  ok(entries.length >= 1 && entries.length <= 12, "At most the last 12 changelog entries");
  ok(
    [...entries].every(li => ["whimsy-changelog-new", "whimsy-changelog-improved", "whimsy-changelog-fixed"].includes(li.querySelector(".whimsy-help-changelog-kind").getAttribute("data-l10n-id"))),
    "Each entry reuses the home page's new/improved/fixed labels, not duplicate strings"
  );

  const all = [...rail].find(b => doc.l10n.getAttributes(b.querySelector(".whimsy-help-rail-name"))?.id == "whimsy-help-rail-all");
  all.click();
  is($("whimsy-help-list").hidden, false, "All features shows the list again");
  is($("whimsy-help-changelog").hidden, true, "and hides the changelog");
  BrowserTestUtils.removeTab(tab);
});

// Regression: renderRail() built its buttons with items.map(...) while
// appending the separator directly to the rail inside that same callback;
// the replaceChildren() that followed then wiped out the just-appended
// separator (it replaces every child, not just the ones it's given), so
// the line above What's new never actually rendered.
add_task(async function test_whats_new_has_a_separator_above_it() {
  const { tab, doc } = await openHelp();
  const rail = [...doc.getElementById("whimsy-help-rail").children];
  const sepIndex = rail.findIndex(el => el.className == "whimsy-help-rail-sep");
  const whatsNewIndex = rail.findIndex(b => {
    const name = b.querySelector?.(".whimsy-help-rail-name");
    return name && doc.l10n.getAttributes(name)?.id == "whimsy-help-rail-whats-new";
  });
  ok(sepIndex >= 0, "The rail has a separator");
  is(sepIndex, whatsNewIndex - 1, "right above What's new");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_off_feature_with_a_settings_pane() {
  Services.prefs.setBoolPref(TAB_PREF, false);
  const { tab, browser, doc } = await openHelp();
  const $ = id => doc.getElementById(id);
  const search = $("whimsy-help-search");
  search.value = "Cmd Tab Numbers";
  search.dispatchEvent(new doc.defaultView.Event("input"));
  const row = $("whimsy-help-list").children[0];
  ok(row, "The off feature still shows (listed and dimmed, per the design)");
  ok(row.classList.contains("is-off"), "and is dimmed");
  const link = row.querySelector(".whimsy-help-row-setting");
  is(
    doc.l10n.getAttributes(link).id,
    "whimsy-help-setting-off",
    "Off · Turn on in Settings › {pane}"
  );
  is(doc.l10n.getAttributes(link).args.pane, "Tabs", "naming its pane");

  const win = browser.documentGlobal;
  const original = win.openPreferences;
  let openedPane = null;
  win.openPreferences = pane => (openedPane = pane);
  try {
    link.click();
    is(openedPane, TAB_PANE_ID, "Clicking the link opens Settings at that pane");
  } finally {
    win.openPreferences = original;
  }
  BrowserTestUtils.removeTab(tab);
  Services.prefs.clearUserPref(TAB_PREF);
});

add_task(async function test_off_feature_with_no_settings_pane() {
  Services.prefs.setBoolPref(NO_PANE_PREF, false);
  const { tab, doc } = await openHelp();
  const $ = id => doc.getElementById(id);
  const search = $("whimsy-help-search");
  search.value = "Ctrl Tab";
  search.dispatchEvent(new doc.defaultView.Event("input"));
  const row = $("whimsy-help-list").children[0];
  ok(row && row.classList.contains("is-off"), "The feature is listed, dimmed");
  const label = row.querySelector(".whimsy-help-row-setting");
  is(doc.l10n.getAttributes(label).id, "whimsy-help-off-no-pane", "and just says Off (no Settings row to link to)");
  is(label.localName, "span", "with no click target, since there's nowhere to send it");
  BrowserTestUtils.removeTab(tab);
  Services.prefs.clearUserPref(NO_PANE_PREF);
});

// RULES-WORKER: every UI change gets a WCAG AA contrast assertion, in both
// schemes, plus screenshots.
add_task(async function test_contrast_and_screenshots() {
  const { tab, browser } = await openHelp();
  const win = browser.contentWindow;
  const doc = browser.contentDocument;

  function resolvedRGB(value) {
    const canvas = doc.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, 1, 1);
    ctx.fillStyle = value;
    ctx.fillRect(0, 0, 1, 1);
    return [...ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)];
  }
  function luminance([r, g, b]) {
    const lin = c => (c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  }
  function contrastRatio(a, b) {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  }

  for (const dark of [false, true]) {
    await whimsySetScheme(dark);
    try {
      await TestUtils.waitForCondition(
        () => win.matchMedia(`(prefers-color-scheme: ${dark ? "dark" : "light"})`).matches,
        "The help page follows the scheme"
      );
      const row = doc.querySelector(".whimsy-help-row");
      const name = row.querySelector(".whimsy-help-row-name");
      const text = row.querySelector(".whimsy-help-row-text");
      const bg = resolvedRGB(win.getComputedStyle(doc.body).backgroundColor);
      const nameRatio = contrastRatio(resolvedRGB(win.getComputedStyle(name).color), bg);
      const textRatio = contrastRatio(resolvedRGB(win.getComputedStyle(text).color), bg);
      Assert.greaterOrEqual(nameRatio, 4.5, `A row's name meets WCAG AA in ${dark ? "dark" : "light"} (${nameRatio.toFixed(2)}:1)`);
      Assert.greaterOrEqual(textRatio, 4.5, `A row's sentence meets WCAG AA in ${dark ? "dark" : "light"} (${textRatio.toFixed(2)}:1)`);
      await whimsyShot(`w29-help-page-${dark ? "dark" : "light"}`, browser.browsingContext.currentWindowGlobal);
    } finally {
      await SpecialPowers.popPrefEnv();
    }
  }
  BrowserTestUtils.removeTab(tab);
});

// W30: the page carries a Content Security Policy like the other
// about:whimsy pages.
add_task(async function test_page_has_a_csp() {
  const { tab, doc } = await openHelp();
  const csp = doc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content ?? "";
  ok(csp.includes("default-src chrome:"), `A CSP: ${csp}`);
  ok(csp.includes("object-src 'none'"), "with no plugins");
  BrowserTestUtils.removeTab(tab);
});
