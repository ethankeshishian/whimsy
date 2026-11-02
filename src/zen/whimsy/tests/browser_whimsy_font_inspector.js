/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave9: W9-01 Font Inspector ("What Font Is This?").
// Shows a popover with rendered font family, size, weight, line height,
// letter spacing, and color (hex + swatch). Each value copies on click.
// Registered with Menus settings (WhimsyMenuPrefs) and WhimsyCommands.

const { WhimsyInspector } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyInspector.sys.mjs");
const { WhimsyCommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommands.sys.mjs");
const { WhimsyMenuPrefs } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyMenuPrefs.sys.mjs");
const { WhimsyPrivate } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPrivate.sys.mjs");
const { SearchTestUtils } = ChromeUtils.importESModule("resource://testing-common/SearchTestUtils.sys.mjs");
SearchTestUtils.init(this);

// Search for This Font uses the default engine: a local one here (tests
// can't reach the network).
add_setup(async function () {
  await SearchTestUtils.installSearchExtension(
    { name: "Whimsy Font Search", search_url: "https://example.com/search", search_url_get_params: "q={searchTerms}" },
    { setAsDefault: true }
  );
});

// Opens the popover and waits until it's shown (its rows only take clicks
// once it's open).
async function openFontPopover() {
  await WhimsyInspector.inspectFont(window);
  const panel = document.getElementById("whimsy-font-inspector-panel");
  if (panel && panel.state != "open") {
    await BrowserTestUtils.waitForPopupEvent(panel, "shown");
  }
  return panel;
}

const PAGE = "https://example.com/document-builder.sjs?html=" + encodeURIComponent(`
  <html>
    <head><title>Font Inspector Test</title></head>
    <body>
      <p id="font-target" style="font-family: Arial, sans-serif; font-size: 24px; font-weight: 700; line-height: 32px; letter-spacing: 1px; color: rgb(255, 0, 0);">
        Sphinx of black quartz, judge my vow.
      </p>
    </body>
  </html>
`);

async function selectTargetText(browser) {
  await SpecialPowers.spawn(browser, [], () => {
    const el = content.document.getElementById("font-target");
    const range = content.document.createRange();
    range.selectNodeContents(el);
    const sel = content.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  });
}

add_task(async function test_font_inspector_command_and_menu() {
  ok(WhimsyInspector.fontInspectorEnabled, "Font Inspector is enabled by default");

  // WhimsyCommands registration
  const command = WhimsyCommands.get("cmd_whimsyInspectFont");
  ok(command, "cmd_whimsyInspectFont is registered in WhimsyCommands");
  is(command.l10nId, "whimsy-action-inspect-font", "Command has correct l10n id");

  // WhimsyCommands registration for search font
  const searchCommand = WhimsyCommands.get("cmd_whimsySearchFont");
  ok(searchCommand, "cmd_whimsySearchFont is registered in WhimsyCommands");
  is(searchCommand.l10nId, "whimsy-action-search-font", "Search font command has correct l10n id");
  ok(searchCommand.keyId, "Search font command has an assignable shortcut key id");

  // Context menu item
  const menuItem = document.getElementById("context-whimsy-inspect-font");
  ok(menuItem, "Context menu item #context-whimsy-inspect-font exists");
  is(menuItem.getAttribute("command"), "cmd_whimsyInspectFont", "Points to cmd_whimsyInspectFont");

  // Registered with WhimsyMenuPrefs under 'selection'
  const selectionItems = WhimsyMenuPrefs.items("selection");
  const found = selectionItems.find(i => i.id === "inspect-font");
  ok(found, "inspect-font is registered in WhimsyMenuPrefs selection menu");
  is(found?.l10n, "whimsy-menus-selection-inspect-font", "Uses correct MenuPrefs l10n string");

  // Test hiding via WhimsyMenuPrefs
  WhimsyMenuPrefs.setHidden("selection", "inspect-font", true);
  ok(WhimsyMenuPrefs.isHidden("selection", "inspect-font"), "inspect-font is marked hidden");
  WhimsyMenuPrefs.restoreDefaults("selection");
  ok(!WhimsyMenuPrefs.isHidden("selection", "inspect-font"), "inspect-font restored to visible");
});

// W10-17: a WhimsySurface card: the text in its own font, the name and
// where it comes from, six facts that copy in place ("Copied", no toast),
// and Search for This Font / Copy CSS (the default, with the keyboard).
add_task(async function test_inspect_font_card() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const browser = tab.linkedBrowser;
  await selectTargetText(browser);
  const panel = await openFontPopover();
  ok(panel.classList.contains("whimsy-surface"), "A Whimsy surface");
  is(panel.getAttribute("hidepopovertail"), "true", "with no arrow tail");
  ok(!panel.querySelector("toolbarseparator, menuitem"), "and no native rows");
  await document.l10n.translateFragment(panel);

  const specimen = panel.querySelector(".whimsy-font-specimen");
  ok(specimen.textContent.includes("Sphinx of black quartz"), "The pad shows the selected text");
  ok(specimen.style.fontFamily.includes("Arial"), "in its own font");
  const name = panel.querySelector(".whimsy-font-name");
  ok(name.textContent && !name.textContent.startsWith("."), `The font is named: ${name.textContent}`);
  is(panel.querySelector(".whimsy-font-source").textContent, "Installed font", "Arial is an installed font");

  const facts = Object.fromEntries([...panel.querySelectorAll(".whimsy-font-fact")].map(f =>
    [f.dataset.fact, f.querySelector(".v").textContent]));
  Assert.deepEqual(Object.keys(facts), ["size", "weight", "line-height", "letter-spacing", "color", "style"], "Six facts");
  is(facts.size, "24px", "Size");
  is(facts.weight, "700 Bold", "Weight with its name");
  is(facts["line-height"], "32px", "Line height");
  is(facts.color, "#FF0000", "Colour as hex");
  is(facts.style, "Normal", "Style");
  ok(panel.querySelector('[data-fact="color"] .whimsy-font-swatch'), "with a swatch");

  const copyCss = panel.querySelector(".whimsy-font-copy-css");
  await TestUtils.waitForCondition(() => document.activeElement == copyCss, "Copy CSS has the keyboard");
  is(copyCss.getAttribute("default"), "true", "Copy CSS is the default");

  // A fact copies its value and says Copied in place.
  const size = panel.querySelector('[data-fact="size"]');
  await SimpleTest.promiseClipboardChange("24px", () => size.click());
  ok(size.hasAttribute("copied"), "It says Copied in place");
  await document.l10n.translateFragment(size);
  is(size.querySelector(".whimsy-surface-copy-live").textContent, "Copied", "in words, read out");
  ok(!currentToast(), "No toast");
  // Weight copies the number, Color the hex.
  await SimpleTest.promiseClipboardChange("700", () => panel.querySelector('[data-fact="weight"]').click());
  await SimpleTest.promiseClipboardChange("#FF0000", () => panel.querySelector('[data-fact="color"]').click());

  const css = 'font-family: "Arial", Arial, sans-serif;\nfont-size: 24px;\nfont-weight: 700;\n' +
    "line-height: 32px;\nletter-spacing: 1px;\ncolor: #FF0000;";
  await SimpleTest.promiseClipboardChange(css, () => copyCss.doCommand());

  ok(!panel.querySelector('[data-l10n-id="whimsy-font-inspect-element"]'), "No Element Info button");
  EventUtils.synthesizeKey("KEY_Escape");
  await TestUtils.waitForCondition(() => !document.getElementById("whimsy-font-inspector-panel"), "Esc closes it");
  BrowserTestUtils.removeTab(tab);
});

