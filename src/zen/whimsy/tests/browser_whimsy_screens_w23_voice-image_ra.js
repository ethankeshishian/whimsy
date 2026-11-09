/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W23 voice-image: read aloud's screenshots. ⌘K (media-4.1, fu-media 4.10),
// starting (media-4.2), playing (4.3), pointing at the card (4.4), the speed
// and voice menu (fu-media 4.5), paused (4.7), muted from the tab (4.8),
// finished (4.9) and the card's exit mid-way.

Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "head_read_aloud.js", this);

const { UrlbarTestUtils } = ChromeUtils.importESModule("resource://testing-common/UrlbarTestUtils.sys.mjs");
UrlbarTestUtils.init(this);

add_setup(async function () {
  await readAloudSetup();
});

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

// drawSnapshot misses XUL panels: a copy of each open one, in the window.
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
    for (const name of ["background-color", "border-top", "border-right", "border-bottom", "border-left", "border-radius", "box-shadow", "padding", "color", "font-family", "font-size", "font-weight", "line-height"]) {
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

async function closeBar() {
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

add_task(async function shots_cmdk() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.ai.enabled", true]] });
  try {
    await withArticle(async () => {
      await shoot("media-4.1", async () => {
        await cmdKListen();
        const { result } = await UrlbarTestUtils.getDetailsOfResultAt(window, 0);
        is(result.payload.whimsyVerb, "listen-page", "4.1: Listen to this page first");
        return closeBar;
      });
    });
    await BrowserTestUtils.withNewTab(`${ROOT}whimsy_read_aloud_app.html`, async () => {
      // eslint-disable-next-line mozilla/no-arbitrary-setTimeout
      await new Promise(r => setTimeout(r, 500));
      await shoot("fu-media-4.10", async () => {
        await cmdKListen();
        const { result } = await UrlbarTestUtils.getDetailsOfResultAt(window, 0);
        is(result.payload.dynamicType, "whimsy-verb-off", "4.10: greyed with its reason");
        return closeBar;
      });
    });
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function shots_player() {
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
});
