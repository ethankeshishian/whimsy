/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "head_side_panel.js", this);

// Temporary Expand, shrink-back, Minimize, and focus-based close routing.

// A selected Essential is not necessarily the result of Expand. Keep Zen's
// close/reset route for ordinary selection while side panels are enabled.
addPanelTask(async function normally_selected_pinned_tabs_keep_close_routing() {
  await SpecialPowers.pushPrefEnv({ set: [
    ["zen.pinned-tab-manager.close-shortcut-behavior", "reset-unload-switch"],
  ] });
  try {
    for (const kind of ["essential", "pinned"]) {
      const tab = kind == "essential"
        ? await makeEssential("https://example.org/?normal-essential-close")
        : await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.org/?normal-pinned-close");
      if (kind == "pinned") {
        gBrowser.pinTab(tab);
      }
      await TestUtils.waitForCondition(() => tab._zenPinnedInitialState?.entry?.url,
        `${kind}: canonical pinned page recorded`);
      gBrowser.selectedTab = tab;
      await SimpleTest.promiseFocus(window);
      tab.linkedBrowser.focus();
      await TestUtils.waitForCondition(() => document.activeElement == tab.linkedBrowser,
        `${kind}: page has close-key focus`);
      ok(!sp().expanded, `${kind}: ordinary selection has no temporary Expand state`);
      ok(!sp().closeFocused(), `${kind}: side panel does not intercept close`);
      is(gBrowser.selectedTab, tab, `${kind}: checking the close route does not switch tabs`);
      ok(!sp().tab && !sp().shrinking, `${kind}: checking the close route does not shrink`);
      EventUtils.synthesizeKey("w", { accelKey: true });
      await TestUtils.waitForCondition(() => !tab.selected, `${kind}: Zen handles the close key`);
      ok(tab.isConnected, `${kind}: Zen keeps the pinned tile`);
      ok(!sp().tab && !sp().shrinking, `${kind}: normal close never creates a popover`);
      gBrowser.selectedTab = home;
    }
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});

addPanelTask(async function minimize_keeps_state_and_expand_is_only_once() {
  const ess = await makeEssential("https://example.org/?expand");
  const loaded = BrowserTestUtils.browserLoaded(ess.linkedBrowser);
  await clickTile(ess, true);
  await loaded;
  await SpecialPowers.spawn(ess.linkedBrowser, [], () => { content.wrappedJSObject.kept = 42; });
  await drag(ess, 35, -60, "se");
  await moveHeader(ess, 120, 0);
  const before = sp().geometry(ess);
  EventUtils.synthesizeMouseAtCenter(box(ess).querySelector(".whimsy-side-panel-hide"), {});
  await hidden(ess, "Minimized");
  ok(ess.undiscardable && !ess.hasAttribute("pending"), "Minimize does not unload");
  await clickTile(ess, true);
  Assert.deepEqual(sp().geometry(ess), before, "Same size on next tile click");
  is(await SpecialPowers.spawn(ess.linkedBrowser, [], () => content.wrappedJSObject.kept), 42, "Same page state");
  const desktop = BrowserTestUtils.browserLoaded(ess.linkedBrowser);
  EventUtils.synthesizeMouseAtCenter(box(ess).querySelector(".whimsy-side-panel-expand"), {});
  await TestUtils.waitForCondition(() => ess.selected && !box(ess).hasAttribute("whimsy-popover"), "Expanded into the page");
  await desktop;
  ok(!ess.hasAttribute(WhimsySidePanel.OFF_ATTR), "Expand preserves popover-by-default");
  ok(!ess.linkedBrowser._whimsySidePanelUA, "Phone override cleared");
  ok(!(await SpecialPowers.spawn(ess.linkedBrowser, [], () => content.navigator.userAgent)).includes("iPhone"), "Desktop UA");
  gBrowser.selectedTab = home;
  await clickTile(ess, true);
  const expanded = BrowserTestUtils.waitForEvent(gBrowser.tabContainer, "TabSelect");
  EventUtils.synthesizeMouseAtCenter(box(ess).querySelector(".whimsy-side-panel-host"), { clickCount: 2 });
  await expanded;
  is(gBrowser.selectedTab, ess, "Header double-click also expands");
  gBrowser.selectedTab = home;
});

// Keep the failing route visible in the test log, including before a fix:
// selected tiles used to return null, and expanded close had no floating tab.
function pipbackState(label, tab) {
  const tile = sp().tileFor({ target: tab, button: 0, getModifierState: () => false });
  info(`pipback ${label}: ${JSON.stringify({ selected: tab.selected,
    actualSelected: gBrowser.selectedTab == tab, tileFor: tile?.id ?? null,
    off: tab.hasAttribute(WhimsySidePanel.OFF_ATTR),
    phone: !!tab.linkedBrowser._whimsySidePanelUA, floating: shown(tab),
    expanded: sp().expanded?.tab == tab,
  })}`);
}

for (const headerDoubleClick of [false, true]) {
  for (const route of ["tile", "menu", "close", "tab", "space", "minimize"]) {
    addPanelTask(async function expanded_essential_returns_to_popover() {
      info(`pipback Expand=${headerDoubleClick ? "header double-click" : "button"}; route=${route}`);
      const methods = ["onMouseDown", "onClick", "toggle", "show", "hide", "setOn", "shrink", "closeFocused"];
      const original = new Map(methods.filter(name => typeof sp()[name] == "function")
        .map(name => [name, sp()[name]]));
      for (const [name, run] of original) {
        sp()[name] = function (...args) {
          info(`pipback code path: ${name}`);
          return run.apply(this, args);
        };
      }
      try {
        const ess = await makeEssential("https://example.org/?pipback");
        await clickTile(ess, true);
        const geometry = sp().geometry(ess);
        const count = gBrowser.tabs.length;
        EventUtils.synthesizeMouseAtCenter(box(ess).querySelector(headerDoubleClick ?
          ".whimsy-side-panel-host" : ".whimsy-side-panel-expand"),
          headerDoubleClick ? { clickCount: 2 } : {});
        await TestUtils.waitForCondition(() => ess.selected && !shown(ess), "Expanded");
        pipbackState("before " + route, ess);
        if (route == "tile") {
          await clickTile(ess, true);
        } else if (route == "menu") {
          const menu = await openTabMenu(ess);
          const item = document.getElementById("context_whimsySidePanel");
          is(item.getAttribute("checked"), "true", "Expanded remains popover-by-default");
          const closed = BrowserTestUtils.waitForEvent(menu, "popuphidden");
          menu.activateItem(item);
          await closed;
          await TestUtils.waitForCondition(() => shown(ess), "Menu shrinks the expanded Essential");
        } else if (route == "close") {
          ess.linkedBrowser.focus();
          EventUtils.synthesizeKey("w", { accelKey: true });
          await TestUtils.waitForCondition(() => gBrowser.selectedTab == home && !sp().tab,
            "Close returns to the page with the Essential tucked away");
          ok(ess.isConnected && !ess.closing, "Essential survives Close");
          is(gBrowser.tabs.length, count, "Close removes no tab");
          await clickTile(ess, true);
        } else {
          if (route == "space") {
            window.dispatchEvent(new CustomEvent("ZenWorkspaceChanged"));
          }
          if (route != "minimize") {
            gBrowser.selectedTab = home;
          }
          await clickTile(ess, true);
          if (route == "minimize") {
            EventUtils.synthesizeMouseAtCenter(box(ess).querySelector(".whimsy-side-panel-hide"), {});
            await hidden(ess, "Minimize after shrinking tucks into tile");
            await clickTile(ess, true);
          }
        }
        await settle(ess);
        pipbackState("after " + route, ess);
        is(gBrowser.selectedTab, home, "Previous page restored");
        ok(shown(ess) && !ess.selected, "Essential floats again");
        ok(!ess.hasAttribute(WhimsySidePanel.OFF_ATTR), "Routing preference stays on");
        ok(ess.linkedBrowser._whimsySidePanelUA, "Phone UA restored");
        Assert.deepEqual(sp().geometry(ess), geometry, "Saved geometry restored");
      } finally {
        for (const [name, run] of original) {
          sp()[name] = run;
        }
      }
    });
  }
}

addPanelTask(async function shrink_fallback_reduced_motion_and_interruption() {
  const ess = await makeEssential("https://example.org/?shrink-fallback");
  const page = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?previous-page");
  await clickTile(ess, true);
  await sp().expand();
  is(sp().expanded.page, page, "Expand remembers the actual underlying page");
  await BrowserTestUtils.removeTab(page);
  await SpecialPowers.pushPrefEnv({ set: [["ui.prefersReducedMotion", 1]] });
  try {
    const shrinking = sp().shrink(ess);
    const animation = sp().shrinking.animation;
    Assert.deepEqual(animation.effect.getKeyframes().map(frame => frame.opacity), ["0", "1"],
      "Reduced motion crossfades without growing or moving");
    await shrinking;
    is(gBrowser.selectedTab, home, "Missing previous page falls back to the recent page in this space");
    ok(shown(ess), "Fallback still floats the Essential");
    await sp().expand();
    const interrupted = sp().shrink(ess, { minimize: true });
    sp().hide({ animate: false });
    sp().show(ess);
    await interrupted;
    ok(shown(ess), "Cancelled shrink cannot minimize a reopened popover");
    ok(!sp().shrinking, "No stale shrink state");
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});

addPanelTask(async function expanded_shrink_motion_and_off_essential() {
  const ess = await makeEssential("https://example.org/?shrink-motion");
  await clickTile(ess, true);
  await sp().expand();
  await SpecialPowers.pushPrefEnv({ set: [["ui.prefersReducedMotion", 0]] });
  try {
    EventUtils.synthesizeMouseAtCenter(ess, {});
    await TestUtils.waitForCondition(() => shown(ess) && sp().shrinking, "Shrink animation running");
    const animation = sp().shrinking.animation;
    animation.pause();
    animation.currentTime = 140;
    is(animation.effect.getTiming().duration, 280, "Reverse Expand lasts 280ms");
    await whimsyShot("w29-pipback-shrink");
    animation.finish();
    await settle(ess);
  } finally {
    await SpecialPowers.popPrefEnv();
  }
  sp().setOn(ess, false);
  EventUtils.synthesizeMouseAtCenter(ess, {});
  await TestUtils.waitForCondition(() => ess.selected, "OFF Essential selects normally");
  pipbackState("OFF selected tile", ess);
  EventUtils.synthesizeMouseAtCenter(ess, {});
  ok(!sp().tab && ess.selected, "OFF selected tile stays a normal page");
  ok(!ess.linkedBrowser._whimsySidePanelUA, "OFF keeps desktop UA");
  gBrowser.selectedTab = home;
  EventUtils.synthesizeMouseAtCenter(ess, {});
  await TestUtils.waitForCondition(() => ess.selected, "OFF still selects after leaving");
});

addPanelTask(async function close_tab_follows_focus() {
  const ess = await makeEssential("https://example.org/?focus");
  await clickTile(ess, true);
  let count = gBrowser.tabs.length;
  ess.linkedBrowser.focus();
  EventUtils.synthesizeKey("w", { accelKey: true });
  await hidden(ess, "Close with browser focus minimizes");
  is(gBrowser.tabs.length, count, "No tab closed");
  await clickTile(ess, true);
  box(ess).querySelector(".whimsy-side-panel-expand").focus();
  EventUtils.synthesizeKey("w", { accelKey: true });
  await hidden(ess, "Close with header focus minimizes");
  is(gBrowser.tabs.length, count, "No tab closed from header");
  const page = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?close-me");
  await clickTile(ess, true);
  page.linkedBrowser.focus();
  const closed = BrowserTestUtils.waitForEvent(page, "TabClose");
  EventUtils.synthesizeKey("w", { accelKey: true });
  await closed;
  ok(shown(ess), "Closing the focused page leaves PiP open");
  sp().hide({ animate: false });
  gBrowser.selectedTab = home;
});

