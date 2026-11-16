/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W29 tab equalizer, the panel: the Equalizer rows under the Tab volume
// slider (equalizer.html). A preset menu (Custom only after a drag), 8
// labelled bands behind a chevron whose state is remembered, a setting
// saved per site (a content pref on the base domain) that reaches the
// site's media, the speaker tooltip naming the preset, and the disabled
// state for audio Gecko can't filter.

const DIR = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com");
const PAGE = DIR + "whimsy_eq.html";
const OTHER = DIR.replace("https://example.com", "https://example.org") + "whimsy_eq.html";
const { WhimsyMedia } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyMedia.sys.mjs");
const cps2 = Cc["@mozilla.org/content-pref/service;1"].getService(Ci.nsIContentPrefService2);
const OPEN_PREF = "whimsy.media.eq-bands-open";
const VOICE = [-6, -3, 0, 3, 5, 4, 1, -2];

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["media.autoplay.default", 0],
      ["media.autoplay.blocking_policy", 0],
      ["whimsy.media.background-mute", "off"],
      [OPEN_PREF, false],
    ],
  });
  registerCleanupFunction(async () => {
    await new Promise(resolve =>
      cps2.removeByName("whimsy.equalizer", Cu.createLoadContext(), { handleCompletion: resolve, handleError: resolve })
    );
    WhimsyMedia._eqCache?.clear();
    Services.prefs.clearUserPref(OPEN_PREF);
  });
});

async function playingTab(url = PAGE) {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, url);
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => content.document.getElementById("audio").play());
  await TestUtils.waitForCondition(() => tab.soundPlaying, "playing");
  return tab;
}

async function openPanel(tab) {
  await SimpleTest.promiseFocus(window);
  const panel = WhimsyMedia.openVolumePanel(window, tab);
  await BrowserTestUtils.waitForPopupEvent(panel, "shown");
  await document.l10n.translateFragment(panel);
  return panel;
}

async function closePanel(panel) {
  const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
  panel.hidePopup();
  await hidden;
}

const elementGains = browser =>
  SpecialPowers.spawn(browser, [], () => {
    // What the page's media was last told (the child's record).
    const actor = content.windowGlobalChild.getActor("WhimsyPage");
    return actor.eqGains ? Array.from(actor.eqGains) : null;
  });

const savedPref = site =>
  new Promise(resolve => {
    let value;
    cps2.getByDomainAndName(site, "whimsy.equalizer", Cu.createLoadContext(), {
      handleResult: pref => (value = pref.value),
      handleCompletion: () => resolve(value),
      handleError: () => resolve(undefined),
    });
  });

async function pickPreset(panel, value) {
  const button = panel.querySelector("#whimsy-eq-preset");
  const listShown = TestUtils.waitForCondition(() => document.getElementById("whimsy-eq-preset-list")?.state == "open", "The preset menu is open");
  EventUtils.synthesizeMouseAtCenter(button, {});
  await listShown;
  const list = document.getElementById("whimsy-eq-preset-list");
  const option = list.querySelector(`[role=option][data-value="${value}"]`);
  ok(option, `The menu has ${value}`);
  const hidden = BrowserTestUtils.waitForPopupEvent(list, "hidden");
  EventUtils.synthesizeMouseAtCenter(option, {});
  await hidden;
}

function presetOptions() {
  return [...document.getElementById("whimsy-eq-preset-list").querySelectorAll("[role=option]")].map(o => o.dataset.value);
}

