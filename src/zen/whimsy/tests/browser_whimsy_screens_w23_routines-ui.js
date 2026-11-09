/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W23 routines-ui screenshots: Library › Routines (list, hover, paused,
// failed, delete confirm), empty with built-ins, the form in place, AI off,
// and the sprite mid-play. Compared by eye with 06-routines and fu-routines.

const { WhimsyRoutines } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyRoutines.sys.mjs");
const { WhimsyRoutinesUI } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyRoutinesUI.sys.mjs");
const { WhimsyAIProviders } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIProviders.sys.mjs");
const { WhimsyAIStore } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIStore.sys.mjs");
const { WhimsyAIUpdates } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIUpdates.sys.mjs");
const { WhimsyAI } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAI.sys.mjs");

const ROUTINES = [
  { builtIn: "daily-brief", title: "Daily brief", prompt: "Summarize today’s meetings.", trigger: { kind: "schedule", days: [1, 2, 3, 4, 5], hour: 8, minute: 0 } },
  { builtIn: "meeting-prep", title: "Meeting prep", prompt: "Pull my last notes.", trigger: { kind: "meeting", leadMinutes: 10 } },
  { builtIn: "standup", title: "Standup digest", prompt: "List what moved.", trigger: { kind: "schedule", days: [1, 2, 3, 4, 5], hour: 9, minute: 30 } },
];

add_setup(async () => {
  await WhimsyAIStore._resetForTesting(PathUtils.join(PathUtils.tempDir, `whimsy-routines-ui-shots-${Date.now()}`));
  WhimsyAIUpdates._resetForTesting();
  WhimsyAIProviders.setTestProvider(() => "3 meetings today, first is Design review at 10:00.\n\n- 10:00 Design review");
  await WhimsyRoutines._resetForTesting();
  registerCleanupFunction(async () => {
    await close();
    await WhimsyRoutines._resetForTesting();
    WhimsyAIProviders.setTestProvider(null);
    WhimsyAIUpdates._resetForTesting();
    await WhimsyAIStore._resetForTesting(null);
    Services.prefs.setBoolPref("whimsy.ai.enabled", true);
    await WhimsyAI.pending;
  });
});

function section() {
  return document.querySelector("whimsy-library-routines-section");
}

async function open() {
  WhimsyRoutinesUI.openLibrary(window);
  const s = await TestUtils.waitForCondition(() => section()?.loaded && section(), "Routines is up");
  await s.updateComplete;
  await document.l10n.translateFragment(s);
  await new Promise(r => setTimeout(r, 400));
  return s;
}

async function close() {
  const ZenLibrary = window.customElements.get("zen-library");
  if (ZenLibrary?.isLibraryOpen) {
    ZenLibrary.animateProgress(0);
    await TestUtils.waitForCondition(() => !ZenLibrary.isLibraryOpen, "The Library closes");
  }
}

add_task(async function shots_list_states() {
  const saved = [];
  for (const r of ROUTINES) {
    saved.push(await WhimsyRoutines.save(r, { confirmed: true }));
  }
  await WhimsyRoutines.runNow(saved[0].id);
  await WhimsyRoutines.idle();
  const s = await open();
  ok(s.querySelectorAll(".whimsy-routine-row").length >= 3, "The rows are there");
  await whimsyBothSchemes("w23-routines-ui-rout-1.1", async () => {
    await document.l10n.translateFragment(s);
  });
  const row = s.querySelector(`.whimsy-routine-row[data-id="${saved[1].id}"]`);
  await whimsyBothSchemes("w23-routines-ui-rout-1.3-focus", async () => {
    row.focus();
  });
  await WhimsyRoutines.pause(saved[2].id, true);
  await TestUtils.waitForCondition(() => s.querySelector("[paused]"), "Paused shows");
  await whimsyBothSchemes("w23-routines-ui-rout-1.5", async () => {
    await document.l10n.translateFragment(s);
  });
  row.focus();
  EventUtils.synthesizeKey("KEY_Backspace");
  await TestUtils.waitForCondition(() => s.querySelector(".whimsy-routine-confirm"), "The confirm strip shows");
  await whimsyBothSchemes("w23-routines-ui-rout-1.8", async () => {
    await document.l10n.translateFragment(s);
  });
  EventUtils.synthesizeKey("KEY_Escape");
  WhimsyRoutinesUI.openForm(window, { routineId: saved[0].id });
  await TestUtils.waitForCondition(() => s.querySelector(".zen-library-search-top[open] ~ * , .whimsy-routine-form"), "The form opens");
  await whimsyBothSchemes("w23-routines-ui-fu-1.1-form", async () => {
    await document.l10n.translateFragment(s);
  });
  await close();
  await WhimsyRoutines._resetForTesting();
});

add_task(async function shots_empty_and_off() {
  await WhimsyRoutines._resetForTesting();
  const s = await open();
  await TestUtils.waitForCondition(() => s.querySelectorAll(".whimsy-routine-builtin").length == 8, "The built-ins show");
  await whimsyBothSchemes("w23-routines-ui-rout-2.1", async () => {
    await document.l10n.translateFragment(s);
  });
  await close();
  await WhimsyRoutines.save(ROUTINES[0], { confirmed: true });
  Services.prefs.setBoolPref("whimsy.ai.enabled", false);
  await WhimsyAI.pending;
  const off = await open();
  await TestUtils.waitForCondition(() => off.querySelector(".whimsy-routines-opt-in"), "The opt-in card shows");
  await whimsyBothSchemes("w23-routines-ui-fu-2.4", async () => {
    await document.l10n.translateFragment(off);
  });
  Services.prefs.setBoolPref("whimsy.ai.enabled", true);
  await WhimsyAI.pending;
  await close();
  const tab = document.querySelector(`zen-library .zen-library-tab[data-section="whimsy-routines"]`);
  ok(tab, "The rail tab is there");
});
