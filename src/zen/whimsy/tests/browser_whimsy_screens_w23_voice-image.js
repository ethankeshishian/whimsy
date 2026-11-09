/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W23 voice-image screenshots.
// Dictation: media-5.3, 5.4, 5.5, 5.7, 5.9, 5.10, fu-media 5.2, and dec-15,
// with a stand-in for @whimsy/speech;1.
// Image text: media-3.1 (nothing drawn), 3.2 (selecting), 3.3 (copied toast),
// 3.4 (⌘F), 3.5 and 3.7 (⌘K on an image with and without text), and 3.6
// (translated in place).
// Read aloud: ⌘K (media-4.1, fu-media 4.10), starting (4.2), playing (4.3),
// pointing at the card (4.4), the speed and voice menu (fu-media 4.5), paused
// (4.7), muted from the tab (4.8), finished (4.9), and the card's exit.
// Panels are copied into the window before each shot (drawSnapshot misses popups).

requestLongerTimeout(4);

Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "head_image_text_w23.js", this);
Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "head_read_aloud.js", this);

const { WhimsyDictation } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyDictation.sys.mjs");
const { WhimsyAIHints } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIHints.sys.mjs");
const { UrlbarTestUtils } = ChromeUtils.importESModule("resource://testing-common/UrlbarTestUtils.sys.mjs");

UrlbarTestUtils.init(this);

// ROOT comes from head_read_aloud.js.
const DICTATION_PAGE = ROOT + "whimsy_dictation.html";
const ARTICLE_PAGE = ROOT + "whimsy_chat_article.html";

function fakeSpeech({ locales = ["en-US"], mic = "authorized" } = {}) {
  const fake = {
    authorizationStatus: "authorized",
    microphoneStatus: mic,
    onDeviceLocales: locales,
    fnKeyUsage: 2,
    sessions: [],
    fn: null,
    requestAccess: cb => cb(true, "authorized"),
    requestMicrophoneAccess: cb => cb(fake.microphoneStatus == "authorized", fake.microphoneStatus),
    listen(locale, listener) {
      const session = { finished: false, finish() { this.finished = true; }, stop() {}, say: (text, final = false) => listener.onText(text, final) };
      fake.sessions.push(session);
      return session;
    },
    watchFnKey(listener) {
      fake.fn = listener;
      return { stop: () => (fake.fn = null) };
    },
    openSystemSettings() {},
  };
  return fake;
}

let speech;

const TRANSLATIONS = {
  "創業 1887": "SINCE 1887",
  星野茶舗: "Hoshino Tea Shop",
  "営業時間 9:00〜17:00 · 年中無休": "Open 9:00 to 17:00 · Every day",
};

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [
    ["whimsy.feature.dictation", true],
    ["whimsy.feature.ai-hints", false],
    ["whimsy.ai.hints.seen", "voice"],
    ["reader.parse-on-load.enabled", true],
    ["findbar.highlightAll", Services.prefs.getBoolPref("findbar.highlightAll", false)],
    ["accessibility.typeaheadfind.flashBar", Services.prefs.getIntPref("accessibility.typeaheadfind.flashBar", 1)],
  ] });
  WhimsyImageText.testRecognizer = imageTextRecognizer;
  WhimsyImageText.testTranslate = lines => lines.map(line => TRANSLATIONS[line] ?? line);
  WhimsyImageText.testTargetLanguage = "en";
  WhimsyReadAloud.testSynth = synth;
  registerCleanupFunction(() => {
    WhimsyDictation.cancel();
    WhimsyDictation.setTestSpeech(null);
    WhimsyDictation._barOpens = 0;
    Services.prefs.clearUserPref("ui.IMERawInputForeground");
    Services.prefs.clearUserPref("ui.IMERawInputUnderlineStyle");
    WhimsyImageText.testRecognizer = null;
    WhimsyImageText.testTranslate = null;
    WhimsyImageText.testTargetLanguage = null;
    WhimsyReadAloud.stop({ animate: false });
    WhimsyReadAloud.testSynth = null;
    WhimsyReadAloud.leaveDelay = 5000;
    Services.prefs.clearUserPref("whimsy.read-aloud.rate");
    Services.prefs.clearUserPref("whimsy.read-aloud.voice");
    closeToasts();
  });
});

