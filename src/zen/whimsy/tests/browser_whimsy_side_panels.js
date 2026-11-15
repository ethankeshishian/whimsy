/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W29 side panels: an Essential opens in a popover next to the sidebar by
// default, without becoming the selected tab and without moving the page.
// It closes on a page click, its tile again, the hide button, a tab switch,
// or a Glance; Esc goes to the site. "Open in Side Panel" (unchecked) and
// "Open in Tab" open it as a normal tab. The free edge resizes it, clamped,
// per site. "Show Chat as Popover" puts chat on the same surface.

const { WhimsySidePanel } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySidePanel.sys.mjs");
const { WhimsyCommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommands.sys.mjs");
const { WhimsyChatPanel } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyChatPanel.sys.mjs");
const { WhimsyAIProviders } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIProviders.sys.mjs");
const { WhimsyAIStore } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIStore.sys.mjs");
const { SessionStore } = ChromeUtils.importESModule("moz-src:///browser/components/sessionstore/SessionStore.sys.mjs");

const WIDTHS = "whimsy.side-panel.widths";
const PREFS = [WIDTHS, "whimsy.chat.popover", "whimsy.chat.side", "whimsy.chat.width", "whimsy.chat.ai-off-toast-seen", "whimsy.ai.order", "whimsy.ai.hints.seen"];

const sp = () => WhimsySidePanel.forWindow(window);
const box = tab => tab.linkedBrowser.closest(".browserSidebarContainer");
const shown = tab => box(tab)?.hasAttribute("whimsy-popover") && sp().tab == tab;
const grip = tab => box(tab).querySelector(":scope > .whimsy-side-panel-grip");
const widthOf = tab => Math.round(box(tab).getBoundingClientRect().width);

const startTabs = new Set(gBrowser.tabs);
let home;

async function settle(tab) {
  await TestUtils.waitForCondition(
    () => !box(tab) || box(tab).getAnimations().every(a => a.playState != "running"),
    "The popover's motion has finished"
  );
}

async function makeEssential(url) {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, url);
  gZenPinnedTabManager.addToEssentials(tab);
  await TestUtils.waitForCondition(() => tab.hasAttribute("zen-essential"), "An Essential");
  gBrowser.selectedTab = home;
  await TestUtils.waitForCondition(() => !tab.selected, "A background tile");
  return tab;
}

async function clickTile(tab, expectShown) {
  EventUtils.synthesizeMouseAtCenter(tab, {});
  await TestUtils.waitForCondition(() => shown(tab) == expectShown, expectShown ? "The popover shows" : "The popover hides");
  await settle(tab);
}

async function hidden(tab, why) {
  await TestUtils.waitForCondition(() => !sp().tab, why);
  await TestUtils.waitForCondition(() => !box(tab).hasAttribute("whimsy-popover"), "...and its panel goes back");
}

async function openTabMenu(tab) {
  const menu = document.getElementById("tabContextMenu");
  const shownEvent = BrowserTestUtils.waitForEvent(menu, "popupshown");
  EventUtils.synthesizeMouseAtCenter(tab, { type: "contextmenu", button: 2 });
  await shownEvent;
  return menu;
}

async function closeMenu(menu) {
  const hiddenEvent = BrowserTestUtils.waitForEvent(menu, "popuphidden");
  menu.hidePopup();
  await hiddenEvent;
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.side-panels", true]] });
  const { outerWidth, outerHeight } = window;
  window.resizeTo(1400, 900);
  await TestUtils.waitForCondition(() => window.innerWidth >= 1300, "Wide window");
  home = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?home");
  registerCleanupFunction(async () => {
    sp().hide({ animate: false });
    for (const tab of [...gBrowser.tabs, ...(gZenWorkspaces.allStoredTabs ?? [])].filter(t => !startTabs.has(t))) {
      if (tab.hasAttribute("zen-essential")) {
        gZenPinnedTabManager.removeEssentials(tab);
      }
      if (!tab.closing && tab.isConnected) {
        BrowserTestUtils.removeTab(tab);
      }
    }
    for (const pref of PREFS) {
      Services.prefs.clearUserPref(pref);
    }
    WhimsyAIProviders.setTestProvider(null);
    window.resizeTo(outerWidth, outerHeight);
  });
});

