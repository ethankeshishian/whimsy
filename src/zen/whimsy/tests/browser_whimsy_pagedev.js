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

// W10-18: one surface, docked at the top end of the page, with Fonts |
// Colors | Built With. Resolves once `tab` shows its results.
const PANEL_ID = "whimsy-pagedev";
async function waitOpen(tab, win = window) {
  await TestUtils.waitForCondition(() => win.document.getElementById(PANEL_ID)?.state == "open", "The page tools open");
  const panel = win.document.getElementById(PANEL_ID);
  await TestUtils.waitForCondition(() => panel.dataset.tab == tab && !panel.querySelector(".whimsy-pagedev-reading"),
    `${tab} is read`);
  await win.document.l10n.translateFragment(panel);
  return panel;
}

async function closeSheet(panel) {
  const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
  EventUtils.synthesizeKey("KEY_Escape", {}, panel.documentGlobal);
  await hidden;
}

const text = el => el?.textContent.replace(/[\u2068\u2069]/g, "") ?? "";

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
  is(document.getElementById("menu_whimsyPageFonts").getAttribute("label"), "Page Fonts", "Row label (W13 F07: Page Fonts)");

  // The switch hides the three rows and turns the commands off.
  Services.prefs.setBoolPref(FEATURE_PREF, false);
  WhimsyPageDev.updateMenu(window);
  ok(document.getElementById("menu_whimsyPageFonts").hidden, "Rows hidden when the feature is off");
  ok(!document.getElementById("menu_whimsyFontInspector").hidden, "Font Inspector row follows its own switch");
  is(await WhimsyPageDev.showColors(window), null, "No surface when the feature is off");
  ok(!document.getElementById(PANEL_ID), "Nothing opened");
  Services.prefs.clearUserPref(FEATURE_PREF);

  // A page the actor can't read: the rows are greyed out and the sheet explains.
  BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, "about:robots");
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, "about:robots");
  WhimsyPageDev.updateMenu(window);
  ok(document.getElementById("menu_whimsyPageFonts").disabled, "Rows disabled on about: pages");
  WhimsyPageDev.showBuiltWith(window);
  const panel = await waitOpen("built-with");
  ok(panel.querySelector(".whimsy-surface-empty"), "Unavailable page shows an empty state");
  ok(panel.querySelector(".whimsy-surface-seg").hasAttribute("disabled"), "and the tabs are disabled");
  await closeSheet(panel);
  BrowserTestUtils.removeTab(tab);
});

