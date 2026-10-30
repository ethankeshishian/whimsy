/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Regression: on a plain upload form (a local copy of the classic
// <input type=file> example), an image on the real clipboard and Cmd+V on the
// focused file input uploads it. Nothing is stubbed and nothing goes online.

const PAGE =
  getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") +
  "whimsy_upload_form.html";

// A 2x2 red PNG.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4z8AARAwQCgAf7gP9i18U1AAAAABJRU5ErkJggg==";

function putImageOnClipboard() {
  const bytes = Uint8Array.from(atob(PNG_BASE64), c => c.charCodeAt(0));
  const imgTools = Cc["@mozilla.org/image/tools;1"].getService(Ci.imgITools);
  const image = imgTools.decodeImageFromArrayBuffer(bytes.buffer, "image/png");
  const transferable = Cc["@mozilla.org/widget/transferable;1"].createInstance(Ci.nsITransferable);
  transferable.init(null);
  transferable.addDataFlavor("image/png");
  transferable.setTransferData("image/png", image);
  Services.clipboard.setData(transferable, null, Ci.nsIClipboard.kGlobalClipboard);
}

add_task(async function test_cmd_v_uploads_clipboard_image() {
  ok(Services.prefs.getBoolPref("whimsy.feature.upload-clipboard", true), "Upload from the clipboard is on");
  putImageOnClipboard();
  ok(
    Services.clipboard.hasDataMatchingFlavors(["image/png"], Ci.nsIClipboard.kGlobalClipboard),
    "The clipboard holds an image"
  );

  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await SpecialPowers.spawn(browser, [], () => content.document.getElementById("myfile").focus());
    EventUtils.synthesizeKey("v", { accelKey: true });
    await TestUtils.waitForCondition(
      () => SpecialPowers.spawn(browser, [], () => content.document.getElementById("myfile").files.length == 1),
      "Cmd+V put a file in the input"
    );
    const file = await SpecialPowers.spawn(browser, [], () => {
      const input = content.document.getElementById("myfile");
      const f = input.files[0];
      return { name: f.name, type: f.type, size: f.size, changes: content.wrappedJSObject.changes };
    });
    ok(file.name.endsWith(".png"), `The input received a PNG (${file.name})`);
    is(file.type, "image/png", "...typed as an image");
    ok(file.size > 0, "...with the image's bytes");
    ok(file.changes >= 1, "The page saw a change event, as with a picked file");
    ok(!document.getElementById("whimsy-upload-panel")?.matches("[panelopen]"), "No popup was needed");
  });
});
