/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave3: the cheat sheet lists Zen's and Firefox's shortcuts too, read from
// the window's live keysets and grouped like about:keyboard (Whimsy, Zen's
// groups, Firefox's menus, Other). Bindings are the current ones, cleared and
// disabled keys are left out, each key shows once, and search filters rows
// (or a whole group by its heading) with an empty state.

const { WhimsyCheatSheet } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCheatSheet.sys.mjs");
const { ShortcutUtils } = ChromeUtils.importESModule("resource://gre/modules/ShortcutUtils.sys.mjs");

function groupOf(catalogue, keyId) {
  return catalogue.find(group => group.rows.some(row => row.keyId == keyId));
}

function addProbeKey({ id, label = null, key = "Q", modifiers = "accel,alt,shift" }) {
  const keyset = document.createXULElement("keyset");
  const keyEl = document.createXULElement("key");
  keyEl.id = id;
  keyEl.setAttribute("key", key);
  keyEl.setAttribute("modifiers", modifiers);
  if (label) {
    keyEl.setAttribute("label", label);
  }
  keyset.append(keyEl);
  document.documentElement.append(keyset);
  registerCleanupFunction(() => keyset.remove());
  return keyEl;
}

add_task(async function test_groups() {
  const catalogue = await WhimsyCheatSheet.catalogue(window);
  ok(catalogue.length >= 3, "Several groups");
  for (const group of catalogue) {
    ok(group.heading, "Every group has a heading");
    ok(group.rows.length, `"${group.heading}" isn't empty`);
  }

  const whimsy = groupOf(catalogue, "key_whimsyCheatsheet");
  ok(whimsy, "Whimsy's own shortcuts are listed");
  is(catalogue[0], whimsy, "...first");

  const zen = groupOf(catalogue, "zen-compact-mode-toggle");
  ok(zen, "Zen's shortcuts are listed");
  isnot(zen, whimsy, "...in a Zen group");

  const file = groupOf(catalogue, "key_newNavigatorTab");
  ok(file, "Firefox's New Tab is listed");
  is(file.heading, document.getElementById("file-menu").label, "...under Firefox's File menu");

  ok(catalogue.every(group => !group.heading.startsWith("customkeys-")),
    "Fluent-only headings (e.g. Navigation) are resolved to text");

  const ids = catalogue.flatMap(group => group.rows.map(row => row.keyId)).filter(Boolean);
  is(new Set(ids).size, ids.length, "Each key appears once");

  const newTab = file.rows.find(row => row.keyId == "key_newNavigatorTab");
  is(newTab.label, ShortcutUtils.prettifyShortcut(document.getElementById("key_newNavigatorTab")),
    "Bindings use the platform's shortcut formatting");
  ok(!newTab.title.startsWith("customkeys-") && !newTab.title.startsWith("key"), "Titles are readable names");
});

add_task(async function test_live_keys() {
  const keyEl = addProbeKey({ id: "key_whimsyCatalogueProbe", label: "Catalogue probe" });
  const unnamed = addProbeKey({ id: "key_whimsyUnnamedProbe", key: "J" });

  let rows = await WhimsyCheatSheet.rows(window);
  let row = rows.find(r => r.keyId == keyEl.id);
  ok(row, "A key added at runtime is found in its keyset");
  is(row.group, (await WhimsyCheatSheet.catalogue(window)).at(-1).heading, "...under Other, last");
  is(row.label, ShortcutUtils.prettifyShortcut(keyEl), "...with its binding");
  ok(!rows.some(r => r.keyId == unnamed.id), "A key with no readable name outside Whimsy's keyset is skipped");

  keyEl.setAttribute("key", "W");
  row = (await WhimsyCheatSheet.rows(window)).find(r => r.keyId == keyEl.id);
  is(row.label, ShortcutUtils.prettifyShortcut(keyEl), "A rebinding shows the new binding");

  keyEl.setAttribute("disabled", "true");
  ok(!(await WhimsyCheatSheet.rows(window)).some(r => r.keyId == keyEl.id), "Disabled keys are left out");
  keyEl.removeAttribute("disabled");
  keyEl.removeAttribute("key");
  ok(!(await WhimsyCheatSheet.rows(window)).some(r => r.keyId == keyEl.id), "Cleared keys are left out");
});

add_task(async function test_panel_search() {
  addProbeKey({ id: "key_whimsySearchProbe", label: "Zebra probe 4417", key: "Y" });
  const shown = BrowserTestUtils.waitForEvent(document, "popupshown", true,
    e => e.target.id == "whimsy-cheatsheet-panel");
  WhimsyCheatSheet.open(window);
  await shown;
  const panel = document.getElementById("whimsy-cheatsheet-panel");
  try {
    await TestUtils.waitForCondition(() => panel.querySelector(".whimsy-cheatsheet-group"), "The list rendered");
    ok(panel.querySelectorAll(".whimsy-cheatsheet-heading").length >= 3, "Group headings are shown");

    const search = panel.querySelector("input");
    is(document.activeElement, search, "Search has focus");
    search.value = "zebra probe 4417";
    search.dispatchEvent(new Event("input"));
    const rows = panel.querySelectorAll(".whimsy-cheatsheet-row");
    is(rows.length, 1, "Search narrows to the matching row");
    is(rows[0].getAttribute("data-key-id"), "key_whimsySearchProbe", "...the right one");
    is(panel.querySelectorAll(".whimsy-cheatsheet-group").length, 1, "Groups without matches are hidden");

    const heading = document.getElementById("file-menu").label;
    search.value = heading;
    search.dispatchEvent(new Event("input"));
    ok(panel.querySelector('.whimsy-cheatsheet-row[data-key-id="key_newNavigatorTab"]'),
      "Searching a group's heading shows the whole group");

    search.value = "no such shortcut 824831";
    search.dispatchEvent(new Event("input"));
    ok(!panel.querySelector(".whimsy-cheatsheet-row"), "No rows for a miss");
    ok(panel.querySelector(".whimsy-cheatsheet-empty"), "...and an empty state");
  } finally {
    const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
    panel.hidePopup();
    await hidden;
  }
});
