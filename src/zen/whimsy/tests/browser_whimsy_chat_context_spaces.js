/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W30 scoped chats (ideas-inventory 6b, mockup 9.3): chat's Add menu offers
// the current space by name and the tab's Zen folder, after the group row
// and before All my tabs, as chips like the group chip. They read with
// WhimsyAIContext's rules: no private tabs, nothing off limits. The folder
// row is left out when the tab isn't in a folder.

const { WhimsyChatPanel } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyChatPanel.sys.mjs");
const { WhimsyAIProviders } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIProviders.sys.mjs");
const { WhimsyAIStore } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIStore.sys.mjs");
const { WhimsyAIContext } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIContext.sys.mjs");

const PAGE = "https://example.com/browser/zen/whimsy/tests/whimsy_chat_article.html";
const chat = () => WhimsyChatPanel.forWindow(window);
const el = () => document.getElementById("whimsy-chat");
const part = sel => el().querySelector(sel);
const parts = sel => [...el().querySelectorAll(sel)];
let calls = [];
let firstSpace, weekend;

async function titled(tab, title) {
  await SpecialPowers.spawn(tab.linkedBrowser, [title], t => {
    content.document.title = t;
  });
  await TestUtils.waitForCondition(() => tab.label == title, `The tab reads ${title}`);
  return tab;
}

async function openPage(name) {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, `${PAGE}?${encodeURIComponent(name)}`);
  return titled(tab, name);
}

async function openChatOn(tab) {
  gBrowser.selectedTab = tab;
  await WhimsyAIStore._resetForTesting(PathUtils.join(PathUtils.tempDir, "whimsy-ctx-spaces-" + Math.random().toString(16).slice(2)));
  calls = [];
  if (!chat().isOpen) {
    EventUtils.synthesizeKey("e", { accelKey: true });
  }
  await TestUtils.waitForCondition(() => chat().isOpen && chat().ready && part(".whimsy-chat-chip[data-kind='tab']"), "Chat is open with its chip");
  await TestUtils.waitForCondition(() => el().getAnimations({ subtree: true }).every(a => a.playState != "running"), "Chat settled");
}

async function openAddMenu() {
  part(".whimsy-chat-add-menu")?.remove();
  EventUtils.synthesizeMouseAtCenter(part(".whimsy-chat-chip-add"), {});
  const menu = await TestUtils.waitForCondition(() => part(".whimsy-chat-add-menu"), "The Add menu opens");
  await TestUtils.waitForCondition(() => [...menu.querySelectorAll(".whimsy-chat-option-label")].every(l => l.textContent), "Its rows have words");
  return menu;
}

function closeAddMenu() {
  EventUtils.synthesizeKey("KEY_Escape");
  return TestUtils.waitForCondition(() => !part(".whimsy-chat-add-menu"), "The Add menu closes");
}

async function ask(text) {
  const before = parts(".whimsy-chat-msg[data-role='ai']").length;
  chat().composer.focus();
  EventUtils.sendString(text);
  EventUtils.synthesizeKey("KEY_Enter");
  await TestUtils.waitForCondition(() => !part(".whimsy-chat-msg[data-role='ai'][busy]") && parts(".whimsy-chat-msg[data-role='ai']").length > before, "The answer is in");
  return calls.at(-1).request.system;
}

async function closeChat() {
  part(".whimsy-chat-add-menu")?.remove();
  if (chat().isOpen) {
    chat().close({ reason: "key" });
    await TestUtils.waitForCondition(() => el().hidden, "Chat closed");
  }
}

