/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W23 memory-fire: shots of what this lane draws, for side-by-side checks
// against the mockups (08-fire fire-0.x/2.x/3.x/4.x, 07-settings set-7.x,
// fu-settings dec-13, 02-command-bar cmd-4.x, fu-chat 4.5, 03-chat
// chat-4.4). WHIMSY_SHOTS=<dir> writes w23-memory-fire-*.png.

const { WhimsyFireButton } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyFireButton.sys.mjs");
const { WhimsyAIMemory } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIMemory.sys.mjs");
const { WhimsyAIIndex } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIIndex.sys.mjs");
const { WhimsyChat } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyChat.sys.mjs");

const LAST_PREF = "whimsy.fire.last";

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.ai.enabled", true], [WhimsyAIMemory.USE_PREF, true], ["whimsy.feature.ai-related", true],
    // No first-use hint toasts over the shots.
    ["whimsy.feature.ai-hints", false]] });
  registerCleanupFunction(() => {
    Services.prefs.clearUserPref(LAST_PREF);
  });
});

async function openFire(options) {
  const shown = BrowserTestUtils.waitForEvent(document, "popupshown", true, e => e.target.id == "whimsyFirePanel");
  WhimsyFireButton.openPanel(window, options);
  await shown;
  const panel = document.getElementById("whimsyFirePanel");
  await document.l10n.translateFragment(panel);
  return panel;
}
async function closeFire(panel) {
  if (panel?.state == "open") {
    const hidden = BrowserTestUtils.waitForEvent(panel, "popuphidden");
    panel.hidePopup();
    await hidden;
  }
}

// fire-2.1: first-time defaults (range, scope, items, kept, can't-undo).
add_task(async function shots_fire_panel_defaults() {
  Services.prefs.clearUserPref(LAST_PREF);
  await whimsyBothSchemes("w23-memory-fire-fire-2.1", async () => {
    const panel = await openFire();
    ok(panel.state == "open" && panel.querySelector("#whimsy-fire-forget"), "fire-2.1: the Fire surface is open on its defaults");
    // MUST 6: a panel is its own widget; copy it into the window for the shot.
    await whimsySettled();
    const undo = whimsyStandInPopups();
    return () => {
      undo();
      return closeFire(panel);
    };
  });
});

// fire-2.7: everything, all time, every space; Fire… because it asks once
// more. fire-3.1: the press asks, in the same surface.
add_task(async function shots_fire_panel_second_ask() {
  Services.prefs.clearUserPref(LAST_PREF);
  const everything = panel => {
    panel.querySelector('#whimsy-fire-range [data-value="all"]').click();
    for (const input of panel.querySelectorAll(".whimsy-fire-scope-group > label input, .whimsy-fire-items input")) {
      if (!input.checked) {
        input.click();
      }
    }
  };
  await whimsyBothSchemes("w23-memory-fire-fire-2.7", async () => {
    const panel = await openFire();
    everything(panel);
    is(document.l10n.getAttributes(panel.querySelector("#whimsy-fire-forget")).id, "whimsy-fire-run-ask", "fire-2.7: Fire… says it asks once more");
    await whimsySettled();
    const undo = whimsyStandInPopups();
    return () => {
      undo();
      return closeFire(panel);
    };
  });
  await whimsyBothSchemes("w23-memory-fire-fire-3.1", async () => {
    const panel = await openFire();
    everything(panel);
    panel.querySelector("#whimsy-fire-forget").click();
    await TestUtils.waitForCondition(() => panel.dataset.step == "confirm", "The confirm step shows");
    ok(panel.dataset.step == "confirm", "fire-3.1: it asks once more, in the same surface");
    await whimsySettled();
    const undo = whimsyStandInPopups();
    return () => {
      undo();
      return closeFire(panel);
    };
  });
});

// fire-4.1: a private window's single question.
add_task(async function shots_fire_panel_private_window() {
  const win = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  try {
    await whimsyBothSchemes("w23-memory-fire-fire-4.1", async () => {
      const shown = BrowserTestUtils.waitForEvent(win.document, "popupshown", true, e => e.target.id == "whimsyFirePanel");
      WhimsyFireButton.openPanel(win);
      await shown;
      const panel = win.document.getElementById("whimsyFirePanel");
      await win.document.l10n.translateFragment(panel);
      ok(panel.state == "open", "fire-4.1: the private window's Fire surface is open");
      return async () => {
        if (panel.state == "open") {
          const hidden = BrowserTestUtils.waitForEvent(panel, "popuphidden");
          panel.hidePopup();
          await hidden;
        }
      };
    });
  } finally {
    await BrowserTestUtils.closeWindow(win);
  }
});

