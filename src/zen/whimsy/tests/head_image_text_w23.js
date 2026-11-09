/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W23 voice-image: the stand-in recognizer for whimsy_image_text.html's
// images. Each line's box on the 632×360 sign, which is turned -2° about
// (288, 177), as Vision would report it (normalized quads).

const { WhimsyImageText } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyImageText.sys.mjs");

const IMAGE_TEXT_ROOT = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com");
const IMAGE_TEXT_PAGE = kind => `${IMAGE_TEXT_ROOT}whimsy_image_text.html?img=${kind}`;

const IMAGE_TEXT_LINES = {
  en: [
    ["SINCE 1887", 148, 141, 84, 13],
    ["Hoshino Tea House", 148, 162, 280, 30],
    ["Open daily 9:00 to 17:00", 148, 198, 190, 17],
  ],
  jp: [
    ["創業 1887", 148, 141, 70, 13],
    ["星野茶舗", 148, 162, 130, 30],
    ["営業時間 9:00〜17:00 · 年中無休", 148, 198, 250, 17],
  ],
};

function imageTextQuad(x, y, w, h) {
  const angle = (-2 * Math.PI) / 180;
  const turn = ([px, py]) => {
    const dx = px - 288;
    const dy = py - 177;
    return [(288 + dx * Math.cos(angle) - dy * Math.sin(angle)) / 632, (177 + dx * Math.sin(angle) + dy * Math.cos(angle)) / 360];
  };
  return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].map(turn);
}

function imageTextRecognizer(src) {
  const kind = /sign_(en|jp)\.svg$/.exec(src)?.[1];
  return kind ? IMAGE_TEXT_LINES[kind].map(([text, x, y, w, h]) => ({ text, quad: imageTextQuad(x, y, w, h) })) : [];
}

// A tab on the page with its image recognized.
async function withImageText(kind, fn) {
  await BrowserTestUtils.withNewTab(IMAGE_TEXT_PAGE(kind), async browser => {
    const src = `${IMAGE_TEXT_ROOT}whimsy_image_text_${kind == "scene" ? "scene" : `sign_${kind}`}.svg`;
    const state = () =>
      SpecialPowers.spawn(browser, [], () => {
        const actor = content.windowGlobalChild.getExistingActor("WhimsyImageText");
        return actor ? { actor: true, observing: !!actor.observer, images: actor.images.size, pending: actor.pending.size, timers: actor.timers.size } : { actor: false };
      });
    try {
      await TestUtils.waitForCondition(async () => (await state()).images > 0, "The image in view was recognized");
    } catch (e) {
      let registered;
      try {
        browser.browsingContext.currentWindowGlobal.getActor("WhimsyImageText");
        registered = true;
      } catch (err) {
        registered = String(err);
      }
      info(`Image text state: ${JSON.stringify(await state())}, parent actor: ${registered}, feature: ${Services.prefs.getBoolPref("whimsy.feature.image-text", true)}`);
      throw e;
    }
    await fn(browser, src);
  });
}

// The lines' boxes in the page (viewport CSS px) and their styles.
function imageTextLayer(browser) {
  return SpecialPowers.spawn(browser, [], () => {
    const actor = content.windowGlobalChild.getExistingActor("WhimsyImageText");
    const out = [];
    for (const info of actor.images.values()) {
      for (const el of info.els) {
        const r = el.getBoundingClientRect();
        const style = content.getComputedStyle(el);
        out.push({
          text: el.textContent,
          rect: { x: r.x, y: r.y, width: r.width, height: r.height },
          cursor: style.cursor,
          color: style.color,
          background: style.backgroundColor,
          translated: el.classList.contains("translated"),
        });
      }
    }
    const pill = [...actor.images.values()].find(i => i.pill)?.pill;
    return { lines: out, pill: pill ? { text: pill.querySelector("span").textContent, button: pill.querySelector("button").textContent } : null };
  });
}
