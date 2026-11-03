/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W11-15: "Show Hidden Spaces…" is a styled surface (the Theme picker
// family), not a native menu. Rows show the space's tile, name and tab
// count; a row click or Return shows the space again and switches to it
// (d15), with an Undo toast; arrow keys move; a locked space unlocks first
// and stays hidden if that's cancelled; the empty state offers to hide the
// current space; the command is always available.

const { WhimsySpaceArchive } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySpaceArchive.sys.mjs");
const { WhimsyHiddenSpaces } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyHiddenSpaces.sys.mjs");
const { WhimsySpaceLock } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySpaceLock.sys.mjs");

let firstSpace, taxes, garden;

add_setup(async function () {
  firstSpace = gZenWorkspaces.getWorkspaces().find(w => w.uuid == gZenWorkspaces.activeWorkspace);
  taxes = await gZenWorkspaces.createAndSaveWorkspace("Taxes 2026", "🧾", true);
  garden = await gZenWorkspaces.createAndSaveWorkspace("Garden", undefined, true);
  registerCleanupFunction(async () => {
    if (gZenWorkspaces.activeWorkspace != firstSpace.uuid) {
      await gZenWorkspaces.changeWorkspaceWithID(firstSpace.uuid);
    }
    for (const space of [taxes, garden]) {
      const workspace = gZenWorkspaces.getWorkspaces().find(w => w.uuid == space.uuid);
      if (workspace) {
        delete workspace.whimsyHidden;
        delete workspace.whimsyLocked;
        gZenWorkspaces.saveWorkspace(workspace);
        await gZenWorkspaces.removeWorkspace(space.uuid);
      }
    }
  });
  if (gZenWorkspaces.activeWorkspace != firstSpace.uuid) {
    await gZenWorkspaces.changeWorkspaceWithID(firstSpace.uuid);
  }
});

function space(uuid) {
  return gZenWorkspaces.getWorkspaces().find(w => w.uuid == uuid);
}

async function openPanel() {
  const shown = BrowserTestUtils.waitForEvent(document, "popupshown", true, e => e.target.id == WhimsyHiddenSpaces.PANEL_ID);
  document.getElementById("cmd_whimsyShowHiddenSpaces").doCommand();
  return (await shown).target;
}

async function closePanel(panel) {
  if (panel.state == "closed" || !panel.isConnected) {
    return;
  }
  const hidden = BrowserTestUtils.waitForEvent(panel, "popuphidden");
  panel.hidePopup();
  await hidden;
}

async function hide(uuid) {
  await WhimsySpaceArchive.toggleHidden(window, uuid);
  toastCleanup();
}

function toastCleanup() {
  closeToasts();
}

add_task(async function test_empty_state_and_always_available() {
  const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");
  ok(globalActions.find(a => a.l10nId == "whimsy-action-show-hidden-spaces")?.isAvailable(window),
    "The command is available with nothing hidden");
  const panel = await openPanel();
  ok(panel.classList.contains("whimsy-surface"), "A Whimsy surface, not a native menu");
  is(panel.localName, "panel", "...a panel");
  ok(panel.querySelector(".whimsy-hidden-spaces-empty"), "The empty state shows");
  const hideButton = panel.querySelector("#whimsy-hidden-spaces-empty-hide");
  ok(hideButton, "It offers to hide the current space");
  await TestUtils.waitForCondition(() => hideButton.label.includes(firstSpace.name), "Named after the current space");
  await closePanel(panel);
});

add_task(async function test_rows_show_and_switch() {
  await hide(taxes.uuid);
  await hide(garden.uuid);
  const panel = await openPanel();
  const rows = [...panel.querySelectorAll(".whimsy-hidden-space")];
  Assert.deepEqual(rows.map(r => r.dataset.uuid), [taxes.uuid, garden.uuid], "One row per hidden space, in switcher order");
  is(panel.querySelector("[role=listbox]").getAttribute("aria-labelledby"), `${WhimsyHiddenSpaces.PANEL_ID}-title`,
    "A labelled listbox");
  is(rows[0].querySelector(".whimsy-hidden-space-name").textContent, "Taxes 2026", "The name");
  is(rows[0].querySelector(".whimsy-surface-tile-text")?.textContent, "🧾", "Its icon in the tile");
  await TestUtils.waitForCondition(() => /\d+ tabs?/.test(rows[0].querySelector(".whimsy-hidden-space-detail").textContent),
    "Its tab count");
  is(document.activeElement, rows[0], "The first row has focus");
  ok(rows[0].querySelector(".whimsy-hidden-space-unhide"), "An always-visible Unhide pill on an unlocked row");
  is(rows[0].querySelector(".whimsy-hidden-space-unhide").getAttribute("aria-hidden"), "true", "...aria-hidden");

  // Arrow keys move between rows.
  EventUtils.synthesizeKey("KEY_ArrowDown", {}, window);
  is(document.activeElement, rows[1], "Down moves to the next row");
  EventUtils.synthesizeKey("KEY_Home", {}, window);
  is(document.activeElement, rows[0], "Home goes to the first");
  EventUtils.synthesizeKey("KEY_End", {}, window);
  is(document.activeElement, rows[1], "End goes to the last");

  // Return shows it again and switches there — the panel stays open (W14-B5).
  EventUtils.synthesizeKey("KEY_Enter", {}, window);
  await TestUtils.waitForCondition(() => gZenWorkspaces.activeWorkspace == garden.uuid, "Switched to the space");
  // It's shown once the switch has finished (Zen sets the active space first).
  await TestUtils.waitForCondition(() => !space(garden.uuid).whimsyHidden, "...and it's back in the switcher");
  ok(space(taxes.uuid).whimsyHidden, "The other one stays hidden");
  is(panel.state, "open", "The panel stays open");
  ok(!panel.querySelector(`.whimsy-hidden-space[data-uuid="${garden.uuid}"]`), "...its row leaves the list");
  is(document.activeElement, rows[0], "Focus lands on the remaining row (garden's row was last)");

  // Undo hides it again and goes back.
  ok(WhimsyUndo().undo(window), "Undo is offered");
  await TestUtils.waitForCondition(() => space(garden.uuid).whimsyHidden, "Undo hides it again");
  await TestUtils.waitForCondition(() => gZenWorkspaces.activeWorkspace == firstSpace.uuid, "...and returns to where you were");
  await closePanel(panel);

  // A click does the same, and also leaves the panel open.
  const panel2 = await openPanel();
  const row = panel2.querySelector(`.whimsy-hidden-space[data-uuid="${taxes.uuid}"]`);
  EventUtils.synthesizeMouseAtCenter(row, {}, window);
  await TestUtils.waitForCondition(() => gZenWorkspaces.activeWorkspace == taxes.uuid, "A click switches too");
  await TestUtils.waitForCondition(() => !space(taxes.uuid).whimsyHidden, "...and unhides it");
  is(panel2.state, "open", "...without closing the panel");
  ok(!panel2.querySelector(`.whimsy-hidden-space[data-uuid="${taxes.uuid}"]`), "...and removes its row");
  await closePanel(panel2);
  await gZenWorkspaces.changeWorkspaceWithID(firstSpace.uuid);
  WhimsySpaceArchive.restore(window, garden.uuid);
  toastCleanup();
});

add_task(async function test_hide_current_from_footer() {
  await hide(taxes.uuid);
  const panel = await openPanel();
  const button = panel.querySelector("#whimsy-hidden-spaces-hide-current");
  ok(button, "The footer hides the current space");
  const hidden = BrowserTestUtils.waitForEvent(panel, "popuphidden");
  button.doCommand();
  await hidden;
  await TestUtils.waitForCondition(() => space(firstSpace.uuid).whimsyHidden, "The current space is hidden");
  isnot(gZenWorkspaces.activeWorkspace, firstSpace.uuid, "...and you moved off it");
  WhimsySpaceArchive.restore(window, firstSpace.uuid);
  WhimsySpaceArchive.restore(window, taxes.uuid);
  await gZenWorkspaces.changeWorkspaceWithID(firstSpace.uuid);
  toastCleanup();
});

add_task(async function test_locked_space_unlocks_first() {
  // A locked space you haven't unlocked is covered (W13-C2).
  const vault = await gZenWorkspaces.createAndSaveWorkspace("Vault", undefined, true);
  vault.whimsyHidden = true;
  vault.whimsyLocked = true;
  gZenWorkspaces.saveWorkspace(vault);
  WhimsySpaceArchive.applyHidden(window);
  const original = WhimsySpaceLock.authenticate;
  let answer = false;
  let asked = 0;
  WhimsySpaceLock.authenticate = async () => {
    asked++;
    return answer;
  };
  try {
    let panel = await openPanel();
    let row = panel.querySelector(`.whimsy-hidden-space[data-uuid="${vault.uuid}"]`);
    ok(row.hasAttribute("locked"), "A locked space is marked");
    ok(row.querySelector(".whimsy-surface-pill"), "...with a Locked pill");
    ok(!row.querySelector(".whimsy-hidden-space-unhide"), "...and no Unhide pill");
    row.click();
    await TestUtils.waitForCondition(() => asked == 1, "Asked to unlock");
    await new Promise(resolve => setTimeout(resolve, 100));
    is(gZenWorkspaces.activeWorkspace, firstSpace.uuid, "Cancelled: no switch");
    ok(space(vault.uuid).whimsyHidden, "...and it stays hidden");
    is(panel.state, "open", "Cancelled: the panel stays open");
    ok(panel.querySelector(`.whimsy-hidden-space[data-uuid="${vault.uuid}"]`), "...and its row stays too");
    await closePanel(panel);

    answer = true;
    panel = await openPanel();
    row = panel.querySelector(`.whimsy-hidden-space[data-uuid="${vault.uuid}"]`);
    row.click();
    await TestUtils.waitForCondition(() => gZenWorkspaces.activeWorkspace == vault.uuid, "Unlocked: switched");
    await TestUtils.waitForCondition(() => !space(vault.uuid).whimsyHidden, "...and shown again");
    is(asked, 2, "Asked once more, not twice");
    is(panel.state, "open", "Unlocked: the panel stays open too");
    ok(panel.querySelector(".whimsy-hidden-spaces-empty"), "Vault was the last hidden space: the empty state shows");
    await closePanel(panel);
  } finally {
    WhimsySpaceLock.authenticate = original;
    await gZenWorkspaces.changeWorkspaceWithID(firstSpace.uuid);
    const v = space(vault.uuid);
    if (v) {
      delete v.whimsyLocked;
      delete v.whimsyHidden;
      gZenWorkspaces.saveWorkspace(v);
      await gZenWorkspaces.removeWorkspace(vault.uuid);
    }
    toastCleanup();
  }
});

add_task(async function test_filter_from_six() {
  const extra = [];
  for (let i = 0; i < 6; i++) {
    const s = await gZenWorkspaces.createAndSaveWorkspace(`Project ${i}`, undefined, true);
    extra.push(s);
    s.whimsyHidden = true;
    gZenWorkspaces.saveWorkspace(s);
  }
  WhimsySpaceArchive.applyHidden(window);
  try {
    const panel = await openPanel();
    const input = panel.querySelector(".whimsy-hidden-spaces-filter");
    ok(input, "A filter field from six hidden spaces");
    is(document.activeElement, input, "...focused first");
    EventUtils.sendString("project 3", window);
    const visible = [...panel.querySelectorAll(".whimsy-hidden-space")].filter(r => !r.hidden);
    is(visible.length, 1, "Typing filters the rows");
    is(visible[0].dataset.uuid, extra[3].uuid, "...to the match");
    EventUtils.synthesizeKey("KEY_Escape", {}, window);
    is(input.value, "", "Esc clears the filter first");
    is(panel.state, "open", "...and keeps the panel open");
    await closePanel(panel);
  } finally {
    for (const s of extra) {
      delete s.whimsyHidden;
      gZenWorkspaces.saveWorkspace(s);
      await gZenWorkspaces.removeWorkspace(s.uuid);
    }
  }
});

add_task(async function test_close_button_and_escape() {
  await hide(taxes.uuid);
  let panel = await openPanel();
  const closeButton = panel.querySelector(".whimsy-surface-close");
  ok(closeButton, "A visible close button in the header");
  let hidden = BrowserTestUtils.waitForEvent(panel, "popuphidden");
  closeButton.doCommand();
  await hidden;
  is(panel.state, "closed", "...and it closes the panel");

  panel = await openPanel();
  hidden = BrowserTestUtils.waitForEvent(panel, "popuphidden");
  EventUtils.synthesizeKey("KEY_Escape", {}, window);
  await hidden;
  is(panel.state, "closed", "Esc closes the panel too");

  WhimsySpaceArchive.restore(window, taxes.uuid);
  toastCleanup();
});

function WhimsyUndo() {
  return ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyUndo.sys.mjs").WhimsyUndo;
}