// fire dec-16: "Forget everything..." opens Fire with only the AI items.
add_task(async function shots_fire_panel_ai_only() {
  Services.prefs.clearUserPref(LAST_PREF);
  await whimsyBothSchemes("w23-memory-fire-fire-dec-16-ai-only", async () => {
    const panel = await openFire({ aiOnly: true });
    ok(panel.state == "open", "dec-16: Fire opens from Forget everything with the AI items");
    return () => closeFire(panel);
  });
});

// fire-3.2: the done toast, its second line in Fluent.
add_task(async function shots_fire_done_toast() {
  await whimsyBothSchemes("w23-memory-fire-fire-3.2", async () => {
    await WhimsyFireButton.run(window, async () => ({ tabs: 7, visits: 142, items: ["aiChats", "memory"] }), "burn",
      WhimsyFireButton.summaryArgs(window, { range: "hour", allSpaces: false }));
    const toast = currentToast();
    ok(toast, "fire-3.2: the done toast shows");
    await toast?.shown;
    return () => closeToasts();
  });
});

// cmd-4.1: a "Related" row in the command bar, found by meaning.
add_task(async function shots_related_row() {
  const { UrlbarTestUtils } = ChromeUtils.importESModule("resource://testing-common/UrlbarTestUtils.sys.mjs");
  UrlbarTestUtils.init(this);
  WhimsyAIIndex._setTestEmbedder(text => /coffee|caffeine/i.test(text) ? [1, 1, 0, 0] : [0, 0, 1, 0]);
  await WhimsyAIIndex.clear({});
  await WhimsyAIIndex.add({ url: "https://www.nytimes.com/2026/wellness/afternoon-coffee-sleep.html",
    title: "Why your afternoon coffee wrecks your night", text: "coffee sleep" });
  await WhimsyAIIndex.add({ url: "https://examine.com/caffeine-half-life/",
    title: "Caffeine half-life: how long it really lasts", text: "caffeine" });
  WhimsyAIIndex.initWindow(window);
  try {
    await whimsyBothSchemes("w23-memory-fire-cmd-4.1", async () => {
      await UrlbarTestUtils.promiseAutocompleteResultPopup({ window, value: "caffeine and sleep" });
      const tagged = await TestUtils.waitForCondition(() => [...gURLBar.view.panel.querySelectorAll(".urlbarView-row")]
        .filter(r => r.querySelector(".urlbarView-tag")?.textContent == "Related"), "Related rows in the bar");
      Assert.equal(tagged.length, 2, "cmd-4.1: both pages show, each tagged Related, in the real command bar");
      const all = [...gURLBar.view.panel.querySelectorAll(".urlbarView-row")].filter(r => !r.hidden);
      ok(!tagged.includes(all[0]) && all.slice(-2).every(r => tagged.includes(r)),
        "cmd-4.2: the first (heuristic) row stays first; Related rows come last");
      is(gURLBar.view.selectedRowIndex, 0, "...and the first row stays selected");
      return () => UrlbarTestUtils.promisePopupClose(window);
    });
  } finally {
    WhimsyAIIndex._setTestEmbedder(null);
    await WhimsyAIIndex.clear({});
  }
});

