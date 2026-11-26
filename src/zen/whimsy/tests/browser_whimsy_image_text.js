/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W23 voice-image (media-3.x): text in images in view is recognized on this
// Mac (a stand-in recognizer here). An invisible line of text sits over
// each recognized line: the I-beam, drag, double- and triple-click select,
// ⌘C copies with a toast, ⌘F finds it, ⌘K offers Copy and Translate only
// when there's text, and Translate covers each line with Show original.

Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "head_image_text_w23.js", this);

const { WhimsyContextCommands, WhimsyVerbs } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyVerbs.sys.mjs");
const { UrlbarTestUtils } = ChromeUtils.importESModule("resource://testing-common/UrlbarTestUtils.sys.mjs");

UrlbarTestUtils.init(this);

const TRANSLATIONS = {
  "創業 1887": "SINCE 1887",
  星野茶舗: "Hoshino Tea Shop",
  "営業時間 9:00〜17:00 · 年中無休": "Open 9:00 to 17:00 · Every day",
};
const FIND_PREFS = ["findbar.highlightAll", "accessibility.typeaheadfind.flashBar"];

add_setup(async () => {
  const branch = Services.prefs;
  await SpecialPowers.pushPrefEnv({
    set: [
      ["whimsy.feature.ai-hints", false],
      ["whimsy.feature.image-text", true],
      ...FIND_PREFS.map(name => [name, branch.getPrefType(name) == branch.PREF_INT ? branch.getIntPref(name) : branch.getBoolPref(name, false)]),
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

const center = r => [r.x + r.width / 2, r.y + r.height / 2];

function copiedToast() {
  return gZenUIManager.toasts.getToasts().find(t => t.messageId == "whimsy-image-text-copied") ?? null;
}

function toastLines(toast) {
  const detail = toast.element.querySelector("[data-l10n-id='whimsy-image-text-copied-lines']");
  return detail ? document.l10n.getAttributes(detail).args.count : null;
}

async function copyExpecting(expected) {
  await SimpleTest.promiseClipboardChange(expected, () => EventUtils.synthesizeKey("c", { accelKey: true }));
}

add_task(async function ibeam_and_select_copy_toast() {
  await withImageText("en", async browser => {
    const { lines } = await imageTextLayer(browser);
    Assert.deepEqual(lines.map(l => l.text), ["SINCE 1887", "Hoshino Tea House", "Open daily 9:00 to 17:00"], "One invisible line per recognized line");
    for (const line of lines) {
      is(line.cursor, "text", `The pointer is an I-beam over “${line.text}”`);
      is(line.color, "rgba(0, 0, 0, 0)", "Its text is invisible");
      is(line.background, "rgba(0, 0, 0, 0)", "Nothing is drawn on the image");
    }
    const [hx, hy] = center(lines[1].rect);
    const hit = await SpecialPowers.spawn(browser, [hx, hy], (x, y) => {
      const el = content.document.elementFromPoint(x, y);
      return { tag: el.localName, onImage: el.id == "photo", top: el.parentNode == content.document.body };
    });
    ok(!hit.onImage && hit.top, "The text layer, above the image, takes the pointer over a line");

    // Drag across two lines, then ⌘C.
    const [l2, l3] = [lines[1].rect, lines[2].rect];
    await BrowserTestUtils.synthesizeMouseAtPoint(l2.x + 2, l2.y + l2.height / 2, { type: "mousedown" }, browser);
    await BrowserTestUtils.synthesizeMouseAtPoint(l3.x + l3.width / 2, l3.y + l3.height / 2, { type: "mousemove" }, browser);
    await BrowserTestUtils.synthesizeMouseAtPoint(l3.x + l3.width - 2, l3.y + l3.height / 2, { type: "mousemove" }, browser);
    await BrowserTestUtils.synthesizeMouseAtPoint(l3.x + l3.width - 2, l3.y + l3.height / 2, { type: "mouseup" }, browser);
    closeToasts();
    await copyExpecting("Hoshino Tea House\nOpen daily 9:00 to 17:00");
    const toast = await TestUtils.waitForCondition(copiedToast, "⌘C shows the toast");
    is(toastLines(toast), 2, "It says how many lines (2 lines)");

    // Double-click picks a word.
    closeToasts();
    await BrowserTestUtils.synthesizeMouseAtPoint(l2.x + l2.width * 0.56, l2.y + l2.height / 2, { clickCount: 1 }, browser);
    await BrowserTestUtils.synthesizeMouseAtPoint(l2.x + l2.width * 0.56, l2.y + l2.height / 2, { clickCount: 2 }, browser);
    await copyExpecting(text => text == "Tea");
    is(toastLines(await TestUtils.waitForCondition(copiedToast, "Toast")), 1, "One word is one line");
    closeToasts();
  });
});

add_task(async function find_matches_inside_image() {
  await withImageText("en", async browser => {
    EventUtils.synthesizeKey("f", { accelKey: true });
    const findbar = await TestUtils.waitForCondition(() => gBrowser.isFindBarInitialized() && gBrowser.getCachedFindBar(), "The find bar exists");
    await TestUtils.waitForCondition(() => !findbar.hidden && document.activeElement == findbar._findField, "Cmd+F opens it");
    const count = () => findbar.querySelector(".whimsy-find-count")?.getAttribute("value");
    const search = async text => {
      findbar._findField.select();
      EventUtils.sendString(text);
      await TestUtils.waitForCondition(() => findbar._findField.getAttribute("status") != "pending", "Find ran");
    };
    await search("daily");
    try {
      await TestUtils.waitForCondition(() => count() == "1/1", "A word only in the image is found");
    } catch (e) {
      info(`Find count: ${count()}, status: ${findbar._findField.getAttribute("status")}`);
      throw e;
    }
    ok(!findbar.getElement("findbar-textbox-wrapper").hasAttribute("notfound"), "It isn't a miss");
    const found = await SpecialPowers.spawn(browser, [], () => content.getSelection().toString());
    is(found, "daily", "The match is selected on the picture, like page text");
    await search("Hoshino");
    await TestUtils.waitForCondition(() => /\/2$/.test(count()), "Page text and image text count together");
    is(await WhimsyImageText.countInView(browser, "tea"), 1, "The image matcher counts the words in images on screen");
    findbar.close(true);
    await TestUtils.waitForCondition(() => findbar.hidden, "The find bar closes");
  });
});

add_task(async function works_with_ai_off() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.ai.enabled", false]] });
  await withImageText("en", async browser => {
    const { lines } = await imageTextLayer(browser);
    is(lines.length, 3, "Recognized with AI off");
    const l3 = lines[2].rect;
    for (const clickCount of [1, 2, 3]) {
      await BrowserTestUtils.synthesizeMouseAtPoint(l3.x + l3.width / 3, l3.y + l3.height / 2, { clickCount }, browser);
    }
    closeToasts();
    await copyExpecting("Open daily 9:00 to 17:00");
    is(toastLines(await TestUtils.waitForCondition(copiedToast, "Toast")), 1, "Triple-click took the line; 1 line");
    closeToasts();
    ok(WhimsyImageText.pageHasText(browser), "Copy text from image is offered in the command bar");
    await SimpleTest.promiseClipboardChange("SINCE 1887\nHoshino Tea House\nOpen daily 9:00 to 17:00", () =>
      document.getElementById("cmd_whimsyCopyImageText").doCommand()
    );
    is(toastLines(await TestUtils.waitForCondition(copiedToast, "Toast")), 3, "The command copies every line: 3 lines");
    closeToasts();
  });
  await SpecialPowers.popPrefEnv();
});

add_task(async function translate_in_place_show_original() {
  await withImageText("jp", async browser => {
    ok(await WhimsyImageText.translate(window), "Translate text in image ran");
    let layer = await imageTextLayer(browser);
    Assert.deepEqual(layer.lines.map(l => l.text), Object.values(TRANSLATIONS), "Each line is covered by its translation");
    // The plates fade in (150ms, staggered).
    await TestUtils.waitForCondition(async () => {
      layer = await imageTextLayer(browser);
      return layer.lines.every(l => l.translated && l.background != "rgba(0, 0, 0, 0)" && l.color != "rgba(0, 0, 0, 0)");
    }, "The plates fade in");
    ok(true, "On a plate in the image's colours");
    is(layer.pill?.text, "Translated from Japanese", "The pill says what happened");
    is(layer.pill?.button, "Show original", "and offers the original");
    const button = await SpecialPowers.spawn(browser, [], () => {
      const actor = content.windowGlobalChild.getExistingActor("WhimsyImageText");
      const pill = [...actor.images.values()].find(i => i.pill).pill;
      const r = pill.querySelector("button").getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await BrowserTestUtils.synthesizeMouseAtPoint(button.x, button.y, {}, browser);
    await TestUtils.waitForCondition(async () => (await imageTextLayer(browser)).lines.every(l => !l.translated), "Show original swaps back");
    layer = await imageTextLayer(browser);
    Assert.deepEqual(layer.lines.map(l => l.text), Object.keys(TRANSLATIONS), "The image's own text is back (still selectable)");
    is(layer.pill?.button, "Show translation", "and the pill swaps to Show translation");
  });
});

add_task(async function no_text_no_text_commands() {
  const rowsFor = src =>
    WhimsyContextCommands.rank(window, { kind: "page", text: "", title: "A morning", url: "https://a.test/" }, { shares: { image: 0.6 }, images: [{ src, area: 1000 }], underPointer: null, product: false, textChars: 300 })
      .find(g => g.kind == "image")
      ?.all.map(r => r.id) ?? [];
  await withImageText("scene", async (browser, src) => {
    ok(!WhimsyImageText.hasText(src), "An image without text has no text");
    ok(!WhimsyImageText.pageHasText(browser), "so the command bar doesn't offer Copy text from image");
    const { lines } = await imageTextLayer(browser);
    is(lines.length, 0, "and there's no I-beam layer");
    const ids = rowsFor(src);
    ok(ids.includes("ai:ask-image"), "⌘K still asks about the image");
    ok(!ids.includes("image-text:copy") && !ids.includes("image-text:translate"), "but drops the text commands");
  });
  await withImageText("en", async (browser, src) => {
    ok(WhimsyImageText.hasText(src), "A sign has text");
    const ids = rowsFor(src);
    ok(ids.includes("image-text:copy") && ids.includes("image-text:translate"), "⌘K offers Copy and Translate text in image");
    // The real ⌘K: the view share asks this module which images have text.
    WhimsyVerbs.sessions.delete(window);
    EventUtils.synthesizeKey("k", { accelKey: true });
    await TestUtils.waitForCondition(() => WhimsyVerbs.sessions.get(window), "⌘K opened its menu");
    await UrlbarTestUtils.promiseSearchComplete(window);
    const shown = [];
    for (let i = 0; i < UrlbarTestUtils.getResultCount(window); i++) {
      shown.push((await UrlbarTestUtils.getDetailsOfResultAt(window, i)).result.payload.whimsyVerb);
    }
    ok(shown.includes("image-text:copy"), "Copy text from image shows in ⌘K");
    await UrlbarTestUtils.promisePopupClose(window, () => gURLBar.view.close());
    gURLBar.blur();
    WhimsyVerbs.sessions.delete(window);
  });
});

// W30 U3: whether the image's text may go to the cloud is decided for the
// tab the image is in, when Translate is asked for, not for whichever tab
// is in front once recognition has finished.
add_task(async function translate_decides_privacy_for_the_images_tab() {
  const realTranslateWithAI = WhimsyImageText.translateWithAI;
  const realTestTranslate = WhimsyImageText.testTranslate;
  const cloudCalls = [];
  WhimsyImageText.translateWithAI = async lines => {
    cloudCalls.push(lines);
    return lines.map(line => TRANSLATIONS[line] ?? line);
  };
  const recognized = browser =>
    TestUtils.waitForCondition(
      () =>
        SpecialPowers.spawn(browser, [], () => {
          const actor = content.windowGlobalChild.getExistingActor("WhimsyImageText");
          return !!actor && actor.images.size > 0;
        }),
      "The image in view was recognized"
    );
  const normal = await BrowserTestUtils.openNewForegroundTab(gBrowser, IMAGE_TEXT_PAGE("jp"));
  await recognized(normal.linkedBrowser);
  const priv = openWhimsyPrivateTab(window, { url: IMAGE_TEXT_PAGE("jp"), force: true });
  try {
    await BrowserTestUtils.browserLoaded(priv.linkedBrowser, false, IMAGE_TEXT_PAGE("jp"));
    gBrowser.selectedTab = priv;
    await recognized(priv.linkedBrowser);

    // Asked in the private tab; the person switches away while it works.
    WhimsyImageText.testTranslate = () => {
      gBrowser.selectedTab = normal;
      return null;
    };
    ok(!(await WhimsyImageText.translate(window)), "No on-device translation and no cloud: it fails quietly");
    is(cloudCalls.length, 0, "A private tab's image never goes to the cloud, whatever tab is in front later");
    closeToasts();

    // Asked in a normal tab; switching to the private one doesn't block it.
    gBrowser.selectedTab = normal;
    WhimsyImageText.testTranslate = () => {
      gBrowser.selectedTab = priv;
      return null;
    };
    ok(await WhimsyImageText.translate(window), "A normal tab's image is translated by the cloud");
    is(cloudCalls.length, 1, "exactly once");
    closeToasts();
  } finally {
    WhimsyImageText.translateWithAI = realTranslateWithAI;
    WhimsyImageText.testTranslate = realTestTranslate;
    gBrowser.selectedTab = normal;
    BrowserTestUtils.removeTab(normal);
    if (priv.isConnected && !priv.closing) {
      gBrowser.removeTabs([priv], { skipPermitUnload: true, animate: false });
    }
  }
});

// W32 perf: reading an image's text is the costly part, so it happens only
// for images worth it. This counts the reads (the stand-in recognizer's
// calls) by image.
function countReads() {
  const reads = [];
  WhimsyImageText.testRecognizer = src => {
    reads.push(src);
    return imageTextRecognizer(src);
  };
  return {
    of: name => reads.filter(src => src.includes(name)).length,
    all: reads,
    done() {
      WhimsyImageText.testRecognizer = imageTextRecognizer;
    },
  };
}

const imageTextState = browser =>
  SpecialPowers.spawn(browser, [], () => {
    const actor = content.windowGlobalChild.getExistingActor("WhimsyImageText");
    return { images: actor?.images.size ?? 0, queued: actor?.queue.size ?? 0, timers: actor?.timers.size ?? 0, pending: actor?.pending.size ?? 0 };
  });

add_task(async function an_image_is_read_once_across_tabs() {
  const reads = countReads();
  try {
    await withImageText("en", async () => {
      is(reads.of("sign_en.svg"), 1, "The sign is read once");
    });
    await withImageText("en", async browser => {
      is(reads.of("sign_en.svg"), 1, "Another tab with the same image doesn't read it again");
      const { lines } = await imageTextLayer(browser);
      Assert.deepEqual(lines.map(l => l.text), ["SINCE 1887", "Hoshino Tea House", "Open daily 9:00 to 17:00"], "and still gets its lines, where they were");
    });
    Services.obs.notifyObservers(null, "whimsy-ai-store-cleared");
    await withImageText("en", async () => {
      is(reads.of("sign_en.svg"), 2, "Once what was read is cleared, the image is read again");
    });
  } finally {
    reads.done();
  }
});

add_task(async function tiny_and_icon_images_are_never_read() {
  const reads = countReads();
  try {
    await BrowserTestUtils.withNewTab(`${IMAGE_TEXT_PAGE("en")}&small=1`, async browser => {
      await TestUtils.waitForCondition(async () => (await imageTextState(browser)).images > 0, "The sign in view was read");
      // Long past the dwell and an idle slot for the others.
      await new Promise(resolve => setTimeout(resolve, 1500));
      const state = await imageTextState(browser);
      is(state.images, 1, "Only the sign has an entry");
      is(state.queued + state.timers + state.pending, 0, "Nothing else waits to be read");
      Assert.deepEqual(reads.all.map(src => src.replace(IMAGE_TEXT_ROOT, "")), ["whimsy_image_text_sign_en.svg"], "Neither the spacer pixel nor the icon-sized sign was read");
    });
  } finally {
    reads.done();
  }
});

add_task(async function an_image_below_the_fold_waits_until_it_is_in_view() {
  const reads = countReads();
  try {
    await BrowserTestUtils.withNewTab(`${IMAGE_TEXT_PAGE("en")}&far=1`, async browser => {
      await new Promise(resolve => setTimeout(resolve, 1500));
      is(reads.of("sign_en.svg"), 0, "A sign out of view isn't read");
      is((await imageTextState(browser)).queued, 0, "nor queued");
      await SpecialPowers.spawn(browser, [], () => content.document.getElementById("photo").scrollIntoView({ block: "center" }));
      await TestUtils.waitForCondition(async () => (await imageTextState(browser)).images > 0, "Scrolled into view, it's read");
      is(reads.of("sign_en.svg"), 1, "once");
      const { lines } = await imageTextLayer(browser);
      is(lines.length, 3, "and its lines are laid over it");
    });
  } finally {
    reads.done();
  }
});
