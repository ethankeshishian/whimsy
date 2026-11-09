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

const PAGE = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") + "whimsy_ai_page.html";

const ROUTINES = [
  { builtIn: "daily-brief", title: "Daily brief", prompt: "Summarize today’s meetings.", trigger: { kind: "schedule", days: [1, 2, 3, 4, 5], hour: 8, minute: 0 } },
  { builtIn: "meeting-prep", title: "Meeting prep", prompt: "Pull my last notes.", trigger: { kind: "meeting", leadMinutes: 10 } },
  { builtIn: "standup", title: "Standup digest", prompt: "List what moved.", trigger: { kind: "schedule", days: [1, 2, 3, 4, 5], hour: 9, minute: 30 } },
];

add_setup(async () => {
  // No ⌘E hint toast over the shots.
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.ai-hints", false]] });
  ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIHints.sys.mjs").WhimsyAIHints._settleForTesting();
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
  // Routines is last in the rail; bring its tab into a short window's view.
  document.querySelector(`zen-library .zen-library-tab[data-section="whimsy-routines"]`)?.scrollIntoView({ block: "nearest" });
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
  await TestUtils.waitForCondition(() => s.querySelector(".zen-library-search-top[open]") && s.querySelector(".whimsy-routine-form"), "The form opens");
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
  // rout-2.3: Daily brief switched on opens its form in place, filled, with
  // the connect row inline (nothing is connected here).
  const brief = s.querySelector(".whimsy-routine-builtin[data-builtin='daily-brief'] .whimsy-routine-switch");
  brief.scrollIntoView({ block: "nearest" });
  await TestUtils.waitForCondition(() => brief.getBoundingClientRect().width > 0, "Daily brief's switch");
  EventUtils.synthesizeMouseAtCenter(brief, {});
  await TestUtils.waitForCondition(() => s.querySelector(".zen-library-search-top[open]") && s.querySelector(".whimsy-routine-form"), "Its form opens in place");
  await whimsyBothSchemes("w23-routines-ui-rout-2.3", async () => {
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

// drawSnapshot paints the window's own widget, and an open panel is a
// widget of its own, so it never shows in a shot. For the shot, each open
// panel is copied into the window where it sits, with its content box's
// look and its custom properties, and taken out again afterwards.
function standInPopups() {
  const made = [];
  for (const panel of document.querySelectorAll("panel")) {
    if (panel.state != "open") {
      continue;
    }
    const box = panel.shadowRoot?.querySelector("[part~='content']") ?? panel;
    const outer = panel.getOuterScreenRect();
    const inPanel = panel.getBoundingClientRect();
    const rect = box.getBoundingClientRect();
    const stand = document.createElementNS("http://www.w3.org/1999/xhtml", "div");
    stand.id = panel.id;
    stand.className = `${panel.className} whimsy-surface-tokens`;
    const look = getComputedStyle(panel);
    for (let i = 0; i < look.length; i++) {
      const name = look.item(i);
      if (name.startsWith("--")) {
        stand.style.setProperty(name, look.getPropertyValue(name));
      }
    }
    const boxLook = getComputedStyle(box);
    for (const name of ["background-color", "background-image", "border-top", "border-right", "border-bottom", "border-left", "border-radius", "box-shadow", "padding", "color", "font-family", "font-size", "font-weight", "line-height"]) {
      stand.style.setProperty(name, boxLook.getPropertyValue(name));
    }
    // The OS draws a real panel's shadow; the stand-in draws its own.
    if (boxLook.boxShadow == "none") {
      stand.style.boxShadow = "0 0 0 0.5px rgba(0, 0, 0, 0.18), 0 8px 24px rgba(0, 0, 0, 0.16)";
    }
    if (/rgba\(.*, 0\)|transparent/.test(boxLook.backgroundColor)) {
      stand.style.backgroundColor = "var(--zen-dialog-background, var(--arrowpanel-background, Canvas))";
    }
    Object.assign(stand.style, {
      position: "fixed",
      zIndex: "2147483647",
      boxSizing: "border-box",
      display: "flex",
      flexDirection: "column",
      overflow: "hidden",
      left: `${outer.left - window.mozInnerScreenX + rect.left - inPanel.left}px`,
      top: `${outer.top - window.mozInnerScreenY + rect.top - inPanel.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
    for (const child of panel.children) {
      const copy = child.cloneNode(true);
      const from = child.querySelectorAll("input, textarea");
      copy.querySelectorAll("input, textarea").forEach((field, i) => {
        field.value = from[i]?.value ?? field.value;
      });
      stand.append(copy);
    }
    document.documentElement.append(stand);
    made.push(stand);
  }
  return () => made.forEach(s => s.remove());
}

async function openPopup(id, open) {
  const shown = BrowserTestUtils.waitForEvent(document, "popupshown", true, e => e.target.id == id);
  await open();
  await shown;
  const panel = document.getElementById(id);
  await TestUtils.waitForCondition(() => panel.state == "open", `${id} is open`);
  await document.l10n.translateFragment(panel);
  await whimsySettled();
  return panel;
}

async function closePopups() {
  for (const panel of [...document.querySelectorAll("panel.whimsy-surface")].reverse()) {
    if (panel.state == "open") {
      const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
      panel.hidePopup();
      await hidden;
    }
  }
}

// Shoots both schemes of a state that lives in panels: `open()` shows them.
async function popupShots(name, open, check) {
  await whimsyBothSchemes(name, async () => {
    await open();
    await whimsySettled();
    if (check) {
      ok(check(), `${name}: ${check.what ?? "shown"}`);
    }
    const undo = standInPopups();
    return async () => {
      undo();
      await closePopups();
    };
  });
}

// ---- Row states from stubbed routines: running, failed, skipped ----

const MIN = 60 * 1000;
const real = {
  list: WhimsyRoutines.list,
  messages: WhimsyAIStore.messages,
  watches: null,
};

async function stubbed(patches, { cards = {}, watches = [] } = {}) {
  const { WhimsyPageWatch } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPageWatch.sys.mjs");
  real.watches ??= WhimsyPageWatch.list;
  WhimsyPageWatch.list = async () => watches;
  WhimsyRoutines.list = async () => (await real.list.call(WhimsyRoutines)).map(r => ({ ...r, ...(patches[r.title] ?? {}) }));
  WhimsyAIStore.messages = async id => cards[id] ?? real.messages.call(WhimsyAIStore, id);
  Services.obs.notifyObservers(null, WhimsyRoutines.TOPIC);
  return () => {
    WhimsyRoutines.list = real.list;
    WhimsyAIStore.messages = real.messages;
    WhimsyPageWatch.list = real.watches;
  };
}

const WATCHES = [
  { id: "w-mac", url: "https://example.com/macbook-air", title: "MacBook Air 13-inch", condition: "Price drops below $900", interval: 60, lastChecked: Date.now() - 12 * MIN, detail: "Still $999. Checked 12 minutes ago.", userContextId: 0, created: Date.now() - 86400000 },
];

add_task(async function shots_row_states() {
  await WhimsyRoutines._resetForTesting();
  for (const r of ROUTINES) {
    await WhimsyRoutines.save(r, { confirmed: true });
  }
  const s = await open();

  // rout-1.4: Daily brief running, the time a spinner, the result its step.
  let restore = await stubbed({ "Daily brief": { status: "running", lastRun: Date.now() - 2 * MIN } }, { watches: WATCHES });
  try {
    await TestUtils.waitForCondition(() => s.querySelector(".whimsy-routine-spinner"), "Running shows a spinner");
    await whimsyBothSchemes("w23-routines-ui-rout-1.4", async () => {
      await document.l10n.translateFragment(s);
    });
  } finally {
    restore();
  }

  // rout-1.6: three failures, each with its next step.
  restore = await stubbed({
    "Daily brief": { status: "failed", threadId: "t-brief" },
    "Standup digest": { status: "waiting", threadId: "t-standup" },
  }, {
    cards: {
      "t-brief": [{ role: "card", kind: "routine-fail", reason: ["whimsy-routine-reason-expired", { connector: "Google" }], step: { action: "reconnect", connector: "google", connectorName: "Google" } }],
      "t-standup": [{ role: "card", kind: "routine-fail", tone: "muted", reason: ["whimsy-routine-reason-quota", { providers: "Claude, ChatGPT, and Gemini", time: "2:00 PM" }] }],
    },
    watches: [{ ...WATCHES[0], error: "unreadable", failures: 2 }],
  });
  try {
    await TestUtils.waitForCondition(() => s.querySelectorAll(".whimsy-routine-pill").length >= 3, "Three failures show");
    await whimsyBothSchemes("w23-routines-ui-rout-1.6", async () => {
      await document.l10n.translateFragment(s);
    });
  } finally {
    restore();
  }

  // rout-1.7: Meeting prep skipped, too late, with Prep it anyway.
  restore = await stubbed({ "Meeting prep": { status: "skipped", threadId: "t-prep" } }, {
    cards: { "t-prep": [{ role: "card", kind: "routine-skip", meeting: { title: "Design review", start: Date.now() - 25 * MIN } }] },
    watches: WATCHES,
  });
  try {
    await TestUtils.waitForCondition(() => s.querySelector(".whimsy-routine-pill[data-tone='muted']"), "Skipped shows");
    await whimsyBothSchemes("w23-routines-ui-rout-1.7", async () => {
      await document.l10n.translateFragment(s);
    });
  } finally {
    restore();
  }
  Services.obs.notifyObservers(null, WhimsyRoutines.TOPIC);

  // The form in place: the list fades as the form comes in, held at 120ms.
  WhimsyRoutinesUI.openForm(window, {});
  await whimsyShotMid("w23-routines-ui-form-crossfade", () => {
    const running = s.getAnimations({ subtree: true }).filter(a => a.playState == "running" && a.effect?.getComputedTiming().iterations != Infinity);
    return running.sort((a, b) => b.effect.getComputedTiming().endTime - a.effect.getComputedTiming().endTime)[0];
  }, 120);
  await TestUtils.waitForCondition(() => s.querySelector(".whimsy-routine-form"), "The form is in place");
  await close();

  // The rail sprite, frame 18 of 36 (Zen plays 36 steps in 583ms).
  await open();
  const lib = document.querySelector("zen-library");
  lib.activeTab = "history";
  await TestUtils.waitForCondition(() => lib.activeTab == "history", "Away from Routines");
  const tab = document.querySelector(`zen-library .zen-library-tab[data-section="whimsy-routines"]`);
  tab.scrollIntoView({ block: "nearest" });
  await TestUtils.waitForCondition(() => tab.getBoundingClientRect().width > 0, "The rail tab is laid out");
  const image = tab.querySelector(".zen-library-tab-icon-image");
  EventUtils.synthesizeMouseAtCenter(tab, {});
  await whimsyShotMid("w23-routines-ui-sprite-frame-18", () => image.getAnimations().find(a => a.animationName == "zen-library-sprite-play"), Math.round((18 / 35) * 583));
  ok(true, "The sprite played");
  await close();
  await WhimsyRoutines._resetForTesting();
});

// ---- The sheet and its token menus (rout-2.3, 3.x, 4.1) ----

const sheet = () => document.getElementById("whimsy-routine-sheet");

async function openSheetWith(prefill, { outlined = false } = {}) {
  return openPopup("whimsy-routine-sheet", () => WhimsyRoutinesUI.openSheet(window, { prefill, outlined }));
}

async function tokenMenu(field) {
  const token = sheet().querySelector(`[data-field='${field}']`);
  await TestUtils.waitForCondition(() => token.getBoundingClientRect().width > 0, `${field} is laid out`);
  return openPopup(`whimsy-routine-sheet-${field}-list`, () => EventUtils.synthesizeMouseAtCenter(token, {}));
}

add_task(async function shots_sheet_and_menus() {
  await WhimsyRoutines._resetForTesting();
  const { WhimsyConnectors } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyConnectors.sys.mjs");
  const realList = WhimsyConnectors.list;
  const realConnect = WhimsyConnectors.connect;
  let connected = new Set();
  WhimsyConnectors.list = async () => ["google", "microsoft", "apple-calendar"].map(id => ({ id, connected: connected.has(id), status: connected.has(id) ? "ok" : "off" }));
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  try {
    const schedule = { kind: "schedule", days: [1, 2, 3, 4, 5], hour: 8, minute: 0 };
    await popupShots("w23-routines-ui-rout-3.1", () => openSheetWith({ trigger: { kind: "schedule" }, prompt: "" }), Object.assign(() => !!sheet()?.querySelector("[data-field='trigger']"), { what: "the sentence's tokens" }));
    await popupShots("w23-routines-ui-rout-3.2", async () => {
      await openSheetWith({ trigger: { kind: "schedule" }, prompt: "" });
      await tokenMenu("trigger");
    }, () => document.getElementById("whimsy-routine-sheet-trigger-list")?.state == "open");
    await popupShots("w23-routines-ui-rout-3.3", async () => {
      await openSheetWith({ trigger: schedule, prompt: "Summarize today’s meetings." });
      await tokenMenu("schedule");
    }, () => document.getElementById("whimsy-routine-sheet-schedule-list")?.state == "open");
    // rout-3.3, then "Pick days and time…": the menu turns into day chips.
    await popupShots("w23-routines-ui-rout-3.3-pick", async () => {
      await openSheetWith({ trigger: schedule, prompt: "Summarize today’s meetings." });
      const menu = await tokenMenu("schedule");
      const pick = menu.querySelector("[data-value='pick']");
      await TestUtils.waitForCondition(() => pick.getBoundingClientRect().width > 0, "Pick days and time… is laid out");
      EventUtils.synthesizeMouseAtCenter(pick, {});
      await TestUtils.waitForCondition(() => menu.querySelector(".whimsy-routine-schedule-editor"), "The editor is in");
      await document.l10n.translateFragment(menu);
    }, () => !!document.querySelector("#whimsy-routine-sheet-schedule-list .whimsy-routine-schedule-editor"));
    await popupShots("w23-routines-ui-rout-3.4", () => openSheetWith({ trigger: { kind: "page", interval: 60 }, prompt: "Tell me when the price drops below $900." }));
    await popupShots("w23-routines-ui-rout-3.5", () => openSheetWith({ trigger: { kind: "return" }, prompt: "Catch me up on what I missed." }));
    connected = new Set(["google"]);
    await popupShots("w23-routines-ui-rout-3.6", () => openSheetWith({ trigger: { kind: "meeting", leadMinutes: 10 }, prompt: "Pull my last notes with the attendees." }));
    connected = new Set();
    await popupShots("w23-routines-ui-rout-3.7", () => openSheetWith({ trigger: { kind: "email", match: "anyone" }, prompt: "If it’s a receipt, tell me the total." }),
      () => !sheet().querySelector(".whimsy-routine-form-connect").hidden);
    // rout-3.8: Connect pressed, the sign-in still out.
    WhimsyConnectors.connect = () => new Promise(() => {});
    await popupShots("w23-routines-ui-rout-3.8", async () => {
      await openSheetWith({ trigger: { kind: "email", match: "anyone" }, prompt: "If it’s a receipt, tell me the total." });
      const gmail = await TestUtils.waitForCondition(() => sheet().querySelector(".whimsy-routine-form-connect [data-connector='google']"), "Connect Gmail");
      await TestUtils.waitForCondition(() => gmail.getBoundingClientRect().width > 0, "laid out");
      EventUtils.synthesizeMouseAtCenter(gmail, {});
      await TestUtils.waitForCondition(() => sheet().querySelector(".whimsy-routine-form-spinner"), "Connecting");
    }, () => !!sheet().querySelector(".whimsy-routine-form-spinner"));
    WhimsyConnectors.connect = realConnect;
    await popupShots("w23-routines-ui-rout-3.9", () => openSheetWith({ trigger: { kind: "meeting", leadMinutes: 10 }, prompt: "Pull my last notes with the attendees." }));
    await popupShots("w23-routines-ui-rout-3.10", () => openSheetWith({ trigger: { kind: "open-site", host: "linear.app" }, prompt: "Show me what’s assigned to me that changed since yesterday." }),
      () => !!sheet().querySelector("[data-field='site']"));
    await popupShots("w23-routines-ui-rout-3.11", () => openSheetWith({ trigger: { kind: "download" }, prompt: "Summarize it in three lines." }));
    await popupShots("w23-routines-ui-rout-3.12", async () => {
      await openSheetWith({ trigger: schedule, prompt: "Summarize today’s meetings." });
      await tokenMenu("show");
    }, () => document.getElementById("whimsy-routine-sheet-show-list")?.state == "open");
    await popupShots("w23-routines-ui-rout-3.13", async () => {
      await openSheetWith({ trigger: schedule, prompt: "Summarize today’s meetings." });
      await tokenMenu("using");
    }, () => document.getElementById("whimsy-routine-sheet-using-list")?.state == "open");
    await popupShots("w23-routines-ui-rout-3.14", async () => {
      await openSheetWith({ trigger: { kind: "schedule" }, prompt: "" });
      sheet().querySelector("[data-field='trigger']").focus();
    }, () => !!sheet().querySelector(".whimsy-routine-form-ideas, .whimsy-routine-form-idea"));
    // rout-3.15: a narrow window; the sheet keeps 480px and the sentence wraps.
    const { outerWidth, outerHeight } = window;
    window.resizeTo(900, 820);
    await TestUtils.waitForCondition(() => window.innerWidth <= 900, "A narrow window");
    try {
      await popupShots("w23-routines-ui-rout-3.15", () => openSheetWith({ trigger: { kind: "open-site", host: "linear.app" }, prompt: "Show me what’s assigned to me that changed since yesterday." }),
        Object.assign(() => {
          const when = sheet().querySelector(".whimsy-routine-form-when");
          const tokens = [...when.querySelectorAll(".whimsy-routine-token")];
          return Math.round(sheet().getBoundingClientRect().width) <= 480 && tokens.every(t => t.getBoundingClientRect().right <= when.getBoundingClientRect().right + 0.5);
        }, { what: "the sheet keeps 480px and its tokens stay inside" }));
    } finally {
      window.resizeTo(outerWidth, outerHeight);
      await TestUtils.waitForCondition(() => window.outerWidth == outerWidth, "Wide again");
    }
    // rout-4.1: made in chat, beside the chat, outlined.
    const { WhimsyChat } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyChat.sys.mjs");
    await WhimsyChat.open(window);
    try {
      await popupShots("w23-routines-ui-rout-4.1", () => openSheetWith({ title: "Weekly recap", prompt: "Recap my week: what shipped, what slipped, and what’s next.", trigger: { kind: "schedule", days: [5], hour: 16, minute: 0 } }, { outlined: true }),
        () => sheet().querySelectorAll(".is-filled").length >= 4);
    } finally {
      const { WhimsyChatPanel } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyChatPanel.sys.mjs");
      WhimsyChatPanel.forWindow(window).close({ reason: "key" });
    }
  } finally {
    WhimsyConnectors.list = realList;
    WhimsyConnectors.connect = realConnect;
    await closePopups();
    BrowserTestUtils.removeTab(tab);
  }
});

// ---- Watch This Page (rout-5.x) ----

add_task(async function shots_watch_panel() {
  const { WhimsyPageWatch, MAX_WATCHES } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPageWatch.sys.mjs");
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const watchPanel = () => document.getElementById("whimsy-watch-panel");
  const openWatch = opts => openPopup("whimsy-watch-panel", () => WhimsyPageWatch.openDialog(window, tab, opts));
  try {
    await popupShots("w23-routines-ui-rout-5.2", () => openWatch(), () => watchPanel()?.state == "open");
    await popupShots("w23-routines-ui-rout-5.3", async () => {
      await openWatch();
      const dropdown = watchPanel().querySelector(".whimsy-watch-interval");
      await TestUtils.waitForCondition(() => dropdown.getBoundingClientRect().width > 0, "laid out");
      await openPopup("whimsy-watch-interval-list", () => EventUtils.synthesizeMouseAtCenter(dropdown, {}));
    }, () => document.getElementById("whimsy-watch-interval-list")?.state == "open");
    await popupShots("w23-routines-ui-rout-5.9", () => openWatch({ condition: "tickets go on sale", interval: 15, outlined: true }),
      () => watchPanel().querySelector(".whimsy-watch-condition.is-filled"));
    const realList = WhimsyPageWatch.list;
    WhimsyPageWatch.list = async () => Array.from({ length: MAX_WATCHES }, (_, i) => ({ id: `w${i}`, url: `https://example.org/${i}`, userContextId: 0 }));
    try {
      await popupShots("w23-routines-ui-rout-5.8", () => openWatch(), () => !watchPanel().querySelector(".whimsy-watch-error").hidden);
    } finally {
      WhimsyPageWatch.list = realList;
    }
    // rout-5.4: Watch closes the panel and the toast offers Undo.
    await whimsyBothSchemes("w23-routines-ui-rout-5.4", async () => {
      const panel = await openWatch();
      panel.querySelector(".whimsy-watch-condition").focus();
      EventUtils.sendString("the price drops below $900");
      EventUtils.synthesizeKey("KEY_Enter");
      await TestUtils.waitForCondition(() => panel.state != "open", "Watch closes the panel");
      const undo = await TestUtils.waitForCondition(() => document.querySelector(".zen-toast #whimsy-undo-toast-button"), "The toast offers Undo");
      ok(undo, "Watching shows the Undo toast");
      return async () => {
        closeToasts();
        await TestUtils.waitForCondition(() => !WhimsyPageWatch._checking, "The first check is done");
        for (const w of await WhimsyPageWatch.list()) {
          await WhimsyPageWatch.remove(w.id);
        }
      };
    });
  } finally {
    await closePopups();
    BrowserTestUtils.removeTab(tab);
  }
});
