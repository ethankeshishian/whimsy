/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Link lasso (whimsy.feature.link-lasso, W8-29). Covers Option-drag over links with
// a live count, releasing to show a small pill offering "Open as Tabs" and "Make Folder",
// making a folder of unloaded tabs named after the page, opening links as plain tabs,
// the WhimsyCommands registry entries with NO default shortcut, Esc cancelling both
// during drag and while the pill is shown, clicking outside cancelling, a plain drag
// still selecting text, Option-click still clicking, fields left alone, private tabs
// open as private tabs (no folder), the folder name fallback, the switch, the
// commands reachable from the command bar (design-full-4 M1) and pill targets.

const PAGE =
  getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") + "whimsy_lasso.html";
const { WhimsyLinkLasso } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyLinkLasso.sys.mjs");
const { WhimsyCommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommands.sys.mjs");
const { WhimsyPrivate } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPrivate.sys.mjs");
const { UrlbarTestUtils } = ChromeUtils.importESModule("resource://testing-common/UrlbarTestUtils.sys.mjs");

const toasts = [];
const realToast = gZenUIManager.showToast;
add_setup(() => {
  WhimsyLinkLasso.initWindow(window);
  gZenUIManager.showToast = (id, options) => toasts.push({ id, options });
  registerCleanupFunction(() => {
    gZenUIManager.showToast = realToast;
  });
});

function mouse(browser, type, x, y, extra = {}) {
  return BrowserTestUtils.synthesizeMouse("body", x, y, { type, ...extra }, browser);
}

function lassoState(browser) {
  return SpecialPowers.spawn(browser, [], async () => {
    await new Promise(r => content.requestAnimationFrame(() => content.requestAnimationFrame(r)));
    const actor = content.windowGlobalChild.getActor("WhimsyLasso");
    const lasso = actor.lasso;
    await new Promise(r => content.setTimeout(r, 50));
    return lasso
      ? {
          started: lasso.started,
          pillActive: !!lasso.pillActive,
          count: new Set((lasso.selected ?? []).map(l => l.url)).size,
          label: lasso.countEl?.textContent ?? "",
          tabsLabel: lasso.tabsBtn?.textContent ?? "",
          folderLabel: lasso.folderBtn?.textContent ?? "",
        }
      : null;
  });
}

// The tabs a lasso opened (example.org links), so tasks leave nothing behind.
function removeLinkTabs() {
  for (const t of [...gBrowser.tabs]) {
    if (t.linkedBrowser.currentURI.spec.startsWith("https://example.org/") || /example\.org/.test(t.label)) {
      BrowserTestUtils.removeTab(t);
    }
  }
}

async function openPage() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => content.focus());
  return tab;
}

