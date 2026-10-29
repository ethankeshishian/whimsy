/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// Settings → General → Performance: the hardware video decoding checkbox
// reflects the pref, toggling it writes the pref, and a restart prompt
// appears (the decode path itself needs real hardware, so it's untested).

add_task(async function test_hardware_video_decoding_checkbox() {
  const original = Services.prefs.getBoolPref("media.hardware-video-decoding.enabled", true);
  registerCleanupFunction(() => Services.prefs.setBoolPref("media.hardware-video-decoding.enabled", original));

  await BrowserTestUtils.withNewTab("about:preferences#general", async browser => {
    const doc = browser.contentDocument;
    await TestUtils.waitForCondition(() => doc.getElementById("whimsyHardwareVideoDecoding"));
    const checkbox = doc.getElementById("whimsyHardwareVideoDecoding");
    const note = doc.getElementById("whimsyHwDecodeRestart");
    is(checkbox.checked, original, "Checkbox reflects the pref");
    ok(note.hidden, "No restart prompt yet");

    checkbox.checked = !original;
    checkbox.dispatchEvent(new doc.defaultView.Event("command"));
    is(
      Services.prefs.getBoolPref("media.hardware-video-decoding.enabled"),
      !original,
      "Unticking sets the pref false"
    );
    ok(!note.hidden, "The restart prompt appears");
  });
});