add_task(async function click_shows_beside_sidebar_without_selecting() {
  const ess = await makeEssential("https://example.org/?mail");
  const pageWidth = home.linkedBrowser.getBoundingClientRect().width;
  await clickTile(ess, true);
  is(gBrowser.selectedTab, home, "The page stays the selected tab");
  is(home.linkedBrowser.getBoundingClientRect().width, pageWidth, "The page doesn't move or shrink");
  is(widthOf(ess), WhimsySidePanel.DEFAULT_WIDTH, "380px wide");
  const panels = document.getElementById("tabbrowser-tabpanels").getBoundingClientRect();
  const rect = box(ess).getBoundingClientRect();
  Assert.lessOrEqual(Math.abs(rect.top - panels.top - (panels.bottom - rect.bottom)), 2, "Centred top to bottom");
  Assert.less(rect.left - panels.left, 40, "Next to the sidebar");
  is(box(ess).getAttribute("role"), "dialog", "A dialog");
  is(box(ess).getAttribute("aria-label"), "example.org", "named for its site");
  is(ess.getAttribute("visuallyselected"), "true", "Its tile looks selected while it shows");
  const host = box(ess).querySelector(".whimsy-side-panel-host");
  is(host.textContent, "example.org", "The header shows the site");

  await clickTile(ess, false);
  ok(!ess.hasAttribute("visuallyselected"), "A second click on its tile hides it");
  is(gBrowser.selectedTab, home, "and nothing was selected");
});

add_task(async function page_click_tab_switch_and_glance_hide_it() {
  const ess = await makeEssential("https://example.org/?chat");
  await clickTile(ess, true);
  EventUtils.synthesizeMouse(home.linkedBrowser, home.linkedBrowser.getBoundingClientRect().width - 40, 200, {});
  await hidden(ess, "A click in the page hides it");

  await clickTile(ess, true);
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?other");
  await hidden(ess, "A tab switch hides it");
  gBrowser.selectedTab = home;
  BrowserTestUtils.removeTab(other);

  await clickTile(ess, true);
  window.dispatchEvent(new CustomEvent("GlanceOpen", { bubbles: true }));
  await hidden(ess, "A Glance opening hides it");
});

add_task(async function esc_goes_to_the_site_and_hide_button_hides() {
  const ess = await makeEssential("https://example.org/?esc");
  // The first show reloads it once with the phone user agent.
  const loaded = BrowserTestUtils.browserLoaded(ess.linkedBrowser);
  await clickTile(ess, true);
  await loaded;
  await TestUtils.waitForCondition(() => document.activeElement == ess.linkedBrowser, "Focus moves into the site");
  await SpecialPowers.spawn(ess.linkedBrowser, [], () => {
    content.document.addEventListener("keydown", e => {
      if (e.key == "Escape") {
        content.document.body.dataset.esc = "1";
      }
    });
  });
  EventUtils.synthesizeKey("KEY_Escape");
  await TestUtils.waitForCondition(
    () => SpecialPowers.spawn(ess.linkedBrowser, [], () => content.document.body.dataset.esc == "1"),
    "Esc reaches the site"
  );
  ok(shown(ess), "and never hides the popover");

  const button = box(ess).querySelector(".whimsy-side-panel-hide");
  await TestUtils.waitForCondition(() => button.getAttribute("aria-label") == "Hide side panel", "The hide button is named");
  is(button.title, "Hide side panel", "with a tooltip");
  EventUtils.synthesizeMouseAtCenter(button, {});
  await hidden(ess, "The hide button hides it");
  is(document.activeElement, home.linkedBrowser, "Focus goes back to the page");
});

add_task(async function switching_sites_keeps_pages_and_phone_layout() {
  const a = await makeEssential("https://example.org/?a");
  const b = await makeEssential("https://example.com/?b");
  const loaded = BrowserTestUtils.browserLoaded(a.linkedBrowser);
  await clickTile(a, true);
  await loaded;
  const ua = await SpecialPowers.spawn(a.linkedBrowser, [], () => content.navigator.userAgent);
  ok(ua.includes("iPhone"), "The popover's site gets the phone layout");
  await SpecialPowers.spawn(a.linkedBrowser, [], () => {
    content.wrappedJSObject.kept = 1;
  });
  await clickTile(b, true);
  ok(!shown(a), "Another tile swaps the site");
  await clickTile(a, true);
  is(await SpecialPowers.spawn(a.linkedBrowser, [], () => content.wrappedJSObject.kept), 1, "Coming back doesn't reload it");
  sp().hide({ animate: false });

  // Picked as a page (here by keyboard): desktop again.
  const reloaded = BrowserTestUtils.browserLoaded(a.linkedBrowser);
  gBrowser.selectedTab = a;
  await reloaded;
  const desktop = await SpecialPowers.spawn(a.linkedBrowser, [], () => content.navigator.userAgent);
  ok(!desktop.includes("iPhone"), "As a page it's desktop");
  ok(!sp().tab, "and nothing floats");
  gBrowser.selectedTab = home;
});