function useSpeech(options) {
  WhimsyDictation.cancel();
  speech = fakeSpeech(options);
  WhimsyDictation.setTestSpeech(speech);
  return speech;
}

// Fluent in the bar. Commands mode once left the address field with
// data-l10n-id="undefined" (Firefox's search-mode placeholder had no entry
// for Zen's actions source), which threw and left the bar half translated.
async function translateBar() {
  const missing = [...gURLBar.querySelectorAll("[data-l10n-id]")].filter(el => ["", "undefined"].includes(el.getAttribute("data-l10n-id")));
  is(missing.map(el => el.id || el.className).join(), "", "Every element in the bar has a real message id");
  await document.l10n.translateElements([...gURLBar.querySelectorAll("[data-l10n-id]")]);
}

async function frames(n = 2) {
  for (let i = 0; i < n; i++) {
    await new Promise(r => requestAnimationFrame(r));
  }
}

async function closeBar() {
  WhimsyDictation.cancel();
  gURLBar.view.close();
  gURLBar.blur();
  gBrowser.selectedBrowser.focus();
  await TestUtils.waitForCondition(() => !gURLBar.view.isOpen, "The command bar is closed");
}

async function openBar(text = "") {
  gURLBar.focus();
  gURLBar.select();
  if (text) {
    EventUtils.sendString(text);
    await TestUtils.waitForCondition(() => gURLBar.view.isOpen, "The command bar is open");
  }
  await TestUtils.waitForCondition(() => document.getElementById("whimsy-dictation-mic")?.getBoundingClientRect().width > 0, "The mic shows");
}

async function focusField(browser) {
  await SpecialPowers.spawn(browser, [], () => {
    const body = content.document.getElementById("body");
    body.focus();
    body.setSelectionRange(body.value.length, body.value.length);
  });
  await TestUtils.waitForCondition(() => window.windowUtils.IMEStatus == Ci.nsIDOMWindowUtils.IME_STATUS_ENABLED, "The field has focus");
}

async function holdFn() {
  speech.fn("down");
  await TestUtils.waitForCondition(() => WhimsyDictation.active?.phase == "listening" || document.querySelector("panel[id^='whimsy-dictation-']")?.state == "open", "Holding Fn starts");
}

