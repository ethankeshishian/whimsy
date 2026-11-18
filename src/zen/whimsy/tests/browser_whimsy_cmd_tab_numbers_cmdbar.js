/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "head_cmd_tab_numbers.js", this);

add_task(async function open_command_bar_has_one_owner_for_digit_hints() {
  try {
    for (const rowNumbers of [false, true]) {
      await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.command-bar-numbers", rowNumbers]] });
      try {
        await UrlbarTestUtils.promiseAutocompleteResultPopup({ window: win, value: "example" });
        ok(win.gURLBar.view.isOpen, "The command bar is open");
        if (rowNumbers) {
          key("KEY_Meta", { metaKey: true });
          await TestUtils.waitForCondition(() => win.gURLBar.hasAttribute("whimsy-numbers"), "Command bar owns the digit shortcuts");
          ok(!showing(), "No competing tab destinations are advertised");
          await TestUtils.waitForCondition(() => win.getComputedStyle(Numbers.layer(win)).opacity == "0", "Sidebar hints are faded out");
        } else {
          await hold();
          await TestUtils.waitForCondition(() => win.getComputedStyle(Numbers.layer(win)).opacity == "1", "Tab hints show with the command bar open when it does not own digits");
          await TestUtils.waitForCondition(() => [...Numbers.layer(win).children].some(node =>
            !node.hidden && /[1-9]/.test(node.textContent) && node.getBoundingClientRect().height >= 14),
          "Open command bar leaves visible sidebar digits");
          ok(!win.gURLBar.hasAttribute("whimsy-numbers"), "There is only one set of destinations");
        }
      } finally {
        release();
        win.gURLBar.view.close();
        await SpecialPowers.popPrefEnv();
      }
    }
  } finally {
    release();
    win.gURLBar.view.close();
  }
});

// Owner regression: a command-bar shortcut must not poison the next hold.
add_task(async function command_bar_digit_then_sidebar() {
  const { WhimsyCommandBarAI: Bar } = ChromeUtils.importESModule(
    "resource:///modules/whimsy/WhimsyCommandBarAI.sys.mjs");
  const { UrlbarResult } = ChromeUtils.importESModule("chrome://browser/content/urlbar/UrlbarResult.mjs");
  const { UrlbarShared } = ChromeUtils.importESModule("chrome://browser/content/urlbar/UrlbarShared.mjs");
  const provider = new UrlbarTestUtils.TestProvider({
    priority: 100,
    results: [1, 2].map(i => new UrlbarResult({
      type: UrlbarShared.RESULT_TYPE.URL,
      source: UrlbarShared.RESULT_SOURCE.HISTORY,
      payload: { url: `https://example.com/cmdbadge-${i}`, title: `Command badge ${i}` },
    })),
  });
  const { ProvidersManager } = ChromeUtils.importESModule("moz-src:///browser/components/urlbar/UrlbarProvidersManager.sys.mjs");
  const manager = ProvidersManager.getInstanceForSap("urlbar");
  manager.registerProvider(provider);
  try {
    await UrlbarTestUtils.promiseAutocompleteResultPopup({ window: win, value: "cmdbadge" });
    await TestUtils.waitForCondition(() => Bar.numberedRows(win).length >= 2, "The fixture supplies two destinations");
    key("KEY_Meta", { metaKey: true });
    await TestUtils.waitForCondition(() => win.gURLBar.hasAttribute("whimsy-numbers"), "Bar owns hold");
    info(`Before Command-2: bar=${win.gURLBar.view.isOpen}, tabs=${showing()}, rows=${Bar.numberedRows(win).length}`);
    ok(Bar.numberedRows(win).length >= 2, "Command-2 has a destination");
    // Use a real pick without navigating a network fixture.
    const expectedRow = Bar.numberedRows(win)[1];
    const pick = sinon.stub(win.gURLBar, "pickElement").callsFake(() => win.gURLBar.view.close());
    try {
      key("2", { code: "Digit2", metaKey: true });
      ok(pick.calledOnce, "The bar picked its second row");
      is(pick.firstCall.args[0], expectedRow.querySelector(".urlbarView-row-inner") ?? expectedRow,
        "Command-2 picks the second result");
    } finally {
      pick.restore();
    }
    // macOS may omit the digit keyup when the bar closes.
    release();
    win.gBrowser.selectedTab.focus();
    info(`After Command-2/release: bar=${win.gURLBar.view.isOpen}, tabs=${showing()}`);
    await hold();
    info(`Next sidebar hold: tabs=${showing()}`);
    release();
    await assertShortcutTargets();
  } finally {
    release();
    win.gURLBar.view.close();
    manager.unregisterProvider(provider);
  }
});

