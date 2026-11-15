/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W28 verification codes: the field button. A code field gets it only when
// the site has codes in this profile; one code fills on a click; two open
// the chooser; under 5 seconds left the next code fills; no button in a
// private window, another profile, or with the feature off.

const { WhimsyTOTP, STORE_ORIGIN, totp } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyTOTP.sys.mjs"
);
const { WhimsyProfiles } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyProfiles.sys.mjs");

const ROOT = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com");
const PAGE = ROOT + "whimsy_totp_page.html";
const HOST_ID = "whimsy-totp-host";
const ENTRY = { issuer: "Example", account: "octocat", secret: "JBSWY3DPEHPK3PXP", algorithm: "SHA1", digits: 6, period: 30 };
const WORK = { ...ENTRY, account: "octocat-work", secret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ" };
// Ten seconds into a step: well clear of the rollover.
const CLEAR = 1_699_999_990_000;

const realNow = WhimsyTOTP._now;

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.totp", true]] });
  WhimsyTOTP._now = () => CLEAR;
  registerCleanupFunction(async () => {
    WhimsyTOTP._now = realNow;
    await removeCodes();
  });
});

async function save(entry, profileId = 0) {
  await WhimsyTOTP._store.save({
    site: "example.com",
    profileKey: WhimsyProfiles.keyFor(profileId),
    profileName: WhimsyProfiles.nameOf(profileId),
    account: entry.account,
    entry,
  });
}

async function removeCodes() {
  for (const login of await Services.logins.searchLoginsAsync({ origin: STORE_ORIGIN })) {
    await Services.logins.removeLoginAsync(login);
  }
  WhimsyTOTP._store.invalidate();
}

function hasButton(browser) {
  return SpecialPowers.spawn(browser, [HOST_ID], hostId => !!content.document.getElementById(hostId));
}

async function focusField(browser, id) {
  await SpecialPowers.spawn(browser, [id], fieldId => content.document.getElementById(fieldId).focus());
}

function fieldValue(browser, id) {
  return SpecialPowers.spawn(browser, [id], fieldId => content.document.getElementById(fieldId).value);
}

async function clickButton(browser) {
  await TestUtils.waitForCondition(() => hasButton(browser), "The fill button appeared");
  await SpecialPowers.spawn(browser, [HOST_ID], hostId => {
    content.document.getElementById(hostId).openOrClosedShadowRoot.querySelector("button").click();
  });
}

// Waits a few turns for something that shouldn't happen.
async function stillNo(check) {
  for (let i = 0; i < 10; i++) {
    await TestUtils.waitForTick();
  }
  return !(await check());
}

add_task(async function button_only_where_codes_are_saved() {
  await removeCodes();
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await focusField(browser, "otp");
    ok(await stillNo(() => hasButton(browser)), "No button while the site has no codes");
  });
  await save(ENTRY);
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await focusField(browser, "name");
    ok(await stillNo(() => hasButton(browser)), "No button in a name field");
    await focusField(browser, "promo");
    ok(await stillNo(() => hasButton(browser)), "No button in a promo code field");
    await focusField(browser, "otp");
    await TestUtils.waitForCondition(() => hasButton(browser), "A button in the one-time-code field");
    const label = await SpecialPowers.spawn(browser, [HOST_ID], hostId =>
      content.document.getElementById(hostId).openOrClosedShadowRoot.querySelector("button").getAttribute("aria-label"));
    is(label, "Fill verification code", "Its label");
    await focusField(browser, "verify");
    await TestUtils.waitForCondition(() => hasButton(browser), "and in a short field labelled as a code");
  });
});

add_task(async function one_code_fills() {
  await removeCodes();
  await save(ENTRY);
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await focusField(browser, "otp");
    await clickButton(browser);
    const want = await totp(ENTRY, CLEAR);
    await TestUtils.waitForCondition(async () => (await fieldValue(browser, "otp")) == want, "The code was filled");
    ok(!document.getElementById("whimsy-totp-chooser"), "No chooser for one code");
    await TestUtils.waitForCondition(async () => !(await hasButton(browser)), "The button goes once it's filled");
  });
});

add_task(async function rollover_fills_the_next_code() {
  await removeCodes();
  await save(ENTRY);
  const late = CLEAR + 17_000; // 3 seconds left in the step
  WhimsyTOTP._now = () => late;
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await focusField(browser, "otp");
    await clickButton(browser);
    const next = await totp(ENTRY, late + 3_000);
    isnot(next, await totp(ENTRY, late), "The two steps differ");
    await TestUtils.waitForCondition(async () => (await fieldValue(browser, "otp")) == next, "The next code was filled");
  });
  WhimsyTOTP._now = () => CLEAR;
});

