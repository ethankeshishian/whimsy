/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Settings search finds every Whimsy group, even in panes never opened:
// Whimsy's groups wait in templates until their pane is shown, and
// whimsy-settings.js inserts them all once Firefox sets up search.

// Shown: no hidden or visually-hidden ancestor inside the settings page.
function shown(el) {
  for (let node = el; node && node.id != "mainPrefPane"; node = node.parentElement) {
    if (node.hidden || node.classList.contains("visually-hidden")) {
      return false;
    }
  }
  return !!el?.isConnected;
}

// Waits for the search to finish laying out the pane: a row still shown from
// the last query is visible before then, and a click on it can miss.
async function search(doc, query) {
  const win = doc.defaultView;
  const input = doc.getElementById("searchInput");
  const wanted = query.trim().toLowerCase();
  if (input.value.trim().toLowerCase() == wanted) {
    return;
  }
  const done = BrowserTestUtils.waitForEvent(win, "PreferencesSearchCompleted", false, e => e.detail == wanted);
  input.value = query;
  input.dispatchEvent(new win.InputEvent("input", { bubbles: true }));
  await done;
}

function groupLabel(group) {
  const namedBy = group.getAttribute("aria-labelledby")?.split(/\s+/)
    .map(id => group.ownerDocument.getElementById(id)?.textContent.trim() || group.ownerDocument.getElementById(id)?.getAttribute("label")?.trim() || "")
    .join(" ").trim();
  if (namedBy) {
    return namedBy;
  }
  const heading = group.querySelector("h1, h2, h3, .whimsy-menus-detail-title");
  if (heading?.textContent.trim()) {
    return heading.textContent.trim();
  }
  const fieldset = group.localName == "moz-fieldset" ? group : group.querySelector("moz-fieldset");
  // W10-28: a group that is one switch (Enable AI) goes by its name, as
  // Settings search's breadcrumb does.
  const controls = group.querySelectorAll("moz-toggle, moz-checkbox, checkbox");
  return fieldset?.getAttribute("label")?.trim() || (controls.length == 1 ? controls[0].getAttribute("label")?.trim() : "") || "";
}

add_task(async function test_every_whimsy_group_is_searchable() {
  // Start on a pane with no Whimsy groups of its own, so nothing has been
  // inserted by showing a pane.
  await BrowserTestUtils.withNewTab("about:preferences#home", async browser => {
    const doc = browser.contentDocument;
    const win = browser.contentWindow;
    await win.gSearchResultsPane.initializeCategories();
    ok(!doc.getElementById("template-whimsyPrivacy"), "Search setup inserted Privacy's Whimsy groups");
    ok(!doc.getElementById("template-whimsyLooks"), "and Look and Feel's");
    ok(!doc.getElementById("template-whimsyAI"), "and Settings › AI's, where outside agents live");
    ok(!doc.getElementById("template-whimsyClaude") && !doc.getElementById("whimsyClaudeGroup"), "The old Claude card is gone, not waiting anywhere");
    for (const id of ["Teach", "Navigation", "SearchDeck", "Profiles"]) {
      ok(!doc.getElementById(`template-whimsy${id}`), `and ${id}'s (wave9/designfix)`);
    }
    const aiPage = doc.getElementById("whimsyAIPage");
    ok(aiPage && !shown(aiPage), "They stay hidden on another pane");

    const groups = [...doc.querySelectorAll("#mainPrefPane [id^='whimsy'][data-category]")].filter(
      el => el.localName != "hbox" && !el.closest("template")
    );
    ok(groups.length >= 8, `Found Whimsy's groups (${groups.length})`);
    await doc.l10n.translateFragment(doc.getElementById("mainPrefPane"));
    for (const group of groups) {
      ok(groupLabel(group), `Every group's label is translated: #${group.id}`);
    }
    const plugins = doc.getElementById("whimsyLocalPluginsGroup");
    if (plugins) {
      is(groupLabel(plugins), "Local plugins", "The single-row card keeps its visible name");
      is(win.gWhimsySettings.groupName(plugins), groupLabel(plugins), "Search breadcrumbs use that name too");
    }
    for (const el of doc.querySelectorAll("[id^=whimsy][preference]")) {
      ok(win.Preferences.get(el.getAttribute("preference")), `#${el.id} has a registered preference binding`);
    }
    for (const group of groups) {
      const label = groupLabel(group);
      await search(doc, label);
      await TestUtils.waitForCondition(() => shown(group), `Searching "${label}" shows #${group.id}`);
    }

    // The searches users tried.
    const cases = [
      // W23: outside agents are a row of Settings › AI › Outside agents.
      ["Claude", "whimsyAIOutsideEnable"],
      ["debit cards", "whimsyAutofillPayments"],
      ["shipping", "whimsyAutofillAddresses"],
      ["vpn", "whimsyVpnGroup"],
      ["glance size", "whimsyGlanceSizeRow"],
      ["transparency", "whimsyLookGroup"],
      // wave9/designfix (H2, M8): groups that waited for their pane.
      ["tips", "whimsyTeachEnabled"],
      ["trails", "whimsyTrails"],
      ["page actions", "whimsyPageActions"],
      ["search deck", "whimsySearchDeck"],
    ];
    if (Services.prefs.getBoolPref("whimsy.feature.space-profiles", true) && doc.getElementById("whimsyProfilesGroup")) {
      cases.push(["profiles", "whimsyProfilesGroup"]);
    }
    if (doc.getElementById("whimsyLiquidGlass")) {
      // A partial word, as typed.
      cases.push(["liquid glas", "whimsyLiquidGlass"]);
    }
    for (const [query, id] of cases) {
      const el = doc.getElementById(id);
      ok(el, `#${id} exists`);
      await search(doc, query);
      await TestUtils.waitForCondition(() => shown(el), `Searching "${query}" shows #${id}`);
    }

    await search(doc, "");
  });
});

