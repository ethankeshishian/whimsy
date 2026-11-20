/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "head_side_panel.js", this);

// Core Essential routing and chat on the shared popover surface.

addPanelTask(async function click_shows_beside_sidebar_without_selecting() {
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

addPanelTask(async function page_click_and_tab_switch_keep_floating() {
  const ess = await makeEssential("https://example.org/?chat");
  await clickTile(ess, true);
  await SpecialPowers.spawn(home.linkedBrowser, [], () => {
    content.document.addEventListener("click", () => content.document.body.dataset.clicked = "yes", { once: true });
  });
  await BrowserTestUtils.synthesizeMouseAtPoint(home.linkedBrowser.clientWidth - 40, 200, {}, home.linkedBrowser);
  await TestUtils.waitForCondition(() => SpecialPowers.spawn(home.linkedBrowser, [], () => content.document.body.dataset.clicked == "yes"), "The page receives the click");
  ok(shown(ess), "Page clicks keep the popover open");
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?other");
  ok(shown(ess), "A tab switch keeps it floating");
  gBrowser.selectedTab = home;
  BrowserTestUtils.removeTab(other);
  window.dispatchEvent(new CustomEvent("GlanceOpen", { bubbles: true }));
  await hidden(ess, "A Glance opening hides it");
  await clickTile(ess, true);
  window.dispatchEvent(new CustomEvent("ZenWorkspaceChanged"));
  await hidden(ess, "A space switch hides it");
  await clickTile(ess, true);
  gZenPinnedTabManager.removeEssentials(ess);
  BrowserTestUtils.removeTab(ess);
  await TestUtils.waitForCondition(() => !sp().tab, "Closing the Essential hides it");
});

addPanelTask(async function esc_goes_to_the_site_and_hide_button_hides() {
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
  await TestUtils.waitForCondition(() => button.getAttribute("aria-label") == "Minimize", "The hide button is named");
  is(button.title, "Minimize", "with a tooltip");
  EventUtils.synthesizeMouseAtCenter(button, {});
  await hidden(ess, "The hide button hides it");
  is(document.activeElement, home.linkedBrowser, "Focus goes back to the page");
});

addPanelTask(async function switching_sites_keeps_pages_and_phone_layout() {
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

addPanelTask(async function menu_checkbox_and_open_in_tab() {
  const ess = await makeEssential("https://example.org/?menu");
  let menu = await openTabMenu(ess);
  const item = document.getElementById("context_whimsySidePanel");
  ok(item && !item.hidden, "An Essential's menu has Open in Side Panel");
  is(item.getAttribute("type"), "checkbox", "as a checkbox");
  is(item.getAttribute("checked"), "true", "on by default");
  // The regroup puts Side Panel beside Essentials in Where it lives;
  // Show Unread Badge belongs to the later Label group.
  is(item.previousElementSibling?.id, "context_zen-remove-essential", "under Remove from Essentials");
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

// ---- Chat on the same surface ----

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

addPanelTask(async function chat_as_popover_toggle() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.ai.enabled", true], ["whimsy.feature.ai-hints", false]] });
  try {
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

  // Switching keeps chat open, both ways.
  await pressCmdE();
  ok(chat().isOpen, "Open as a column");
  Services.prefs.setBoolPref("whimsy.chat.popover", true);
  ok(chatEl().hasAttribute("whimsy-popover"), "On: chat floats in the popover");
  ok(chat().isOpen, "Switching to the popover keeps chat open");
  await settleChat();
  ok(chat().isOpen, "and it stays open");
  is(home.linkedBrowser.getBoundingClientRect().width, pageWidth, "The page doesn't move");

  // It docks on chat's side, not the sidebar's.
  const panels = document.getElementById("tabbrowser-tabpanels").getBoundingClientRect();
  Services.prefs.setStringPref("whimsy.chat.side", "right");
  await TestUtils.waitForCondition(() => panels.right - chatEl().getBoundingClientRect().right < 40, "Docked right when chat is on the right");
  Services.prefs.setStringPref("whimsy.chat.side", "left");
  await TestUtils.waitForCondition(() => chatEl().getBoundingClientRect().left - panels.left < 40, "Docked left when chat is on the left");
  Services.prefs.clearUserPref("whimsy.chat.side");

  // Minimize replaces the sidebar button, with the same action.
  const hideButton = document.getElementById("whimsy-chat-hide-button");
  is(hideButton.querySelector(".whimsy-chat-icon").dataset.icon, "minimize", "Minimize in the popover's header");
  is(hideButton.getAttribute("data-l10n-id"), "whimsy-chat-minimize-button", "named Minimize");

  // ⌘W closes the focused popover, not the tab.
  const tabs = gBrowser.tabs.length;
  chatEl().querySelector("textarea, [contenteditable], button")?.focus();
  ok(chatEl().contains(document.activeElement), "Focus is in chat");
  EventUtils.synthesizeKey("w", { accelKey: true });
  await TestUtils.waitForCondition(() => !chat().isOpen, "⌘W closes the popover");
  is(gBrowser.tabs.length, tabs, "and leaves the tab");
  await settleChat();

  await pressCmdE();
  ok(chat().isOpen, "Open in the popover");
  Services.prefs.setBoolPref("whimsy.chat.popover", false);
  ok(!chatEl().hasAttribute("whimsy-popover"), "Off: a column");
  ok(chat().isOpen, "Switching to the column keeps chat open");
  await settleChat();
  ok(chat().isOpen, "and it stays open");
  is(hideButton.querySelector(".whimsy-chat-icon").dataset.icon, "chat-hide", "The column keeps its own hide button");
  EventUtils.synthesizeMouse(home.linkedBrowser, home.linkedBrowser.getBoundingClientRect().width / 2, 200, {});
  ok(chat().isOpen, "A page click doesn't close the column (it's no longer the popover)");
  hideButton.click();
  await TestUtils.waitForCondition(() => !chat().isOpen, "Hidden");
  await settleChat();
  Services.prefs.setBoolPref("whimsy.chat.popover", true);
  await pressCmdE();
  ok(chatEl().hasAttribute("whimsy-popover"), "On again");

  const menu = chat().headMenu;
  const shownEvent = BrowserTestUtils.waitForEvent(menu, "popupshown");
  menu.openPopup(chatEl(), "after_start");
  await shownEvent;
  const popover = document.getElementById("whimsy-chat-menu-popover");
  await TestUtils.waitForCondition(() => popover.label == "Show Chat as Popover", "Its name");
  is(popover.getAttribute("checked"), "true", "Checked");
  ok(!popover.previousElementSibling.disabled, "Chat can still move sides while it floats");
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
  } finally {
    await WhimsyAIStore._resetForTesting(null);
    await SpecialPowers.popPrefEnv();
  }
});
