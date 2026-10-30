/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave3: tree tabs collapse/expand and drag-out reparenting. A parent's
// disclosure button folds its subtree (nested folds survive, selecting a
// folded tab unfolds its ancestors, Zen's `hidden` is never touched), and a
// same-window drop sets the dropped tab's depth from the horizontal offset:
// left of its indent detaches it, right nests it under the tab above, and
// its own subtree follows it.

const { WhimsyTreeTabs } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyTreeTabs.sys.mjs");

const FEATURE = "whimsy.feature.tree-tabs";
const STYLE = "whimsy.tabs.tree-style";

const startTabs = new Set(gBrowser.tabs);
registerCleanupFunction(async () => {
  // Turn the tree off first so closing a parent doesn't archive its branch.
  Services.prefs.setBoolPref(FEATURE, false);
  for (const tab of gBrowser.tabs.filter(t => !startTabs.has(t))) {
    if (tab.isConnected && !tab.closing) {
      await BrowserTestUtils.removeTab(tab);
    }
  }
  Services.prefs.clearUserPref(FEATURE);
});

function openChildOf(opener, url) {
  const tab = BrowserTestUtils.addTab(gBrowser, url, { openerBrowser: opener.linkedBrowser });
  return BrowserTestUtils.browserLoaded(tab.linkedBrowser).then(() => tab);
}

async function makeTree() {
  const root = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?fold-root");
  const child = await openChildOf(root, "https://example.com/?fold-child");
  const leaf = await openChildOf(child, "https://example.com/?fold-leaf");
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?fold-other");
  WhimsyTreeTabs.render(window);
  return { root, child, leaf, other };
}

async function closeAll(tabs) {
  await SpecialPowers.pushPrefEnv({ set: [[FEATURE, false]] });
  for (const tab of tabs) {
    if (tab.isConnected && !tab.closing) {
      await BrowserTestUtils.removeTab(tab);
    }
  }
  await SpecialPowers.popPrefEnv();
}

