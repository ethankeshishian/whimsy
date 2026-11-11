/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { WhimsyAITabs } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAITabs.sys.mjs");
const { WhimsyAIProviders } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIProviders.sys.mjs");
const { SessionStore } = ChromeUtils.importESModule("moz-src:///browser/components/sessionstore/SessionStore.sys.mjs");
const { TabStateFlusher } = ChromeUtils.importESModule("moz-src:///browser/components/sessionstore/TabStateFlusher.sys.mjs");
const TITLE = "(7) Project planning notes for the autumn launch | Example";
const SHORT = "Launch Plan";
const initialTabs = new Set(gBrowser.tabs);
const folders = new Set();
let serial = 0;
let calls = 0;

add_setup(async function setup_tidy_pinning() {
  await SpecialPowers.pushPrefEnv({ set: [
    ["whimsy.feature.tidy-titles", true],
    ["whimsy.feature.ai-providers", true],
    ["whimsy.ai.enabled", true],
    ["zen.view.sidebar-expanded", true],
    ["zen.tabs.rename-tabs", true],
  ] });
  WhimsyAIProviders.setTestProvider(() => { calls++; return SHORT; });
  WhimsyAITabs.initWindow(window);
  registerCleanupFunction(async () => {
    WhimsyAIProviders.setTestProvider(null);
    for (const folder of folders) {
      if (folder.isConnected) {
        folder.delete();
      }
    }
    for (const tab of gBrowser.tabs.filter(t => !initialTabs.has(t))) {
      await closeTab(tab);
    }
  });
});

async function closeTab(tab) {
  if (!tab.isConnected || tab.closing) {
    return;
  }
  if (tab.hasAttribute("zen-essential")) {
    gZenPinnedTabManager.removeEssentials(tab);
  }
  await BrowserTestUtils.removeTab(tab);
}

async function page(title = TITLE) {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, `https://example.com/?tidy-pin=${++serial}`);
  await SpecialPowers.spawn(tab.linkedBrowser, [title], text => { content.document.title = text; });
  await TestUtils.waitForCondition(() => tab.label == title && !tab.hasAttribute("busy"), "Page title ready");
  return tab;
}

async function drop(tab, target) {
  await TestUtils.waitForCondition(() => !document.getAnimations().some(a =>
    a.playState == "running" && a.effect?.target?.closest?.(".tabbrowser-tab")), "Tabs settled before dragging");
  const rect = target.getBoundingClientRect();
  ok(rect.width && rect.height, "Drop target is visible");
  EventUtils.synthesizeDrop(tab, target, null, "move", window, window, {
    clientX: rect.x + rect.width / 2,
    clientY: rect.y + rect.height / 2,
  });
  const dataTransfer = new DataTransfer();
  dataTransfer.mozSetDataAt("application/x-moz-tabbrowser-tab", tab, 0);
  tab.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer }));
  await TestUtils.waitForCondition(() => tab.pinned, "Drop pinned the tab");
}

