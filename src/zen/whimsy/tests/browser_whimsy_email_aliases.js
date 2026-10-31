/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Email aliases (whimsy.feature.email-aliases): a button in email fields
// opens a chrome menu with iCloud Hide My Email and Firefox Relay. iCloud's
// network calls are stubbed; no request leaves the test.

const { WhimsyEmailAliases } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyEmailAliases.sys.mjs"
);

const ROOT = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com");
const PAGE = ROOT + "whimsy_email_form.html";
const HOST_ID = "whimsy-email-aliases-host";

const requests = [];
const toasts = [];
let signIns = 0;
let signedIn = true;
let failGenerate = false;

const real = {
  request: WhimsyEmailAliases._request,
  cookie: WhimsyEmailAliases.hasICloudCookie,
  signIn: WhimsyEmailAliases.openICloudSignIn,
  toast: gZenUIManager.showToast,
};

add_setup(async function () {
  WhimsyEmailAliases.hasICloudCookie = () => signedIn;
  WhimsyEmailAliases.openICloudSignIn = () => signIns++;
  WhimsyEmailAliases._request = async (url, body) => {
    requests.push({ url, body: body ? JSON.parse(body) : null });
    if (url.includes("/validate")) {
      return {
        status: 200,
        json: {
          dsInfo: { dsid: "42" },
          webservices: { premiummailsettings: { url: "https://p99-maildomainws.icloud.com:443" } },
        },
      };
    }
    if (url.includes("/hme/generate")) {
      return failGenerate
        ? { status: 500, json: null }
        : { status: 200, json: { success: true, result: { hme: "quiet.fox@icloud.com" } } };
    }
    if (url.includes("/hme/reserve")) {
      return { status: 200, json: { success: true, result: {} } };
    }
    return { status: 404, json: null };
  };
  gZenUIManager.showToast = id => toasts.push(id);
  registerCleanupFunction(() => {
    WhimsyEmailAliases._request = real.request;
    WhimsyEmailAliases.hasICloudCookie = real.cookie;
    WhimsyEmailAliases.openICloudSignIn = real.signIn;
    gZenUIManager.showToast = real.toast;
    WhimsyEmailAliases.clearStatus();
  });
});

function reset() {
  requests.length = 0;
  toasts.length = 0;
  signIns = 0;
  failGenerate = false;
  WhimsyEmailAliases.clearStatus();
}

async function focusField(browser, id) {
  await SpecialPowers.spawn(browser, [id], fieldId => content.document.getElementById(fieldId).focus());
}

function hasButton(browser) {
  return SpecialPowers.spawn(browser, [HOST_ID], hostId => !!content.document.getElementById(hostId));
}

// Clicks the button (a trusted click from privileged code) and waits for
// the chrome menu with its iCloud row settled.
async function openMenu(browser) {
  await TestUtils.waitForCondition(() => hasButton(browser), "The alias button appeared");
  const popupShown = BrowserTestUtils.waitForEvent(document, "popupshown", false,
    e => e.target.id == "whimsy-email-aliases-popup");
  await SpecialPowers.spawn(browser, [HOST_ID], hostId => {
    content.document.getElementById(hostId).openOrClosedShadowRoot.querySelector("button").click();
  });
  const { target: popup } = await popupShown;
  const icloud = popup.querySelector("#whimsy-email-aliases-icloud");
  await TestUtils.waitForCondition(() => !icloud.disabled || icloud.dataset.action === "" &&
    icloud.getAttribute("data-l10n-id") != "whimsy-email-aliases-icloud-checking", "iCloud status settled");
  return { popup, icloud };
}

async function choose(popup, item) {
  const hidden = BrowserTestUtils.waitForPopupEvent(popup, "hidden");
  popup.activateItem(item);
  await hidden;
}

function fieldValue(browser, id) {
  return SpecialPowers.spawn(browser, [id], fieldId => content.document.getElementById(fieldId).value);
}

add_task(async function test_button_only_in_email_fields() {
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await focusField(browser, "name");
    ok(!(await hasButton(browser)), "No button in a name field");
    await focusField(browser, "email");
    await TestUtils.waitForCondition(() => hasButton(browser), "Button in a type=email field");
    await focusField(browser, "password");
    await TestUtils.waitForCondition(async () => !(await hasButton(browser)), "Leaving the field hides it");
    await focusField(browser, "contact");
    await TestUtils.waitForCondition(() => hasButton(browser), "Button in a field named like email");
  });
});

