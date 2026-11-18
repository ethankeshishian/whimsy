/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "head_side_panel.js", this);

// Expand by button or header double-click, with every shrink-back route.

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

