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
    EventUtils.synthesizeMouseAtCenter(button, {}, browser.contentWindow);
    const option = await TestUtils.waitForCondition(() => doc.querySelector("[role=option][data-value='1.5']") ?? window.document.querySelector("[role=option][data-value='1.5']"), "The menu opens");
    EventUtils.synthesizeMouseAtCenter(option, {}, option.ownerGlobal);
    await TestUtils.waitForCondition(() => Services.prefs.getStringPref("whimsy.video.default-speed") == "1.5", "Picking 1.5× sets the default");

    EventUtils.synthesizeMouseAtCenter(doc.getElementById("whimsyMediaDefaultSpeedMenu"), {}, browser.contentWindow);
    const other = await TestUtils.waitForCondition(() => doc.querySelector("[role=option][data-value='other']") ?? window.document.querySelector("[role=option][data-value='other']"), "The menu opens again");
    EventUtils.synthesizeMouseAtCenter(other, {}, other.ownerGlobal);
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
