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
const { ProvidersManager } = ChromeUtils.importESModule("moz-src:///browser/components/urlbar/UrlbarProvidersManager.sys.mjs");

const LAST_PREF = "whimsy.fire.last";

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.ai.enabled", true]] });
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
    return () => closeFire(panel);
  });
});

// fire-2.7: ticking Memory asks once more, in the same surface.
add_task(async function shots_fire_panel_second_ask() {
  Services.prefs.clearUserPref(LAST_PREF);
  await whimsyBothSchemes("w23-memory-fire-fire-2.7", async () => {
    const panel = await openFire();
    const input = panel.querySelector('[data-l10n-id="whimsy-fire-item-memory"]')?.closest("label")?.querySelector("input");
    input.click();
    panel.querySelector("#whimsy-fire-forget").click();
    await TestUtils.waitForCondition(() => panel.dataset.step == "confirm", "The confirm step shows");
    return () => closeFire(panel);
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
    return () => closeFire(panel);
  });
});

// fire-3.2: the done toast, its second line in Fluent.
add_task(async function shots_fire_done_toast() {
  await whimsyBothSchemes("w23-memory-fire-fire-3.2", async () => {
    await WhimsyFireButton.run(window, async () => ({ tabs: 2, items: ["aiChats", "memory"] }), "burn");
    const toast = currentToast();
    await toast?.shown;
    return () => closeToasts();
  });
});

// cmd-4.1: a "Related" row in the command bar, found by meaning.
add_task(async function shots_related_row() {
  WhimsyAIIndex._setTestEmbedder(text => [text.toLowerCase().includes("coffee") ? 1 : 0, 1, 0, 0]);
  await WhimsyAIIndex.clear({});
  await WhimsyAIIndex.add({ url: "https://example.com/coffee-shot", title: "Best espresso machines", text: "coffee espresso" });
  WhimsyAIIndex.initWindow(window);
  try {
    await whimsyBothSchemes("w23-memory-fire-cmd-4.1", async () => {
      const provider = ProvidersManager.getProvider("WhimsyRelated");
      const added = [];
      await provider.startQuery({ searchString: "coffee" }, (p, result) => added.push(result));
      ok(added.length, "A Related row was produced for the shot (rendered by the urlbar view itself)");
      return null;
    });
  } finally {
    WhimsyAIIndex._setTestEmbedder(null);
    await WhimsyAIIndex.clear({});
  }
});

// fu-chat 4.5 / chat-4.4: the memory-saved note with Undo, and the "Used N
// memories" line, rendered the way a chat panel would append them.
add_task(async function shots_memory_note_and_used_line() {
  const render = WhimsyChat.cardRenderer("note:memory-saved");
  await whimsyBothSchemes("w23-memory-fire-fu-chat-4.5", async () => {
    const node = render(document, { facts: ["Lives in Austin"], memoryIds: ["shot-1"] }, { thread: { id: "shot" } });
    document.documentElement.append(node);
    await document.l10n.translateFragment(node);
    return () => node.remove();
  });
});

// set-7.1 / set-7.3 / fu-settings dec-13: Settings > AI > Memory (the
// switch, the list, edit in place, Export).
add_task(async function shots_memory_settings() {
  await WhimsyAIMemory.save("Prefers dark mode");
  await WhimsyAIMemory.save("Works on the Whimsy browser");
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:preferences#whimsyAI");
  const win = tab.linkedBrowser.contentWindow;
  const doc = win.document;
  try {
    await TestUtils.waitForCondition(() => win.WhimsyAISettings?.root && doc.getElementById("whimsyMemoryList")?.childElementCount >= 2,
      "Settings memory section is built");
    doc.getElementById("whimsyMemoryList").scrollIntoView({ block: "start", behavior: "instant" });
    await whimsyBothSchemes("w23-memory-fire-set-7.1", async () => null);
  } finally {
    BrowserTestUtils.removeTab(tab);
    for (const m of await WhimsyAIMemory.list()) {
      await WhimsyAIMemory.remove(m.id, { block: false });
    }
  }
});
