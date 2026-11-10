/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W10-03 (Arc): Next Space past the last space opens New Space; Previous
// Space stops at the first. Zen's wrap-around setting went round to the
// other end. Only Next/Previous Space (their keys, the Spaces menu, the
// command bar); a burst of presses stops at the last space rather than
// making one.

const { WhimsySpaceSwitchQueue } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsySpaceSwitchQueue.sys.mjs"
);

const { UrlbarTestUtils } = ChromeUtils.importESModule("resource://testing-common/UrlbarTestUtils.sys.mjs");
UrlbarTestUtils.init(this);

const EDGES = "whimsy.feature.space-edges";
let created = [];
let originalSpace;
let creations = 0;

async function settle() {
  await TestUtils.waitForCondition(
    () => !WhimsySpaceSwitchQueue.isSwitching(window) && !gZenWorkspaces.isChangingWorkspace,
    "Switches done"
  );
}

async function goTo(space) {
  await settle();
  if (gZenWorkspaces.activeWorkspace != space.uuid) {
    await gZenWorkspaces.changeWorkspaceWithID(space.uuid);
  }
  await settle();
}

function command(id) {
  document.getElementById(id).doCommand();
}


add_setup(async function () {
  await TestUtils.waitForCondition(() => WhimsySpaceSwitchQueue.debugState(window), "Space switching set up");
  await SpecialPowers.pushPrefEnv({ set: [["zen.workspaces.wrap-around-navigation", true]] });
  originalSpace = gZenWorkspaces.getActiveWorkspace();
  for (const name of ["Edge A", "Edge B", "Edge C"]) {
    created.push(await gZenWorkspaces.createAndSaveWorkspace(name, undefined, true));
  }
  // Count New Space instead of opening its form.
  gZenWorkspaces.openWorkspaceCreation = async () => {
    creations++;
  };
  registerCleanupFunction(async () => {
    delete gZenWorkspaces.openWorkspaceCreation;
    await settle();
    await gZenWorkspaces.changeWorkspaceWithID(originalSpace.uuid);
    for (const space of created) {
      await gZenWorkspaces.removeWorkspace(space.uuid);
    }
    created = [];
  });
  ok(gZenWorkspaces.getWorkspaces().length >= 3, "At least three spaces");
});

add_task(async function test_next_past_last_makes_a_space() {
  ok(Services.prefs.getBoolPref(EDGES), "On by default");
  const all = gZenWorkspaces.getWorkspaces();
  await goTo(all.at(-1));
  creations = 0;
  command("cmd_zenWorkspaceForward");
  await TestUtils.waitForCondition(() => creations == 1, "Next Space on the last space opens New Space");
  await settle();
  is(gZenWorkspaces.activeWorkspace, all.at(-1).uuid, "It didn't wrap to the first space");
});

add_task(async function test_previous_stops_at_first() {
  const all = gZenWorkspaces.getWorkspaces();
  await goTo(all[0]);
  creations = 0;
  command("cmd_zenWorkspaceBackward");
  await new Promise(r => setTimeout(r, 300));
  await settle();
  is(gZenWorkspaces.activeWorkspace, all[0].uuid, "Previous Space on the first space stays there");
  is(creations, 0, "and makes nothing");
});

add_task(async function test_middle_steps_normally() {
  const all = gZenWorkspaces.getWorkspaces();
  await goTo(all.at(-2));
  command("cmd_zenWorkspaceForward");
  await TestUtils.waitForCondition(() => gZenWorkspaces.activeWorkspace == all.at(-1).uuid, "Next Space goes to the next one");
  await settle();
  command("cmd_zenWorkspaceBackward");
  await TestUtils.waitForCondition(() => gZenWorkspaces.activeWorkspace == all.at(-2).uuid, "Previous Space goes back");
  await settle();
});

add_task(async function test_burst_stops_at_last() {
  const all = gZenWorkspaces.getWorkspaces();
  await goTo(all.at(-2));
  creations = 0;
  window.gReduceMotionOverride = false;
  command("cmd_zenWorkspaceForward");
  ok(WhimsySpaceSwitchQueue.isSwitching(window), "The first slide is playing");
  command("cmd_zenWorkspaceForward");
  command("cmd_zenWorkspaceForward");
  await settle();
  window.gReduceMotionOverride = undefined;
  is(gZenWorkspaces.activeWorkspace, all.at(-1).uuid, "A burst lands on the last space");
  is(creations, 0, "without making a new one");
});