// The "." bug: macOS's system face is hidden behind a name starting with
// "."; the card names it San Francisco, a Mac system font, never ".".
add_task(async function test_system_font_is_named() {
  const page = "https://example.com/document-builder.sjs?html=" + encodeURIComponent(
    `<p id="font-target" style="font-family: -apple-system, system-ui; font-size: 16px">Build momentum</p>`);
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, page);
  await selectTargetText(tab.linkedBrowser);
  const actor = WhimsyInspector.actorFor(tab.linkedBrowser);
  const data = await actor.sendQuery("Whimsy:InspectFontSelection");
  if (AppConstants.platform == "macosx") {
    ok(data.system, "The child reports the system font");
    is(data.family, null, "with no hidden name");
  }
  ok(!String(data.family ?? "").startsWith("."), "Never a name starting with a period");
  const panel = await openFontPopover();
  await document.l10n.translateFragment(panel);
  const name = panel.querySelector(".whimsy-font-name").textContent;
  ok(!name.startsWith("."), `The card's name isn't hidden: ${name}`);
  if (AppConstants.platform == "macosx") {
    is(name, "San Francisco", "It's San Francisco");
    is(panel.querySelector(".whimsy-font-source").textContent, "Mac system font", "a Mac system font");
    ok(![...panel.querySelectorAll("button")].some(b => b.label == "Search for This Font"), "No search for the system font");
  }
  panel.hidePopup();
  await BrowserTestUtils.waitForPopupEvent(panel, "hidden");
  BrowserTestUtils.removeTab(tab);
});

// A web font: its family and "Web font"; a second face that drew a
// character shows in "Also uses".
add_task(async function test_web_font_and_also_uses() {
  const fontURL = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") +
    "whimsy_pagedev_font.ttf";
  const page = "https://example.com/document-builder.sjs?html=" + encodeURIComponent(`
    <style>@font-face { font-family: "Whimsy Test Face"; src: url("${fontURL}"); }</style>
    <p id="font-target" style="font-family: 'Whimsy Test Face', serif; font-size: 20px">Hello there ✓</p>`);
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, page);
  await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
    await content.document.fonts.ready;
  });
  await selectTargetText(tab.linkedBrowser);
  const panel = await openFontPopover();
  await document.l10n.translateFragment(panel);
  is(panel.querySelector(".whimsy-font-name").textContent, "Whimsy Test Face", "The web font's family");
  is(panel.querySelector(".whimsy-font-source").textContent, "Web font", "Web font");
  const also = panel.querySelector(".whimsy-font-also");
  if (also) {
    ok(/Also uses .+ for \d+ character/.test(also.textContent), `Also uses: ${also.textContent}`);
  }
  panel.hidePopup();
  await BrowserTestUtils.waitForPopupEvent(panel, "hidden");
  BrowserTestUtils.removeTab(tab);
});