add_task(async function test_rows_presets_and_custom() {
  const tab = await playingTab();
  const panel = await openPanel(tab);
  const eq = panel.querySelector(".whimsy-eq");
  ok(eq.checkVisibility(), "The Equalizer rows show under the volume slider");
  ok(panel.querySelector(".whimsy-volume-row").compareDocumentPosition(eq) & Node.DOCUMENT_POSITION_FOLLOWING, "They come after the volume row");
  Assert.greaterOrEqual(eq.getBoundingClientRect().top, panel.querySelector(".whimsy-volume-row").getBoundingClientRect().bottom, "The Equalizer rows are laid out below the volume row");
  ok(eq.querySelector(".whimsy-surface-rule"), "A hairline separates them");
  // The popup's border and padding reduce the space available to both rows.
  const eqRect = eq.getBoundingClientRect();
  const volumeRect = panel.querySelector(".whimsy-volume-row").getBoundingClientRect();
  const panelRect = panel.getBoundingClientRect();
  is(Math.round(eqRect.left), Math.round(volumeRect.left), "The rows align at the left edge");
  is(Math.round(eqRect.right), Math.round(volumeRect.right), "The rows align at the right edge");
  for (const rect of [eqRect, volumeRect]) {
    Assert.greater(rect.width, 0, "The row has a positive width");
    Assert.greaterOrEqual(rect.left, panelRect.left, "The row fits inside the popup's left edge");
    Assert.lessOrEqual(rect.right, panelRect.right, "The row fits inside the popup's right edge");
  }
  Assert.lessOrEqual(Math.round(panelRect.width), 320, "The panel hugs its rows");
  is(eq.querySelector(".whimsy-eq-label").textContent, "Equalizer", "The row is labelled Equalizer");
  const button = panel.querySelector("#whimsy-eq-preset");
  is(button.getAttribute("aria-label"), "Equalizer preset", "The preset menu is named");
  await TestUtils.waitForCondition(() => button.textContent.trim() == "Flat", "A new site starts Flat");

  // Contrast: the preset menu's text on its filled background (WCAG AA).
  const contrast = contrastOf(button.querySelector(".whimsy-surface-dropdown-value"), button);
  ok(contrast >= 4.5, `The preset menu's text meets 4.5:1 (${contrast.toFixed(2)})`);

  // The bands start hidden; the chevron shows them.
  const bands = panel.querySelector(".whimsy-eq-bands");
  const chevron = panel.querySelector(".whimsy-eq-chevron");
  ok(bands.hidden, "The bands start hidden");
  is(chevron.getAttribute("aria-expanded"), "false", "The chevron says the bands are hidden");
  await TestUtils.waitForCondition(() => chevron.getAttribute("tooltiptext") == "Show bands", "Chevron: Show bands");
  EventUtils.synthesizeMouseAtCenter(chevron, {});
  ok(!bands.hidden, "The chevron shows the bands");
  is(chevron.getAttribute("aria-expanded"), "true", "aria-expanded follows");
  ok(Services.prefs.getBoolPref(OPEN_PREF), "Open bands are remembered");
  await TestUtils.waitForCondition(() => chevron.getAttribute("tooltiptext") == "Hide bands", "Chevron: Hide bands");

  const sliders = [...bands.querySelectorAll("input[type=range]")];
  is(sliders.length, 8, "8 bands");
  await document.l10n.translateFragment(panel);
  Assert.deepEqual(
    sliders.map(s => s.getAttribute("aria-label")),
    ["60 Hz", "150 Hz", "400 Hz", "1k Hz", "2.4k Hz", "6k Hz", "10k Hz", "15k Hz"],
    "Each band is named by its frequency"
  );
  ok(sliders.every(s => s.min == "-12" && s.max == "12" && s.step == "1"), "+-12 dB in 1 dB steps");
  ok(sliders.every(s => s.checkVisibility() && s.getBoundingClientRect().height >= 90), "The bands are upright sliders");
  await TestUtils.waitForCondition(() => sliders[0].getAttribute("aria-valuetext") == "0 decibels", "A band says its gain");
  for (const label of bands.querySelectorAll(".whimsy-eq-freq")) {
    ok(label.scrollWidth <= label.clientWidth + 1, `${label.textContent} isn't clipped`);
  }

  // The preset menu: five presets, no Custom yet.
  await pickPreset(panel, "voice");
  await TestUtils.waitForCondition(() => button.textContent.trim() == "Voice", "Voice picked");
  Assert.deepEqual(sliders.map(s => Number(s.value)), VOICE, "Voice sets the bands");
  await TestUtils.waitForCondition(async () => JSON.stringify(await elementGains(tab.linkedBrowser)) == JSON.stringify(VOICE), "The page's media gets Voice");
  is(JSON.parse(await savedPref("https://example.com/")).preset, "voice", "Voice is saved for the site");
  EventUtils.synthesizeMouseAtCenter(button, {});
  await TestUtils.waitForCondition(() => document.getElementById("whimsy-eq-preset-list")?.state == "open");
  Assert.deepEqual(presetOptions(), ["flat", "voice", "bass-boost", "treble-boost", "loudness"], "No Custom before a drag");
  let list = document.getElementById("whimsy-eq-preset-list");
  let hidden = BrowserTestUtils.waitForPopupEvent(list, "hidden");
  EventUtils.synthesizeKey("KEY_Escape");
  await hidden;

  // Dragging a band: Custom.
  sliders[0].focus();
  EventUtils.synthesizeKey("KEY_ArrowUp");
  is(sliders[0].value, "-5", "The arrow key moves the band");
  await TestUtils.waitForCondition(() => button.textContent.trim() == "Custom", "A drag switches to Custom");
  await TestUtils.waitForCondition(() => sliders[0].getAttribute("aria-valuetext") == "-5 decibels", "The band's value text follows");
  const custom = [-5, ...VOICE.slice(1)];
  await TestUtils.waitForCondition(async () => JSON.stringify(await elementGains(tab.linkedBrowser)) == JSON.stringify(custom), "The page gets the custom gains");
  Assert.deepEqual(JSON.parse(await savedPref("https://example.com/")), { preset: "custom", gains: custom }, "Custom gains are saved");
  EventUtils.synthesizeMouseAtCenter(button, {});
  await TestUtils.waitForCondition(() => document.getElementById("whimsy-eq-preset-list")?.state == "open");
  Assert.deepEqual(presetOptions(), ["flat", "voice", "bass-boost", "treble-boost", "loudness", "custom"], "Custom shows after a drag");
  list = document.getElementById("whimsy-eq-preset-list");
  hidden = BrowserTestUtils.waitForPopupEvent(list, "hidden");
  EventUtils.synthesizeKey("KEY_Escape");
  await hidden;

  // Flat resets everything and forgets the site.
  await pickPreset(panel, "flat");
  ok(sliders.every(s => s.value == "0"), "Flat resets every band");
  await TestUtils.waitForCondition(async () => (await elementGains(tab.linkedBrowser)).every(db => db == 0), "The page's media is flat");
  is(await savedPref("https://example.com/"), undefined, "Nothing is saved for a flat site");

  // The chevron hides the bands again, and that's remembered too.
  EventUtils.synthesizeMouseAtCenter(chevron, {});
  ok(bands.hidden, "The chevron hides the bands");
  ok(!Services.prefs.getBoolPref(OPEN_PREF), "Hidden bands are remembered");
  await closePanel(panel);
  BrowserTestUtils.removeTab(tab);
});