add_task(async function test_switch_off_keeps_zen_wrap() {
  await SpecialPowers.pushPrefEnv({ set: [[EDGES, false]] });
  const all = gZenWorkspaces.getWorkspaces();
  await goTo(all.at(-1));
  creations = 0;
  command("cmd_zenWorkspaceForward");
  await TestUtils.waitForCondition(() => gZenWorkspaces.activeWorkspace == all[0].uuid, "Off: Zen wraps to the first space");
  await settle();
  is(creations, 0, "and makes nothing");
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_swipe_burst_skips_hidden_and_stops_at_edges() {
  const all = gZenWorkspaces.getWorkspaces();
  const hiddenSpace = all[1];
  hiddenSpace.whimsyHidden = true;
  gZenWorkspaces.saveWorkspace(hiddenSpace);
  window.dispatchEvent(new CustomEvent("ZenWorkspaceDataChanged"));

  const visible = all.filter(s => !s.whimsyHidden);
  ok(visible.length >= 3, "At least 3 visible spaces");

  // Start at the first visible space
  await goTo(visible[0]);
  creations = 0;
  window.gReduceMotionOverride = false;

  // A fast burst of forward swipes (more swipes than spaces). Each swipe
  // ends in Zen's ZenSpacesSwipe#handleSwipeEnd, which calls
  // changeWorkspaceShortcut(direction, true); synthetic gesture events
  // don't carry the deltas Zen's swipe needs, so the burst calls that.
  const swipes = [];
  swipes.push(gZenWorkspaces.changeWorkspaceShortcut(1, true));
  ok(WhimsySpaceSwitchQueue.isSwitching(window), "Forward slide in flight");
  for (let i = 0; i < visible.length + 1; i++) {
    swipes.push(gZenWorkspaces.changeWorkspaceShortcut(1, true));
  }
  await Promise.all(swipes);
  await settle();

  is(
    gZenWorkspaces.activeWorkspace,
    visible.at(-1).uuid,
    "Fast forward swipe burst lands on the last visible space, skipping hidden space and without wrapping"
  );
  is(creations, 0, "Fast burst did not create a new space at the edge");

  // Now a fast burst of backward swipes from the last space
  const back = [];
  back.push(gZenWorkspaces.changeWorkspaceShortcut(-1, true));
  ok(WhimsySpaceSwitchQueue.isSwitching(window), "Backward slide in flight");
  for (let i = 0; i < visible.length + 1; i++) {
    back.push(gZenWorkspaces.changeWorkspaceShortcut(-1, true));
  }
  await Promise.all(back);
  await settle();

  is(
    gZenWorkspaces.activeWorkspace,
    visible[0].uuid,
    "Fast backward swipe burst lands on the first visible space, skipping hidden space and without wrapping"
  );
  is(creations, 0, "Backward burst did not create a new space");

  window.gReduceMotionOverride = undefined;
  delete hiddenSpace.whimsyHidden;
  gZenWorkspaces.saveWorkspace(hiddenSpace);
  window.dispatchEvent(new CustomEvent("ZenWorkspaceDataChanged"));
  await settle();
});

add_task(async function test_switcher_arrows_skip_hidden_and_enforce_edges() {
  const all = gZenWorkspaces.getWorkspaces();
  const hiddenSpace = all[1];
  hiddenSpace.whimsyHidden = true;
  gZenWorkspaces.saveWorkspace(hiddenSpace);
  window.dispatchEvent(new CustomEvent("ZenWorkspaceDataChanged"));

  const visible = all.filter(s => !s.whimsyHidden);
  await goTo(visible[0]);
  creations = 0;

  const icons = document.getElementById("zen-workspaces-button");
  const firstButton = icons.querySelector(`toolbarbutton[zen-workspace-id="${visible[0].uuid}"]`);
  firstButton.focus();

  // Backward arrow from first space: stops at first space
  firstButton.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
  await settle();
  is(gZenWorkspaces.activeWorkspace, visible[0].uuid, "ArrowLeft on first space stays at first space");
  is(creations, 0, "No new space made");

  // Forward arrow: steps to visible[1], skipping hiddenSpace (all[1])
  firstButton.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  await settle();
  is(gZenWorkspaces.activeWorkspace, visible[1].uuid, "ArrowRight skipped hidden space");

  // Move to the last visible space
  await goTo(visible.at(-1));
  creations = 0;
  const lastButton = icons.querySelector(`toolbarbutton[zen-workspace-id="${visible.at(-1).uuid}"]`);
  lastButton.focus();

  // Forward arrow past the last space: opens New Space
  lastButton.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  await TestUtils.waitForCondition(() => creations == 1, "ArrowRight past last space opens New Space");
  await settle();
  is(gZenWorkspaces.activeWorkspace, visible.at(-1).uuid, "ArrowRight did not wrap to first space");

  delete hiddenSpace.whimsyHidden;
  gZenWorkspaces.saveWorkspace(hiddenSpace);
  window.dispatchEvent(new CustomEvent("ZenWorkspaceDataChanged"));
  await settle();
});

// W11-16: Zen's swipe edge actions (New Space past the last space, the
// Library past the first) count the visible spaces, so a hidden space at an
// end doesn't take them away. They are the window's own module instances
// (Zen loads them with global "current").
add_task(async function test_edge_actions_count_visible_spaces() {
  await SpecialPowers.pushPrefEnv({ set: [["zen.library.enabled", true]] });
  const { ZenLibrary } = window.ChromeUtils.importESModule("moz-src:///zen/library/ZenLibrary.mjs", { global: "current" });
  const { ZenSpaceAddSwipe } = window.ChromeUtils.importESModule("resource:///modules/zen/ZenSpaceAddSwipe.mjs", { global: "current" });
  ok(ZenLibrary.readySwipeOpenLibrary._whimsyVisible, "The window's ZenLibrary is wrapped");
  ok(ZenSpaceAddSwipe.prototype.readySwipeAddSpace._whimsyVisible, "...and its ZenSpaceAddSwipe");
  if (!gZenWorkspaces.shouldSwipeEdgeActions) {
    info("Swipe edge actions are off in this build; the wrappers were checked");
    await SpecialPowers.popPrefEnv();
    return;
  }
  const all = gZenWorkspaces.getWorkspaces();
  const [first, second] = all;
  const last = all.at(-1);
  const beforeLast = all.at(-2);
  first.whimsyHidden = true;
  last.whimsyHidden = true;
  gZenWorkspaces.saveWorkspace(first);
  gZenWorkspaces.saveWorkspace(last);
  try {
    const libraryAtStart = !ZenLibrary.libraryOnRight;
    await gZenWorkspaces.changeWorkspaceWithID((libraryAtStart ? second : beforeLast).uuid);
    ok(ZenLibrary.readySwipeOpenLibrary(), "At the first visible space, a swipe can open the Library");
    await gZenWorkspaces.changeWorkspaceWithID((libraryAtStart ? beforeLast : second).uuid);
    ok(ZenSpaceAddSwipe.prototype.readySwipeAddSpace.call(null), "At the last visible space, a swipe can add a space");
  } finally {
    delete first.whimsyHidden;
    delete last.whimsyHidden;
    gZenWorkspaces.saveWorkspace(first);
    gZenWorkspaces.saveWorkspace(last);
    await SpecialPowers.popPrefEnv();
  }
});

// W24 smallbugs #13: mouse back/forward buttons on the sidebar fire the
// same "AppCommand" event a swipe/Zen's own _handleAppCommand react to
// (only while the mouse hovers the sidebar). Back on the space at the
// Library's edge should open it instead of just stopping there, and
// Forward while it's open should close it and land back on the space you
// came from (like history) rather than stepping past it.
function appCommand(command) {
  document.documentElement.dispatchEvent(new CommandEvent("AppCommand", { bubbles: true, cancelable: true, command }));
}

async function hoverSidebar() {
  EventUtils.synthesizeMouseAtCenter(gNavToolbox, { type: "mousemove" }, window);
  await TestUtils.waitForCondition(() => gNavToolbox.matches(":hover"), "The mouse is over the sidebar");
}

add_task(async function test_mouse_back_forward_opens_and_returns_from_library() {
  await SpecialPowers.pushPrefEnv({ set: [["zen.library.enabled", true]] });
  const { ZenLibrary } = window.ChromeUtils.importESModule("moz-src:///zen/library/ZenLibrary.mjs", { global: "current" });
  const all = gZenWorkspaces.getWorkspaces();
  // The Library sits past whichever end Settings puts it on; start there.
  const edgeSpace = ZenLibrary.libraryOnRight ? all.at(-1) : all[0];
  const backCommand = ZenLibrary.libraryOnRight ? "Forward" : "Back";
  const forwardCommand = ZenLibrary.libraryOnRight ? "Back" : "Forward";
  await goTo(edgeSpace);
  ok(!ZenLibrary.isLibraryOpen, "The Library starts closed");
  await hoverSidebar();
  try {
    appCommand(backCommand);
    await TestUtils.waitForCondition(() => ZenLibrary.isLibraryOpen, "The mouse button at the Library's edge opens it");
    is(gZenWorkspaces.activeWorkspace, edgeSpace.uuid, "The active space didn't change");

    appCommand(forwardCommand);
    await TestUtils.waitForCondition(() => !ZenLibrary.isLibraryOpen, "The other mouse button closes the Library");
    is(gZenWorkspaces.activeWorkspace, edgeSpace.uuid, "...landing back on the space you came from, not the next one over");
  } finally {
    if (ZenLibrary.isLibraryOpen) {
      ZenLibrary.close();
      await TestUtils.waitForCondition(() => !ZenLibrary.isLibraryOpen, "Library closed for cleanup");
    }
    EventUtils.synthesizeMouseAtCenter(document.documentElement, { type: "mousemove" }, window);
    await SpecialPowers.popPrefEnv();
  }
});

// W14-17: a hidden space takes no slot on the strip. A drag never shows it,
// a slide never passes it, a swipe from a hidden space that's showing goes
// to its neighbour that way, and a swipe that switches nothing puts the
// dragged strip back.
function stripOffset(space) {
  const transform = gZenWorkspaces.workspaceElement(space.uuid)?.style.transform || "none";
  if (transform == "none") {
    return 0;
  }
  const match = /translateX\((-?[\d.]+)%\)/.exec(transform);
  return match ? Number(match[1]) : NaN;
}

function parked(space) {
  return stripOffset(space) <= -100 * (gZenWorkspaces.getWorkspaces().length + 1);
}

async function stripAtRest(onStrip, what) {
  const active = gZenWorkspaces.activeWorkspace;
  const at = onStrip.findIndex(space => space.uuid == active);
  await TestUtils.waitForCondition(
    () => !gZenWorkspaces._animatingChange && onStrip.every((space, i) => Math.abs(stripOffset(space) - (i - at) * 100) < 0.5),
    `${what}: every space on the strip is back at rest`
  );
}

function hide(space, hidden) {
  if (hidden) {
    space.whimsyHidden = true;
  } else {
    delete space.whimsyHidden;
  }
  gZenWorkspaces.saveWorkspace(space);
  window.dispatchEvent(new CustomEvent("ZenWorkspaceDataChanged"));
}

add_task(async function test_hidden_space_takes_no_strip_slot() {
  const all = gZenWorkspaces.getWorkspaces();
  ok(all.length >= 4, "At least four spaces");
  const [first, hidden, third] = all;
  await goTo(first);
  hide(hidden, true);
  const visible = all.filter(space => space != hidden);
  await TestUtils.waitForCondition(() => parked(hidden), "Hiding a space parks it off the strip at once");
  await stripAtRest(visible, "After hiding");
  try {
    // Zen's swipe update drags the strip; the neighbour it reveals is the
    // next visible space, and the hidden one stays parked.
    gZenWorkspaces._organizeWorkspaceStripLocations(first, true, -60);
    is(stripOffset(first), -30, "The dragged space follows the drag");
    is(stripOffset(third), 70, "...and the next visible space comes in beside it");
    ok(parked(hidden), "The hidden space never shows in the drag");
    await gZenWorkspaces.changeWorkspaceShortcut(1, true);
    await settle();
    is(gZenWorkspaces.activeWorkspace, third.uuid, "The swipe lands on the next visible space");
    ok(parked(hidden), "...without sliding through the hidden one");
    await stripAtRest(visible, "After the swipe");

    // Showing the hidden space (Show Hidden Spaces' preview, a restore):
    // it takes its own place, and a swipe from it goes its way.
    await gZenWorkspaces.changeWorkspaceWithID(hidden.uuid);
    await settle();
    await stripAtRest(all, "On the hidden space");
    await gZenWorkspaces.changeWorkspaceShortcut(1, true);
    await settle();
    is(gZenWorkspaces.activeWorkspace, third.uuid, "Right from the hidden space: the space after it");
    await TestUtils.waitForCondition(() => parked(hidden), "Left, it parks again");
    await gZenWorkspaces.changeWorkspaceWithID(hidden.uuid);
    await settle();
    await gZenWorkspaces.changeWorkspaceShortcut(-1, true);
    await settle();
    is(gZenWorkspaces.activeWorkspace, first.uuid, "Left from the hidden space: the space before it");
    await stripAtRest(visible, "Back on the first space");

    // At the left edge a swipe switches nothing: the strip goes back.
    gZenWorkspaces._organizeWorkspaceStripLocations(first, true, 60);
    is(stripOffset(first), 30, "Dragged past the first space");
    is(await gZenWorkspaces.changeWorkspaceShortcut(-1, true), null, "Nothing to switch to");
    await stripAtRest(visible, "After a swipe at the left edge");
    is(gZenWorkspaces.activeWorkspace, first.uuid, "Still on the first space");
  } finally {
    hide(hidden, false);
    await settle();
    await goTo(first);
    await stripAtRest(gZenWorkspaces.getWorkspaces(), "Unhidden, it takes its slot back");
  }
});

// W14-17 (user decision): hidden spaces are listed only by Show Hidden
// Spaces. The command bar's Focus on and Move to rows and the Move Tab menu
// leave them out; once unhidden they're ordinary again.
add_task(async function test_hidden_space_is_not_offered() {
  const { WhimsySpaces } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySpaces.sys.mjs");
  const all = gZenWorkspaces.getWorkspaces();
  const target = all.at(-1);
  await goTo(all[0]);
  const name = target.name;
  const rows = async value => {
    await UrlbarTestUtils.promiseAutocompleteResultPopup({ window, value, waitForFocus: SimpleTest.waitForFocus });
    await UrlbarTestUtils.promiseSearchComplete(window);
    let count = 0;
    for (let i = 0; i < UrlbarTestUtils.getResultCount(window); i++) {
      const { result } = await UrlbarTestUtils.getDetailsOfResultAt(window, i);
      count += result.payload?.workspaceId == target.uuid ? 1 : 0;
    }
    gURLBar.searchMode = null;
    await UrlbarTestUtils.promisePopupClose(window, () => EventUtils.synthesizeKey("KEY_Escape"));
    return count;
  };
  // Focus on <space> (the spaces search, "` name") and Move to <space>.
  const focusRows = () => rows("` " + name);
  const moveRows = () => rows(name);
  const offered = [await focusRows(), await moveRows()];
  Assert.greater(offered[0], 0, "A visible space has a Focus on row");
  Assert.greater(offered[1], 0, "...and a Move to row");
  hide(target, true);
  try {
    is(await focusRows(), 0, "Hidden, the spaces search doesn't list it");
    is(await moveRows(), 0, "...nor does a search offer to move a tab there");
    ok(!WhimsySpaces.movableSpaces(window).some(space => space.uuid == target.uuid), "...and Move to leaves it out");
  } finally {
    hide(target, false);
    await settle();
  }
  is(await focusRows(), offered[0], "Unhidden, it's searchable again");
  is(await moveRows(), offered[1], "...and offered as a Move to target");
  ok(WhimsySpaces.movableSpaces(window).some(space => space.uuid == target.uuid), "...and a Move to target");
});