add_task(async function menu_checkbox_and_open_in_tab() {
  const ess = await makeEssential("https://example.org/?menu");
  let menu = await openTabMenu(ess);
  const item = document.getElementById("context_whimsySidePanel");
  ok(item && !item.hidden, "An Essential's menu has Open in Side Panel");
  is(item.getAttribute("type"), "checkbox", "as a checkbox");
  is(item.getAttribute("checked"), "true", "on by default");
  is(item.previousElementSibling?.id, "context_whimsyUnreadBadge", "under Show Unread Badge");
  await TestUtils.waitForCondition(() => item.label == "Open in Side Panel", "Its name");
  menu.activateItem(item);
  await BrowserTestUtils.waitForEvent(menu, "popuphidden");
  ok(ess.hasAttribute(WhimsySidePanel.OFF_ATTR), "Unchecked");
  is(SessionStore.getCustomTabValue(ess, WhimsySidePanel.OFF_KEY), "true", "and saved with the tab");

  EventUtils.synthesizeMouseAtCenter(ess, {});
  await TestUtils.waitForCondition(() => gBrowser.selectedTab == ess, "Unchecked, it opens as a normal tab");
  ok(!sp().tab, "not in the popover");

  // Checked again while on it: the page you were on comes back.
  menu = await openTabMenu(ess);
  ok(!item.hasAttribute("checked"), "Shown unchecked");
  menu.activateItem(item);
  await BrowserTestUtils.waitForEvent(menu, "popuphidden");
  await TestUtils.waitForCondition(() => gBrowser.selectedTab == home, "Checking it goes back to the page");
  ok(!ess.hasAttribute(WhimsySidePanel.OFF_ATTR), "Checked");
  ok(!SessionStore.getCustomTabValue(ess, WhimsySidePanel.OFF_KEY), "Nothing saved when on");

  menu = await openTabMenu(home);
  ok(!item.checkVisibility(), "A normal tab has no Open in Side Panel");
  await closeMenu(menu);

  // Open in Tab, from the command bar's command.
  const entry = WhimsyCommands.get("cmd_whimsySidePanel");
  ok(entry, "A command");
  Assert.deepEqual(entry.variants, ["whimsy-action-open-in-side-panel", "whimsy-action-open-in-tab"], "named for what it does");
  await clickTile(ess, true);
  document.getElementById("cmd_whimsySidePanel").doCommand();
  await TestUtils.waitForCondition(() => gBrowser.selectedTab == ess, "Open in Tab makes it the page");
  ok(ess.hasAttribute(WhimsySidePanel.OFF_ATTR), "and opens it as a tab from then on");
  ok(!box(ess).hasAttribute("whimsy-popover"), "No longer floating");
  document.getElementById("cmd_whimsySidePanel").doCommand();
  await TestUtils.waitForCondition(() => gBrowser.selectedTab == home, "Open in Side Panel sends it back to the sidebar");
  ok(!ess.hasAttribute(WhimsySidePanel.OFF_ATTR), "on again");
});

async function drag(tab, dx) {
  const g = grip(tab);
  EventUtils.synthesizeMouse(g, 3, 100, { type: "mousedown" });
  EventUtils.synthesizeMouse(g, 3 + dx / 2, 100, { type: "mousemove" });
  EventUtils.synthesizeMouse(g, 3 + dx, 100, { type: "mousemove" });
  EventUtils.synthesizeMouse(g, 3 + dx, 100, { type: "mouseup" });
  await settle(tab);
}

const saved = () => JSON.parse(Services.prefs.getStringPref(WIDTHS, "{}"));

