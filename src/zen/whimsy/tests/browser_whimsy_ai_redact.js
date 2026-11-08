/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W23: the one redactor. Password, card, and one-time-code fields never
// reach a model: left out of page text, masked solid before a capture.

const { WhimsyAIContext } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIContext.sys.mjs");
const { WhimsyAISensitive, MASK_COLOR } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAISensitive.sys.mjs");

const ROOT = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com");
const PAGE = ROOT + "whimsy_ai_sensitive.html";
const HOST = ROOT + "whimsy_ai_payment_host.html";

// Fixture secrets, built by concatenation.
const PASSWORD = "hunter" + "2" + "Pass!";
const CARD = ["4111", "1111", "1111", "1111"].join(" ");
const OTP = "48" + "2913";
const YELLOW = [255, 230, 0];
const MASK = MASK_COLOR.match(/\d+/g).map(Number);

// Typing here is fixture data: whatever drafts it leaves use the test key
// store and are gone before the next file.
add_setup(async function () {
  const { OSKeyStoreTestUtils } = ChromeUtils.importESModule("resource://testing-common/OSKeyStoreTestUtils.sys.mjs");
  const { WhimsyFormDrafts } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyFormProtection.sys.mjs");
  OSKeyStoreTestUtils.setup();
  registerCleanupFunction(async () => {
    await WhimsyFormDrafts.forgetAll();
    await OSKeyStoreTestUtils.cleanup();
  });
});

async function typeInto(browser, selector, text) {
  browser.focus();
  await BrowserTestUtils.synthesizeMouseAtCenter(selector, {}, browser);
  await TestUtils.waitForCondition(() => SpecialPowers.spawn(browser, [selector], sel => {
    const el = content.document.querySelector(sel);
    el.focus();
    return content.document.hasFocus() && content.document.activeElement == el;
  }), `${selector} has focus`);
  EventUtils.sendString(text);
  await TestUtils.waitForCondition(() => SpecialPowers.spawn(browser, [selector, text], (sel, want) => {
    const el = content.document.querySelector(sel);
    return (el.value ?? el.textContent).includes(want);
  }), `${selector} holds what was typed`);
}

async function rectOf(browser, selector) {
  return SpecialPowers.spawn(browser, [selector], sel => {
    const r = content.document.querySelector(sel).getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  });
}

async function pixelAt(browser, x, y) {
  const bitmap = await whimsySnapshot(browser.browsingContext.currentWindowGlobal, new DOMRect(x, y, 1, 1), 1, "white");
  const canvas = document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);
  return [...ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)];
}

function near(actual, expected, label) {
  ok(actual.every((v, i) => Math.abs(v - expected[i]) <= 6), `${label}: ${actual} is ${expected}`);
}

async function openFilled() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const browser = tab.linkedBrowser;
  await typeInto(browser, "#pw", PASSWORD);
  await typeInto(browser, "#cc", CARD);
  await typeInto(browser, "#otp", OTP);
  await typeInto(browser, "#otpedit", OTP);
  return tab;
}

add_task(async function password_card_otp_fields_never_in_text() {
  const tab = await openFilled();
  const data = await WhimsyAIContext.extract(tab.linkedBrowser);
  ok(data.text.includes("Plain words about the order."), "Page text is there");
  ok(data.text.includes("Ada Lovelace"), "An ordinary field's value is there");
  ok(data.text.includes("94110"), "A postal code isn't taken for a one-time code");
  ok(!data.text.includes(PASSWORD), "The password isn't in the text, not even mirrored into the page");
  ok(!data.text.includes(CARD) && !data.text.includes(CARD.replace(/ /g, "")), "The card number isn't in the text");
  ok(!data.text.includes(OTP), "The one-time code isn't in the text");
  is(data.sensitiveRects.filter(r => r.kind != "mirror").length, 4, "Four secret fields are known");
  is(data.sensitiveRects.filter(r => r.kind == "mirror").length, 1, "So is the password the page shows again");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function redacts_card_run_in_textarea() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  await typeInto(tab.linkedBrowser, "#notes", "pay with " + CARD + " please");
  const data = await WhimsyAIContext.extract(tab.linkedBrowser);
  ok(data.text.includes("pay with [card number] please"), "The card run in a textarea is replaced");
  ok(!data.text.includes(CARD), "The digits are gone");
  const key = "sk_" + "live_" + "abcdefghij0123456789";
  is(WhimsyAISensitive.redactText(`key ${key} ok`).text, "key [secret] ok", "A key-looking string is replaced");
  is(WhimsyAISensitive.redactText("mail ada@example.com").text, "mail ada@example.com", "Emails stay");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function masks_cross_origin_payment_frame() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, HOST);
  const browser = tab.linkedBrowser;
  await TestUtils.waitForCondition(() =>
    browser.browsingContext.children[0]?.currentWindowGlobal?.documentURI?.spec.includes("payment_frame"),
  "The payment frame loaded");
  const frameBC = browser.browsingContext.children[0];
  await SpecialPowers.spawn(frameBC, [], async () => {
    if (content.document.readyState != "complete") {
      await new Promise(r => content.addEventListener("load", r, { once: true }));
    }
    await new Promise(r => content.requestAnimationFrame(() => content.requestAnimationFrame(r)));
  });
  const data = await WhimsyAIContext.extract(browser);
  ok(data.text.includes("Store page text"), "The store's own text is there");
  ok(!data.text.includes("Pay securely"), "Nothing from the payment frame is in the text");
  const r = await rectOf(browser, "#pay");
  // Clear of the frame's scrollbar, which holds nothing of the page's.
  const x = r.x + r.width - 30;
  const y = r.y + r.height - 10;
  near(await pixelAt(browser, x, y), YELLOW, "Unmasked, the frame shows");
  const masked = await WhimsyAIContext.withMask(browser, () => pixelAt(browser, x, y));
  near(masked, MASK, "Masked, the whole payment frame is the mask colour");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function otp_in_contenteditable_is_masked() {
  const tab = await openFilled();
  const browser = tab.linkedBrowser;
  is(await SpecialPowers.spawn(browser, [], () => content.document.getElementById("otpedit").textContent.length > 0), true,
    "The code was typed into the contenteditable");
  for (const sel of ["#otpedit", "#pw", "#cc", "#otp", "#mirror"]) {
    const r = await rectOf(browser, sel);
    const px = await WhimsyAIContext.withMask(browser, () => pixelAt(browser, r.x + 10, r.y + r.height / 2));
    near(px, MASK, `${sel} is masked`);
  }
  const name = await rectOf(browser, "#name");
  near(await WhimsyAIContext.withMask(browser, () => pixelAt(browser, name.x + 200, name.y + name.height / 2)), YELLOW,
    "An ordinary field isn't masked");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function mask_lifts_after_capture() {
  const tab = await openFilled();
  const browser = tab.linkedBrowser;
  const r = await rectOf(browser, "#cc");
  const x = r.x + r.width - 10;
  const y = r.y + r.height / 2;
  near(await WhimsyAIContext.withMask(browser, () => pixelAt(browser, x, y)), MASK, "Masked during the capture");
  near(await pixelAt(browser, x, y), YELLOW, "The mask is gone afterwards");
  await Assert.rejects(WhimsyAIContext.withMask(browser, () => { throw new Error("capture failed"); }), /capture failed/,
    "A failed capture still rejects");
  near(await pixelAt(browser, x, y), YELLOW, "The mask lifts after a failed capture too");
  BrowserTestUtils.removeTab(tab);
});