// The parent never trusts the page: odd names, sizes and colours are dropped.
add_task(function test_validation() {
  const { validateFontData } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyInspector.sys.mjs");
  const data = validateFontData({
    family: "Evil\u0007Font" + "x".repeat(400), source: "web", size: "calc(1px)", weight: "bold", lineHeight: "24px",
    colorHex: "red; background: url(x)", others: [{ family: ".SFNS", count: 2 }], style: "italic",
  });
  ok(!data.family.includes("\u0007") && data.family.length <= 200, "Control characters and length are stripped");
  is(data.size, "normal", "A size that isn't px falls back");
  is(data.weight, 400, "A weight that isn't a number falls back");
  is(data.colorHex, null, "A colour that isn't hex is dropped");
  ok(data.others[0].system && !data.others[0].family, "A hidden face name reads as the system font");
  is(validateFontData({ family: ".AppleSystemUIFont" }).family, null, "A dotted family is the system font");
});

// The page can't be read (a privileged page): the card says so, with Close.
add_task(async function test_cant_read() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:robots");
  const shown = BrowserTestUtils.waitForEvent(document, "popupshown", true, e => e.target.id == "whimsy-font-inspector-panel");
  await WhimsyInspector.inspectFont(window);
  await shown;
  const panel = document.getElementById("whimsy-font-inspector-panel");
  ok(panel.querySelector(".whimsy-font-unavailable"), "It says it can't read the page");
  is(panel.querySelectorAll(".whimsy-surface-footer button").length, 1, "only Close");
  panel.hidePopup();
  await BrowserTestUtils.waitForPopupEvent(panel, "hidden");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_search_for_this_font_button_and_command() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const browser = tab.linkedBrowser;

  await selectTargetText(browser);

  // Inspect font so popover opens
  await openFontPopover();

  const panel = document.getElementById("whimsy-font-inspector-panel");
  ok(panel, "Font inspector panel opened");

  await document.l10n.translateFragment(panel);
  const searchBtn = Array.from(panel.querySelectorAll("button")).find(b => b.label === "Search for This Font");
  ok(searchBtn, "Search for This Font button exists in popover");

  // Track tab opened via waitForNewTab
  const tabPromise = BrowserTestUtils.waitForNewTab(gBrowser, url => url.includes("Arial"), false);
  searchBtn.click();

  const newTab = await tabPromise;
  ok(newTab, "Search tab was opened");
  is(gBrowser.tabs.indexOf(newTab), gBrowser.tabs.indexOf(tab) + 1, "New search tab is positioned right next to the current tab");
  ok(newTab.linkedBrowser.currentURI.spec.includes("Arial"), "Search URL includes rendered font name Arial");

  BrowserTestUtils.removeTab(newTab);

  // Test the command directly via WhimsyCommands
  const cmdTabPromise = BrowserTestUtils.waitForNewTab(gBrowser, url => url.includes("Arial"), false);
  await WhimsyInspector.searchFont(window);
  const cmdTab = await cmdTabPromise;
  ok(cmdTab, "cmd_whimsySearchFont opened a search tab for selected text font");
  is(gBrowser.tabs.indexOf(cmdTab), gBrowser.tabs.indexOf(tab) + 1, "Command opened tab next to current tab");

  BrowserTestUtils.removeTab(cmdTab);
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_feature_switch_disabled() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.font-inspector", false]] });
  ok(!WhimsyInspector.fontInspectorEnabled, "Font inspector switch is off");

  // Inspect font does nothing when disabled
  await WhimsyInspector.inspectFont(window);
  ok(!document.getElementById("whimsy-font-inspector-panel"), "No panel opens when switch is off");

  await SpecialPowers.popPrefEnv();
  ok(WhimsyInspector.fontInspectorEnabled, "Font inspector switch is on again");
});

// wave9/pagedev: the card is styled in the browser window (W10-17: by
// whimsy-browser.css, as a WhimsySurface).
add_task(async function test_popover_is_styled() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  await selectTargetText(tab.linkedBrowser);
  const panel = await openFontPopover();
  const facts = panel.querySelector(".whimsy-font-facts");
  is(getComputedStyle(facts).display, "grid", "The facts lay out as a grid");
  is(getComputedStyle(facts).borderTopLeftRadius, "8px", "on a rounded track");
  is(getComputedStyle(panel.querySelector(".whimsy-font-specimen")).fontSize, "26px", "The specimen is 26px");
  panel.hidePopup();
  await BrowserTestUtils.waitForPopupEvent(panel, "hidden");
  BrowserTestUtils.removeTab(tab);
});