add_task(async function resize_is_clamped_and_kept_per_site() {
  const a = await makeEssential("https://example.org/?wide");
  const b = await makeEssential("https://example.com/?narrow");
  await clickTile(a, true);
  ok(grip(a).checkVisibility(), "A grip on the free edge");
  await TestUtils.waitForCondition(() => grip(a).getAttribute("aria-label") == "Resize side panel", "Named");
  await drag(a, 100);
  is(widthOf(a), 480, "Dragging the edge follows the pointer");
  is(saved()["example.org"], 480, "and is kept for that site");
  await drag(a, 2000);
  is(widthOf(a), Math.floor(window.innerWidth / 2), "No wider than half the window");
  await drag(a, -2000);
  is(widthOf(a), WhimsySidePanel.MIN_WIDTH, "No narrower than 320px");
  await drag(a, 80);
  const kept = widthOf(a);
  is(kept, 400, "400px");

  await clickTile(b, true);
  is(widthOf(b), WhimsySidePanel.DEFAULT_WIDTH, "Another site keeps its own width");
  await clickTile(a, true);
  is(widthOf(a), kept, "and the first site comes back at its width");

  EventUtils.synthesizeMouse(grip(a), 3, 100, { clickCount: 1 });
  EventUtils.synthesizeMouse(grip(a), 3, 100, { clickCount: 2 });
  await settle(a);
  is(widthOf(a), WhimsySidePanel.DEFAULT_WIDTH, "Double-click resets the width");
  ok(!("example.org" in saved()), "and forgets it");

  // A window under 1000px: 320px.
  window.resizeTo(960, 800);
  await TestUtils.waitForCondition(() => window.innerWidth < 1000, "Narrow window");
  await TestUtils.waitForCondition(() => widthOf(a) == WhimsySidePanel.MIN_WIDTH, "320px in a narrow window");
  window.resizeTo(1400, 900);
  await TestUtils.waitForCondition(() => window.innerWidth >= 1300, "Wide again");
  await TestUtils.waitForCondition(() => widthOf(a) == WhimsySidePanel.DEFAULT_WIDTH, "380px again");
  sp().hide({ animate: false });
});

// ---- Chat on the same surface ----

const chat = () => WhimsyChatPanel.forWindow(window);
const chatEl = () => document.getElementById("whimsy-chat");

async function settleChat() {
  await TestUtils.waitForCondition(
    () => !chatEl() || chatEl().getAnimations({ subtree: true }).every(a => a.playState != "running"),
    "Chat's motion has finished"
  );
}

async function pressCmdE() {
  const was = chat().isOpen;
  EventUtils.synthesizeKey("e", { accelKey: true });
  await TestUtils.waitForCondition(() => chat().isOpen != was, "⌘E reached chat");
  await settleChat();
}

add_task(async function chat_as_popover_toggle() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.ai.enabled", true], ["whimsy.feature.ai-hints", false]] });
  await WhimsyAIStore._resetForTesting(PathUtils.join(PathUtils.tempDir, "whimsy-side-panels-" + Date.now()));
  WhimsyAIProviders.setTestProvider(async function* () {
    yield { type: "text", delta: "Hello." };
  });
  WhimsyAIProviders.setOrder(["claude"]);
  is(Services.prefs.getDefaultBranch("").getBoolPref("whimsy.chat.popover"), false, "Off by default");
  await SimpleTest.promiseFocus(window);
  gBrowser.selectedBrowser.focus();

  // Off: chat is its own column and the page narrows.
  const pageWidth = home.linkedBrowser.getBoundingClientRect().width;
  await pressCmdE();
  ok(!chatEl().hasAttribute("whimsy-popover"), "A column when off");
  chat().close({ reason: "key" });
  await settleChat();

  Services.prefs.setBoolPref("whimsy.chat.popover", true);
  await pressCmdE();
  ok(chatEl().hasAttribute("whimsy-popover"), "On: chat floats in the popover");
  is(home.linkedBrowser.getBoundingClientRect().width, pageWidth, "The page doesn't move");
  const panels = document.getElementById("tabbrowser-tabpanels").getBoundingClientRect();
  Assert.less(chatEl().getBoundingClientRect().left - panels.left, 40, "Next to the sidebar");

  const menu = chat().headMenu;
  const shownEvent = BrowserTestUtils.waitForEvent(menu, "popupshown");
  menu.openPopup(chatEl(), "after_start");
  await shownEvent;
  const popover = document.getElementById("whimsy-chat-menu-popover");
  await TestUtils.waitForCondition(() => popover.label == "Show Chat as Popover", "Its name");
  is(popover.getAttribute("checked"), "true", "Checked");
  ok(popover.previousElementSibling.disabled, "Moving chat is off while it floats");
  await closeMenu(menu);

  // One thing at a time.
  const ess = await makeEssential("https://example.org/?with-chat");
  await pressCmdE();
  ok(chat().isOpen, "Chat open again");
  await clickTile(ess, true);
  await TestUtils.waitForCondition(() => !chat().isOpen, "A site in the popover closes chat");
  await pressCmdE();
  await hidden(ess, "Chat in the popover hides the site");
  EventUtils.synthesizeMouse(home.linkedBrowser, home.linkedBrowser.getBoundingClientRect().width - 40, 200, {});
  await TestUtils.waitForCondition(() => !chat().isOpen, "A page click closes chat in the popover");
  await settleChat();

  Services.prefs.setBoolPref("whimsy.chat.popover", false);
  await pressCmdE();
  ok(!chatEl().hasAttribute("whimsy-popover"), "Off again: a column");
  chat().close({ reason: "key" });
  await settleChat();
  await WhimsyAIStore._resetForTesting(null);
});