function standInPopups() {
  const made = [];
  for (const panel of document.querySelectorAll("panel")) {
    if (panel.state != "open") {
      continue;
    }
    const box = panel.shadowRoot?.querySelector("[part~='content']") ?? panel;
    const outer = panel.getOuterScreenRect();
    const inPanel = panel.getBoundingClientRect();
    const rect = box.getBoundingClientRect();
    const stand = document.createElementNS("http://www.w3.org/1999/xhtml", "div");
    stand.className = `${panel.className} whimsy-surface-tokens`;
    const look = getComputedStyle(panel);
    for (let i = 0; i < look.length; i++) {
      const name = look.item(i);
      if (name.startsWith("--")) {
        stand.style.setProperty(name, look.getPropertyValue(name));
      }
    }
    const boxLook = getComputedStyle(box);
    for (const name of ["background-color", "background-image", "border-top", "border-right", "border-bottom", "border-left", "border-radius", "box-shadow", "padding", "color", "font-family", "font-size", "font-weight", "line-height"]) {
      stand.style.setProperty(name, boxLook.getPropertyValue(name));
    }
    if (boxLook.boxShadow == "none") {
      stand.style.boxShadow = "0 0 0 0.5px rgba(0, 0, 0, 0.18), 0 8px 24px rgba(0, 0, 0, 0.16)";
    }
    if (/rgba\(.*, 0\)|transparent/.test(boxLook.backgroundColor)) {
      stand.style.backgroundColor = "var(--zen-dialog-background, var(--arrowpanel-background, Canvas))";
    }
    Object.assign(stand.style, {
      position: "fixed",
      zIndex: "2147483647",
      boxSizing: "border-box",
      display: "flex",
      flexDirection: "column",
      overflow: "hidden",
      left: `${outer.left - window.mozInnerScreenX + rect.left - inPanel.left}px`,
      top: `${outer.top - window.mozInnerScreenY + rect.top - inPanel.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
    for (const child of panel.children) {
      stand.append(child.cloneNode(true));
    }
    document.documentElement.append(stand);
    made.push(stand);
  }
  return () => made.forEach(s => s.remove());
}

async function closePanels() {
  for (const panel of document.querySelectorAll("panel.whimsy-dictation-panel")) {
    if (panel.state == "open") {
      const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
      panel.hidePopup();
      await hidden;
    }
  }
}

add_task(async function shots_command_bar_mic() {
  useSpeech();
  await BrowserTestUtils.withNewTab(ARTICLE_PAGE, async () => {
    // media-5.3: keyboard focus on the mic, its tooltip names the key.
    await whimsyBothSchemes("w23-voice-image-media-5.3", async () => {
      await openBar("night trains");
      const mic = document.getElementById("whimsy-dictation-mic");
      // Moving focus would close the bar; the look of keyboard focus is what's shot.
      InspectorUtils.addPseudoClassLock(mic, ":focus-visible");
      await document.l10n.translateFragment(mic);
      await frames();
      ok(mic.matches(":focus-visible"), "The mic shows keyboard focus");
      is(getComputedStyle(mic.querySelector(".whimsy-dictation-tip")).visibility, "visible", "Its tooltip shows");
      return async () => {
        InspectorUtils.removePseudoClassLock(mic, ":focus-visible");
        await closeBar();
      };
    });

    // media-5.4: listening in the bar, the unsure tail greyed.
    await whimsyBothSchemes("w23-voice-image-media-5.4", async () => {
      await openBar("n");
      gURLBar.select();
      EventUtils.synthesizeKey("KEY_Backspace");
      const mic = document.getElementById("whimsy-dictation-mic");
      EventUtils.synthesizeMouseAtCenter(mic, {});
      await TestUtils.waitForCondition(() => WhimsyDictation.active?.phase == "listening", "Listening");
      speech.sessions.at(-1).say("night trains from vienna");
      speech.sessions.at(-1).say("night trains from vienna to paris");
      await TestUtils.waitForCondition(() => gURLBar.value == "night trains from vienna to paris", "Words in the bar");
      await TestUtils.waitForCondition(() => gURLBar.view.isOpen, "Results update");
      await translateBar();
      await frames();
      ok(gURLBar.querySelector(".whimsy-dictation-tail").textContent.length, "A tail is greyed");
      return closeBar;
    });

    // media-5.7: Fn with nothing focused opens the bar listening.
    await whimsyBothSchemes("w23-voice-image-media-5.7", async () => {
      gBrowser.selectedBrowser.focus();
      await SpecialPowers.spawn(gBrowser.selectedBrowser, [], () => content.document.activeElement?.blur());
      await holdFn();
      await translateBar();
      await frames();
      is(WhimsyDictation.active.target, "commandbar", "The bar listens");
      return async () => {
        speech.fn("up");
        await closeBar();
      };
    });

    // fu-media dec-15: hold ⌘K, the open menu listens.
    await whimsyBothSchemes("w23-voice-image-fu-dec-15", async () => {
      gBrowser.selectedBrowser.focus();
      EventUtils.synthesizeKey("k", { accelKey: true, type: "keydown" });
      await TestUtils.waitForCondition(() => WhimsyDictation.active?.target == "cmdk", "The menu listens");
      speech.sessions.at(-1).say("summarize this");
      speech.sessions.at(-1).say("summarize this page");
      await TestUtils.waitForCondition(() => gURLBar.value == "summarize this page", "Words in the menu");
      await translateBar();
      await frames(3);
      ok(!gURLBar.querySelector(".whimsy-dictation-key").hidden, "It says release ⌘K");
      return async () => {
        EventUtils.synthesizeKey("k", { accelKey: true, type: "keyup" });
        await closeBar();
      };
    });

    // fu-media 5.2: the first-use toast, no ring.
    await SpecialPowers.pushPrefEnv({ set: [
      ["whimsy.feature.ai-hints", true],
      ["whimsy.ai.hints.seen", "ask,context-commands,chat,updates,video-summary,image-text,agent-mode"],
      ["whimsy.ai.hints.today", ""],
    ] });
    await whimsyBothSchemes("w23-voice-image-fu-5.2", async () => {
      WhimsyAIHints._resetForTesting();
      WhimsyAIHints._setTimingForTesting({ gapMs: 0, seenMs: 60000, timeoutMs: 60000, pollMs: 50 });
      WhimsyDictation.registerHint();
      // Each scheme shows the hint afresh: neither seen nor counted today.
      Services.prefs.setStringPref("whimsy.ai.hints.seen", "ask,context-commands,chat,updates,video-summary,image-text,agent-mode");
      Services.prefs.setStringPref("whimsy.ai.hints.today", "");
      WhimsyDictation._barOpens = 2;
      await openBar("n");
      const toast = await TestUtils.waitForCondition(() => gZenUIManager.toasts.getToasts().find(t => t.element.getAttribute("whimsy-ai-hint") == "voice"), "The voice hint shows");
      await toast.shown;
      await document.l10n.translateFragment(toast.element);
      await whimsySettled();
      is(getComputedStyle(document.getElementById("whimsy-dictation-mic")).boxShadow, "none", "No ring on the mic");
      return async () => {
        toast.close({ instant: true });
        WhimsyAIHints._restoreForTesting();
        await closeBar();
      };
    });
    WhimsyAIHints._setTimingForTesting(null);
    await SpecialPowers.popPrefEnv();
  });
});

add_task(async function shots_field_and_panels() {
  useSpeech();
  await BrowserTestUtils.withNewTab(DICTATION_PAGE, async browser => {
    // media-5.5: words go in greyed until final, the pill under the caret.
    await whimsyBothSchemes("w23-voice-image-media-5.5", async () => {
      await focusField(browser);
      await holdFn();
      speech.sessions.at(-1).say("I can do Thursday at");
      await TestUtils.waitForCondition(
        async () => (await SpecialPowers.spawn(browser, [], () => content.document.getElementById("body").value)).endsWith("Thursday at"),
        "Words go into the field"
      );
      const pill = document.getElementById("whimsy-dictation-pill");
      await document.l10n.translateFragment(pill);
      await frames(3);
      WhimsyDictation.placePill(WhimsyDictation.active);
      ok(BrowserTestUtils.isVisible(pill), "The pill shows");
      return async () => {
        WhimsyDictation.cancel();
        speech.fn("up");
      };
    });

    // media-5.9: the microphone is off for Whimsy.
    useSpeech({ mic: "denied" });
    await whimsyBothSchemes("w23-voice-image-media-5.9", async () => {
      await focusField(browser);
      speech.fn("down");
      const panel = await TestUtils.waitForCondition(() => document.getElementById("whimsy-dictation-denied"), "The panel shows");
      await TestUtils.waitForCondition(() => panel.state == "open", "Open");
      await document.l10n.translateFragment(panel);
      await whimsySettled();
      ok(panel.querySelector(".whimsy-dictation-panel-text"), "It names the switch");
      const undo = standInPopups();
      return async () => {
        undo();
        speech.fn("up");
        await closePanels();
      };
    });

    // media-5.10: no on-device dictation for the language.
    useSpeech({ locales: [] });
    await whimsyBothSchemes("w23-voice-image-media-5.10", async () => {
      await openBar();
      speech.fn("down");
      const panel = await TestUtils.waitForCondition(() => document.getElementById("whimsy-dictation-setup"), "The panel shows");
      await TestUtils.waitForCondition(() => panel.state == "open", "Open");
      await document.l10n.translateFragment(panel);
      await whimsySettled();
      ok(panel.querySelector(".whimsy-dictation-panel-text"), "It says where to get it");
      const undo = standInPopups();
      return async () => {
        undo();
        speech.fn("up");
        await closePanels();
        await closeBar();
      };
    });
  });
});

// Image text.

async function selectTwoLines(browser) {
  const { lines } = await imageTextLayer(browser);
  const [l2, l3] = [lines[1].rect, lines[2].rect];
  await BrowserTestUtils.synthesizeMouseAtPoint(l2.x + 2, l2.y + l2.height / 2, { type: "mousedown" }, browser);
  await BrowserTestUtils.synthesizeMouseAtPoint(l3.x + l3.width - 2, l3.y + l3.height / 2, { type: "mousemove" }, browser);
  await BrowserTestUtils.synthesizeMouseAtPoint(l3.x + l3.width - 2, l3.y + l3.height / 2, { type: "mouseup" }, browser);
  // Park the pointer off the image.
  await BrowserTestUtils.synthesizeMouseAtPoint(5, 5, { type: "mousemove" }, browser);
}

async function imageCmdK() {
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
      // Three in the page's text and one in the image.
      await TestUtils.waitForCondition(() => /\/4$/.test(findbar.querySelector(".whimsy-find-count")?.getAttribute("value") ?? ""), "Four matches, one in the image");
      EventUtils.synthesizeKey("KEY_Enter");
      ok(true, "3.4: ⌘F finds the word in the image");
      return async () => {
        findbar.close(true);
        await TestUtils.waitForCondition(() => findbar.hidden, "Closed");
      };
    });
  });
});

add_task(async function shots_image_cmdk() {
  await withImageText("jp", async () => {
    await whimsyBothSchemes("w23-voice-image-media-3.5", async () => {
      const close = await imageCmdK();
      const ids = [];
      for (let i = 0; i < UrlbarTestUtils.getResultCount(window); i++) {
        ids.push((await UrlbarTestUtils.getDetailsOfResultAt(window, i)).result.payload.whimsyVerb);
      }
      info(`3.5 rows: ${ids.join(", ")}`);
      ok(ids.includes("image:copy") && ids.includes("image:save"), "3.5: Copy Image and Save Image As… are listed");
      is(gURLBar.inputField.getAttribute("data-l10n-id"), "whimsy-cmdk-type-command", "3.5: the field says Type a command");
      ok(!BrowserTestUtils.isVisible(document.getElementById("urlbar-search-mode-indicator")), "3.5: no empty search-mode capsule");
      // Group headings: Firefox's row labels, shown for ⌘K's rows.
      const labelled = () => [...gURLBar.view.panel.querySelectorAll(".urlbarView-row[label]")].filter(r => BrowserTestUtils.isVisible(r));
      await TestUtils.waitForCondition(() => labelled().some(r => r.getAttribute("label") == "This image"), "3.5: the This image heading");
      const first = labelled()[0];
      is(first.getAttribute("label"), "This image", "3.5: the first group's heading is This image");
      ok(first.querySelector(".urlbarView-title")?.textContent, "3.5: the headed row keeps its title (the label didn't wipe it)");
      ok(labelled().some(r => r.getAttribute("label") == "This page"), "3.5: This page heads the page's commands");
      await translateBar();
      return close;
    });
  });
  await withImageText("scene", async () => {
    await whimsyBothSchemes("w23-voice-image-media-3.7", async () => {
      const close = await imageCmdK();
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

// Read aloud.

// Starts reading the open article and drives it to sentence `index`.
async function reading(index = 0, { start = true } = {}) {
  WhimsyReadAloud.stop({ animate: false });
  document.getElementById("cmd_whimsyListenPage").doCommand();
  await waitForSpeech(sentenceOf(0));
  if (start) {
    synth.start();
  }
  if (index) {
    WhimsyReadAloud.goTo(index);
  }
  const shown = await cardShown();
  await whimsySettled();
  return shown;
}

async function shoot(name, prepare) {
  await whimsyBothSchemes(`w23-voice-image-${name}`, async dark => {
    const cleanup = await prepare(dark);
    // eslint-disable-next-line mozilla/no-arbitrary-setTimeout
    await new Promise(r => setTimeout(r, 250));
    return async () => {
      await cleanup?.();
      WhimsyReadAloud.stop({ animate: false });
    };
  });
  ok(true, `Shot ${name}`);
}

async function closeVerbsBar() {
  if (gURLBar.view.isOpen) {
    await UrlbarTestUtils.promisePopupClose(window, () => {
      gURLBar.blur();
      if (gURLBar.view.isOpen) {
        gURLBar.view.close();
      }
    });
  }
  gURLBar.searchMode = null;
  WhimsyVerbs.sessions.delete(window);
}

// ⌘K with AI on, typed "listen".
async function cmdKListen() {
  await SimpleTest.promiseFocus(window);
  gBrowser.selectedBrowser.focus();
  WhimsyVerbs.sessions.delete(window);
  EventUtils.synthesizeKey("k", { accelKey: true });
  await TestUtils.waitForCondition(() => WhimsyVerbs.sessions.get(window), "⌘K opened its menu");
  await UrlbarTestUtils.promiseSearchComplete(window);
  EventUtils.sendString("listen");
  await UrlbarTestUtils.promiseSearchComplete(window);
}

add_task(async function shots_read_aloud_cmdk() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.ai.enabled", true]] });
  try {
    await withArticle(async () => {
      await shoot("media-4.1", async () => {
        await cmdKListen();
        const { result } = await UrlbarTestUtils.getDetailsOfResultAt(window, 0);
        is(result.payload.whimsyVerb, "listen-page", "4.1: Listen to this page first");
        return closeVerbsBar;
      });
    });
    await BrowserTestUtils.withNewTab(`${ROOT}whimsy_read_aloud_app.html`, async () => {
      // eslint-disable-next-line mozilla/no-arbitrary-setTimeout
      await new Promise(r => setTimeout(r, 500));
      await shoot("fu-media-4.10", async () => {
        await cmdKListen();
        const { result } = await UrlbarTestUtils.getDetailsOfResultAt(window, 0);
        is(result.payload.dynamicType, "whimsy-verb-off", "4.10: greyed with its reason");
        return closeVerbsBar;
      });
    });
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function shots_player() {
  // Read aloud works with AI off.
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.ai.enabled", false]] });
  await withArticle(async browser => {
    await shoot("media-4.2", async () => {
      const { card } = await reading(0, { start: false });
      ok(card.hasAttribute("busy"), "4.2: starting");
    });
    await shoot("media-4.3", async () => {
      const { card } = await reading(2);
      ok(card.classList.contains("playing"), "4.3: playing");
      is(await highlighted(browser), "Then Austria did something odd.", "4.3: the sentence is tinted");
    });
    await shoot("media-4.4", async () => {
      const { holder } = await reading(3);
      synth.boundary(20);
      InspectorUtils.addPseudoClassLock(holder, ":hover");
      await whimsySettled();
      ok(true, "4.4: pointing at the card");
      return () => InspectorUtils.removePseudoClassLock(holder, ":hover");
    });
    await shoot("fu-media-4.5", async () => {
      Services.prefs.setStringPref("whimsy.read-aloud.rate", "1.25");
      const { card } = await reading(3);
      // The click is covered by browser_whimsy_read_aloud.js; here only the look matters.
      WhimsyReadAloud.openSpeedMenu(window, card.querySelector(".whimsy-read-aloud-speed"));
      const panel = await TestUtils.waitForCondition(() => document.getElementById("whimsy-read-aloud-speed-menu"), "The speed menu opens");
      await TestUtils.waitForCondition(() => panel.state == "open", "The speed menu is open");
      await document.l10n.translateFragment(panel);
      ok(panel.querySelector("[aria-selected='true']")?.textContent.includes("1.25×"), "4.5: 1.25× is checked");
      await whimsySettled();
      const undo = standInPopups();
      return async () => {
        undo();
        const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
        panel.hidePopup();
        await hidden;
        Services.prefs.clearUserPref("whimsy.read-aloud.rate");
      };
    });
    await shoot("media-4.7", async () => {
      const { card } = await reading(4);
      WhimsyReadAloud.pause();
      ok(!card.classList.contains("playing"), "4.7: paused");
    });
    await shoot("media-4.8", async () => {
      const { card } = await reading(4);
      gBrowser.selectedTab.toggleMuteAudio();
      ok(card.hasAttribute("muted"), "4.8: muted from the tab");
      return () => gBrowser.selectedTab.hasAttribute("muted") && gBrowser.selectedTab.toggleMuteAudio();
    });
    await shoot("media-4.9", async () => {
      await reading(0);
      WhimsyReadAloud.goTo(WhimsyReadAloud.session.sentences.length - 1);
      synth.end();
      ok(WhimsyReadAloud.session.card.hasAttribute("finished"), "4.9: finished");
    });

    // The finished card's exit (Zen's zen-removing), mid-way.
    await whimsySetScheme(false);
    try {
      await reading(0);
      WhimsyReadAloud.goTo(WhimsyReadAloud.session.sentences.length - 1);
      synth.end();
      const card = WhimsyReadAloud.session.card;
      await whimsySettled();
      WhimsyReadAloud.stop();
      await whimsyShotMid("w23-voice-image-media-4.9-leave", () => card.getAnimations().find(a => a.transitionProperty == "opacity"), 150);
      await TestUtils.waitForCondition(() => !card.isConnected, "The card leaves");
      ok(true, "Shot the exit mid-way");
    } finally {
      await SpecialPowers.popPrefEnv();
    }
  });
  await SpecialPowers.popPrefEnv();
});