const optionsOf = menu => [...menu.querySelectorAll(".whimsy-chat-option")];
const allTabsRow = menu => optionsOf(menu).find(o => o.querySelector("[data-l10n-id='whimsy-chat-add-all-tabs']"));
const chipOf = kind => part(`.whimsy-chat-chip[data-kind='${kind}']`);

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.ai.enabled", true], ["whimsy.feature.ai-hints", false], ["whimsy.ai.order", "claude"], ["whimsy.ai.off", ""], ["whimsy.feature.tree-tabs", false]] });
  WhimsyAIProviders.setTestProvider(async function* (provider, request) {
    calls.push({ provider, request });
    yield { type: "text", delta: "Answer to " + request.lastUserText };
  });
  firstSpace = gZenWorkspaces.getWorkspaces().find(w => w.uuid == gZenWorkspaces.activeWorkspace);
  weekend = await gZenWorkspaces.createAndSaveWorkspace("Weekend", undefined, true);
  await gZenWorkspaces.changeWorkspace(weekend);
  registerCleanupFunction(async () => {
    await closeChat();
    WhimsyAIProviders.setTestProvider(null);
    Services.prefs.clearUserPref("whimsy.ai.hints.seen");
    await gZenWorkspaces.changeWorkspace(firstSpace);
    await gZenWorkspaces.removeWorkspace(weekend.uuid);
  });
});