add_task(async function test_icloud_signed_in_fills() {
  reset();
  signedIn = true;
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await focusField(browser, "email");
    const { popup, icloud } = await openMenu(browser);
    is(icloud.getAttribute("data-l10n-id"), "whimsy-email-aliases-icloud", "Signed in: one-click Hide My Email");
    await choose(popup, icloud);
    await TestUtils.waitForCondition(async () => (await fieldValue(browser, "email")) == "quiet.fox@icloud.com",
      "The new address was filled in");
    const reserve = requests.find(r => r.url.includes("/hme/reserve"));
    ok(reserve.url.startsWith("https://p99-maildomainws.icloud.com/v1/hme/reserve?"), "Uses the account's own service URL");
    ok(reserve.url.includes("dsid=42"), "Sends the account's dsid");
    is(reserve.body.hme, "quiet.fox@icloud.com", "Reserves the generated address");
    is(reserve.body.label, "example.com", "Labelled with the site (from the principal)");
    ok(toasts.includes("whimsy-email-aliases-toast-filled"), "A toast confirms it");
  });
});

add_task(async function test_icloud_signed_out_opens_sign_in() {
  reset();
  signedIn = false;
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await focusField(browser, "email");
    const { popup, icloud } = await openMenu(browser);
    is(icloud.getAttribute("data-l10n-id"), "whimsy-email-aliases-icloud-sign-in", "Signed out: the row says so");
    is(requests.length, 0, "No request without an iCloud session");
    await choose(popup, icloud);
    is(signIns, 1, "Choosing it opens iCloud sign-in");
    is(await fieldValue(browser, "email"), "", "Nothing was filled");
  });
  signedIn = true;
});

add_task(async function test_icloud_failure_is_not_silent() {
  reset();
  failGenerate = true;
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await focusField(browser, "email");
    const { popup, icloud } = await openMenu(browser);
    await choose(popup, icloud);
    await TestUtils.waitForCondition(() => toasts.includes("whimsy-email-aliases-toast-icloud-failed"),
      "A failure toast appears");
    is(await fieldValue(browser, "email"), "", "Nothing was filled");
  });
});

add_task(async function test_relay_row_follows_firefox_pref() {
  reset();
  await SpecialPowers.pushPrefEnv({ set: [["signon.firefoxRelay.feature", "disabled"]] });
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await focusField(browser, "email");
    const { popup } = await openMenu(browser);
    ok(popup.querySelector("#whimsy-email-aliases-relay").hidden, "Relay is hidden when Firefox's Relay is off");
    const hidden = BrowserTestUtils.waitForPopupEvent(popup, "hidden");
    popup.hidePopup();
    await hidden;
  });
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_switches_off() {
  for (const pref of ["whimsy.feature.email-aliases", "whimsy.email-aliases.button"]) {
    await SpecialPowers.pushPrefEnv({ set: [[pref, false]] });
    await BrowserTestUtils.withNewTab(PAGE, async browser => {
      await focusField(browser, "email");
      await TestUtils.waitForTick();
      ok(!(await hasButton(browser)), `No button with ${pref} off`);
    });
    await SpecialPowers.popPrefEnv();
  }
});

