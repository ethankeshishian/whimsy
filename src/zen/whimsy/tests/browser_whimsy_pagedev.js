/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave9/pagedev (W9-11): Fonts on This Page, Page Colors and Built With,
// grouped with the Font Inspector and Element Info in Tools ▸ Browser
// Tools. Runs against a local page (whimsy_pagedev.html) with a web font,
// known colours, Built With signals and an X-Powered-By header.

const { WhimsyPageDev, formatColor, hslOf, cssVariables } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyPageDev.sys.mjs"
);
const { WhimsyTechRules, RULES, CATEGORIES } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyTechRules.sys.mjs"
);
const { WhimsyCommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommands.sys.mjs");

const ROOT = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com");
const PAGE = ROOT + "whimsy_pagedev.html";
const FEATURE_PREF = "whimsy.feature.page-dev";

async function openPage(win = window) {
  const tab = await BrowserTestUtils.openNewForegroundTab(win.gBrowser, PAGE);
  // The web font must be loaded before the fonts are read.
  await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
    await content.document.fonts.ready;
  });
  return tab;
}

async function waitOpen(id, win = window) {
  await TestUtils.waitForCondition(() => win.document.getElementById(id)?.state == "open", `${id} opens`);
  const panel = win.document.getElementById(id);
  // Translate now so a message that would wipe a row's children shows up.
  await win.document.l10n.translateFragment(panel);
  return panel;
}

async function closeSheet(panel) {
  const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
  EventUtils.synthesizeKey("KEY_Escape", {}, panel.ownerGlobal);
  await hidden;
}

function rowTitle(row) {
  const label = row.querySelector(".whimsy-sheet-item-title");
  return label?.getAttribute("value") || label?.textContent || "";
}

function rowDetail(row) {
  return row.querySelector(".whimsy-sheet-item-detail")?.getAttribute("value") ?? "";
}

