/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */
"use strict";

const { WhimsySpaceExtensions } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySpaceExtensions.sys.mjs");
const { ZenUrlbarProviderGlobalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBActionsProvider.sys.mjs");
const { WhimsyFocusNotch } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyFocusNotch.sys.mjs");

add_task(async function extensions_follow_toolbar_visibility() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.space-extensions", true]] });
  const extension = ExtensionTestUtils.loadExtension({
    useAddonManager: "temporary",
    manifest: { name: "W29 Visibility Regression", browser_action: { default_title: "W29 Visibility Regression" } },
  });
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  try {
    await extension.startup();
    const widgetId = WhimsySpaceExtensions.widgetIdFor(extension.id);
    await gUnifiedExtensions.pinToToolbar(widgetId, true);
    const node = CustomizableUI.getWidget(widgetId).forWindow(window).node;
    const actions = async () => {
      const rows = [];
      const text = "w29 visibility regression";
      await new ZenUrlbarProviderGlobalActions().startQuery(
        { trimmedLowerCaseSearchString: text, searchString: text, searchMode: null },
        (_, row) => rows.push(row)
      );
      return rows.some(row => row.commandId == `zen:extension-${extension.id}`);
    };
    for (const keys of [null, [], [WhimsySpaceExtensions.activeKey(window)], []]) {
      WhimsySpaceExtensions.setAllowedProfiles(extension.id, keys);
      is(await actions(), !node.hidden, "Command actions agree with the toolbar after each visibility change");
    }
    await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.space-extensions", false]] });
    WhimsySpaceExtensions.applyVisibility(window);
    ok(!node.hidden, "Feature off restores toolbar visibility");
    ok(await actions(), "Feature off restores command action");
    await SpecialPowers.popPrefEnv();
  } finally {
    WhimsySpaceExtensions.setAllowedProfiles(extension.id, null);
    await extension.unload();
    BrowserTestUtils.removeTab(tab);
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function timer_rounding_and_mirrored_motion() {
  const session = { endsAt: Date.now() + 60000, totalMs: 60000 };
  for (const reduced of [0, 1]) {
    await SpecialPowers.pushPrefEnv({ set: [["ui.prefersReducedMotion", reduced]] });
    let notch;
    try {
      notch = WhimsyFocusNotch.attach(window, session);
      const style = getComputedStyle(notch);
      const radii = [style.borderTopLeftRadius, style.borderTopRightRadius,
        style.borderBottomLeftRadius, style.borderBottomRightRadius];
      ok(parseFloat(radii[0]) > 0, "Timer corners have a radius");
      ok(radii.every(radius => radius == radii[0]), "All four timer corners share a radius");
      const incoming = notch.getAnimations().filter(a => a.transitionProperty == "translate");
      is(incoming.length, reduced ? 0 : 1, "Entrance motion follows reduced-motion preference");
      if (!reduced && incoming.length) {
        const entrance = incoming[0];
        const frames = entrance.effect.getKeyframes();
        is(frames[0].translate, "0px -110%", "Entrance starts at exit destination");
        const timing = entrance.effect.getTiming();
        entrance.finish();
        getComputedStyle(notch).translate;
        WhimsyFocusNotch.detach(window);
        getComputedStyle(notch).translate;
        const exit = notch.getAnimations().find(a => a.transitionProperty == "translate");
        ok(exit, "Exit uses a translate transition");
        if (exit) {
          is(exit.effect.getTiming().duration, timing.duration, "Entrance and exit durations match");
          is(exit.effect.getTiming().easing, timing.easing, "Entrance and exit easing match");
          const outFrames = exit.effect.getKeyframes();
          is(outFrames.at(-1).translate, frames[0].translate, "Exit and entrance transforms mirror");
        }
      } else {
        WhimsyFocusNotch.detach(window);
        ok(!notch.isConnected, "Reduced motion removes timer immediately");
      }
    } finally {
      WhimsyFocusNotch.detach(window, { instant: true });
      notch?.remove();
      await SpecialPowers.popPrefEnv();
    }
  }
});

add_task(async function folder_accel_click_opens_normal_tab() {
  await SpecialPowers.pushPrefEnv({ set: [["zen.view.sidebar-expanded", true]] });
  const before = new Set(gBrowser.tabs);
  let folder, parent;
  try {
    const url = "https://example.com/?folder-accel";
    const source = await BrowserTestUtils.openNewForegroundTab(gBrowser, url);
    folder = await gZenFolders.createFolder([source], { renameFolder: false, label: "Accel regression" });
    folder.collapsed = false;
    for (const nested of [false, true]) {
      if (nested) {
        parent = await gZenFolders.createFolder([], { renameFolder: false, label: "Parent" });
        parent.appendChild(folder);
        gBrowser.tabContainer._invalidateCachedTabs();
        parent.collapsed = false;
      }
      for (const background of [true, false]) {
        await SpecialPowers.pushPrefEnv({ set: [["browser.tabs.loadInBackground", background]] });
        try {
          for (const selector of [".tab-label-container", ".tab-icon-image"]) {
            gBrowser.selectedTab = source;
            source.scrollIntoView();
            const target = source.querySelector(selector);
            await TestUtils.waitForCondition(() => target.getBoundingClientRect().width > 0, "Tab target is visible");
            const opened = BrowserTestUtils.waitForNewTab(gBrowser, url, true);
            EventUtils.synthesizeMouseAtCenter(target, { accelKey: true });
            const copy = await opened;
            ok(!copy.pinned, "Accel-click opens an unpinned tab");
            ok(!copy.group && !copy.closest("zen-folder"), "New tab is outside every folder");
            is(gBrowser.selectedTab, background ? source : copy, "Selection follows loadInBackground");
            is(source.group, folder, "Source stays in its folder");
            ok(source.pinned, "Source stays pinned");
            BrowserTestUtils.removeTab(copy);
          }
        } finally {
          await SpecialPowers.popPrefEnv();
        }
      }
    }
  } finally {
    for (const tab of gBrowser.tabs.filter(t => !before.has(t))) {
      BrowserTestUtils.removeTab(tab);
    }
    if (folder?.isConnected) folder.delete();
    if (parent?.isConnected) parent.delete();
    await SpecialPowers.popPrefEnv();
  }
});

// The timer uses its existing surface and colors; capture the corrected
// geometry at the normal window width in both schemes for visual review.
add_task(async function timer_screens() {
  for (const dark of [false, true]) {
    await whimsySetScheme(dark);
    try {
      const notch = WhimsyFocusNotch.attach(window, { endsAt: Date.now() + 60000, totalMs: 60000 });
      getComputedStyle(notch).translate;
      for (const animation of notch.getAnimations()) {
        animation.finish();
      }
      await whimsyShot(`w29-timer-${dark ? "dark" : "light"}`);
    } finally {
      WhimsyFocusNotch.detach(window, { instant: true });
      await SpecialPowers.popPrefEnv();
    }
  }
});
