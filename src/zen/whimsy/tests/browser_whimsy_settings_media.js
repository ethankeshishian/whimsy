/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W23 video: Settings › Media, its own page. The media rows that sat under
// Tabs live here, with the default speed (a WhimsySurface menu with Other…)
// and Summarize and picture-in-picture.

add_task(async function settings_media_page_has_moved_checkboxes() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.video.default-speed", "1"]] });
  await BrowserTestUtils.withNewTab("about:preferences#whimsyMedia", async browser => {
    const doc = browser.contentDocument;
    await TestUtils.waitForCondition(() => doc.getElementById("whimsyMediaVideosGroup") && !doc.getElementById("whimsyMediaVideosGroup").hidden, "Media shows");
    ok(doc.getElementById("category-whimsy-media"), "Media is in the sidebar");
    for (const id of ["whimsyBackgroundMute", "whimsyPipSnapBack", "whimsyCallPip", "whimsyVideoSpeed", "whimsyVideoCaptions", "whimsyVideoTopButtons"]) {
      const row = doc.getElementById(id);
      ok(row, `${id} is here`);
      is(row?.closest("groupbox")?.getAttribute("data-category"), "paneWhimsyMedia", `${id} is on the Media page`);
    }
    ok(doc.getElementById("whimsyMediaReadAloud") && doc.getElementById("whimsyMediaDictation"), "Read aloud and dictation have their places");

    // The default speed: a styled menu, then Other… for any speed.
    const button = doc.getElementById("whimsyMediaDefaultSpeedMenu");
    ok(button, "The default speed is a menu button");
    button.scrollIntoView();
    // The listbox is a real styled surface (an NSPopover-backed panel), not a
    // native menu; browser_whimsy_site_settings.js picks the same widget the
    // same way: .click() on the row, not a coordinate-based synthesized
    // click, which can miss while the popover is still settling.
    button.click();
    const option = await TestUtils.waitForCondition(() => doc.querySelector("[role=option][data-value='1.5']") ?? window.document.querySelector("[role=option][data-value='1.5']"), "The menu opens");
    option.click();
    await TestUtils.waitForCondition(() => Services.prefs.getStringPref("whimsy.video.default-speed") == "1.5", "Picking 1.5× sets the default");

    doc.getElementById("whimsyMediaDefaultSpeedMenu").click();
    const other = await TestUtils.waitForCondition(() => doc.querySelector("[role=option][data-value='other']") ?? window.document.querySelector("[role=option][data-value='other']"), "The menu opens again");
    other.click();
    const input = await TestUtils.waitForCondition(() => doc.getElementById("whimsyMediaDefaultSpeedInput"), "Other… is a field");
    input.focus();
    input.select();
    EventUtils.sendString("20", browser.contentWindow);
    EventUtils.synthesizeKey("KEY_Enter", {}, browser.contentWindow);
    await TestUtils.waitForCondition(() => Services.prefs.getStringPref("whimsy.video.default-speed") == "16", "20 becomes 16×");
    ok(doc.getElementById("whimsyMediaDefaultSpeedNote"), "with a one-line note");
  });
  Services.prefs.clearUserPref("whimsy.video.default-speed");
  await SpecialPowers.popPrefEnv();
});

add_task(async function tabs_page_lost_the_media_rows() {
  await BrowserTestUtils.withNewTab("about:preferences#zenTabManagement", async browser => {
    const doc = browser.contentDocument;
    await TestUtils.waitForCondition(() => doc.getElementById("whimsyTabsGroup"), "Tabs shows");
    ok(!doc.getElementById("whimsyTabsGroup").querySelector("#whimsyVideoSpeed, #whimsyPipSnapBack"), "No media rows under Tabs");
  });
});

add_task(async function sites_with_their_own_speed_forget_all() {
  const { WhimsyVideoSpeed } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyVideoSpeed.sys.mjs");
  const cps = Cc["@mozilla.org/content-pref/service;1"].getService(Ci.nsIContentPrefService2);
  const set = (site, rate) =>
    new Promise(resolve => cps.set(`https://${site}/`, "whimsy.video-speed", rate, Cu.createLoadContext(), { handleCompletion: resolve, handleError: resolve }));
  await WhimsyVideoSpeed.forgetAll();
  await set("www.youtube.com", 2);
  await set("vimeo.com", 1.25);
  await set("example.com", 1.5);
  await set("example.org", 3);
  is((await WhimsyVideoSpeed.savedSites()).length, 4, "Four sites have their own speed");
  await BrowserTestUtils.withNewTab("about:preferences#whimsyMedia", async browser => {
    const doc = browser.contentDocument;
    const row = await TestUtils.waitForCondition(() => {
      const r = doc.getElementById("whimsyMediaSitesRow");
      return r && !r.hidden && r;
    }, "Sites with their own speed shows");
    const list = doc.getElementById("whimsyMediaSitesList");
    await TestUtils.waitForCondition(() => list.textContent.endsWith(", and 2 more"), "Two by name, and the rest counted");
    ok(!list.textContent.includes("www."), "Sites are named without www.");
    ok(/\d×/.test(list.textContent), "with their speeds");
    const button = doc.getElementById("whimsyMediaForgetAll");
    button.scrollIntoView();
    EventUtils.synthesizeMouseAtCenter(button, {}, browser.contentWindow);
    await TestUtils.waitForCondition(() => row.hidden, "Forget all empties the row, so it goes");
  });
  is((await WhimsyVideoSpeed.savedSites()).length, 0, "Every site is back on your default");
});