// Contrast between an element's text and the first filled background at or
// above `surface`.
function contrastOf(textEl, surface) {
  const rgb = value => {
    const canvas = document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = value;
    ctx.fillRect(0, 0, 1, 1);
    return [...ctx.getImageData(0, 0, 1, 1).data];
  };
  // Composite the layers from the panel's background up.
  const layers = [];
  for (let node = surface; node && node.nodeType == 1; node = node.parentElement) {
    const color = getComputedStyle(node).backgroundColor;
    if (!/rgba\(\s*0,\s*0,\s*0,\s*0\s*\)|transparent/.test(color)) {
      layers.unshift(rgb(color));
    }
    if (node.localName == "panel") {
      const box = node.shadowRoot?.querySelector("[part~='content']");
      const panelBg = box && getComputedStyle(box).backgroundColor;
      if (panelBg && !/transparent|rgba\(.*, 0\)/.test(panelBg)) {
        layers.unshift(rgb(panelBg));
      }
      break;
    }
  }
  const over = (top, under) => top.slice(0, 3).map((c, i) => (c * top[3] + under[i] * (255 - top[3])) / 255);
  let bg = matchMedia("(prefers-color-scheme: dark)").matches ? [30, 30, 32] : [255, 255, 255];
  for (const layer of layers) {
    bg = over(layer, bg);
  }
  const fg = over(rgb(getComputedStyle(textEl).color), bg);
  const lum = ([r, g, b]) => {
    const lin = c => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  };
  const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

add_task(async function test_per_site_persistence() {
  const tab = await playingTab();
  let panel = await openPanel(tab);
  await pickPreset(panel, "bass-boost");
  await closePanel(panel);

  // Another tab on the same site (a subdomain shares it) gets Bass Boost:
  // its media at once and its panel.
  const same = await playingTab(PAGE.replace("https://example.com", "https://test1.example.com"));
  await TestUtils.waitForCondition(
    async () => JSON.stringify(await elementGains(same.linkedBrowser)) == JSON.stringify([7, 5, 2, 0, 0, 0, 0, 0]),
    "The same site's other tab plays with Bass Boost"
  );
  panel = await openPanel(same);
  const button = panel.querySelector("#whimsy-eq-preset");
  await TestUtils.waitForCondition(() => button.textContent.trim() == "Bass Boost", "Its panel shows Bass Boost");
  await closePanel(panel);

  // A different site is still flat.
  const other = await playingTab(OTHER);
  panel = await openPanel(other);
  await TestUtils.waitForCondition(() => button.textContent.trim() == "Flat", "Another site is Flat");
  await closePanel(panel);
  is(await savedPref("https://example.org/"), undefined, "Nothing is saved for the other site");

  // After a restart (the cache gone), the site's choice comes back from
  // the content pref.
  WhimsyMedia._eqCache.clear();
  BrowserTestUtils.reloadTab(same);
  await BrowserTestUtils.browserLoaded(same.linkedBrowser);
  await SpecialPowers.spawn(same.linkedBrowser, [], () => content.document.getElementById("audio").play());
  await TestUtils.waitForCondition(
    async () => JSON.stringify(await elementGains(same.linkedBrowser)) == JSON.stringify([7, 5, 2, 0, 0, 0, 0, 0]),
    "The saved setting comes back"
  );

  // The speaker's tooltip names the preset; a flat site's doesn't.
  const tooltip = document.createXULElement("tooltip");
  document.getElementById("mainPopupSet").append(tooltip);
  const fakeEvent = trigger => ({
    target: Object.defineProperty(tooltip, "triggerNode", { value: trigger, configurable: true }),
    stopPropagation() {},
    preventDefault() {},
  });
  for (const [t, preset] of [[same, "Bass Boost"], [other, null]]) {
    // As if the pointer were over the speaker (a getter on the tab).
    Object.defineProperty(t, "_overAudioButton", { value: true, configurable: true });
    try {
      gBrowser.createTooltip(fakeEvent(t));
    } finally {
      delete t._overAudioButton;
    }
    const { id, args } = document.l10n.getAttributes(tooltip);
    const [message] = await document.l10n.formatMessages([{ id, args }]);
    const label = message.attributes.find(a => a.name == "label").value;
    if (preset) {
      is(id, "whimsy-eq-speaker-tooltip", "The speaker's tooltip is the equalizer's");
      ok(label.endsWith(` · Equalizer: ${preset}`), `It names the preset: ${label}`);
      ok(/tab/i.test(label.split(" · ")[0]), "It keeps Firefox's mute text first");
    } else {
      ok(!label.includes("Equalizer"), `A flat site's tooltip is Firefox's own: ${label}`);
    }
  }
  tooltip.remove();

  panel = await openPanel(same);
  await pickPreset(panel, "flat");
  await closePanel(panel);
  for (const t of [tab, same, other]) {
    BrowserTestUtils.removeTab(t);
  }
});

add_task(async function test_unsupported_audio() {
  // A media stream (a call, generated audio) can't be filtered: the panel
  // disables the equalizer and says why.
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => content.wrappedJSObject.playStream());
  await TestUtils.waitForCondition(
    () => SpecialPowers.spawn(tab.linkedBrowser, [], () => content.document.getElementById("audio").currentTime > 0),
    "The stream plays"
  );
  const panel = await openPanel(tab);
  const note = panel.querySelector(".whimsy-eq-unsupported");
  await TestUtils.waitForCondition(() => !note.hidden, "The panel says the audio can't be adjusted");
  await document.l10n.translateFragment(panel);
  is(note.textContent, "This site's audio can't be adjusted.", "The note's copy");
  ok(panel.querySelector("#whimsy-eq-preset").disabled, "The preset menu is disabled");
  ok([...panel.querySelectorAll(".whimsy-eq-slider")].every(s => s.disabled), "The bands are disabled");
  await closePanel(panel);
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_feature_switch() {
  const tab = await playingTab();
  WhimsyMedia.setSiteEq(tab.linkedBrowser, "voice");
  await TestUtils.waitForCondition(async () => JSON.stringify(await elementGains(tab.linkedBrowser)) == JSON.stringify(VOICE), "Voice on");
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.tab-eq", false]] });
  await TestUtils.waitForCondition(async () => (await elementGains(tab.linkedBrowser)).length == 0, "Off: the media plays flat");
  const panel = await openPanel(tab);
  ok(panel.querySelector(".whimsy-eq").hidden, "Off: no Equalizer rows");
  await closePanel(panel);
  await SpecialPowers.popPrefEnv();
  await TestUtils.waitForCondition(async () => JSON.stringify(await elementGains(tab.linkedBrowser)) == JSON.stringify(VOICE), "On again: Voice comes back");
  await WhimsyMedia.setSiteEq(tab.linkedBrowser, "flat");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_screenshots() {
  // Light and dark, bands open, with Voice.
  const tab = await playingTab();
  await WhimsyMedia.setSiteEq(tab.linkedBrowser, "voice");
  Services.prefs.setBoolPref(OPEN_PREF, true);
  for (const dark of [false, true]) {
    await whimsySetScheme(dark);
    const panel = await openPanel(tab);
    await whimsySettled();
    const button = panel.querySelector("#whimsy-eq-preset");
    await TestUtils.waitForCondition(() => button.textContent.trim() == "Voice", "Voice shows");
    const contrast = contrastOf(button.querySelector(".whimsy-surface-dropdown-value"), button);
    ok(contrast >= 4.5, `${dark ? "Dark" : "Light"}: the preset menu's text meets 4.5:1 (${contrast.toFixed(2)})`);
    const label = panel.querySelector(".whimsy-eq-label");
    ok(label.scrollWidth <= label.clientWidth + 1, "The Equalizer label isn't clipped");
    const undo = whimsyStandInPopups();
    try {
      await whimsyShot(`w29-equalizer-${dark ? "dark" : "light"}`);
    } finally {
      undo();
    }
    await closePanel(panel);
    await SpecialPowers.popPrefEnv();
  }
  Services.prefs.setBoolPref(OPEN_PREF, false);
  await WhimsyMedia.setSiteEq(tab.linkedBrowser, "flat");
  BrowserTestUtils.removeTab(tab);
});