// ZenUrlbarController.handleNewTab binds the new-tab command to a floating
// command bar, and a second Command-T closes that session. Exercise the native
// key path, including keyups delivered to the newly focused bar. Do not call
// doCommand(), open the popup through a test helper, or pick a result here.
async function summonThenClose(closePath) {
  const testing = win.gZenUIManager.testingEnabled;
  await SpecialPowers.pushPrefEnv({ set: [
    ["zen.urlbar.replace-newtab", true],
    ["ui.prefersReducedMotion", 0],
  ] });
  const synth = (keyName, options = {}) => EventUtils.synthesizeKey(keyName, options, win);
  function commandT(lostLetterKeyup) {
    synth("KEY_Meta", { type: "keydown" });
    synth("t", { type: "keydown", metaKey: true });
    logChord("Command-T keydown");
    if (!lostLetterKeyup) {
      synth("t", { type: "keyup", metaKey: true });
    }
    synth("KEY_Meta", { type: "keyup" });
    const state = logChord(`Command-T release (lost letter keyup=${lostLetterKeyup})`);
    ok(!state.meta && !state.keys.length && !state.timer, "Meta release clears the entire summon chord");
  }
  try {
    // Zen's testing flag intentionally bypasses the product Command-T path.
    // Disable only that bypass; keep the real command and focus handlers.
    win.gZenUIManager.testingEnabled = false;
    await SimpleTest.promiseFocus(win);
    await TestUtils.waitForCondition(() => !win.matchMedia("(prefers-reduced-motion: reduce)").matches,
      "Sidebar fade is enabled");
    for (const lostLetterKeyup of [false, true]) {
      win.gURLBar.view.close();
      synth("KEY_Meta", { type: "keyup" });
      win.gBrowser.selectedTab.focus();
      const tabsBefore = [...win.gBrowser.tabs];
      const selectedBefore = win.gBrowser.selectedTab;
      logChord(`Before summon / ${closePath}`);
      commandT(lostLetterKeyup);
      await TestUtils.waitForCondition(() => win.gURLBar.view.isOpen && win.gURLBar.hasAttribute("zen-newtab"),
        "The real Command-T summoned the command bar");
      logChord(`Before immediate close / ${closePath}`);
      if (closePath == "escape") {
        synth("KEY_Escape");
      } else if (closePath == "outside") {
        const target = win.gBrowser.selectedTab;
        ok(target.checkVisibility({ visibilityProperty: true }), "The outside click target is visible");
        EventUtils.synthesizeMouseAtCenter(target, {}, win);
      } else {
        commandT(lostLetterKeyup);
      }
      await TestUtils.waitForCondition(() => !win.gURLBar.view.isOpen && !win.gURLBar.hasAttribute("zen-newtab"),
        `${closePath} closed the summoned bar without picking a row`);
      Assert.deepEqual([...win.gBrowser.tabs], tabsBefore, "Summon and close created no tab");
      is(win.gBrowser.selectedTab, selectedBefore, "No result or tab was picked");
      const state = logChord(`After close / ${closePath}`);
      ok(!state.meta && !state.keys.length && !state.timer, "Closing leaves no stale chord or pending timer");

      win.gBrowser.selectedTab.focus();
      if (Numbers.layer(win)) {
        await TestUtils.waitForCondition(() => win.getComputedStyle(Numbers.layer(win)).opacity == "0",
          "Sidebar starts transparent");
      }
      const revealed = BrowserTestUtils.waitForMutationCondition(root,
        { attributes: true, attributeFilter: ["whimsy-tab-numbers"] }, showing);
      synth("KEY_Meta", { type: "keydown" });
      logChord(`Sidebar hold pending / ${closePath}`);
      await revealed;
      await assertBadgeFade(Numbers.layer(win), true, false);
      ok([...Numbers.layer(win).children].some(node => !node.hidden && node.getBoundingClientRect().height > 0),
        "The fading sidebar layer contains a visible badge");
      logChord(`Sidebar hold revealed / ${closePath}`);
      synth("KEY_Meta", { type: "keyup" });
      await assertBadgeFade(Numbers.layer(win), false, false);

      const targets = [...Numbers.tabsForShortcut(win)].slice(0, 3);
      is(targets.length, 3, "Three real shortcut targets exist");
      for (const [index, target] of targets.entries()) {
        // Start elsewhere so every shortcut must actually switch a tab.
        win.gBrowser.selectedTab = targets[(index + 1) % targets.length];
        win.gBrowser.selectedTab.focus();
        synth("KEY_Meta", { type: "keydown" });
        synth(String(index + 1), { metaKey: true });
        synth("KEY_Meta", { type: "keyup" });
        await TestUtils.waitForCondition(() => win.gBrowser.selectedTab == target,
          `Real Command-${index + 1} switches tabs after ${closePath}`);
      }
      logChord(`After sidebar shortcuts / ${closePath}`);
    }
  } finally {
    synth("KEY_Meta", { type: "keyup" });
    win.gURLBar.view.close();
    win.gZenUIManager.testingEnabled = testing;
    await SpecialPowers.popPrefEnv();
  }
}