// W10-18: the one surface. Each command opens it on its tab; a second
// command switches tab (still one panel); it stays on an outside click and
// closes on Esc; it is a WhimsySurface at the top end of the page.
add_task(async function test_one_surface() {
  const tab = await openPage();
  document.getElementById("cmd_whimsyPageColors").doCommand();
  let panel = await waitOpen("colors");
  ok(panel.classList.contains("whimsy-surface"), "A Whimsy surface");
  is(panel.getAttribute("noautohide"), "true", "It stays while you use the page");
  is(panel.querySelector(".whimsy-surface-title").textContent, "example.com", "Titled with the host");
  is(panel.querySelector("[role=tablist]").querySelectorAll("[role=tab]").length, 3, "Fonts | Colors | Built With");
  is(panel.querySelector('[role=tab][aria-selected="true"]').dataset.value, "colors", "on Colors");
  const area = document.getElementById("tabbrowser-tabbox").getBoundingClientRect();
  const rect = panel.getBoundingClientRect();
  const nearEnd = Math.abs(rect.right - (area.right - 10)) <= 4;
  const nearStart = Math.abs(rect.left - (area.left + 10)) <= 4;
  ok(gZenVerticalTabsManager?._prefsRightSide ? nearStart : nearEnd, "Docked 10px in from the page's end edge");
  ok(rect.top - area.top < 40, "near the top of the page");

  document.getElementById("cmd_whimsyBuiltWith").doCommand();
  panel = await waitOpen("built-with");
  is(document.querySelectorAll(`#${PANEL_ID}`).length, 1, "Still one panel");
  is(panel.querySelector('[role=tab][aria-selected="true"]').dataset.value, "built-with", "now on Built With");

  // An outside click doesn't close it.
  EventUtils.synthesizeMouseAtCenter(gBrowser.selectedBrowser, {});
  // eslint-disable-next-line mozilla/no-arbitrary-setTimeout
  await new Promise(r => setTimeout(r, 200));
  is(panel.state, "open", "An outside click keeps it open");

  // Arrow keys on the tabs switch them.
  panel.querySelector('[role=tab][aria-selected="true"]').focus();
  EventUtils.synthesizeKey("KEY_ArrowLeft");
  panel = await waitOpen("colors");
  ok(true, "Arrow keys switch tabs");

  // Navigation re-reads the page.
  // The "Reading the page…" state can be brief: catch it as it's added.
  const reread = new Promise(resolve => {
    const observer = new MutationObserver(() => {
      if (panel.querySelector(".whimsy-pagedev-reading")) {
        observer.disconnect();
        resolve();
      }
    });
    observer.observe(panel, { childList: true, subtree: true });
  });
  BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, PAGE + "?again");
  await reread;
  await waitOpen("colors");
  ok(panel.querySelectorAll(".whimsy-pagedev-color").length, "Read again after navigating");

  // Switching tabs closes it.
  const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.org/");
  await hidden;
  ok(true, "Switching tabs closes it");
  BrowserTestUtils.removeTab(other);
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_fonts_on_this_page() {
  const tab = await openPage();
  gBrowser.selectedBrowser.focus();
  is(document.activeElement, gBrowser.selectedBrowser, "The page has focus to start");

  document.getElementById("cmd_whimsyPageFonts").doCommand();
  const panel = await waitOpen("fonts");
  ok(panel.contains(document.activeElement), "Keyboard focus moves into the surface");

  const rows = [...panel.querySelectorAll(".whimsy-pagedev-font")];
  ok(rows.length >= 2, `Lists the rendered families (${rows.map(r => r.dataset.family)})`);
  const web = rows.find(r => r.dataset.family == "WhimsyTestFont");
  ok(web, "The @font-face family actually used is listed by its CSS name");
  ok(rows.indexOf(web) > 0, "Families are ordered by share of the text (body text outweighs the heading)");
  is(text(web.querySelector(".whimsy-pagedev-row-title")), "WhimsyTestFont", "Its name");
  ok(/% of text · Web font$/.test(text(web.querySelector(".whimsy-pagedev-row-line"))),
    `Share and source: ${text(web.querySelector(".whimsy-pagedev-row-line"))}`);
  is(text(web.querySelector(".whimsy-pagedev-row-trailing")), "400", "Weights used");
  const specimen = web.querySelector(".whimsy-pagedev-specimen");
  ok(specimen.style.maskImage.startsWith('url("data:image/png'), "The Aa is drawn in the font by the page");
  is(text(panel.querySelector(".whimsy-surface-caption-detail")), "by share of text", "by share of text");

  // A row opens to its source and actions.
  const head = web.querySelector(".whimsy-pagedev-row-head");
  is(head.getAttribute("aria-expanded"), "false", "Rows start closed");
  head.focus();
  EventUtils.synthesizeKey("KEY_Enter");
  is(head.getAttribute("aria-expanded"), "true", "Return opens a row");
  const source = web.querySelector(".whimsy-pagedev-source");
  await TestUtils.waitForCondition(() => BrowserTestUtils.isVisible(source), "The opened row is visible");
  ok(text(source).includes("whimsy_pagedev_font.ttf"), "Source is the web font's URL");
  await SimpleTest.promiseClipboardChange(url => url.endsWith("whimsy_pagedev_font.ttf"), () => source.click());
  ok(source.hasAttribute("copied"), "It says Copied in place");
  await SimpleTest.promiseClipboardChange("WhimsyTestFont", () => web.querySelector(".whimsy-pagedev-copy-name").click());

  // Highlight on Page outlines the text set in that family.
  const highlight = web.querySelector(".whimsy-pagedev-highlight-button");
  is(highlight.getAttribute("aria-pressed"), "false", "Highlight starts off");
  highlight.click();
  await TestUtils.waitForCondition(() => highlight.getAttribute("aria-pressed") == "true", "Highlight on");
  let state = await WhimsyPageDev.query(tab.linkedBrowser, "WhimsyPageDev:HighlightState");
  is(state.family, "WhimsyTestFont", "The page highlights that family");
  ok(state.count >= 2, `Every use is outlined (${state.count} boxes)`);

  await closeSheet(panel);
  state = await WhimsyPageDev.query(tab.linkedBrowser, "WhimsyPageDev:HighlightState");
  is(state.count, 0, "Closing it removes the highlight");
  is(document.activeElement, gBrowser.selectedBrowser, "Focus returns to the page");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_page_colors() {
  const tab = await openPage();
  WhimsyPageDev.showColors(window);
  const panel = await waitOpen("colors");

  // W13 F07 (option C): four swatches a row, the picked one's value in the
  // detail bar under them.
  const swatches = [...panel.querySelectorAll(".whimsy-pagedev-color")];
  const bar = panel.querySelector(".whimsy-pagedev-detail");
  const value = () => text(bar.querySelector(".whimsy-pagedev-detail-value"));
  const find = hex => swatches.find(el => el.dataset.hex == hex);
  ok(find("#FFFFFF"), "Page background");
  ok(find("#222222"), "Body text");
  ok(find("#0055CC"), "Link colour");
  ok(find("#102030"), "Banner background");
  ok(find("#FF8800"), "Border colour");
  is(swatches[0].dataset.hex, "#FFFFFF", "Sorted by area: the page background first");
  ok(find("#FF8800").getAttribute("aria-label").includes("Border"), "Border role named");
  ok(find("#0055CC").getAttribute("aria-label").includes("Link"), "Link role named");
  Assert.lessOrEqual(swatches.length, 16, "At most 16 swatches");
  is(new Set(swatches.map(el => el.dataset.hex)).size, swatches.length, "Deduplicated");
  is(getComputedStyle(panel.querySelector(".whimsy-pagedev-swatches")).gridTemplateColumns.split(" ").length, 4,
    "Four columns");
  is(swatches[0].getAttribute("aria-checked"), "true", "The first swatch starts picked");
  is(value(), "#FFFFFF", "…its value in the bar");

  // A real click picks a swatch (it doesn't copy); Copy copies the pick.
  EventUtils.synthesizeMouseAtCenter(find("#FF8800"), {});
  is(find("#FF8800").getAttribute("aria-checked"), "true", "A click picks it");
  is(value(), "#FF8800", "The bar shows its value");
  const copy = bar.querySelector(".whimsy-pagedev-detail-copy");
  await SimpleTest.promiseClipboardChange("#FF8800", () => EventUtils.synthesizeMouseAtCenter(copy, {}));
  ok(copy.hasAttribute("copied"), "Copy says Copied");

  // RGB / HSL on demand, for display and copy.
  const rgb = panel.querySelector('.whimsy-pagedev-formats [data-value="rgb"]');
  EventUtils.synthesizeMouseAtCenter(rgb, {});
  is(rgb.getAttribute("aria-checked"), "true", "RGB selected");
  is(value(), "rgb(255, 136, 0)", "The bar shows rgb()");
  await SimpleTest.promiseClipboardChange("rgb(255, 136, 0)", () => EventUtils.synthesizeMouseAtCenter(copy, {}));
  rgb.focus();
  EventUtils.synthesizeKey("KEY_ArrowRight");
  const hsl = panel.querySelector('.whimsy-pagedev-formats [data-value="hsl"]');
  is(document.activeElement, hsl, "Arrow keys move through the formats");
  is(hsl.getAttribute("aria-checked"), "true", "HSL selected");
  is(value(), "hsl(32, 100%, 50%)", "The bar shows hsl()");
  panel.querySelector('.whimsy-pagedev-formats [data-value="hex"]').click();

  // Keys: the swatches are a radiogroup in rows of four.
  find("#FF8800").focus();
  const at = swatches.indexOf(find("#FF8800"));
  EventUtils.synthesizeKey("KEY_ArrowRight");
  if (at + 1 < swatches.length) {
    is(document.activeElement, swatches[at + 1], "Right picks the next swatch");
    is(value(), swatches[at + 1].dataset.hex, "…and the bar follows");
  }
  swatches[0].focus();
  EventUtils.synthesizeKey("KEY_ArrowDown");
  if (swatches.length > 4) {
    is(document.activeElement, swatches[4], "Down moves a row");
  }
  await SimpleTest.promiseClipboardChange(value(), () => EventUtils.synthesizeKey("KEY_Enter"));
  ok(true, "Return on a swatch copies it");

  // Contrast: a pill per pair, the ratio to one decimal.
  const pairs = [...panel.querySelectorAll(".whimsy-pagedev-pair")];
  ok(pairs.length >= 3, "Text/background pairs listed");
  const colors = row => text(row.querySelector(".whimsy-pagedev-pair-colors"));
  const faint = pairs.find(row => colors(row) == "#AAAAAA on #FFFFFF");
  ok(faint, "The faint text pair is listed");
  is(text(faint.querySelector(".whimsy-pagedev-ratio")), "2.3", "Ratio to one decimal");
  is(faint.querySelector(".whimsy-pagedev-pill").dataset.level, "fail", "2.3:1 fails");
  is(text(faint.querySelector(".whimsy-pagedev-pill")), "Fails", "and says Fails");
  is(faint.querySelector(".whimsy-pagedev-pill").getAttribute("tone"), "fail", "in the fail tone");
  const banner = pairs.find(row => colors(row) == "#FFFFFF on #102030");
  ok(banner, "The banner pair is listed");
  is(banner.querySelector(".whimsy-pagedev-pill").dataset.level, "aaa", "White on navy passes AAA");
  await SimpleTest.promiseClipboardChange("#AAAAAA on #FFFFFF: 2.32:1 (AA FAIL, AAA FAIL)", () => faint.click());

  // Copy as CSS variables.
  const copyAll = panel.querySelector(".whimsy-pagedev-copy-css-vars");
  await SimpleTest.promiseClipboardChange(
    t => t.startsWith(":root {") && t.includes("--page-border-1: #FF8800;") && t.includes("--page-background-1: #FFFFFF;"),
    () => copyAll.doCommand()
  );
  ok(true, "CSS variables copied, named by role");

  await closeSheet(panel);
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_built_with() {
  const tab = await openPage();
  WhimsyPageDev.showBuiltWith(window);
  const panel = await waitOpen("built-with");
  const rows = [...panel.querySelectorAll(".whimsy-pagedev-tech")];
  const byKey = key => rows.find(row => row.getAttribute("data-key") == key);
  const name = row => text(row.querySelector(".whimsy-pagedev-tech-name")).replace(/\s+/g, " ").trim();

  is(name(byKey("wordpress")), "WordPress 6.4.2", "WordPress from the generator tag, with its version");
  byKey("wordpress").querySelector(".whimsy-pagedev-row-head").click();
  ok(text(byKey("wordpress").querySelector(".whimsy-pagedev-evidence")).includes("/wp-content/"),
    "Its evidence opens under it, with the wp-content resource");
  is(name(byKey("jquery")), "jQuery 3.7.1", "jQuery from window.jQuery.fn.jquery");
  is(name(byKey("angular")), "Angular 17.0.1", "Angular from [ng-version]");
  ok(byKey("tailwind"), "Tailwind from --tw- variables and utility classes");
  ok(byKey("express"), "Express from the X-Powered-By header the tab already has");
  ok(byKey("react"), "React from its global");
  ok(!byKey("bootstrap"), "No Bootstrap: \"mb-3\" alone isn't evidence");
  is(text(byKey("jquery").querySelector(".whimsy-pagedev-monogram")), "J", "A monogram tile");
  const getterRan = await SpecialPowers.spawn(tab.linkedBrowser, [], () => content.wrappedJSObject.__pageGetterRan);
  ok(!getterRan, "Detection never ran a page getter");

  const captions = [...panel.querySelectorAll(".whimsy-surface-caption-label")].map(text);
  ok(captions.includes("Content Management"), `Grouped by category (${captions})`);
  ok(panel.querySelector(".whimsy-pagedev-note"), "Says it is local");

  await SimpleTest.promiseClipboardChange(
    t => t.includes("WordPress 6.4.2 (Content Management)") && t.includes("Express (Back End)") &&
      t.includes("jQuery 3.7.1 (JavaScript Libraries): Script global window.jQuery"),
    () => panel.querySelector(".whimsy-pagedev-copy-all").doCommand()
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
  const panel = await waitOpen("colors", win);
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
