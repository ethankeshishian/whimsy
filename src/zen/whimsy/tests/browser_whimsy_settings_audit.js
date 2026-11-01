/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave10 (W10-12): every Whimsy setting is found by Settings search (by its
// label, its short name and its other words) and is a command with a
// shortcut you can assign. "Tidy Titles" found nothing (the label says
// "Tidy tab titles") and had no command.
//
// The audit reads the real Settings page: a Whimsy control there with no
// entry in WhimsySettingsCommands.SETTINGS fails it, so a new setting can't
// ship without a command and search words.

requestLongerTimeout(8);

const { WhimsySettingsCommands } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsySettingsCommands.sys.mjs"
);
const { WhimsyCommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommands.sys.mjs");
const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");

const { SETTINGS } = WhimsySettingsCommands;
const CONTROLS =
  "checkbox, moz-checkbox, moz-toggle, moz-select, moz-radio-group, menulist, radiogroup, input, textarea, [role='radiogroup']";

// Shown: no hidden or visually-hidden ancestor inside the settings page.
function shown(el) {
  for (let node = el; node && node.id != "mainPrefPane"; node = node.parentElement) {
    if (node.hidden || node.classList.contains("visually-hidden")) {
      return false;
    }
  }
  return !!el?.isConnected;
}

// Hidden by its own state (a provider's row, a form's error), below the
// group search reveals.
function hiddenByState(el) {
  for (let node = el; node && node.parentElement?.id != "mainPrefPane"; node = node.parentElement) {
    if (node.hidden) {
      return true;
    }
  }
  return false;
}

let lastQuery = null;
async function search(win, query) {
  const wanted = query.trim().toLowerCase();
  if (wanted == lastQuery) {
    return;
  }
  lastQuery = wanted;
  const done = BrowserTestUtils.waitForEvent(win, "PreferencesSearchCompleted", false, e => e.detail == wanted);
  const input = win.document.getElementById("searchInput");
  input.value = query;
  input.dispatchEvent(new win.InputEvent("input", { bubbles: true }));
  await done;
}

// Whimsy's own controls: the id starts with "whimsy", or (no id) the
// nearest ancestor with an id does. Zen's Glance group and Firefox's own
// groups that Whimsy moved keep their own ids.
function whimsyControls(doc) {
  return [...doc.querySelectorAll(`#mainPrefPane :is(${CONTROLS})`)].filter(el => {
    const owner = el.id ? el : el.parentElement?.closest("[id]");
    return !!owner?.id.startsWith("whimsy");
  });
}

function entryFor(doc, el) {
  return (
    SETTINGS.find(entry => {
      const setting = doc.getElementById(entry.setting);
      return (setting && (setting == el || setting.contains(el))) || (entry.covers && el.closest(entry.covers));
    }) ?? null
  );
}

// The words Settings shows for a control, when it has its own.
function labelOf(doc, el) {
  if (el.localName == "radiogroup" || el.getAttribute("role") == "radiogroup") {
    return "";
  }
  const escaped = doc.defaultView.CSS.escape(el.id);
  const label = doc.querySelector(`label[control="${escaped}"], label[for="${escaped}"]`);
  const text =
    el.getAttribute("label") ||
    label?.getAttribute("value") ||
    label?.textContent ||
    (el.localName == "hbox" ? el.querySelector("h1, h2, h3")?.textContent : "") ||
    "";
  return text.trim();
}

// Settings that can be missing from the page although they apply.
const MAY_BE_ABSENT = {
  // Inserted into Firefox's Updates group once that renders, which a build
  // without Firefox's updater doesn't have.
  "update-channel": true,
};

// The values Settings offers for a choice.
function domChoices(el) {
  return [...el.querySelectorAll("menuitem[value], radio[value], input[type='radio'][value], [data-icon]")].map(
    item => item.getAttribute("value") ?? item.dataset.icon
  );
}

async function openSettings(callback) {
  // Start on a pane with no Whimsy groups, so search setup inserts them.
  await BrowserTestUtils.withNewTab("about:preferences#home", async browser => {
    const win = browser.contentWindow;
    const doc = browser.contentDocument;
    await win.gSearchResultsPane.initializeCategories();
    await TestUtils.waitForCondition(
      () => doc.getElementById("whimsyAITidyTitles")?.hasAttribute("searchkeywords") ||
        doc.querySelector("[searchkeywords*='Tidy Tab Titles']"),
      "Search words are on the controls"
    );
    // About's channel joins Firefox's Updates group once that renders.
    for (let i = 0; i < 50 && !doc.getElementById("whimsyUpdatesChannel")?.isConnected; i++) {
      await new Promise(resolve => win.requestAnimationFrame(resolve));
    }
    lastQuery = null;
    await callback(win, doc);
    await search(win, "");
  });
}

add_task(async function test_every_control_has_an_entry() {
  await openSettings(async (win, doc) => {
    const controls = whimsyControls(doc);
    Assert.greater(controls.length, 60, `Found Whimsy's controls (${controls.length})`);
    for (const el of controls) {
      const entry = entryFor(doc, el);
      ok(entry, `#${el.id || el.parentElement?.closest("[id]")?.id} (${el.localName}) has an entry in WhimsySettingsCommands.SETTINGS`);
    }

    const names = new Set();
    for (const entry of SETTINGS) {
      ok(!names.has(entry.name), `${entry.name} is listed once`);
      names.add(entry.name);
      ok(WhimsySettingsCommands.nameOf(entry), `${entry.name} has a name (whimsy-setting-${entry.name})`);
      const el = doc.getElementById(entry.setting);
      if (!el) {
        // Only a setting that doesn't apply here is missing from Settings.
        ok(
          entry.exempt || MAY_BE_ABSENT[entry.name] || !WhimsySettingsCommands.available(entry),
          `#${entry.setting} is in Settings or doesn't apply`
        );
        continue;
      }
      // The entry describes the control Settings shows.
      const pref = el.getAttribute("preference") || el.dataset.featurePref;
      if (pref && entry.pref) {
        is(entry.pref, pref, `${entry.name}: same pref as #${entry.setting}`);
      }
      const feature = el.closest("[data-whimsy-feature]")?.dataset.whimsyFeature;
      if (feature) {
        ok(entry.feature?.includes(feature), `${entry.name}: goes with the "${feature}" switch, like its row`);
      }
      if (entry.choices) {
        const offered = domChoices(el);
        const listed = entry.choices.map(choice => String(choice.value));
        for (const value of listed) {
          ok(offered.includes(value), `${entry.name}: "${value}" is one of Settings' choices`);
        }
        if (!entry.partial) {
          for (const value of offered) {
            ok(listed.includes(value), `${entry.name}: Settings' choice "${value}" has a command`);
          }
        }
      }
      if (hiddenByState(el)) {
        ok(entry.exempt, `${entry.name}: a control hidden by default has no command to need`);
      }
    }
  });
});

add_task(async function test_every_setting_is_found_by_search() {
  await openSettings(async (win, doc) => {
    // The searches from the bug.
    for (const [query, id] of [
      ["Tidy Titles", "whimsyAITidyTitles"],
      ["tidy tab titles", "whimsyAITidyTitles"],
      ["Tidy Tabs", "whimsyAITidyTabs"],
      ["5-second previews", "whimsyAILinkPreviews"],
      ["link previews", "whimsyAILinkPreviews"],
      ["ask on page", "whimsyAIAskOnPage"],
      ["utm", "whimsyStripTracking"],
      ["tree style", "whimsyTreeTabs"],
    ]) {
      const el = doc.getElementById(id);
      ok(el, `#${id} exists`);
      await search(win, query);
      ok(shown(el), `Searching "${query}" shows #${id}`);
    }

    for (const entry of SETTINGS) {
      const el = doc.getElementById(entry.setting);
      if (!el || hiddenByState(el)) {
        continue;
      }
      const [name, keyword] = WhimsySettingsCommands.keywordsOf(entry);
      const queries = [labelOf(doc, el), name, keyword].filter(Boolean);
      for (const query of queries) {
        await search(win, query);
        ok(shown(el), `Searching "${query}" shows #${entry.setting}`);
      }
    }

    // Settings → Menus: each row is found by its own words, and the search
    // shows the menu it's in (W10-21).
    const row =
      doc.querySelector('[data-category="paneWhimsyMenus"] .whimsy-menus-detail[data-inactive] .whimsy-menus-row-label') ??
      doc.querySelector('[data-category="paneWhimsyMenus"] .whimsy-menus-row-label');
    if (row) {
      await TestUtils.waitForCondition(() => row.textContent.trim(), "Menu rows are named");
      const words = row.textContent.trim();
      await search(win, words);
      await TestUtils.waitForCondition(() => shown(row) && row.checkVisibility(), `Searching "${words}" shows its menu row`);
    }
  });
});

add_task(async function test_every_setting_is_a_command() {
  for (const entry of SETTINGS) {
    if (entry.exempt) {
      ok(entry.exempt.length > 10, `${entry.name}: no command, because it's ${entry.exempt}`);
      continue;
    }
    const ids = entry.command ?? WhimsySettingsCommands.specsFor(entry).map(spec => spec.id);
    Assert.greater(ids.length, 0, `${entry.name} has a command`);
    for (const id of ids) {
      const command = WhimsyCommands.get(id);
      ok(command, `${entry.name}: ${id} is registered`);
      const keyId = command?.keyId ?? command?.elsewhere;
      ok(keyId && document.getElementById(keyId), `${entry.name}: ${id} has a <key>, so a shortcut can be assigned`);
      ok(WhimsyCommands.title(command), `${entry.name}: ${id} has a name in about:keyboard`);
      const rows = globalActions.filter(a => a.whimsyCommand == id || a.command == id);
      Assert.greater(rows.length, 0, `${entry.name}: ${id} is in the command bar`);
      for (const row of rows) {
        ok(row.label && !row.label.includes("{"), `${entry.name}: "${row.label}" is a whole name`);
      }
    }
  }
});

function rowFor(id, l10nId) {
  return globalActions.find(a => a.whimsyCommand == id && a.l10nId == l10nId);
}

add_task(async function test_switch_commands() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["whimsy.feature.tidy-titles", true],
      ["whimsy.ai.enabled", true],
    ],
  });
  const id = "cmd_whimsySetting-tidy-titles";
  const off = rowFor(id, "whimsy-setting-off");
  const on = rowFor(id, "whimsy-setting-on");
  is(off?.label, "Turn Tidy Tab Titles Off", "The command bar names it");
  ok(off.isAvailable(window) && !on.isAvailable(window), "Only the change that applies is offered");
  ok(off.whimsyKeywords.includes("tidy titles"), "It answers to the same words as in Settings");

  document.getElementById(id).doCommand();
  ok(!Services.prefs.getBoolPref("whimsy.feature.tidy-titles"), "The command turns it off");
  ok(on.isAvailable(window) && !off.isAvailable(window), "Now Turn On is offered");
  document.getElementById(id).doCommand();
  ok(Services.prefs.getBoolPref("whimsy.feature.tidy-titles"), "and on again");

  // With AI turned off, AI settings have nothing to change.
  Services.prefs.setBoolPref("whimsy.ai.enabled", false);
  ok(!on.isAvailable(window) && !off.isAvailable(window), "No Tidy Tab Titles commands with AI off");
  document.getElementById(id).doCommand();
  ok(Services.prefs.getBoolPref("whimsy.feature.tidy-titles"), "and its shortcut does nothing");

  // W10-28: Enable AI's own command: Turn AI On / Turn AI Off.
  const aiOn = rowFor("cmd_whimsySetting-ai", "whimsy-setting-on");
  is(aiOn?.label, "Turn AI On", "Enable AI's command is named by what it does");
  ok(aiOn.isAvailable(window), "and offered while AI is off");
  document.getElementById("cmd_whimsySetting-ai").doCommand();
  ok(Services.prefs.getBoolPref("whimsy.ai.enabled"), "Turning AI on enables it");
  const aiOff = rowFor("cmd_whimsySetting-ai", "whimsy-setting-off");
  is(aiOff?.label, "Turn AI Off", "and Turn AI Off once it's on");
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_choice_and_range_commands() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["whimsy.tabs.title-lines", 1],
      ["whimsy.look.transparency", 0],
    ],
  });
  const two = rowFor("cmd_whimsySetting-title-lines-2", "whimsy-setting-choose");
  const one = rowFor("cmd_whimsySetting-title-lines-1", "whimsy-setting-choose");
  is(two?.label, "Tab Title Lines: 2 lines", "A choice is named by the setting and its choice");
  ok(!one.isAvailable(window), "The current choice isn't offered");
  document.getElementById("cmd_whimsySetting-title-lines-2").doCommand();
  is(Services.prefs.getIntPref("whimsy.tabs.title-lines"), 2, "The command picks it");
  ok(one.isAvailable(window) && !two.isAvailable(window), "and the others are offered");

  if (AppConstants.platform == "macosx" && Services.prefs.getBoolPref("whimsy.feature.transparency", true)) {
    const up = rowFor("cmd_whimsySetting-transparency-up", "whimsy-setting-increase");
    const down = rowFor("cmd_whimsySetting-transparency-down", "whimsy-setting-decrease");
    is(up?.label, "Increase Transparency", "A slider gets Increase");
    ok(!down.isAvailable(window), "and no Decrease at its lowest");
    const DBGc = document.querySelectorAll("#cmd_whimsySetting-transparency-up");
    info(`DEBUGT count=${DBGc.length} disabled=${DBGc[0]?.getAttribute("disabled")} upAvail=${up.isAvailable(window)} val=${Services.prefs.getIntPref("whimsy.look.transparency")} oncommand=${DBGc[0]?.getAttribute("oncommand")}`);
    const DBGobs = { observe: () => info(`DEBUGT changed to ${Services.prefs.getIntPref("whimsy.look.transparency")} ${new Error().stack.split("\n").slice(0, 8).join(" | ")}`) };
    Services.prefs.addObserver("whimsy.look.transparency", DBGobs);
    document.getElementById("cmd_whimsySetting-transparency-up").doCommand();
    is(Services.prefs.getIntPref("whimsy.look.transparency"), 10, "Increase moves one step");
    Services.prefs.setIntPref("whimsy.look.transparency", 15);
    document.getElementById("cmd_whimsySetting-transparency-down").doCommand();
    is(Services.prefs.getIntPref("whimsy.look.transparency"), 10, "Decrease lands on a step");
  }
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_a_shortcut_can_be_assigned() {
  const { CustomKeys } = ChromeUtils.importESModule("moz-src:///browser/components/customkeys/CustomKeys.sys.mjs");
  registerCleanupFunction(() => CustomKeys.resetAll());
  await SpecialPowers.pushPrefEnv({
    set: [
      ["whimsy.feature.tidy-titles", true],
      ["whimsy.ai.enabled", true],
    ],
  });
  const command = WhimsyCommands.get("cmd_whimsySetting-tidy-titles");
  is(WhimsyCommands.title(command), "Turn Tidy Tab Titles On or Off", "One name for its shortcut");
  const keyEl = document.getElementById(command.keyId);
  ok(keyEl, "It has a <key>");
  ok(!keyEl.hasAttribute("key") && !keyEl.hasAttribute("keycode"), "with no default shortcut");

  ok(WhimsyCommands.rebind("cmd_whimsySetting-tidy-titles", { modifiers: "accel,shift", key: "Y" }).ok,
    "A free shortcut can be assigned");
  is(keyEl.getAttribute("key"), "Y", "and is bound");
  EventUtils.synthesizeKey("y", { accelKey: true, shiftKey: true });
  await TestUtils.waitForCondition(
    () => !Services.prefs.getBoolPref("whimsy.feature.tidy-titles"),
    "The shortcut turns Tidy Tab Titles off"
  );
  WhimsyCommands.reset("cmd_whimsySetting-tidy-titles");
  ok(!keyEl.hasAttribute("key"), "Reset leaves it unbound");
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_switch_off() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.settings-commands", false]] });
  const row = rowFor("cmd_whimsySetting-trails", "whimsy-setting-off") ?? rowFor("cmd_whimsySetting-trails", "whimsy-setting-on");
  ok(row && !row.isAvailable(window), "With the switch off, setting commands leave the command bar");
  await SpecialPowers.popPrefEnv();
});