add_task(async function real_summon_escape_then_sidebar() {
  await summonThenClose("escape");
});

add_task(async function real_summon_outside_click_then_sidebar() {
  await summonThenClose("outside");
});

add_task(async function real_summon_shortcut_toggle_then_sidebar() {
  await summonThenClose("shortcut");
});

function rectangles(nodes) {
  return nodes.map(node => {
    const r = node.getBoundingClientRect();
    return [r.x, r.y, r.width, r.height];
  });
}

async function assertBadgeFade(node, visible, reduced) {
  const style = win.getComputedStyle(node);
  const animations = node.getAnimations();
  if (reduced) {
    is(style.transitionDuration, "0s", "Reduced motion is instant");
    is(animations.length, 0, "Reduced motion starts no transition");
  } else {
    is(style.transitionDuration, visible ? "0.12s" : "0.09s", "Enter and exit use the shared durations");
    is(style.transitionTimingFunction, visible ? "ease-out" : "ease-in", "Shared easing");
    const fade = animations.find(a => a.transitionProperty == "opacity");
    ok(fade, `${visible ? "Enter" : "Exit"} actually starts an opacity transition`);
    if (fade) {
      fade.pause();
      await fade.ready;
      fade.currentTime = 0;
      const startOpacity = Number(win.getComputedStyle(node).opacity);
      fade.currentTime = fade.effect.getTiming().duration / 2;
      const opacity = Number(win.getComputedStyle(node).opacity);
      ok(opacity > 0 && opacity < 1, "The badge is partially painted midway through the transition");
      ok(visible ? opacity > startOpacity : opacity < startOpacity,
        `Sampled opacity ${visible ? "rises on entry" : "falls on exit"}: ${startOpacity} → ${opacity}`);
      fade.finish();
      await fade.finished;
    }
  }
  is(win.getComputedStyle(node).opacity, visible ? "1" : "0", "The fade reaches its endpoint");
}