add_task(async function test_lasso_pill_and_make_folder() {
  const tab = await openPage();
  const browser = tab.linkedBrowser;
  const opened = [];
  const onOpen = event => opened.push(event.target);
  gBrowser.tabContainer.addEventListener("TabOpen", onOpen);
  toasts.length = 0;

  await mouse(browser, "mousedown", 5, 5, { altKey: true });
  await mouse(browser, "mousemove", 60, 60, { altKey: true, buttons: 1 });
  let state = await lassoState(browser);
  ok(state?.started, "an Option-drag starts a lasso");
  is(state.count, 2, "the live count follows the rectangle");
  is(state.label, "2 links", "the count is shown");

  await mouse(browser, "mousemove", 300, 200, { altKey: true, buttons: 1 });
  state = await lassoState(browser);
  is(state.count, 3, "duplicates count once and script links not at all");
  await mouse(browser, "mouseup", 300, 200, { altKey: true });

  // On release, a small pill offers Open as Tabs and Make Folder
  state = await lassoState(browser);
  ok(state?.pillActive, "on release the pill appears");
  is(state.tabsLabel, "Open as Tabs", "pill offers Open as Tabs");
  is(state.folderLabel, "Make Folder", "pill offers Make Folder");

  // Click Make Folder on the pill
  await SpecialPowers.spawn(browser, [], () => {
    const actor = content.windowGlobalChild.getActor("WhimsyLasso");
    actor.lasso.folderBtn.click();
  });

  await TestUtils.waitForCondition(() => toasts.some(t => t.id == "whimsy-link-lasso-toast"), "a toast confirms");
  gBrowser.tabContainer.removeEventListener("TabOpen", onOpen);
  const linkTabs = opened.filter(t => !t.hasAttribute("zen-empty-tab"));
  Assert.deepEqual(linkTabs.map(t => t.label), ["One", "Two", "Three"], "one tab per link, in page order");
  ok(linkTabs.every(t => !t.linkedPanel), "the tabs are unloaded");
  const folder = linkTabs[0].group;
  ok(folder?.isZenFolder, "they're in a Zen folder");
  is(folder.label, "Lasso Reading List", "named after the page");
  ok(linkTabs.every(t => t.group == folder), "all in the same folder");
  is(gBrowser.selectedTab, tab, "you stay on the page");
  const toast = toasts.find(t => t.id == "whimsy-link-lasso-toast");
  Assert.deepEqual(toast.options.l10nArgs, { count: 3, name: "Lasso Reading List" }, "the toast says how many and where");
  ok(!(await lassoState(browser)), "the lasso is gone");

  await folder.delete();
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_lasso_open_as_tabs() {
  const tab = await openPage();
  const browser = tab.linkedBrowser;
  const opened = [];
  const onOpen = event => opened.push(event.target);
  gBrowser.tabContainer.addEventListener("TabOpen", onOpen);
  toasts.length = 0;

  await mouse(browser, "mousedown", 5, 5, { altKey: true });
  await mouse(browser, "mousemove", 300, 200, { altKey: true, buttons: 1 });
  await mouse(browser, "mouseup", 300, 200, { altKey: true });

  let state = await lassoState(browser);
  ok(state?.pillActive, "the pill is active");

  // Click Open as Tabs on the pill
  await SpecialPowers.spawn(browser, [], () => {
    const actor = content.windowGlobalChild.getActor("WhimsyLasso");
    actor.lasso.tabsBtn.click();
  });

  await TestUtils.waitForCondition(() => toasts.some(t => t.id == "whimsy-link-lasso-open-toast"), "a toast confirms open tabs");
  gBrowser.tabContainer.removeEventListener("TabOpen", onOpen);
  const linkTabs = opened.filter(t => !t.hasAttribute("zen-empty-tab"));
  is(linkTabs.length, 3, "three tabs opened");
  ok(linkTabs.every(t => !t.linkedPanel), "the tabs are unloaded");
  ok(!linkTabs[0].group, "the tabs are plain tabs, not in a folder");
  ok(!(await lassoState(browser)), "the lasso is gone");

  for (const t of linkTabs) {
    BrowserTestUtils.removeTab(t);
  }
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_lasso_commands_registered() {
  const tabsCmd = WhimsyCommands.get("cmd_whimsyLassoOpenTabs");
  const folderCmd = WhimsyCommands.get("cmd_whimsyLassoMakeFolder");

  ok(tabsCmd, "cmd_whimsyLassoOpenTabs is registered in WhimsyCommands");
  ok(folderCmd, "cmd_whimsyLassoMakeFolder is registered in WhimsyCommands");
  // design-full-4 L2: the commands say what they act on (the pill keeps the
  // user's short "Open as Tabs" / "Make Folder"), with icons, whimsy-action-*.
  is(WhimsyCommands.title(tabsCmd), "Open Lassoed Links as Tabs", "the command says what it opens");
  is(WhimsyCommands.title(folderCmd), "Make Folder from Lassoed Links", "the command says what it folds");
  is(tabsCmd.l10nId, "whimsy-action-lasso-open-tabs", "whimsy-action- id");
  is(folderCmd.l10nId, "whimsy-action-lasso-make-folder", "whimsy-action- id");
  const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");
  const iconOf = id => globalActions.find(a => a.l10nId == id)?.icon;
  ok(iconOf("whimsy-action-lasso-open-tabs"), "Open Lassoed Links as Tabs has an icon in the command bar");
  ok(iconOf("whimsy-action-lasso-make-folder"), "Make Folder from Lassoed Links has an icon in the command bar");
  is(tabsCmd.defaultKey, null, "cmd_whimsyLassoOpenTabs has no default shortcut");
  is(folderCmd.defaultKey, null, "cmd_whimsyLassoMakeFolder has no default shortcut");

  const tab = await openPage();
  const browser = tab.linkedBrowser;
  toasts.length = 0;

  await mouse(browser, "mousedown", 5, 5, { altKey: true });
  await mouse(browser, "mousemove", 300, 200, { altKey: true, buttons: 1 });
  await mouse(browser, "mouseup", 300, 200, { altKey: true });

  ok(WhimsyLinkLasso.hasSelection(window), "hasSelection is true while pill is active");

  // Run cmd_whimsyLassoOpenTabs command
  window.document.getElementById("cmd_whimsyLassoOpenTabs").doCommand();
  await TestUtils.waitForCondition(() => toasts.some(t => t.id == "whimsy-link-lasso-open-toast"), "command opened tabs");
  ok(!WhimsyLinkLasso.hasSelection(window), "hasSelection cleared after command");
  ok(!(await lassoState(browser)), "lasso closed by command");

  removeLinkTabs();
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_escape_cancels_without_clicking() {
  const tab = await openPage();
  const browser = tab.linkedBrowser;
  const before = gBrowser.tabs.length;
  toasts.length = 0;
  await mouse(browser, "mousedown", 25, 30, { altKey: true });
  await mouse(browser, "mousemove", 120, 80, { altKey: true, buttons: 1 });
  ok((await lassoState(browser))?.started, "lassoing");
  EventUtils.synthesizeKey("KEY_Escape", {}, window);
  ok(!(await lassoState(browser)), "Esc cancels during drag");
  // Releasing over a link afterwards must not follow it.
  await SpecialPowers.spawn(browser, [], () => {
    content.document.getElementById("a1").addEventListener("click", e => {
      content.wrappedJSObject.clicked = !e.defaultPrevented;
      e.preventDefault();
    });
  });
  await BrowserTestUtils.synthesizeMouseAtCenter("#a1", { type: "mouseup", altKey: true }, browser);
  await new Promise(r => setTimeout(r, 100));
  const clicked = await SpecialPowers.spawn(browser, [], () => !!content.wrappedJSObject.clicked);
  ok(!clicked, "no click went through");
  is(gBrowser.tabs.length, before, "no tabs were made");
  ok(!toasts.length, "no toast");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_escape_cancels_pill() {
  const tab = await openPage();
  const browser = tab.linkedBrowser;
  toasts.length = 0;
  await mouse(browser, "mousedown", 5, 5, { altKey: true });
  await mouse(browser, "mousemove", 300, 200, { altKey: true, buttons: 1 });
  await mouse(browser, "mouseup", 300, 200, { altKey: true });

  let state = await lassoState(browser);
  ok(state?.pillActive, "pill active");
  EventUtils.synthesizeKey("KEY_Escape", {}, window);
  ok(!(await lassoState(browser)), "Esc cancels pill");
  ok(!WhimsyLinkLasso.hasSelection(window), "hasSelection cleared");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_click_outside_cancels_pill() {
  const tab = await openPage();
  const browser = tab.linkedBrowser;
  toasts.length = 0;
  await mouse(browser, "mousedown", 5, 5, { altKey: true });
  await mouse(browser, "mousemove", 300, 200, { altKey: true, buttons: 1 });
  await mouse(browser, "mouseup", 300, 200, { altKey: true });

  let state = await lassoState(browser);
  ok(state?.pillActive, "pill active");
  await mouse(browser, "mousedown", 5, 5);
  ok(!(await lassoState(browser)), "click outside cancels pill");
  ok(!WhimsyLinkLasso.hasSelection(window), "hasSelection cleared");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_normal_drag_and_click_untouched() {
  const tab = await openPage();
  const browser = tab.linkedBrowser;
  // A plain drag selects text.
  await BrowserTestUtils.synthesizeMouse("#text", 1, 5, { type: "mousedown" }, browser);
  await BrowserTestUtils.synthesizeMouse("#text", 120, 5, { type: "mousemove", buttons: 1 }, browser);
  await BrowserTestUtils.synthesizeMouse("#text", 120, 5, { type: "mouseup" }, browser);
  const selected = await SpecialPowers.spawn(browser, [], () => content.getSelection().toString());
  ok(selected.length > 3, "a plain drag still selects text");
  ok(!(await lassoState(browser)), "no lasso without Option");

  // Option-click without a drag still clicks. (On a link, Option-click is
  // Zen's Glance, which handles the click itself; use plain text here.)
  await SpecialPowers.spawn(browser, [], () => {
    content.document.getElementById("text").addEventListener("click", e => {
      content.wrappedJSObject.altClicked = e.altKey;
    });
  });
  await BrowserTestUtils.synthesizeMouseAtCenter("#text", { altKey: true }, browser);
  ok(await SpecialPowers.spawn(browser, [], () => !!content.wrappedJSObject.altClicked), "Option-click still clicks");

  // Fields keep Option-drag (word selection).
  await BrowserTestUtils.synthesizeMouse("#field", 4, 4, { type: "mousedown", altKey: true }, browser);
  await BrowserTestUtils.synthesizeMouse("#field", 60, 4, { type: "mousemove", altKey: true, buttons: 1 }, browser);
  ok(!(await lassoState(browser)), "no lasso from a text field");
  await BrowserTestUtils.synthesizeMouse("#field", 60, 4, { type: "mouseup", altKey: true }, browser);

  // A page that handles Option-drag itself keeps it.
  await SpecialPowers.spawn(browser, [], () => {
    content.document.addEventListener("mousedown", e => e.preventDefault(), { once: true });
  });
  await mouse(browser, "mousedown", 5, 5, { altKey: true });
  await mouse(browser, "mousemove", 200, 100, { altKey: true, buttons: 1 });
  ok(!(await lassoState(browser)), "the page's own Option-drag wins");
  await mouse(browser, "mouseup", 200, 100, { altKey: true });
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_private_and_edges() {
  const tab = WhimsyPrivate.openPrivateTab(window, { url: PAGE, force: true });
  ok(tab, "a private tab opened");
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser);
  toasts.length = 0;
  const before = gBrowser.tabs.length;
  const made = WhimsyLinkLasso.createFolder(window, tab.linkedBrowser, {
    links: [{ url: "https://example.org/one", title: "One" }],
    pageTitle: "Private",
  });
  is(made, null, "no folder from a private tab");
  is(gBrowser.tabs.length, before, "no tabs either");
  is(toasts[0]?.id, "whimsy-link-lasso-private-toast", "says why");

  // design-full-4 M2: the pill doesn't offer Make Folder there, and Open as
  // Tabs works, opening the links as private tabs (nothing is kept).
  const browser = tab.linkedBrowser;
  await SpecialPowers.spawn(browser, [], () => content.focus());
  await mouse(browser, "mousedown", 5, 5, { altKey: true });
  await mouse(browser, "mousemove", 300, 200, { altKey: true, buttons: 1 });
  await mouse(browser, "mouseup", 300, 200, { altKey: true });
  await TestUtils.waitForCondition(() => WhimsyLinkLasso.hasSelection(window), "the selection reached the parent");
  const hidden = await SpecialPowers.spawn(browser, [], async () => {
    const actor = content.windowGlobalChild.getActor("WhimsyLasso");
    await ContentTaskUtils.waitForCondition(() => actor.lasso?.folderBtn?.hidden, "Make Folder hides");
    return { folder: actor.lasso.folderBtn.hidden, tabs: actor.lasso.tabsBtn.hidden };
  });
  ok(hidden.folder && !hidden.tabs, "private: the pill offers only Open as Tabs");
  const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");
  const action = id => globalActions.find(a => a.l10nId == id);
  ok(action("whimsy-action-lasso-open-tabs").isAvailable(window), "private: Open Lassoed Links as Tabs is offered");
  ok(!action("whimsy-action-lasso-make-folder").isAvailable(window), "private: Make Folder from Lassoed Links isn't");
  const opened = [];
  const onOpen = event => opened.push(event.target);
  gBrowser.tabContainer.addEventListener("TabOpen", onOpen);
  toasts.length = 0;
  await SpecialPowers.spawn(browser, [], () => {
    content.windowGlobalChild.getActor("WhimsyLasso").lasso.tabsBtn.click();
  });
  await TestUtils.waitForCondition(() => toasts.some(t => t.id == "whimsy-link-lasso-open-toast"), "tabs opened");
  gBrowser.tabContainer.removeEventListener("TabOpen", onOpen);
  is(opened.length, 3, "the three links opened");
  ok(opened.every(t => WhimsyPrivate.isPrivateTab(t)), "as private tabs");
  for (const t of opened) {
    BrowserTestUtils.removeTab(t);
  }
  BrowserTestUtils.removeTab(tab);

  is(WhimsyLinkLasso.folderName("", "https://www.example.org/x"), "example.org", "untitled pages use the site");
  is(WhimsyLinkLasso.folderName("", "about:blank"), "Links", "no title or site: the localized fallback");
  is(WhimsyLinkLasso.folderName("x".repeat(80), "").length, 60, "long titles are shortened");
  is(WhimsyLinkLasso.createFolder(window, gBrowser.selectedBrowser, { links: [] }), null, "no links, no folder");
});

add_task(async function test_feature_switch_off() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.link-lasso", false]] });
  const tab = await openPage();
  const browser = tab.linkedBrowser;
  await mouse(browser, "mousedown", 5, 5, { altKey: true });
  await mouse(browser, "mousemove", 300, 200, { altKey: true, buttons: 1 });
  ok(!(await lassoState(browser)), "no lasso with the switch off");
  await mouse(browser, "mouseup", 300, 200, { altKey: true });
  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
});

// design-full-4 M1: opening the command bar blurs the page; the selection
// must survive it so "Open Lassoed Links as Tabs" and "Make Folder from
// Lassoed Links" show in the command bar and run from there.
add_task(async function test_lasso_commands_from_the_command_bar() {
  const tab = await openPage();
  const browser = tab.linkedBrowser;
  await mouse(browser, "mousedown", 5, 5, { altKey: true });
  await mouse(browser, "mousemove", 300, 200, { altKey: true, buttons: 1 });
  await mouse(browser, "mouseup", 300, 200, { altKey: true });
  await TestUtils.waitForCondition(() => WhimsyLinkLasso.hasSelection(window), "lassoed");

  await UrlbarTestUtils.promiseAutocompleteResultPopup({ window, waitForFocus: SimpleTest.waitForFocus, value: "Lassoed" });
  ok(WhimsyLinkLasso.hasSelection(window), "the selection survives the page losing focus");
  ok((await lassoState(browser))?.pillActive, "the pill and highlights stay while the bar is open");
  const rowFor = text => {
    for (let i = 0; i < UrlbarTestUtils.getResultCount(window); i++) {
      const row = UrlbarTestUtils.getRowAt(window, i);
      if (row?.textContent.includes(text)) {
        return row;
      }
    }
    return null;
  };
  await TestUtils.waitForCondition(() => rowFor("Open Lassoed Links as Tabs"), "Open Lassoed Links as Tabs is offered");
  ok(rowFor("Make Folder from Lassoed Links"), "Make Folder from Lassoed Links is offered");

  const opened = [];
  const onOpen = event => opened.push(event.target);
  gBrowser.tabContainer.addEventListener("TabOpen", onOpen);
  toasts.length = 0;
  EventUtils.synthesizeMouseAtCenter(rowFor("Make Folder from Lassoed Links"), {});
  await TestUtils.waitForCondition(() => toasts.some(t => t.id == "whimsy-link-lasso-toast"), "the folder was made from the bar");
  gBrowser.tabContainer.removeEventListener("TabOpen", onOpen);
  const linkTabs = opened.filter(t => !t.hasAttribute("zen-empty-tab"));
  is(linkTabs.length, 3, "one tab per lassoed link");
  ok(!WhimsyLinkLasso.hasSelection(window), "running the command clears the selection");
  await TestUtils.waitForCondition(async () => !(await lassoState(browser)), "…and the pill");
  await UrlbarTestUtils.promisePopupClose(window).catch(() => {});
  gURLBar.blur();
  const folder = linkTabs[0]?.group;
  if (folder?.isZenFolder) {
    await folder.delete();
  }
  removeLinkTabs();
  BrowserTestUtils.removeTab(tab);
});

// A selection doesn't outlive switching tabs (the page is hidden).
add_task(async function test_lasso_cleared_by_tab_switch() {
  const tab = await openPage();
  const browser = tab.linkedBrowser;
  await mouse(browser, "mousedown", 5, 5, { altKey: true });
  await mouse(browser, "mousemove", 300, 200, { altKey: true, buttons: 1 });
  await mouse(browser, "mouseup", 300, 200, { altKey: true });
  await TestUtils.waitForCondition(() => WhimsyLinkLasso.hasSelection(window), "lassoed");
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
  await BrowserTestUtils.switchTab(gBrowser, tab);
  await TestUtils.waitForCondition(() => !WhimsyLinkLasso.hasSelection(window), "switching away cleared it");
  ok(!(await lassoState(browser)), "the pill is gone");
  BrowserTestUtils.removeTab(other);
  BrowserTestUtils.removeTab(tab);
});

// design-full-4 L2: the pill's buttons are at least 24px tall, and the
// overlay sheet (chrome://, in anonymous content) actually applies.
add_task(async function test_lasso_pill_targets() {
  const tab = await openPage();
  const browser = tab.linkedBrowser;
  await mouse(browser, "mousedown", 5, 5, { altKey: true });
  await mouse(browser, "mousemove", 300, 200, { altKey: true, buttons: 1 });
  await mouse(browser, "mouseup", 300, 200, { altKey: true });
  const sizes = await SpecialPowers.spawn(browser, [], async () => {
    const actor = content.windowGlobalChild.getActor("WhimsyLasso");
    await ContentTaskUtils.waitForCondition(() => actor.lasso?.pillActive, "pill");
    const style = content.getComputedStyle(actor.lasso.pill);
    await ContentTaskUtils.waitForCondition(
      () => content.getComputedStyle(actor.lasso.pill).position == "absolute",
      "the overlay sheet applies"
    );
    return {
      position: style.position,
      heights: [actor.lasso.tabsBtn, actor.lasso.folderBtn].map(b => b.getBoundingClientRect().height),
    };
  });
  is(sizes.position, "absolute", "the pill is styled");
  ok(sizes.heights.every(h => h >= 24), `buttons are at least 24px tall (${sizes.heights})`);
  await SpecialPowers.spawn(browser, [], () => content.windowGlobalChild.getActor("WhimsyLasso").end({ cancel: true }));
  BrowserTestUtils.removeTab(tab);
});
