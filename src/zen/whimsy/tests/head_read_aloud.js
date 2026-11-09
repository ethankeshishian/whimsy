/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

/* exported synth, ROOT, readAloudSetup, withArticle, waitForSpeech, cardShown, highlighted, sentenceOf, click, openSpeedMenu, WhimsyReadAloud, WhimsyVerbs, WhimsyContextCommands */

// W23 voice-image: shared by browser_whimsy_read_aloud.js and its screens.

const { WhimsyReadAloud } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyReadAloud.sys.mjs");
const { WhimsyVerbs, WhimsyContextCommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyVerbs.sys.mjs");

const ROOT = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com");
const ARTICLE = [
  "The night train was supposed to be dead.",
  "By 2016 Germany’s rail operator had sold off its sleeper cars, and the routes that once linked Paris to Moscow had shrunk to a handful of slow, unloved services.",
  "Then Austria did something odd.",
  "ÖBB bought the coaches nobody wanted, rebranded them Nightjet, and started selling beds to people who were tired of airports.",
];

// macOS's voices, stood in: the test says when speech starts, reaches a
// word, and ends.
const synth = {
  current: null,
  spoken: [],
  voices: [
    { name: "Ava (Premium)", voiceURI: "com.apple.voice.premium.en-US.Ava", lang: "en-US", default: true },
    { name: "Samantha", voiceURI: "com.apple.voice.compact.en-US.Samantha", lang: "en-US", default: false },
    { name: "Thomas", voiceURI: "com.apple.voice.compact.fr-FR.Thomas", lang: "fr-FR", default: false },
  ],
  getVoices() {
    return this.voices;
  },
  speak(u) {
    this.spoken.push(u);
    this.current = u;
  },
  cancel() {
    this.current = null;
  },
  start() {
    this.current?.onstart?.();
  },
  boundary(charIndex) {
    this.current?.onboundary?.({ name: "word", charIndex });
  },
  end() {
    const u = this.current;
    this.current = null;
    u?.onend?.();
  },
};

async function readAloudSetup() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["whimsy.ai.enabled", false],
      ["whimsy.feature.ai-hints", false],
      ["reader.parse-on-load.enabled", true],
    ],
  });
  WhimsyReadAloud.testSynth = synth;
  registerCleanupFunction(() => {
    WhimsyReadAloud.stop({ animate: false });
    WhimsyReadAloud.testSynth = null;
    WhimsyReadAloud.leaveDelay = 5000;
    Services.prefs.clearUserPref("whimsy.read-aloud.rate");
    Services.prefs.clearUserPref("whimsy.read-aloud.voice");
    closeToasts();
  });
}

async function withArticle(fn) {
  await BrowserTestUtils.withNewTab(`${ROOT}whimsy_read_aloud.html`, async browser => {
    await TestUtils.waitForCondition(() => browser.isArticle, "Reader View finds the article");
    try {
      await fn(browser);
    } finally {
      WhimsyReadAloud.stop({ animate: false });
      WhimsyReadAloud.leaveDelay = 5000;
    }
  });
}

function sentenceOf(index) {
  return ARTICLE[index];
}

async function waitForSpeech(match) {
  await TestUtils.waitForCondition(
    () => synth.current && (match instanceof RegExp ? match.test(synth.current.text) : synth.current.text == match),
    `Speaking ${match}`
  );
}

async function cardShown(win = window) {
  const holder = win.document.getElementById("whimsy-read-aloud-player");
  await TestUtils.waitForCondition(() => holder && !holder.hidden && holder.querySelector(".zen-media-card"), "The mini player shows");
  return { holder, card: holder.querySelector(".zen-media-card") };
}

// The text tinted in the page under `name`, or "".
async function highlighted(browser, name = "whimsy-read-aloud") {
  // The mark message goes first on the same channel, so this sees it.
  return SpecialPowers.spawn(browser, [name], async which => {
    const highlight = content.CSS.highlights.get(which);
    let range = null;
    highlight?.forEach(r => (range ??= r));
    return range ? range.toString().replace(/\s+/g, " ").trim() : "";
  });
}

// Clicks once the control has stopped moving (the same box on two checks)
// and nothing else is drawn over its centre: the card re-lays out as it
// mutes and pauses, and a click on a moving control can land beside it.
async function click(el) {
  let last = "";
  let covered = null;
  await TestUtils.waitForCondition(() => {
    const r = el.getBoundingClientRect();
    const box = `${r.x},${r.y},${r.width},${r.height}`;
    const still = r.width > 0 && box == last;
    last = box;
    if (!still) {
      return false;
    }
    // A popup is a widget of its own: the window's elementFromPoint can't see into it.
    if (el.closest("panel, menupopup")) {
      return true;
    }
    const hit = el.ownerDocument.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    // Its own parts, or a parent that takes its clicks (the tab's speaker).
    const ours = !!hit && (el.contains(hit) || hit.contains(el));
    if (hit && !ours && hit != covered) {
      covered = hit;
      info(`Over ${el.className} at its centre: ${hit.localName}#${hit.id}.${hit.className}`);
    }
    return ours;
  }, "The control shows, still, with nothing over it");
  EventUtils.synthesizeMouseAtCenter(el, {}, el.ownerDocument.defaultView);
  await new Promise(r => setTimeout(r, 0));
}

async function openSpeedMenu(button) {
  const r = button.getBoundingClientRect();
  info(`Speed button at ${r.x},${r.y} ${r.width}x${r.height}; on top there: ${document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.outerHTML.slice(0, 160)}`);
  await click(button);
  const panel = await TestUtils.waitForCondition(() => document.getElementById("whimsy-read-aloud-speed-menu"), "The speed menu opens");
  await TestUtils.waitForCondition(() => panel.state == "open", "The speed menu is open");
  await document.l10n.translateFragment(panel);
  return panel;
}