add_task(async function test_commands_menu_and_switch() {
  for (const [id, l10nId] of [
    ["cmd_whimsyPageFonts", "whimsy-action-page-fonts"],
    ["cmd_whimsyPageColors", "whimsy-action-page-colors"],
    ["cmd_whimsyBuiltWith", "whimsy-action-built-with"],
  ]) {
    const entry = WhimsyCommands.get(id);
    ok(entry, `${id} is a Whimsy command`);
    is(entry.l10nId, l10nId, `${id} has its name`);
    ok(entry.keyId, `${id} has an assignable shortcut`);
    is(entry.defaultKey, null, `${id} has no default shortcut`);
    ok(document.getElementById(id), `${id} has a <command>`);
  }

  // One group in Tools > Browser Tools: the three tools and both inspectors.
  const popup = document.getElementById("menuWebDeveloperPopup");
  ok(popup, "Tools > Browser Tools exists");
  const ids = [
    "menu_whimsyPageFonts",
    "menu_whimsyPageColors",
    "menu_whimsyBuiltWith",
    "menu_whimsyFontInspector",
    "menu_whimsyElementInfo",
  ];
  const tab = await openPage();
  WhimsyPageDev.updateMenu(window);
  for (const id of ids) {
    const item = document.getElementById(id);
    is(item?.parentElement, popup, `${id} is in Browser Tools`);
    ok(!item.hidden && !item.disabled, `${id} is shown and enabled on a web page`);
  }
  is(popup.lastElementChild.id, "menu_whimsyElementInfo", "The group is last in the menu");
  is(document.getElementById("menu_whimsyFontInspector").getAttribute("command"), "cmd_whimsyInspectFont",
    "Font Inspector row runs the existing command");
  // No duplicates: each tool appears once in the window's menus.
  for (const command of ["cmd_whimsyPageFonts", "cmd_whimsyPageColors", "cmd_whimsyBuiltWith"]) {
    is(document.querySelectorAll(`menuitem[command="${command}"]`).length, 1, `${command} has one menu row`);
  }
  await document.l10n.translateFragment(popup);
  is(document.getElementById("menu_whimsyPageFonts").getAttribute("label"), "Fonts on This Page", "Row label");

  // The switch hides the three rows and turns the commands off.
  Services.prefs.setBoolPref(FEATURE_PREF, false);
  WhimsyPageDev.updateMenu(window);
  ok(document.getElementById("menu_whimsyPageFonts").hidden, "Rows hidden when the feature is off");
  ok(!document.getElementById("menu_whimsyFontInspector").hidden, "Font Inspector row follows its own switch");
  is(await WhimsyPageDev.showColors(window), null, "No sheet when the feature is off");
  ok(!document.getElementById("whimsy-pagedev-colors-panel"), "Nothing opened");
  Services.prefs.clearUserPref(FEATURE_PREF);

  // A page the actor can't read: the rows are greyed out and the sheet explains.
  BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, "about:robots");
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, "about:robots");
  WhimsyPageDev.updateMenu(window);
  ok(document.getElementById("menu_whimsyPageFonts").disabled, "Rows disabled on about: pages");
  WhimsyPageDev.showBuiltWith(window);
  const panel = await waitOpen("whimsy-pagedev-built-with-panel");
  ok(panel.querySelector(".whimsy-sheet-empty"), "Unavailable page shows an empty state");
  await closeSheet(panel);
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_fonts_on_this_page() {
  const tab = await openPage();
  gBrowser.selectedBrowser.focus();
  is(document.activeElement, gBrowser.selectedBrowser, "The page has focus to start");

  document.getElementById("cmd_whimsyPageFonts").doCommand();
  const panel = await waitOpen("whimsy-pagedev-fonts-panel");
  ok(panel.contains(document.activeElement), "Keyboard focus moves into the sheet");

  const groups = [...panel.querySelectorAll(".whimsy-pagedev-font")];
  ok(groups.length >= 2, `Lists the rendered families (${groups.map(g => g.getAttribute("aria-label"))})`);
  const web = groups.find(g => g.getAttribute("aria-label") == "WhimsyTestFont");
  ok(web, "The @font-face family actually used is listed by its CSS name");
  ok(
    groups.indexOf(web) > 0,
    "Families are ordered by share of the text (body text outweighs the heading)"
  );

  const props = [...web.querySelectorAll(".whimsy-pagedev-prop")];
  const byTitle = title => props.find(row => rowTitle(row) == title);
  is(rowDetail(byTitle("Family")), "WhimsyTestFont", "Family row survives Fluent with its value");
  is(rowDetail(byTitle("Weights")), "400", "Weight used");
  is(rowDetail(byTitle("Styles")), "normal", "Style used");
  ok(rowDetail(byTitle("Source")).includes("whimsy_pagedev_font.ttf"), "Source is the web font's URL");
  ok(/% of text, \d+ characters/.test(rowDetail(byTitle("Usage"))), `Usage: ${rowDetail(byTitle("Usage"))}`);
  ok(web.querySelector(".whimsy-pagedev-font-share").getAttribute("value").endsWith("%"), "Share shown");

  const sample = web.querySelector(".whimsy-pagedev-sample");
  ok(sample.style.maskImage.startsWith('url("data:image/png'), "Sample is drawn in the font by the page");
  is(sample.getAttribute("role"), "img", "Sample is an image to assistive tech");

  // Each value copies, and the toast says what.
  await SimpleTest.promiseClipboardChange(
    url => url.endsWith("whimsy_pagedev_font.ttf"),
    () => byTitle("Source").doCommand()
  );
  ok(true, "Source copies the bare URL");
  await SimpleTest.promiseClipboardChange("400", () => byTitle("Weights").doCommand());

  // Highlight on Page outlines the text set in that family.
  const highlight = web.querySelector(".whimsy-pagedev-highlight-button");
  is(highlight.getAttribute("aria-pressed"), "false", "Highlight starts off");
  highlight.click();
  await TestUtils.waitForCondition(() => highlight.getAttribute("aria-pressed") == "true", "Highlight on");
  let state = await WhimsyPageDev.query(tab.linkedBrowser, "WhimsyPageDev:HighlightState");
  is(state.family, "WhimsyTestFont", "The page highlights that family");
  ok(state.count >= 2, `Every use is outlined (${state.count} boxes)`);

  // Keyboard: arrows move between rows and buttons.
  byTitle("Family").focus();
  EventUtils.synthesizeKey("KEY_ArrowDown");
  isnot(document.activeElement, byTitle("Family"), "ArrowDown moves to the next row");

  await closeSheet(panel);
  state = await WhimsyPageDev.query(tab.linkedBrowser, "WhimsyPageDev:HighlightState");
  is(state.count, 0, "Closing the sheet removes the highlight");
  is(document.activeElement, gBrowser.selectedBrowser, "Focus returns to the page");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_page_colors() {
  const tab = await openPage();
  const panel = await (async () => {
    WhimsyPageDev.showColors(window);
    return waitOpen("whimsy-pagedev-colors-panel");
  })();

  const rows = [...panel.querySelectorAll(".whimsy-pagedev-color")];
  const find = hex => rows.find(row => rowTitle(row) == hex);
  ok(find("#FFFFFF"), "Page background");
  ok(find("#222222"), "Body text");
  ok(find("#0055CC"), "Link colour");
  ok(find("#102030"), "Banner background");
  ok(find("#FF8800"), "Border colour");
  is(rows[0] && rowTitle(rows[0]), "#FFFFFF", "Sorted by area: the page background first");
  ok(find("#FF8800").querySelector(".whimsy-sheet-item-subtitle").getAttribute("value").includes("Border"),
    "Border role named");
  ok(find("#0055CC").querySelector(".whimsy-sheet-item-subtitle").getAttribute("value").includes("Link"),
    "Link role named");
  is(new Set(rows.map(rowTitle)).size, rows.length, "Deduplicated");

  await SimpleTest.promiseClipboardChange("#FF8800", () => find("#FF8800").doCommand());

  // RGB / HSL on demand, for display and copy.
  const rgb = panel.querySelector('.whimsy-pagedev-format[data-format="rgb"]');
  rgb.click();
  is(rgb.getAttribute("aria-checked"), "true", "RGB selected");
  ok(rows.some(row => rowTitle(row) == "rgb(255, 136, 0)"), "Rows show rgb()");
  const orange = rows.find(row => rowTitle(row) == "rgb(255, 136, 0)");
  await SimpleTest.promiseClipboardChange("rgb(255, 136, 0)", () => orange.doCommand());
  rgb.focus();
  EventUtils.synthesizeKey("KEY_ArrowRight");
  const hsl = panel.querySelector('.whimsy-pagedev-format[data-format="hsl"]');
  is(document.activeElement, hsl, "Arrow keys move through the formats");
  is(hsl.getAttribute("aria-checked"), "true", "HSL selected");
  is(rowTitle(orange), "hsl(32, 100%, 50%)", "Rows show hsl()");
  panel.querySelector('.whimsy-pagedev-format[data-format="hex"]').click();

  // Contrast: two decimals, PASS/FAIL judged on the shown number.
  const pairs = [...panel.querySelectorAll(".whimsy-pagedev-pair")];
  ok(pairs.length >= 3, "Text/background pairs listed");
  const faint = pairs.find(row => rowTitle(row) == "#AAAAAA on #FFFFFF");
  ok(faint, "The faint text pair is listed");
  is(rowDetail(faint), "2.32:1", "Ratio to two decimals");
  const badges = [...faint.querySelectorAll(".whimsy-pagedev-badge")].map(b => b.textContent);
  Assert.deepEqual(badges, ["AA FAIL", "AAA FAIL"], "Faint text fails AA and AAA");
  const banner = pairs.find(row => rowTitle(row) == "#FFFFFF on #102030");
  ok(banner, "The banner pair is listed");
  Assert.deepEqual(
    [...banner.querySelectorAll(".whimsy-pagedev-badge")].map(b => b.textContent),
    ["AA PASS", "AAA PASS"],
    "White on navy passes"
  );
  for (const row of pairs) {
    ok(/^\d+\.\d{2}:1$/.test(rowDetail(row)), `Two decimals: ${rowDetail(row)}`);
  }
  await SimpleTest.promiseClipboardChange(
    "#AAAAAA on #FFFFFF: 2.32:1 (AA FAIL, AAA FAIL)",
    () => faint.doCommand()
  );

  // Copy all as CSS variables.
  const copyAll = panel.querySelector(".whimsy-sheet-footer-button");
  await SimpleTest.promiseClipboardChange(
    text => text.startsWith(":root {") && text.includes("--page-border-1: #FF8800;") && text.includes("--page-background-1: #FFFFFF;"),
    () => copyAll.doCommand()
  );
  ok(true, "CSS variables copied, named by role");

  await closeSheet(panel);
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_built_with() {
  const tab = await openPage();
  WhimsyPageDev.showBuiltWith(window);
  const panel = await waitOpen("whimsy-pagedev-built-with-panel");
  const rows = [...panel.querySelectorAll(".whimsy-pagedev-tech")];
  const byKey = key => rows.find(row => row.getAttribute("data-key") == key);

  is(rowTitle(byKey("wordpress")), "WordPress 6.4.2", "WordPress from the generator tag, with its version");
  ok(
    byKey("wordpress").querySelector(".whimsy-sheet-item-subtitle").getAttribute("value").includes("/wp-content/"),
    "Evidence lists the wp-content resource too"
  );
  is(rowTitle(byKey("jquery")), "jQuery 3.7.1", "jQuery from window.jQuery.fn.jquery");
  is(rowTitle(byKey("angular")), "Angular 17.0.1", "Angular from [ng-version]");
  ok(byKey("tailwind"), "Tailwind from --tw- variables and utility classes");
  ok(byKey("express"), "Express from the X-Powered-By header the tab already has");
  ok(byKey("react"), "React from its global");
  ok(!byKey("bootstrap"), "No Bootstrap: \"mb-3\" alone isn't evidence");
  const getterRan = await SpecialPowers.spawn(tab.linkedBrowser, [], () => content.wrappedJSObject.__pageGetterRan);
  ok(!getterRan, "Detection never ran a page getter");

  const captions = [...panel.querySelectorAll(".whimsy-sheet-caption label")].map(l => l.textContent);
  ok(captions.includes("Content Management"), `Grouped by category (${captions})`);
  ok(panel.querySelector(".whimsy-pagedev-note"), "Says it is local");

  await SimpleTest.promiseClipboardChange(
    text => text.startsWith("jQuery 3.7.1 (JavaScript Libraries): Script global window.jQuery"),
    () => byKey("jquery").doCommand()
  );
  await SimpleTest.promiseClipboardChange(
    text => text.includes("WordPress 6.4.2 (Content Management)") && text.includes("Express (Back End)"),
    () => panel.querySelector(".whimsy-sheet-footer-button").doCommand()
  );
  await closeSheet(panel);
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_private_window() {
  const win = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  // Popups only finish opening in a window that has painted and has focus.
  await SimpleTest.promiseFocus(win);
  const tab = await openPage(win);
  WhimsyPageDev.showColors(win);
  const panel = await waitOpen("whimsy-pagedev-colors-panel", win);
  ok(panel.querySelectorAll(".whimsy-pagedev-color").length, "Works in a private window");
  // (Esc closing a sheet is covered above, in the main window.)
  const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
  panel.hidePopup();
  await hidden;
  is(Services.prefs.getChildList("whimsy.pagedev").length, 0, "Nothing is stored");
  BrowserTestUtils.removeTab(tab);
  await BrowserTestUtils.closeWindow(win);
});

add_task(async function test_pure_helpers_and_rules() {
  is(formatColor({ r: 255, g: 136, b: 0, a: 1 }, "hex"), "#FF8800", "hex");
  is(formatColor({ r: 255, g: 136, b: 0, a: 0.5 }, "rgb"), "rgba(255, 136, 0, 0.5)", "rgba");
  Assert.deepEqual(hslOf({ r: 0, g: 0, b: 255 }), { h: 240, s: 100, l: 50 }, "hsl");
  is(
    cssVariables([{ rgba: { r: 0, g: 0, b: 0, a: 1 }, roles: ["text"], share: 0.5 }]),
    ":root {\n  --page-text-1: #000000; /* 50% */\n}\n",
    "CSS variables"
  );

  Assert.deepEqual(WhimsyTechRules.detect({}), [], "No signals, no technologies");
  const keys = new Set();
  for (const rule of RULES) {
    ok(rule.name && rule.key && CATEGORIES.includes(rule.category), `${rule.key}: name, key and category`);
    ok(!keys.has(rule.key), `${rule.key} is unique`);
    keys.add(rule.key);
    ok(
      ["generator", "globals", "prefixes", "selectors", "expando", "urls", "headers", "cssVars", "classes"].some(
        k => rule[k]
      ),
      `${rule.key} has evidence to look for`
    );
  }
  const found = WhimsyTechRules.detect({ headers: { server: "nginx/1.25.3", "cf-ray": "abc" } });
  Assert.deepEqual(found.map(t => t.key).sort(), ["cloudflare", "nginx"], "Header rules");
  is(found.find(t => t.key == "nginx").version, "1.25.3", "Version from the header");
  is(
    WhimsyTechRules.detect({ globals: { "jQuery": true, "jQuery.fn.jquery": "<img src=x>" } })[0].version,
    null,
    "A page-supplied version that isn't one is dropped"
  );
});
