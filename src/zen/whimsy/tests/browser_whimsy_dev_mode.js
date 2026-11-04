/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// http://localhost:PORT -> the tab has whimsy-devmode and the top bar is
// visible. example.org -> no. Turning it on for that site sets and saves
// the permission.

add_task(async function test_localhost_is_dev_mode_example_org_is_not() {
  await BrowserTestUtils.withNewTab("http://mochi.test:8888/", async browser => {
    const tab = gBrowser.getTabForBrowser(browser);
    // mochi.test:8888 has an explicit port, so it counts as a dev host.
    await TestUtils.waitForCondition(() => tab.hasAttribute("whimsy-devmode"));
    ok(tab.hasAttribute("whimsy-devmode"), "A host with an explicit port is Developer Mode");
    const bar = window.document.getElementById("whimsy-devmode-bar");
    ok(bar && !bar.hidden, "The top bar is visible for the selected dev-mode tab");
  });

  await BrowserTestUtils.withNewTab("https://example.org/", async browser => {
    const tab = gBrowser.getTabForBrowser(browser);
    ok(!tab.hasAttribute("whimsy-devmode"), "A plain https host is not Developer Mode");
  });
});

add_task(async function test_manual_toggle_persists() {
  const { WhimsyDevMode } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyDevMode.sys.mjs");
  const uri = Services.io.newURI("https://example.com/");
  registerCleanupFunction(() => {
    if (WhimsyDevMode.isDevMode(uri)) {
      WhimsyDevMode.toggleSite(uri);
    }
  });

  ok(!WhimsyDevMode.isDevMode(uri), "example.com starts out of Developer Mode");
  WhimsyDevMode.toggleSite(uri);
  ok(WhimsyDevMode.isDevMode(uri), "Toggling on sets and saves the permission");
  WhimsyDevMode.toggleSite(uri);
  ok(!WhimsyDevMode.isDevMode(uri), "Toggling again clears it");
});

// A toast over a Developer Mode tab's bar: its top edge and its close button
// take the pointer (the bar's toolbar stacked above the toast container, so
// clicks there landed on the bar).
add_task(async function test_toast_above_the_dev_bar() {
  await BrowserTestUtils.withNewTab("http://mochi.test:8888/", async browser => {
    const tab = gBrowser.getTabForBrowser(browser);
    await TestUtils.waitForCondition(() => tab.hasAttribute("whimsy-devmode"), "Developer Mode");
    const bar = document.getElementById("whimsy-devmode-bar");
    ok(bar && !bar.hidden, "The bar shows");
    const toast = gZenUIManager.toasts.open("whimsy-archive-toast", { timeout: 0 });
    try {
      const close = toast.element.querySelector(".whimsy-toast-close");
      await TestUtils.waitForCondition(() => {
        const r = toast.element.getBoundingClientRect();
        return r.width > 100 && toast.element.getAnimations({ subtree: true }).every(x => x.playState != "running");
      }, "The toast is in place");
      EventUtils.synthesizeMouseAtCenter(toast.element, { type: "mousemove" });
      await TestUtils.waitForCondition(() => close.checkVisibility({ opacityProperty: true }), "The close button shows on hover");
      const box = toast.element.getBoundingClientRect();
      const x = Math.round(box.left + box.width / 2);
      const hit = y => document.elementFromPoint(x, y);
      ok(toast.element.contains(hit(Math.ceil(box.top + 2))), `The toast's top edge takes the pointer (${hit(Math.ceil(box.top + 2))?.id || hit(Math.ceil(box.top + 2))?.localName})`);
      const c = close.getBoundingClientRect();
      is(document.elementFromPoint(c.left + c.width / 2, c.top + c.height / 2), close, "and so does its close button");
      EventUtils.synthesizeMouseAtCenter(close, {});
      await TestUtils.waitForCondition(() => toast.closing || toast.closed, "Clicking ✕ closes it");
    } finally {
      toast.close({ instant: true });
    }
  });
});
