/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "head_cmd_tab_numbers.js", this);

add_task(async function other_spaces_have_no_badges() {
  const other = await win.gZenWorkspaces.createAndSaveWorkspace("Tab numbers test", undefined, true);
  try {
    await win.gZenWorkspaces.changeWorkspaceWithID(other.uuid);
    const foreign = [];
    for (let i = 0; i < 2; i++) {
      foreign.push(await BrowserTestUtils.openNewForegroundTab(win.gBrowser, "about:blank"));
    }
    await assertShortcutTargets(); // Also checks Firefox's short-list clamp.
    for (let i = 0; i < 9; i++) {
      foreign.push(await BrowserTestUtils.openNewForegroundTab(win.gBrowser, "about:blank"));
    }
    await assertShortcutTargets();
    await win.gZenWorkspaces.changeWorkspaceWithID(originalSpace);
    await hold();
    for (const tab of foreign) {
      ok(!Numbers.targets(win).has(tab), "Other-space tabs are unreachable");
      ok(!badge(tab), "No stale badge on an unreachable tab");
    }
    release();
    await assertShortcutTargets();
    // Hold Command through a space switch, then release in the new space:
    // the hints follow the current space and no space keeps any.
    const faded = () => win.getComputedStyle(Numbers.layer(win)).opacity == "0";
    await hold();
    await win.gZenWorkspaces.changeWorkspaceWithID(other.uuid);
    await settled("Switched space while holding Command");
    if (showing()) {
      await TestUtils.waitForCondition(() => foreign.some(tab => badge(tab)), "Hints follow the new space");
      for (const tab of startTabs) {
        ok(!badge(tab) || win.gBrowser.visibleTabs.includes(tab), "No hint stays on the previous space's tabs");
      }
    }
    release();
    await TestUtils.waitForCondition(faded, "Releasing after a space switch fades every hint");
    await win.gZenWorkspaces.changeWorkspaceWithID(originalSpace);
    await settled("Back on the original space");
    ok(faded() && !showing(), "No hint is left in the original space either");
  } finally {
    release();
    await win.gZenWorkspaces.changeWorkspaceWithID(originalSpace);
    await win.gZenWorkspaces.removeWorkspace(other.uuid);
  }
});

add_task(async function private_space_excludes_essentials() {
  // The previous task's space removal and switch back must be over, or its
  // queued switch lands after the Private Space opens.
  await settled("The previous space switch finished");
  win.document.getElementById("cmd_whimsyNewScratch").doCommand();
  await TestUtils.waitForCondition(() => WhimsyPrivate.activeSpaceIsScratch(win), "Private Space active");
  // Tabs opened mid-slide are overridden by the slide's own selection.
  await settled("The switch to the Private Space finished");
  // This window is synced with the suite's main window, which lists the
  // Private Space too without showing it: it must not close it as left empty.
  await new Promise(resolve => win.setTimeout(resolve, 300)); // eslint-disable-line mozilla/no-arbitrary-setTimeout
  await settled("No space switch follows the Private Space opening");
  ok(WhimsyPrivate.activeSpaceIsScratch(win), "The empty Private Space stays open");
  const scratchId = WhimsyPrivate.getScratch(win)?.uuid;
  ok(scratchId, "The Private Space exists");
  const tabs = [];
  try {
    for (let i = 0; i < 10; i++) {
      tabs.push(WhimsyPrivate.openPrivateTab(win, { url: "about:blank" }));
    }
    await TestUtils.waitForCondition(() =>
      tabs.every(tab => tab?.getAttribute("zen-workspace-id") == scratchId) &&
      win.gBrowser.selectedTab == tabs.at(-1),
    "Every private tab is in the Private Space, the last one selected");
    await settled("No space switch follows the private tabs");
    ok(WhimsyPrivate.activeSpaceIsScratch(win), "Still on the Private Space");
    await hold();
    for (const tab of Numbers.targets(win).keys()) {
      ok(!tab.hasAttribute("zen-essential") && !tab.hasAttribute("zen-empty-tab"), "Only Private Space tabs are badged");
    }
    release();
    await assertShortcutTargets();
  } finally {
    release();
    for (const tab of tabs) {
      if (tab?.isConnected && !tab.closing) {
        await BrowserTestUtils.removeTab(tab, { animate: false });
      }
    }
    await WhimsyPrivate.closeScratch(win);
    await settled("Back from the Private Space");
    if (win.gZenWorkspaces.activeWorkspace != originalSpace) {
      await win.gZenWorkspaces.changeWorkspaceWithID(originalSpace);
      await settled("Back on the original space");
    }
  }
});