add_task(async function test_disclosure_button() {
  await SpecialPowers.pushPrefEnv({ set: [[FEATURE, true], [STYLE, "tree"]] });
  const { root, child, leaf, other } = await makeTree();
  try {
    const control = root.querySelector(".whimsy-tree-toggle");
    ok(control, "A parent gets a disclosure button");
    ok(!leaf.querySelector(".whimsy-tree-toggle"), "A leaf has none");
    is(control.getAttribute("aria-expanded"), "true", "Starts expanded");
    await document.l10n.translateFragment(root);
    ok(control.getAttribute("aria-label"), "The button has an accessible name");

    if (document.documentElement.getAttribute("zen-sidebar-expanded") == "true") {
      EventUtils.synthesizeMouseAtCenter(control, {});
    } else {
      info("Sidebar collapsed: the button is hidden there, so click it directly");
      control.click();
    }
    ok(root.hasAttribute("whimsy-tree-collapsed"), "Clicking folds the branch");
    is(control.getAttribute("aria-expanded"), "false", "aria-expanded follows");
    is(gBrowser.selectedTab, other, "Clicking the button doesn't select its tab");
    ok(!child.visible && !leaf.visible, "Folded tabs aren't visible to native navigation");
    ok(!gBrowser.visibleTabs.includes(child), "The visible-tabs cache is refreshed");
    ok(!child.hasAttribute("hidden") && !child.hidden, "Zen's hidden state is untouched");

    control.click();
    ok(child.visible && leaf.visible, "Clicking again unfolds it");
  } finally {
    await closeAll([leaf, child, root, other]);
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_nested_folds_and_selection() {
  await SpecialPowers.pushPrefEnv({ set: [[FEATURE, true], [STYLE, "tree"]] });
  const { root, child, leaf, other } = await makeTree();
  try {
    WhimsyTreeTabs.toggleBranch(window, child);
    WhimsyTreeTabs.toggleBranch(window, root);
    WhimsyTreeTabs.toggleBranch(window, root);
    ok(child.visible, "Unfolding the root shows the child");
    ok(!leaf.visible, "The child's own fold survives");

    gBrowser.selectedTab = leaf;
    ok(leaf.visible, "Selecting a folded tab reveals it");
    ok(!child.hasAttribute("whimsy-tree-collapsed"), "...by unfolding its ancestors");

    WhimsyTreeTabs.toggleBranch(window, root);
    is(gBrowser.selectedTab, root, "Folding the branch holding the selected tab selects the parent");
    WhimsyTreeTabs.toggleBranch(window, root);

    WhimsyTreeTabs.toggleBranch(window, leaf);
    ok(!leaf.hasAttribute("whimsy-tree-collapsed"), "A tab without children can't fold");

    await SpecialPowers.pushPrefEnv({ set: [[STYLE, "islands"]] });
    WhimsyTreeTabs.toggleBranch(window, root);
    ok(!child.visible && !leaf.visible, "Islands folds a whole island");
    WhimsyTreeTabs.toggleBranch(window, root);
    await SpecialPowers.popPrefEnv();

    WhimsyTreeTabs.toggleBranch(window, root);
    await SpecialPowers.pushPrefEnv({ set: [[FEATURE, false]] });
    ok(child.visible && leaf.visible, "Switching the feature off shows folded tabs");
    ok(!root.querySelector(".whimsy-tree-toggle"), "...and removes the buttons");
    ok(!Object.hasOwn(child, "visible"), "...and restores the native visible getter");
    await SpecialPowers.popPrefEnv();
  } finally {
    await closeAll([leaf, child, root, other]);
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_drop_reparents() {
  await SpecialPowers.pushPrefEnv({ set: [[FEATURE, true], [STYLE, "tree"]] });
  const { root, child, leaf, other } = await makeTree();
  try {
    // What a native drop leaves behind: the child moved after `other`.
    gBrowser.moveTabTo(child, { tabIndex: other.index + 1 });
    WhimsyTreeTabs.reparentDropped(window, [child], 0);
    is(WhimsyTreeTabs.openerOf(child), null, "Dropped at the outer edge: detached into a root");
    is(WhimsyTreeTabs.openerOf(leaf), child, "Its own subtree stays with it");
    is(leaf.index, child.index + 1, "...and follows it in tab order");

    WhimsyTreeTabs.reparentDropped(window, [child], 1);
    is(WhimsyTreeTabs.openerOf(child), other, "Dropped one indent in: nested under the tab above");
    WhimsyTreeTabs.reparentDropped(window, [child], 9);
    is(WhimsyTreeTabs.depthOf(child), 1, "Deeper than the tab above allows: one level below it");

    // Dropping a parent carries its subtree; it never parents to its own child.
    WhimsyTreeTabs.reparentDropped(window, [other], 3);
    is(WhimsyTreeTabs.openerOf(other), root, "A parent nests under the tab above it");
    is(WhimsyTreeTabs.depthOf(leaf), 3, "...taking its subtree along a level deeper");
    ok(!WhimsyTreeTabs.ancestorsOf(other).includes(child), "No cycles");

    await SpecialPowers.pushPrefEnv({ set: [[STYLE, "islands"]] });
    WhimsyTreeTabs.reparentDropped(window, [leaf], 3);
    is(WhimsyTreeTabs.depthOf(leaf), 1, "Islands caps a drop at one level");
    await SpecialPowers.popPrefEnv();

    await SpecialPowers.pushPrefEnv({ set: [[FEATURE, false]] });
    const opener = child.openerTab;
    WhimsyTreeTabs.reparentDropped(window, [child], 0);
    is(child.openerTab, opener, "Feature off leaves openers alone");
    await SpecialPowers.popPrefEnv();
  } finally {
    await closeAll([leaf, child, root, other]);
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_boundaries() {
  await SpecialPowers.pushPrefEnv({ set: [[FEATURE, true], [STYLE, "tree"]] });
  const tabs = [await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?depth-root")];
  try {
    for (let i = 0; i < 6; i++) {
      tabs.push(await openChildOf(tabs.at(-1), `https://example.com/?depth-${i}`));
    }
    WhimsyTreeTabs.render(window);
    is(WhimsyTreeTabs.depthOf(tabs.at(-1)), 4, "Indentation caps at four");
    is(WhimsyTreeTabs.rootOf(tabs.at(-1)), tabs[0], "The real root still resolves");

    const space = tabs[1].getAttribute("zen-workspace-id");
    tabs[1].setAttribute("zen-workspace-id", "another-space");
    is(WhimsyTreeTabs.openerOf(tabs[1]), null, "No parent across spaces");
    tabs[1].setAttribute("zen-workspace-id", space);

    gBrowser.pinTab(tabs[0]);
    is(WhimsyTreeTabs.openerOf(tabs[1]), null, "A pinned tab is never a parent");
    gBrowser.unpinTab(tabs[0]);

    tabs[0].openerTab = tabs.at(-1);
    ok(WhimsyTreeTabs.ancestorsOf(tabs[0]).length < tabs.length, "Cyclic opener data terminates");
    tabs[0].openerTab = null;
  } finally {
    await closeAll(tabs.reverse());
    await SpecialPowers.popPrefEnv();
  }
});