add_task(async function two_codes_open_the_chooser() {
  await removeCodes();
  await save(ENTRY);
  await save(WORK);
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await focusField(browser, "otp");
    const shown = BrowserTestUtils.waitForEvent(document, "popupshown", false, e => e.target.id == "whimsy-totp-chooser");
    await clickButton(browser);
    const { target: panel } = await shown;
    is(document.getElementById("whimsy-totp-chooser-title").textContent, "Choose an account", "The chooser's title");
    const cards = [...panel.querySelectorAll("[role=radio]")];
    Assert.deepEqual(cards.map(c => c.dataset.account).sort(), ["octocat", "octocat-work"], "Both accounts");
    const work = cards.find(c => c.dataset.account == "octocat-work");
    const code = await totp(WORK, CLEAR);
    await TestUtils.waitForCondition(() => work.querySelector(".whimsy-surface-choice-detail").textContent, "Details translated");
    is(work.querySelector(".whimsy-surface-choice-detail").textContent, `${code.slice(0, 3)} ${code.slice(3)} · 20s`,
      "Each with its code and seconds");
    await whimsyBothSchemes("w28-totp-chooser", async dark => {
      for (const el of [document.getElementById("whimsy-totp-chooser-title"), work.querySelector(".whimsy-surface-choice-name"),
        work.querySelector(".whimsy-surface-choice-detail")]) {
        const ratio = contrastOf(el);
        Assert.greaterOrEqual(ratio, 4.5, `${dark ? "dark" : "light"}: ${el.className || el.id} contrast ${ratio.toFixed(2)}:1`);
      }
      return whimsyStandInPopups();
    });
    const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
    EventUtils.synthesizeMouseAtCenter(work, {}, window);
    await hidden;
    await TestUtils.waitForCondition(async () => (await fieldValue(browser, "otp")) == code, "The picked account's code was filled");
  });
});

add_task(async function a_fill_needs_the_click() {
  await removeCodes();
  await save(ENTRY);
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await focusField(browser, "otp");
    await TestUtils.waitForCondition(() => hasButton(browser), "The button");
    // A fill the person didn't click for goes nowhere.
    const actor = browser.browsingContext.currentWindowGlobal.getActor("WhimsyTOTP");
    const filled = await actor.sendQuery("WhimsyTOTP:Fill", { code: "123456" });
    ok(!filled, "Not filled without a click on the button");
    is(await fieldValue(browser, "otp"), "", "The field is still empty");
    // A synthetic (untrusted) click from the page does nothing.
    await SpecialPowers.spawn(browser, [HOST_ID], hostId => {
      // Handed to the page, which clicks it from its own script.
      content.wrappedJSObject.whimsyButton = content.document.getElementById(hostId).openOrClosedShadowRoot.querySelector("button");
      const script = content.document.createElement("script");
      script.textContent = "whimsyButton.click(); whimsyButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));";
      content.document.body.append(script);
      delete content.wrappedJSObject.whimsyButton;
    });
    ok(await stillNo(async () => (await fieldValue(browser, "otp")) != ""), "An untrusted click fills nothing");
  });
});

add_task(async function not_elsewhere() {
  await removeCodes();
  await save(ENTRY);
  // Another profile's tab.
  const work = WhimsyProfiles.create("Codes Elsewhere");
  try {
    const tab = BrowserTestUtils.addTab(gBrowser, PAGE, { userContextId: work });
    gBrowser.selectedTab = tab;
    await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, PAGE);
    await focusField(tab.linkedBrowser, "otp");
    ok(await stillNo(() => hasButton(tab.linkedBrowser)), "No button in another profile");
    BrowserTestUtils.removeTab(tab);
  } finally {
    const { ContextualIdentityService } = ChromeUtils.importESModule(
      "moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs"
    );
    ContextualIdentityService.remove(work);
  }
  // A private window.
  const win = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  const tab = await BrowserTestUtils.openNewForegroundTab(win.gBrowser, PAGE);
  await focusField(tab.linkedBrowser, "otp");
  ok(await stillNo(() => hasButton(tab.linkedBrowser)), "No button in a private window");
  await BrowserTestUtils.closeWindow(win);
  // The feature off.
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.totp", false]] });
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await focusField(browser, "otp");
    ok(await stillNo(() => hasButton(browser)), "No button with the feature off");
  });
  await SpecialPowers.popPrefEnv();
});

function srgb(color) {
  const canvas = document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  return [...ctx.getImageData(0, 0, 1, 1).data];
}

function contrastOf(el) {
  const luminance = ([r, g, b]) => {
    const lin = c => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  };
  const win = el.ownerDocument.defaultView;
  let bg = "white";
  for (let node = el; node; node = node.parentElement) {
    const color = win.getComputedStyle(node).backgroundColor;
    if (srgb(color)[3] == 255) {
      bg = color;
      break;
    }
  }
  // A translucent text colour is blended onto the background first.
  const [fr, fg, fb, fa] = srgb(win.getComputedStyle(el).color);
  const [br, bgG, bb] = srgb(bg);
  const a = fa / 255;
  const text = [fr * a + br * (1 - a), fg * a + bgG * (1 - a), fb * a + bb * (1 - a)];
  const [hi, lo] = [luminance(text), luminance([br, bgG, bb])].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
