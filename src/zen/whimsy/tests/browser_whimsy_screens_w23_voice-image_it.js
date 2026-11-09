/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W23 voice-image, image text: screenshots of media-3.1 (text in an image,
// nothing drawn), 3.2/3.8 (selecting it), 3.3 (copied toast), 3.4 (⌘F),
// 3.5 (⌘K on an image with text), 3.6 (translated in place with its pill
), and 3.7 (⌘K on an image without text).

Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "head_image_text_w23.js", this);

const { WhimsyVerbs } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyVerbs.sys.mjs");
const { UrlbarTestUtils } = ChromeUtils.importESModule("resource://testing-common/UrlbarTestUtils.sys.mjs");

UrlbarTestUtils.init(this);

const TRANSLATIONS = {
  "創業 1887": "SINCE 1887",
  星野茶舗: "Hoshino Tea Shop",
  "営業時間 9:00〜17:00 · 年中無休": "Open 9:00 to 17:00 · Every day",
};

add_setup(async () => {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["whimsy.feature.ai-hints", false],
      ["findbar.highlightAll", Services.prefs.getBoolPref("findbar.highlightAll", false)],
      ["accessibility.typeaheadfind.flashBar", Services.prefs.getIntPref("accessibility.typeaheadfind.flashBar", 1)],
    ],
  });
  WhimsyImageText.testRecognizer = imageTextRecognizer;
  WhimsyImageText.testTranslate = lines => lines.map(line => TRANSLATIONS[line] ?? line);
  WhimsyImageText.testTargetLanguage = "en";
  registerCleanupFunction(() => {
    WhimsyImageText.testRecognizer = null;
    WhimsyImageText.testTranslate = null;
    WhimsyImageText.testTargetLanguage = null;
    closeToasts();
  });
});

async function selectTwoLines(browser) {
  const { lines } = await imageTextLayer(browser);
  const [l2, l3] = [lines[1].rect, lines[2].rect];
  await BrowserTestUtils.synthesizeMouseAtPoint(l2.x + 2, l2.y + l2.height / 2, { type: "mousedown" }, browser);
  await BrowserTestUtils.synthesizeMouseAtPoint(l3.x + l3.width - 2, l3.y + l3.height / 2, { type: "mousemove" }, browser);
  await BrowserTestUtils.synthesizeMouseAtPoint(l3.x + l3.width - 2, l3.y + l3.height / 2, { type: "mouseup" }, browser);
  // Park the pointer off the image.
  await BrowserTestUtils.synthesizeMouseAtPoint(5, 5, { type: "mousemove" }, browser);
}

async function cmdK() {
  WhimsyVerbs.sessions.delete(window);
  EventUtils.synthesizeKey("k", { accelKey: true });
  await TestUtils.waitForCondition(() => WhimsyVerbs.sessions.get(window), "⌘K opened its menu");
  await UrlbarTestUtils.promiseSearchComplete(window);
  return async () => {
    await UrlbarTestUtils.promisePopupClose(window, () => gURLBar.view.close());
    gURLBar.blur();
    WhimsyVerbs.sessions.delete(window);
  };
}

add_task(async function shots_select_and_copy() {
  await withImageText("en", async browser => {
    await whimsyBothSchemes("w23-voice-image-media-3.1", async () => {
      ok((await imageTextLayer(browser)).lines.length == 3, "3.1: the sign's lines are recognized, nothing drawn");
    });
    await whimsyBothSchemes("w23-voice-image-media-3.2", async () => {
      await selectTwoLines(browser);
      ok(true, "3.2: two lines selected");
    });
    await whimsyBothSchemes("w23-voice-image-media-3.3", async () => {
      await selectTwoLines(browser);
      closeToasts();
      EventUtils.synthesizeKey("c", { accelKey: true });
      const toast = await TestUtils.waitForCondition(() => gZenUIManager.toasts.getToasts().find(t => t.messageId == "whimsy-image-text-copied"), "The toast");
      await toast.shown;
      ok(true, "3.3: Copied text from image");
      return () => closeToasts();
    });
  });
});

add_task(async function shot_find() {
  await withImageText("en", async browser => {
    await whimsyBothSchemes("w23-voice-image-media-3.4", async () => {
      EventUtils.synthesizeKey("f", { accelKey: true });
      const findbar = await TestUtils.waitForCondition(() => gBrowser.isFindBarInitialized() && gBrowser.getCachedFindBar(), "The find bar");
      await TestUtils.waitForCondition(() => !findbar.hidden && document.activeElement == findbar._findField, "Open");
      findbar._findField.select();
      EventUtils.sendString("tea");
      await TestUtils.waitForCondition(() => /\/3$/.test(findbar.querySelector(".whimsy-find-count")?.getAttribute("value") ?? ""), "Three matches, one in the image");
      EventUtils.synthesizeKey("KEY_Enter");
      ok(true, "3.4: ⌘F finds the word in the image");
      return async () => {
        findbar.close(true);
        await TestUtils.waitForCondition(() => findbar.hidden, "Closed");
      };
    });
  });
});

add_task(async function shots_cmdk() {
  await withImageText("jp", async () => {
    await whimsyBothSchemes("w23-voice-image-media-3.5", async () => {
      const close = await cmdK();
      ok(true, "3.5: ⌘K with an image with text");
      return close;
    });
  });
  await withImageText("scene", async () => {
    await whimsyBothSchemes("w23-voice-image-media-3.7", async () => {
      const close = await cmdK();
      ok(true, "3.7: ⌘K with an image without text");
      return close;
    });
  });
});

add_task(async function shots_translate() {
  await withImageText("jp", async () => {
    await whimsyBothSchemes("w23-voice-image-media-3.6", async () => {
      ok(await WhimsyImageText.translate(window), "3.6: translated in place");
      await new Promise(r => setTimeout(r, 400));
    });
  });
});
