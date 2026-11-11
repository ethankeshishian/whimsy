/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

add_task(async function screenshots_themes() {
  for (const [name, theme, expected] of [
    ["generated", "light", "generated"], ["native", "native", "native"], ["already-dark", "already", "native"],
  ]) {
    await whimsyBothSchemes(`w24-darkpages-${name}`, async () => {
      const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE + "?theme=" + theme);
      await darkState(tab.linkedBrowser, expected);
      return () => BrowserTestUtils.removeTab(tab);
    });
  }
});