// These rows used to render without a Preferences registration. They must
// read the stored value and write it back when pressed, even if their pane
// was instantiated by search before the user opened it.
add_task(async function test_template_checkbox_bindings() {
  const cases = [
    ["whimsyNotesEnabled", "whimsy.feature.notes"],
    ["whimsyNoteBlocksEnabled", "whimsy.feature.note-blocks"],
    ["whimsyEaselEnabled", "whimsy.feature.easel"],
    ["whimsyFinderFoldersEnabled", "whimsy.feature.finder-folders"],
    ["whimsyScreenshotSidebarEnabled", "whimsy.feature.screenshot-sidebar"],
    ["whimsyCloseWindowWithLastTab", "browser.tabs.closeWindowWithLastTab"],
    ["whimsyDockBadge", "whimsy.downloads.dock-badge"],
    ["whimsyQuickLook", "whimsy.feature.quick-look"],
    ["whimsySpaceExtensions", "whimsy.feature.space-extensions"],
  ];
  await BrowserTestUtils.withNewTab("about:preferences#home", async browser => {
    // The switches are put back before this tab closes: one of them is
    // "close the window with its last tab", and closing the tab with it on
    // can close the test's window.
    await SpecialPowers.pushPrefEnv({ set: cases.map(([, pref]) => [pref, false]) });
    try {
      const doc = browser.contentDocument;
      const win = browser.contentWindow;
      await win.gSearchResultsPane.initializeCategories();
      await doc.l10n.translateFragment(doc.getElementById("mainPrefPane"));
      for (const [id, pref] of cases) {
        const box = doc.getElementById(id);
        ok(box, `#${id} is present`);
        await search(doc, box.getAttribute("label"));
        await TestUtils.waitForCondition(() => shown(box), `Search reveals #${id}`);
        ok(!box.checked, `#${id} reads its stored false value`);
        box.scrollIntoView({ block: "center" });
        EventUtils.synthesizeMouseAtCenter(box, {}, win);
        await TestUtils.waitForCondition(() => Services.prefs.getBoolPref(pref), `#${id} writes its preference`);
      }
    } finally {
      await SpecialPowers.popPrefEnv();
    }
  });
});

// wave9/designfix (H2): with Firefox's settings redesign, General is hidden,
// so Tips lives in Look and Feel, where it can be reached and switched.
add_task(async function test_tips_switch_is_reachable() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.teach.enabled", true]] });
  await BrowserTestUtils.withNewTab("about:preferences#zenLooks", async browser => {
    const doc = browser.contentDocument;
    const win = browser.contentWindow;
    await TestUtils.waitForCondition(() => win.gLastCategory?.category == "paneZenLooks", "Look and Feel shows");
    const box = await TestUtils.waitForCondition(() => doc.getElementById("whimsyTeachEnabled"), "Tips is there");
    const group = doc.getElementById("whimsyTeachGroup");
    is(group.dataset.category, "paneZenLooks", "Tips belongs to Look and Feel");
    await TestUtils.waitForCondition(() => shown(group) && group.checkVisibility(), "and is visible there");
    is(group.previousElementSibling?.id, "whimsyLookGroup", "after Whimsy's Look group");
    ok(box.checked, "on while tips are on");
    box.scrollIntoView();
    box.click();
    await TestUtils.waitForCondition(() => !Services.prefs.getBoolPref("whimsy.teach.enabled"), "unchecking turns tips off");
    box.click();
    await TestUtils.waitForCondition(() => Services.prefs.getBoolPref("whimsy.teach.enabled"), "and checking turns them on");
  });
  await SpecialPowers.popPrefEnv();
});