// fix7/tabs: the button is filled (white glyph on a solid blue, readable on
// any field) and steps left of another password manager's inline button
// instead of sitting under it, including one that arrives after focus.
add_task(async function test_filled_and_clear_of_password_managers() {
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await focusField(browser, "email");
    await TestUtils.waitForCondition(() => hasButton(browser), "The alias button appeared");
    const plain = await SpecialPowers.spawn(browser, [HOST_ID], hostId => {
      const host = content.document.getElementById(hostId);
      const button = host.openOrClosedShadowRoot.querySelector("button");
      const style = content.getComputedStyle(button);
      const field = content.document.getElementById("email").getBoundingClientRect();
      return {
        background: style.backgroundColor,
        color: style.color,
        opacity: style.opacity,
        width: host.getBoundingClientRect().width,
        right: host.getBoundingClientRect().right,
        fieldRight: field.right,
      };
    });
    is(plain.background, "rgb(0, 100, 210)", "A solid fill, not an outline");
    is(plain.color, "rgb(255, 255, 255)", "with a white glyph");
    is(plain.opacity, "1", "at full strength");
    Assert.greaterOrEqual(plain.width, 24, "A 24px target");
    Assert.lessOrEqual(plain.fieldRight - plain.right, 8, "At the field's end when nothing else is there");

    // 1Password's inline button: a <com-1password-button> laid over the
    // field's end, added a moment after focus.
    const placed = await SpecialPowers.spawn(browser, [HOST_ID], async hostId => {
      const doc = content.document;
      const field = doc.getElementById("email").getBoundingClientRect();
      const other = doc.createElement("com-1password-button");
      Object.assign(other.style, {
        position: "absolute",
        display: "block",
        width: "24px",
        height: "24px",
        left: `${field.right + content.scrollX - 30}px`,
        top: `${field.top + content.scrollY + (field.height - 24) / 2}px`,
      });
      doc.body.append(other);
      const host = doc.getElementById(hostId);
      await ContentTaskUtils.waitForCondition(
        () => host.getBoundingClientRect().right <= other.getBoundingClientRect().left,
        "The alias button moved left of 1Password's"
      );
      const result = {
        gap: other.getBoundingClientRect().left - host.getBoundingClientRect().right,
        insideField: host.getBoundingClientRect().left >= field.left,
      };
      other.remove();
      return result;
    });
    Assert.greaterOrEqual(placed.gap, 0, "No overlap with the other manager's button");
    Assert.lessOrEqual(placed.gap, 10, "...but right beside it");
    ok(placed.insideField, "...and still inside the field");
  });
});

add_task(async function test_sits_beside_multiple_inline_buttons() {
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await focusField(browser, "email");
    await TestUtils.waitForCondition(() => hasButton(browser), "The alias button appeared");

    // Add both an eye icon and a 1Password button to simulate a field with both
    const placed = await SpecialPowers.spawn(browser, [HOST_ID], async hostId => {
      const doc = content.document;
      const field = doc.getElementById("email").getBoundingClientRect();

      // Rightmost: 1Password button
      const op = doc.createElement("div");
      op.className = "com-1password-button";
      Object.assign(op.style, {
        position: "absolute",
        display: "block",
        width: "24px",
        height: "24px",
        left: `${field.right + content.scrollX - 30}px`,
        top: `${field.top + content.scrollY + (field.height - 24) / 2}px`,
      });
      doc.body.append(op);

      // To the left of 1Password: site's eye button
      const eye = doc.createElement("button");
      eye.type = "button";
      eye.className = "password-eye";
      eye.setAttribute("aria-label", "Show password");
      Object.assign(eye.style, {
        position: "absolute",
        display: "block",
        width: "24px",
        height: "24px",
        left: `${field.right + content.scrollX - 60}px`,
        top: `${field.top + content.scrollY + (field.height - 24) / 2}px`,
      });
      doc.body.append(eye);

      const host = doc.getElementById(hostId);
      await ContentTaskUtils.waitForCondition(
        () => host.getBoundingClientRect().right <= eye.getBoundingClientRect().left,
        "The alias button moved left of the eye button"
      );

      const hostRect = host.getBoundingClientRect();
      const eyeRect = eye.getBoundingClientRect();
      const opRect = op.getBoundingClientRect();

      const result = {
        gapToEye: eyeRect.left - hostRect.right,
        noOverlapEye: hostRect.right <= eyeRect.left,
        noOverlapOp: hostRect.right <= opRect.left,
        insideField: hostRect.left >= field.left,
      };

      op.remove();
      eye.remove();
      return result;
    });

    ok(placed.noOverlapEye, "Alias button does not overlap the eye button");
    ok(placed.noOverlapOp, "Alias button does not overlap 1Password");
    Assert.greaterOrEqual(placed.gapToEye, 0, "No overlap with eye icon");
    Assert.lessOrEqual(placed.gapToEye, 10, "Sits beside eye icon");
    ok(placed.insideField, "Still inside field");
  });
});