const paths = {
  async context_menu(tab) {
    const menu = document.getElementById("tabContextMenu");
    const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
    EventUtils.synthesizeMouseAtCenter(tab, { type: "contextmenu", button: 2 });
    await shown;
    const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
    menu.activateItem(document.getElementById("context_pinTab"));
    await hidden;
  },
  drag_to_pins: tab => drop(tab, gZenWorkspaces.activeWorkspaceElement.querySelector(".zen-current-workspace-indicator")),
  drag_to_essentials: tab => drop(tab, gZenWorkspaces.getCurrentEssentialsContainer()),
  async keyboard() {
    gURLBar.focus();
    EventUtils.synthesizeKey("d", { accelKey: true }, window);
  },
  async command_bar() {
    // Engage the real Pin Tab result through Zen's command-bar provider.
    const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");
    const { ZenUrlbarProviderGlobalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBActionsProvider.sys.mjs");
    const action = globalActions.find(a => a.l10nId == "zen-action-pin-tab");
    ok(action.isAvailable(window), "Pin Tab is available in the command bar");
    new ZenUrlbarProviderGlobalActions().onEngagement(null, null, {
      result: { payload: { zenCommand: action.command } }, element: gURLBar.inputField,
    });
  },
  async folder(tab) {
    folders.add(gZenFolders.createFolder([tab], { label: "Tidy regression", renameFolder: false }));
  },
  async existing_folder(tab) {
    const folder = gZenFolders.createFolder([], { label: "Existing tidy regression", renameFolder: false });
    folders.add(folder);
    folder.addTabs([tab]);
  },
};

async function assertPersisted(tab, expected, path) {
  // A painted title/busy=false does not mean SessionStore has received the
  // content process's history update. getTabState reads that cache synchronously.
  await TabStateFlusher.flush(tab.linkedBrowser);
  const state = SessionStore.getTabState(tab);
  const saved = JSON.parse(state);
  Assert.equal(saved.entries[saved.index - 1]?.url, tab.linkedBrowser.currentURI.spec,
    `${path}: session includes the loaded page before restoring`);
  is(saved.zenStaticLabel, expected, `${path}: session serializes the name`);
  const restored = BrowserTestUtils.addTab(gBrowser, "about:blank");
  try {
    ok(!restored.selected, `${path}: restoration displays the name in a background tab`);
    const restoring = BrowserTestUtils.waitForEvent(restored, "SSTabRestoring");
    SessionStore.setTabState(restored, state);
    await restoring;
    await TestUtils.waitForCondition(() => restored.label == expected, `${path}: restored name is visible`);
    is(restored.zenStaticLabel, expected, `${path}: name survives session restoration`);
  } finally {
    await closeTab(restored);
  }
}

add_task(async function test_every_pin_path_tidies_preserves_and_persists() {
  for (const [name, pin] of Object.entries(paths)) {
    const tab = await page();
    try {
      await pin(tab);
      await TestUtils.waitForCondition(() => tab.zenStaticLabel == SHORT, `${name}: pinning tidies the title`);
      is(tab.label, SHORT, `${name}: tidy name is visible`);
      ok(tab.hasAttribute("whimsy-title-tidied"), `${name}: reveal animation marker is present`);
      await assertPersisted(tab, SHORT, name);
    } finally {
      await closeTab(tab);
    }
    const named = await page();
    try {
      named.zenStaticLabel = "My chosen name";
      gBrowser._setTabLabel(named, named.zenStaticLabel, { _zenChangeLabelFlag: true });
      const before = calls;
      await pin(named);
      await TestUtils.waitForCondition(() => named.pinned, `${name}: named tab pinned`);
      await WhimsyAITabs.onTabPinned(named);
      is(calls, before, `${name}: no provider request for a manual name`);
      is(named.label, "My chosen name", `${name}: manual label is kept`);
      await assertPersisted(named, "My chosen name", name);
    } finally {
      await closeTab(named);
    }
  }
});

add_task(async function test_no_provider_offline_and_ai_disabled_fallback() {
  const ready = WhimsyAIProviders.isReady;
  try {
    for (const mode of ["no-provider", "offline", "empty", "ai-disabled"]) {
      let requests = 0;
      WhimsyAIProviders.isReady = async () => mode != "no-provider";
      WhimsyAIProviders.setTestProvider(() => {
        requests++;
        if (mode == "offline") {
          throw new Error("Stub provider offline");
        }
        return "";
      });
      await SpecialPowers.pushPrefEnv({ set: [["whimsy.ai.enabled", mode != "ai-disabled"]] });
      // Each case must miss the title cache, including results from the
      // pinning-path task, so it exercises its own provider/fallback path.
      const tab = await page(`${TITLE} (${mode})`);
      try {
        gBrowser.pinTab(tab);
        await TestUtils.waitForCondition(() => tab.zenStaticLabel == "Project planning notes for", `${mode}: general fallback works`);
        is(tab.label, "Project planning notes for", `${mode}: useful local name is visible`);
        is(requests, ["offline", "empty"].includes(mode) ? 1 : 0,
          `${mode}: exercises the expected provider path`);
      } finally {
        await closeTab(tab);
        await SpecialPowers.popPrefEnv();
      }
    }
  } finally {
    WhimsyAIProviders.isReady = ready;
    WhimsyAIProviders.setTestProvider(() => { calls++; return SHORT; });
  }
});

add_task(async function test_short_titles_and_late_manual_rename() {
  let finish;
  let requested;
  const started = new Promise(resolve => { requested = resolve; });
  WhimsyAIProviders.setTestProvider(() => {
    requested();
    return new Promise(resolve => { finish = resolve; });
  });
  const tab = await page("(2) Brief | Example");
  try {
    gBrowser.pinTab(tab);
    const tidying = WhimsyAITabs.onTabPinned(tab);
    await started;
    gZenTabRenamer.start({ target: tab, explicit: true });
    const input = await TestUtils.waitForCondition(() => document.getElementById("tab-label-input"), "Manual rename opens during request");
    input.value = "Chosen later";
    EventUtils.synthesizeKey("KEY_Enter", {}, window);
    await TestUtils.waitForCondition(() => tab.zenStaticLabel == "Chosen later", "Manual rename saved");
    finish("Brief");
    await TestUtils.waitForCondition(() => !document.getElementById("tab-label-input"), "Rename input closed");
    await tidying;
    is(tab.label, "Chosen later", "A delayed AI response cannot replace a manual rename");
    await assertPersisted(tab, "Chosen later", "later rename");
  } finally {
    finish?.("Brief");
    WhimsyAIProviders.setTestProvider(() => { calls++; return SHORT; });
    await closeTab(tab);
  }
});

add_task(async function test_title_switch_off() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.tidy-titles", false]] });
  const tab = await page();
  try {
    gBrowser.pinTab(tab);
    await WhimsyAITabs.onTabPinned(tab);
    is(tab.label, TITLE, "Feature off preserves the page title");
    ok(!tab.zenStaticLabel, "Feature off sets no static label");
  } finally {
    await closeTab(tab);
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_loading_pin_and_reduced_motion() {
  await SpecialPowers.pushPrefEnv({ set: [
    ["whimsy.ai.enabled", false], ["ui.prefersReducedMotion", 1],
  ] });
  const tab = await page("(6) Loading notes | Example");
  try {
    // Model the real pin-before-load order. The title/busy notification must
    // retry only this newly pinned tab, rather than rename all restored pins.
    tab.setAttribute("busy", "true");
    gBrowser.pinTab(tab);
    await WhimsyAITabs.onTabPinned(tab);
    ok(!tab.zenStaticLabel, "Wait for the loaded title");
    tab.removeAttribute("busy");
    tab.dispatchEvent(new CustomEvent("TabAttrModified", {
      bubbles: true, detail: { changed: ["busy"] },
    }));
    await TestUtils.waitForCondition(() => tab.label == "Loading notes", "Pinning during loading retries when loading finishes");
    is(getComputedStyle(tab.querySelector(".tab-label")).animationName, "none", "Reduced motion suppresses the tidy animation");
  } finally {
    await closeTab(tab);
    await SpecialPowers.popPrefEnv();
  }
});