add_task(async function space_and_folder_rows_chips_and_what_they_read() {
  const one = await openPage("Folder one");
  const two = await openPage("Folder two");
  const folder = await gZenFolders.createFolder([one, two], { renameFolder: false, label: "Trip planning" });
  const lisbon = await openPage("Lisbon");
  const porto = await openPage("Porto");
  const locked = await openPage("Locked away");
  const isLockedTab = WhimsyAIContext.isLockedTab;
  WhimsyAIContext.isLockedTab = tab => tab == locked || isLockedTab.call(WhimsyAIContext, tab);
  let privateWin;
  try {
    is(WhimsyAIContext.folderOf(one), folder, "The tab is in the folder");
    await openChatOn(one);
    let menu = await openAddMenu();
    const spaceRow = menu.querySelector("[data-space]");
    const folderRow = menu.querySelector("[data-folder]");
    ok(spaceRow && folderRow, "A space row and a folder row");
    is(spaceRow.querySelector(".whimsy-chat-option-label").textContent, "Weekend", "The space by name");
    is(folderRow.querySelector(".whimsy-chat-option-label").textContent, "Trip planning", "The folder by name");
    await TestUtils.waitForCondition(() => spaceRow.querySelector(".whimsy-chat-option-detail").textContent == "4 tabs", "The space counts its web tabs, less the locked one");
    await TestUtils.waitForCondition(() => folderRow.querySelector(".whimsy-chat-option-detail").textContent == "2 tabs", "The folder counts its tabs");
    const options = optionsOf(menu);
    is(options.indexOf(spaceRow) + 1, options.indexOf(folderRow), "Space, then folder");
    is(options.indexOf(folderRow) + 1, options.indexOf(allTabsRow(menu)), "then All my tabs");

    EventUtils.synthesizeMouseAtCenter(spaceRow, {});
    const spaceChip = await TestUtils.waitForCondition(() => chipOf("space"), "A space chip joins the composer");
    is(spaceChip.querySelector(".whimsy-chat-chip-label").textContent, "Weekend", "named for the space");
    await TestUtils.waitForCondition(() => spaceChip.querySelector(".whimsy-chat-chip-count[data-kind='tabs']")?.textContent == "4 tabs", "and says 4 tabs");
    await TestUtils.waitForCondition(() => spaceChip.querySelector(".whimsy-chat-chip-body").getAttribute("title") == "Every tab in Weekend · 4 tabs. Show what AI sees", "Its tooltip");
    ok(part(".whimsy-chat-chip[data-kind='tab']"), "This tab stays too");

    menu = await openAddMenu();
    ok(!menu.querySelector("[data-space]"), "Once added, the space row is gone");
    EventUtils.synthesizeMouseAtCenter(menu.querySelector("[data-folder]"), {});
    const folderChip = await TestUtils.waitForCondition(() => chipOf("folder"), "A folder chip joins the composer");
    is(folderChip.querySelector(".whimsy-chat-chip-label").textContent, "Trip planning", "named for the folder");
    await TestUtils.waitForCondition(() => folderChip.querySelector(".whimsy-chat-chip-count[data-kind='tabs']")?.textContent == "2 tabs", "and says 2 tabs");
    await TestUtils.waitForCondition(() => folderChip.querySelector(".whimsy-chat-chip-body").getAttribute("title") == "Every tab in Trip planning · 2 tabs. Show what AI sees", "Its tooltip");
    is(folderChip.querySelector(".whimsy-chat-chip-mark").localName, "span", "led by the folder icon");
    menu = await openAddMenu();
    ok(!menu.querySelector("[data-folder]"), "Once added, the folder row is gone");
    await closeAddMenu();

    const system = await ask("Which city is cheaper?");
    ok(system.includes("?Lisbon") && system.includes("?Porto") && system.includes("?Folder%20two"), "The space's tabs are sent");
    ok(!system.includes("?Locked%20away"), "The locked tab isn't");
    is(system.split("?Folder%20one").length - 1, 1, "This tab is read once");
    is(system.split("?Folder%20two").length - 1, 1, "A tab in both the space and the folder is read once");
    // One used line under the message, one item per chip that widened it.
    const usedItems = () => parts(".whimsy-chat-used").flatMap(u => [...u.children].map(item => item.textContent));
    await TestUtils.waitForCondition(() => usedItems().includes("Used Weekend · 4 tabs"), "The used line names the space and its count");
    await TestUtils.waitForCondition(() => usedItems().includes("Used Trip planning · 2 tabs"), "and the folder and its count");

    // A private window's tabs are never read.
    privateWin = await BrowserTestUtils.openNewBrowserWindow({ private: true });
    const secret = await BrowserTestUtils.openNewForegroundTab(privateWin.gBrowser, `${PAGE}?Secret`);
    is(WhimsyAIContext.isOffLimits(secret), "private", "A private tab is off limits");
    const inPrivate = WhimsyAIContext.scopeTabs(privateWin, "space", privateWin.gZenWorkspaces?.activeWorkspace);
    ok(!inPrivate.tabs.includes(secret), "and no space chip reads it");
    ok(!WhimsyAIContext.scopeTabs(window, "space", weekend.uuid).tabs.includes(secret), "nor this window's");
  } finally {
    WhimsyAIContext.isLockedTab = isLockedTab;
    if (privateWin) {
      await BrowserTestUtils.closeWindow(privateWin);
    }
    await closeChat();
    if (folder.isConnected) {
      const removed = BrowserTestUtils.waitForEvent(folder, "TabGroupRemoved");
      folder.delete();
      await removed;
    }
    for (const tab of [one, two, lisbon, porto, locked]) {
      if (tab.isConnected && !tab.closing) {
        BrowserTestUtils.removeTab(tab);
      }
    }
  }
});

add_task(async function no_folder_row_outside_a_folder() {
  const lisbon = await openPage("Lisbon");
  const porto = await openPage("Porto");
  try {
    ok(!WhimsyAIContext.folderOf(lisbon), "Not in a folder");
    await openChatOn(lisbon);
    const menu = await openAddMenu();
    ok(!menu.querySelector("[data-folder]"), "No folder row");
    const spaceRow = menu.querySelector("[data-space]");
    ok(spaceRow, "The space row stays");
    await TestUtils.waitForCondition(() => spaceRow.querySelector(".whimsy-chat-option-detail").textContent == "2 tabs", "counting the space's tabs");
    const options = optionsOf(menu);
    is(options.indexOf(spaceRow) + 1, options.indexOf(allTabsRow(menu)), "just before All my tabs");
    await closeAddMenu();
  } finally {
    await closeChat();
    for (const tab of [lisbon, porto]) {
      if (tab.isConnected && !tab.closing) {
        BrowserTestUtils.removeTab(tab);
      }
    }
  }
});
