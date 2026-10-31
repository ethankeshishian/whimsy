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

async function search(doc, query) {
  const input = doc.getElementById("searchInput");
  input.value = query;
  input.dispatchEvent(new doc.defaultView.InputEvent("input", { bubbles: true }));
}

function groupLabel(group) {
  const heading = group.querySelector("h2, h3");
  if (heading?.textContent.trim()) {
    return heading.textContent.trim();
  }
  const fieldset = group.localName == "moz-fieldset" ? group : group.querySelector("moz-fieldset");
  return fieldset?.getAttribute("label")?.trim() || "";
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
    ok(!doc.getElementById("template-whimsyClaude"), "and Claude's");
    for (const id of ["Teach", "Navigation", "SearchDeck", "Profiles"]) {
      ok(!doc.getElementById(`template-whimsy${id}`), `and ${id}'s (wave9/designfix)`);
    }
    ok(!shown(doc.getElementById("whimsyClaudeGroup")), "They stay hidden on another pane");

    const groups = [...doc.querySelectorAll("#mainPrefPane [id^='whimsy'][data-category]")].filter(
      el => el.localName != "hbox" && !el.closest("template")
    );
    ok(groups.length >= 8, `Found Whimsy's groups (${groups.length})`);
    await TestUtils.waitForCondition(() => groups.every(groupLabel), "Every group's label is translated");
    for (const group of groups) {
      const label = groupLabel(group);
      await search(doc, label);
      await TestUtils.waitForCondition(() => shown(group), `Searching "${label}" shows #${group.id}`);
    }

    // The searches users tried.
    const cases = [
      ["Claude", "whimsyClaudeGroup"],
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