// fu-chat 4.5 / chat-4.4: the memory-saved note with Undo after a real
// answer in the chat panel, then the "Used 1 memory" action on the next.
add_task(async function shots_memory_note_and_used_line() {
  const { WhimsyChatPanel } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyChatPanel.sys.mjs");
  const { WhimsyAIProviders } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIProviders.sys.mjs");
  const { WhimsyAIStore } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIStore.sys.mjs");
  await WhimsyAIStore._resetForTesting(PathUtils.join(PathUtils.tempDir, "whimsy-memory-shots-" + Math.random().toString(16).slice(2)));
  WhimsyAIProviders.setTestProvider(async request => request.task == "memory"
    ? (request.lastUserText.includes("I live in Austin") ? JSON.stringify(["Lives in Austin"]) : "[]")
    : "Try the breakfast tacos on East Cesar Chavez.");
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  const chat = WhimsyChatPanel.forWindow(window);
  const ask = async text => {
    chat.composer.focus();
    EventUtils.sendString(text);
    EventUtils.synthesizeKey("KEY_Enter");
    await TestUtils.waitForCondition(() => chat.body.querySelector(".whimsy-chat-msg[data-role='ai']:not([busy])") &&
      !chat.body.querySelector(".whimsy-chat-msg[busy]"), "Answered");
    await chat.memoryNote;
  };
  try {
    EventUtils.synthesizeKey("e", { accelKey: true });
    await TestUtils.waitForCondition(() => chat.isOpen && chat.ready, "Chat is open");
    await ask("I live in Austin, any taco tips?");
    await TestUtils.waitForCondition(() => chat.body.querySelector("[data-kind='memory-saved']"), "The memory note shows");
    await ask("Where should I eat in Austin tonight?");
    const used = await TestUtils.waitForCondition(() => chat.body.querySelector("[data-action='used-memories']"), "The used-memories action shows");
    ok(used, "fu-chat 4.5 / chat-4.4: the note line and the Used 1 memory action are both in the chat");
    await whimsyBothSchemes("w23-memory-fire-fu-chat-4.5", async () => {
      await document.l10n.translateFragment(chat.body);
      return null;
    });
  } finally {
    if (chat.isOpen) {
      chat.close({ reason: "key" });
    }
    BrowserTestUtils.removeTab(tab);
    WhimsyAIProviders.setTestProvider(null);
    for (const m of await WhimsyAIMemory.list()) {
      await WhimsyAIMemory.remove(m.id, { block: false });
    }
    await WhimsyAIStore._resetForTesting(null);
  }
});

// set-7.1 / set-7.3 / fu-settings dec-13: Settings > AI > Memory (the
// switch, the list, edit in place, Export).
add_task(async function shots_memory_settings() {
  const { WhimsyAIStore } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIStore.sys.mjs");
  await WhimsyAIStore._resetForTesting(PathUtils.join(PathUtils.tempDir, "whimsy-memory-set-shots-" + Math.random().toString(16).slice(2)));
  const lisbon = await WhimsyAIStore.createThread({ title: "Lisbon in March" });
  await WhimsyAIMemory.save("Prefers aisle seats on flights", { source: lisbon.id });
  await WhimsyAIMemory.save("Works on the Whimsy browser");
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:preferences#whimsyAI");
  const win = tab.linkedBrowser.contentWindow;
  const doc = win.document;
  try {
    await TestUtils.waitForCondition(() => win.WhimsyAISettings?.root && doc.getElementById("whimsyMemoryList")?.childElementCount >= 2,
      "Settings memory section is built");
    ok(doc.getElementById("whimsyMemoryList").childElementCount >= 2, "set-7.1: both memories are listed");
    const reduce = win.WhimsyAISettings.reducedMotion;
    win.WhimsyAISettings.reducedMotion = () => true;
    try {
      win.WhimsyAISettings.jumpTo("memory");
    } finally {
      win.WhimsyAISettings.reducedMotion = reduce;
    }
    ok(!doc.getElementById("whimsyMemorySearch").closest("[hidden]"), "set-7.1: a search pill above the list");
    await TestUtils.waitForCondition(() => doc.getElementById("whimsyMemoryCount").textContent.includes("2"), "set-7.1: and the count");
    const search = doc.getElementById("whimsyMemorySearch");
    search.value = "aisle";
    search.dispatchEvent(new win.Event("input"));
    await TestUtils.waitForCondition(() => doc.getElementById("whimsyMemoryList").childElementCount == 1, "Searching narrows the list");
    search.value = "";
    search.dispatchEvent(new win.Event("input"));
    await TestUtils.waitForCondition(() => doc.getElementById("whimsyMemoryList").childElementCount == 2, "Clearing it brings both back");
    await whimsyBothSchemes("w23-memory-fire-set-7.1", async () => null);
  } finally {
    BrowserTestUtils.removeTab(tab);
    for (const m of await WhimsyAIMemory.list()) {
      await WhimsyAIMemory.remove(m.id, { block: false });
    }
    await WhimsyAIStore._resetForTesting(null);
  }
});