add_task(async function expanded_and_compact_screenshots() {
  const expanded = root.getAttribute("zen-sidebar-expanded");
  const compact = win.gZenCompactModeManager.preference;
  try {
    for (const state of ["expanded", "compact"]) {
      win.gZenCompactModeManager.preference = state == "compact";
      root.setAttribute("zen-sidebar-expanded", state == "expanded" ? "true" : "false");
      for (const dark of [false, true]) {
        await whimsySetScheme(dark);
        try {
          await TestUtils.waitForCondition(() =>
            win.matchMedia(`(prefers-color-scheme: ${dark ? "dark" : "light"})`).matches,
          "The hints window has the requested color scheme");
          const flags = ["zen-has-hover", "has-popup-menu", "flash-popup", "zen-user-show"];
          const before = flags.map(attr => win.gNavToolbox.hasAttribute(attr));
          await hold();
          Assert.deepEqual(flags.map(attr => win.gNavToolbox.hasAttribute(attr)), before, "Hints never force compact mode open");
          await TestUtils.waitForCondition(() => win.getComputedStyle(Numbers.layer(win)).opacity == "1", "The hints finished fading in");
          const nodes = Numbers.layer(win).querySelectorAll(".whimsy-number-badge");
          ok(nodes.length > 0, "Tab keycaps exist in this sidebar mode");
          for (const node of nodes) {
            const style = win.getComputedStyle(node);
            is(style.borderRadius, "4px", "Tab numbers use the command keycap shape");
          }
          await whimsySettled(win.document);
          await whimsyShot(`w24-cmdhints-${state}-${dark ? "dark" : "light"}`, win.browsingContext.currentWindowGlobal);
        } finally {
          release();
          await SpecialPowers.popPrefEnv();
        }
      }
    }
  } finally {
    release();
    win.gZenCompactModeManager.preference = compact;
    if (expanded == null) {
      root.removeAttribute("zen-sidebar-expanded");
    } else {
      root.setAttribute("zen-sidebar-expanded", expanded);
    }
  }
});

add_task(async function tab_hints_remain_readable_on_custom_sidebar_colours() {
  const previous = root.style.getPropertyValue("--toolbox-textcolor");
  try {
    for (const color of ["rgb(22, 22, 26)", "rgb(240, 240, 244)"]) {
      root.style.setProperty("--toolbox-textcolor", color);
      await hold();
      await TestUtils.waitForCondition(() => win.getComputedStyle(Numbers.layer(win)).opacity == "1", "Hints faded in");
      for (const node of Numbers.layer(win).querySelectorAll(".whimsy-number-badge")) {
        const style = win.getComputedStyle(node);
        isnot(style.backgroundColor, "rgb(0, 0, 0)", "Custom sidebar colours keep a quiet keycap fill");
        const luminance = value => {
          const { r, g, b } = win.InspectorUtils.colorToRGBA(value);
          const linear = v => (v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
          return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
        };
        const fg = luminance(style.color), bg = luminance(style.backgroundColor);
        ok((Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05) >= 4.5, "Sidebar number contrast meets AA");
      }
      release();
    }
  } finally {
    release();
    if (previous) {
      root.style.setProperty("--toolbox-textcolor", previous);
    } else {
      root.style.removeProperty("--toolbox-textcolor");
    }
  }
});

add_task(async function nothing_keeps_animating() {
  // Every space switch, hint fade, and Private Space slide above has an end.
  const running = () => win.document.getAnimations().filter(a => a.playState == "running" &&
    (a.effect?.getComputedTiming().endTime ?? 0) == Infinity || a.playState == "running");
  const describe = a => {
    const t = a.effect?.target;
    const el = t?.element ?? t;
    return `${a.animationName || a.transitionProperty || a.id || a.constructor.name} on ` +
      `${el?.localName}#${el?.id || ""}.${[...(el?.classList ?? [])].join(".")}${t?.pseudoElement ?? ""} ` +
      `(iterations=${a.effect?.getComputedTiming().iterations})`;
  };
  await TestUtils.waitForCondition(() => !running().length, "Animations settle", 100, 50).catch(() => {});
  const left = running();
  info(`Still running: ${left.map(describe).join(" | ") || "none"}`);
  is(left.length, 0, `No animation is left running: ${left.map(describe).join(" | ")}`);
});
