/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave7/small: lazy init. A new window gets its shortcuts and visible parts
// at once and its command-bar-only parts once it's idle; with
// whimsy.startup.lazy-init off, everything starts at once.

const EARLY = ["key_whimsyCopyFullPage", "cmd_whimsyCapturePortrait"];
const DEFERRED = ["cmd_whimsyCast", "cmd_whimsyCreateEmailAlias", "whimsy-cookie-editor"];

async function initialized(win) {
  await TestUtils.waitForCondition(() => win.whimsyDeferredInit, "Whimsy started in the new window");
}

add_task(async function test_deferred_parts_arrive_when_idle() {
  const win = await BrowserTestUtils.openNewBrowserWindow();
  await initialized(win);
  for (const id of EARLY) {
    ok(win.document.getElementById(id), `${id} is there from the start`);
  }
  await win.whimsyDeferredInit;
  for (const id of DEFERRED) {
    ok(win.document.getElementById(id), `${id} arrived once the window was idle`);
  }
  await BrowserTestUtils.closeWindow(win);
});

add_task(async function test_switch_off_starts_everything_at_once() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.startup.lazy-init", false]] });
  const win = await BrowserTestUtils.openNewBrowserWindow();
  await initialized(win);
  for (const id of [...EARLY, ...DEFERRED]) {
    ok(win.document.getElementById(id), `${id} is there at once`);
  }
  await BrowserTestUtils.closeWindow(win);
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_closing_before_idle_is_harmless() {
  const win = await BrowserTestUtils.openNewBrowserWindow();
  await initialized(win);
  const done = win.whimsyDeferredInit;
  await BrowserTestUtils.closeWindow(win);
  await done;
  ok(true, "The deferred init settles even for a window that closed");
});