add_task(async function shared_badges_have_motion_colours_and_no_layout_shift() {
  const { WhimsyCommandBarAI: Bar } = ChromeUtils.importESModule(
    "resource:///modules/whimsy/WhimsyCommandBarAI.sys.mjs");
  const appearance = node => {
    const s = win.getComputedStyle(node);
    return [s.color, s.backgroundColor, s.borderRadius, s.fontFamily, s.fontSize,
      s.fontWeight, s.fontVariantNumeric, s.height, s.minWidth, s.width, s.padding];
  };
  for (const dark of [false, true]) {
    await whimsySetScheme(dark);
    try {
      await TestUtils.waitForCondition(() => win.matchMedia(`(prefers-color-scheme: ${dark ? "dark" : "light"})`).matches,
        "The test window has the requested scheme");
      for (const reduced of [false, true]) {
        await SpecialPowers.pushPrefEnv({ set: [["ui.prefersReducedMotion", reduced ? 1 : 0]] });
        try {
          await TestUtils.waitForCondition(() => win.matchMedia("(prefers-reduced-motion: reduce)").matches == reduced,
            "Motion preference applied");
          win.gURLBar.view.close();
          const tabs = [...win.gBrowser.visibleTabs].flatMap(tab =>
            [tab, ...tab.querySelectorAll(".tab-label, .tab-icon-image, .tab-content")]);
          const tabRects = rectangles(tabs);
          await hold();
          Assert.deepEqual(rectangles(tabs), tabRects, "Every sidebar tab, title, and icon keeps its rectangle");
          await assertBadgeFade(Numbers.layer(win), true, reduced);
          const tabBadge = [...Numbers.layer(win).children].find(n => !n.hidden);
          ok(tabBadge, "A sidebar badge is visible");
          const tabStyle = appearance(tabBadge);
          isnot(tabStyle[0], "rgb(0, 0, 0)", "Badge ink is not hard black");
          isnot(tabStyle[1], "rgb(0, 0, 0)", "Badge fill is not hard black");
          if (!reduced) {
            await whimsyShot(`w29-cmdbadge-tabs-${dark ? "dark" : "light"}`, win.browsingContext.currentWindowGlobal);
          }
          release();
          await assertBadgeFade(Numbers.layer(win), false, reduced);
          ok(tabBadge.isConnected, "Exit retains the badge node");

          await UrlbarTestUtils.promiseAutocompleteResultPopup({ window: win, value: "example" });
          // Compare resting geometry, after the bar's own scale/lift entrance.
          // Keep badge motion enabled: it is what this task samples below.
          await TestUtils.waitForCondition(() => win.gURLBar.getAnimations({ subtree: true })
            .every(a => a.playState != "running" || a.effect.getComputedTiming().iterations == Infinity),
          "The command bar entrance has finished");
          const rows = Bar.numberedRows(win);
          const contents = [...win.gURLBar.view.panel.querySelectorAll(".urlbarView-row")].flatMap(row =>
            [row, ...row.querySelectorAll("*:not(.whimsy-number-badge)")]);
          const rowRects = rectangles(contents);
          // Trigger the production hold deadline without polling past its 120ms fade.
          const revealed = BrowserTestUtils.waitForMutationCondition(win.gURLBar,
            { attributes: true, attributeFilter: ["whimsy-numbers"] },
            () => win.gURLBar.hasAttribute("whimsy-numbers"));
          key("KEY_Meta", { metaKey: true });
          await revealed;
          Assert.deepEqual(rectangles(contents), rowRects, "Every command row, text, and icon keeps its rectangle");
          const barBadge = rows[0].querySelector(".whimsy-number-badge");
          Assert.deepEqual(appearance(barBadge), tabStyle, "Both surfaces have identical badge colours, shape, and type");
          await assertBadgeFade(barBadge, true, reduced);
          Assert.deepEqual(rectangles(contents), rowRects, "Finished entry keeps every row rectangle");
          // Selection's on-accent descendant rule must not override the
          // keycap's own ink/fill pair (the light selected-row regression).
          const selected = rows[0].hasAttribute("selected");
          for (const value of [false, true]) {
            rows[0].toggleAttribute("selected", value);
            Assert.deepEqual(appearance(barBadge), tabStyle, "Normal and selected keycaps match the sidebar");
            is(win.InspectorUtils.colorToRGBA(win.getComputedStyle(barBadge).backgroundColor).a, 1,
              "Every keycap fill is opaque");
          }
          rows[0].toggleAttribute("selected", selected);
          if (!reduced) {
            await whimsyShot(`w29-cmdbadge-bar-${dark ? "dark" : "light"}`, win.browsingContext.currentWindowGlobal);
          }
          release();
          await assertBadgeFade(barBadge, false, reduced);
          Assert.deepEqual(rectangles(contents), rowRects, "Exit keeps every command row rectangle");
          ok(barBadge.isConnected, "The command-bar exit retains its node");
          win.gURLBar.view.close();
        } finally {
          release();
          win.gURLBar.view.close();
          await SpecialPowers.popPrefEnv();
        }
      }
    } finally {
      await SpecialPowers.popPrefEnv();
    }
  }
});

