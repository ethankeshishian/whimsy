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
    ];
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
