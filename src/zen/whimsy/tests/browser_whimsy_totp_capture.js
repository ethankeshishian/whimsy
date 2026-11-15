/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W28 verification codes: right-click a setup QR code → Add Verification
// Code…. The item shows for a setup code drawn as an <img>, a <canvas>, or
// an <svg>, and not for another QR code or a plain image; Save keeps the
// code in the login store (encrypted, hidden from Firefox's password
// lists), and saving it again offers Replace.

const { WhimsyTOTP, STORE_ORIGIN, totp } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyTOTP.sys.mjs"
);
const { WhimsyProfiles } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyProfiles.sys.mjs");
const { LoginHelper } = ChromeUtils.importESModule("resource://gre/modules/LoginHelper.sys.mjs");
const { QRCodeGenerator } = ChromeUtils.importESModule(
  "moz-src:///browser/components/qrcode/QRCodeGenerator.sys.mjs"
);

const ROOT = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com");
const PAGE = ROOT + "whimsy_totp_page.html";
const SECRET = "JBSWY3DPEHPK3PXP";
const SETUP = `otpauth://totp/Example:octocat?secret=${SECRET}&issuer=Example`;
const MENU_ID = "context-whimsy-totp-add";

const toasts = [];
const realToast = gZenUIManager.showToast;
let setupQR, otherQR;

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.totp", true], ["browser.shareqrcode.embed_logo", false]] });
  setupQR = await QRCodeGenerator.generateQRCode(SETUP);
  otherQR = await QRCodeGenerator.generateQRCode("https://example.com/pay?amount=5");
  gZenUIManager.showToast = (id, options) => toasts.push({ id, args: options?.l10nArgs });
  // Two saved passwords for the site, so the account is a choice.
  for (const username of ["octocat", "octocat-work"]) {
    const login = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(Ci.nsILoginInfo);
    login.init("https://example.com", "https://example.com", null, username, "hunter2", "", "");
    await Services.logins.addLoginAsync(login);
  }
  registerCleanupFunction(async () => {
    gZenUIManager.showToast = realToast;
    await Services.logins.removeAllUserFacingLoginsAsync();
    for (const l of await codeLogins()) {
      await Services.logins.removeLoginAsync(l);
    }
    WhimsyTOTP._store.invalidate();
  });
});

// The page with each kind of QR code (and a plain square) to right-click.
async function openPage(win = window) {
  const tab = await BrowserTestUtils.openNewForegroundTab(win.gBrowser, PAGE);
  await SpecialPowers.spawn(tab.linkedBrowser, [setupQR, otherQR], async (setup, other) => {
    const doc = content.document;
    const box = doc.getElementById("codes");
    const img = src => {
      const el = doc.createElement("img");
      el.className = "qr";
      el.src = src;
      return el;
    };
    const setupImg = img(setup);
    setupImg.id = "img";
    const otherImg = img(other);
    otherImg.id = "other";
    box.append(setupImg, otherImg);
    await Promise.all([setupImg.decode(), otherImg.decode()]);
    const canvas = doc.createElement("canvas");
    canvas.id = "canvas";
    canvas.className = "qr";
    canvas.width = canvas.height = 200;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(setupImg, 0, 0, 200, 200);
    const plain = doc.createElement("canvas");
    plain.id = "plain";
    plain.className = "qr";
    plain.width = plain.height = 200;
    const pctx = plain.getContext("2d");
    pctx.fillStyle = "#4a7";
    pctx.fillRect(0, 0, 200, 200);
    const svgNS = "http://www.w3.org/2000/svg";
    const svg = doc.createElementNS(svgNS, "svg");
    svg.id = "svg";
    svg.setAttribute("class", "qr");
    svg.setAttribute("viewBox", "0 0 200 200");
    const image = doc.createElementNS(svgNS, "image");
    image.setAttribute("href", setup);
    image.setAttribute("width", "200");
    image.setAttribute("height", "200");
    image.setAttribute("style", "image-rendering: pixelated");
    svg.append(image);
    box.append(canvas, plain, svg);
  });
  return tab;
}

async function rightClick(browser, selector, win = window) {
  const menu = win.document.getElementById("contentAreaContextMenu");
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  await BrowserTestUtils.synthesizeMouseAtCenter(selector, { type: "contextmenu", button: 2 }, browser);
  await shown;
  return menu;
}

async function closeMenu(menu) {
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.hidePopup();
  await hidden;
}

// Whether the item shows: the page's answer may come just after the menu.
async function itemShows(win = window) {
  const item = win.document.getElementById(MENU_ID);
  return TestUtils.waitForCondition(() => !item.hidden, "The item shows", 50, 40).then(() => true, () => false);
}

async function openAddFrom(browser, selector) {
  const menu = await rightClick(browser, selector);
  ok(await itemShows(), `Add Verification Code… shows for the ${selector} setup code`);
  const item = document.getElementById(MENU_ID);
  is(item.getAttribute("data-l10n-id"), "whimsy-totp-context-add", "The item's string");
  const shown = BrowserTestUtils.waitForEvent(document, "popupshown", false, e => e.target.id == "whimsy-totp-add");
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.activateItem(item);
  await hidden;
  const { target: panel } = await shown;
  await TestUtils.waitForCondition(() => panel.querySelector(".whimsy-totp-code-value")?.textContent, "The code shows");
  return panel;
}

async function closePanel(panel) {
  const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
  panel.hidePopup();
  await hidden;
}

async function codeLogins() {
  return (await Services.logins.searchLoginsAsync({ origin: STORE_ORIGIN })).filter(l => l.origin == STORE_ORIGIN);
}

add_task(async function item_only_for_setup_codes() {
  const tab = await openPage();
  const browser = tab.linkedBrowser;
  for (const selector of ["#img", "#canvas", "#svg"]) {
    const menu = await rightClick(browser, selector);
    ok(await itemShows(), `Shows for a setup code drawn as ${selector}`);
    await closeMenu(menu);
    ok(document.getElementById(MENU_ID).hidden, "and hides again with the menu");
  }
  for (const [selector, why] of [["#other", "another QR code"], ["#plain", "a plain image"], ["#name", "a text field"]]) {
    const menu = await rightClick(browser, selector);
    ok(!(await itemShows()), `Not for ${why}`);
    await closeMenu(menu);
  }
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.totp", false]] });
  const menu = await rightClick(browser, "#img");
  ok(!(await itemShows()), "Not with the feature off");
  await closeMenu(menu);
  await SpecialPowers.popPrefEnv();
  BrowserTestUtils.removeTab(tab);
});

add_task(async function save_replace_and_storage() {
  toasts.length = 0;
  const tab = await openPage();
  const browser = tab.linkedBrowser;
  let panel = await openAddFrom(browser, "#img");
  const doc = panel.ownerDocument;
  is(doc.getElementById("whimsy-totp-add-title").textContent, "Add a verification code for example.com", "The title names the site");
  const cards = [...panel.querySelectorAll(".whimsy-totp-accounts [role=radio]")];
  Assert.deepEqual(cards.map(c => c.dataset.account), ["octocat", "octocat-work"], "The QR account, then the other saved login");
  is(cards[0].getAttribute("aria-checked"), "true", "pre-selected from the QR label");
  is(cards[1].querySelector(".whimsy-surface-choice-detail").textContent, "Saved login", "Saved logins say so");
  const code = panel.querySelector(".whimsy-totp-code-value").textContent.replace(" ", "");
  const entry = { secret: SECRET, algorithm: "SHA1", digits: 6, period: 30 };
  const now = Date.now();
  ok([await totp(entry, now - 2000), await totp(entry, now)].includes(code), "The first code, live");
  ok(/^Changes in \d+s$/.test(panel.querySelector("#whimsy-totp-code-row .whimsy-surface-row-detail").textContent), "with its countdown");
  ok(panel.querySelector(".whimsy-totp-help").textContent.includes("profile"), "The help line");

  // Light and dark, with the text's contrast checked in each.
  await whimsyBothSchemes("w28-totp-add", async dark => {
    for (const el of [doc.getElementById("whimsy-totp-add-title"), panel.querySelector(".whimsy-totp-help"),
      panel.querySelector("#whimsy-totp-code-row .whimsy-surface-row-detail"), panel.querySelector(".whimsy-totp-code-value")]) {
      const ratio = contrastOf(el);
      Assert.greaterOrEqual(ratio, 4.5, `${dark ? "dark" : "light"}: ${el.className || el.id} contrast ${ratio.toFixed(2)}:1`);
    }
    return whimsyStandInPopups();
  });

  // Pick the work account, then Save.
  EventUtils.synthesizeMouseAtCenter(cards[1], {}, window);
  is(cards[1].getAttribute("aria-checked"), "true", "Picking another account");
  let hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
  EventUtils.synthesizeMouseAtCenter(panel.querySelector("#whimsy-totp-save"), {}, window);
  await hidden;
  let logins = await codeLogins();
  is(logins.length, 1, "Save keeps one code");
  const [login] = logins;
  is(login.username, "octocat-work", "under the account picked");
  is(login.httpRealm, `whimsy-totp|v1|${WhimsyProfiles.keyFor(0)}|example.com`, "for this profile and site");
  const stored = JSON.parse(login.password);
  ok(stored.uri.startsWith("otpauth://totp/") && stored.uri.includes(SECRET), "The record holds the setup URI");
  is(stored.profile, WhimsyProfiles.nameOf(0), "and the profile's name");
  Assert.deepEqual(toasts.at(-1), { id: "whimsy-totp-saved-toast", args: { site: "example.com" } }, "A toast confirms it");

  // Encrypted on disk, and out of Firefox's own password lists.
  const file = PathUtils.join(PathUtils.profileDir, "logins.json");
  if (await IOUtils.exists(file)) {
    const raw = await IOUtils.readUTF8(file);
    ok(!raw.includes(SECRET) && !raw.includes("otpauth"), "The key isn't readable in logins.json");
  }
  ok(!LoginHelper.isUserFacingLogin(login), "Not a user-facing login (about:logins, breach alerts)");
  const facing = await LoginHelper.getAllUserFacingLogins();
  ok(facing.every(l => l.origin != STORE_ORIGIN), "Not listed with the saved passwords");
  is(facing.length, 2, "while the real passwords still are");

  // The same account again: Replace.
  panel = await openAddFrom(browser, "#canvas");
  const work = panel.querySelector(".whimsy-totp-accounts [data-account='octocat-work']");
  EventUtils.synthesizeMouseAtCenter(work, {}, window);
  EventUtils.synthesizeMouseAtCenter(panel.querySelector("#whimsy-totp-save"), {}, window);
  await TestUtils.waitForCondition(() => panel.dataset.state == "exists", "Already saved");
  await TestUtils.waitForCondition(() => doc.getElementById("whimsy-totp-add-title").textContent.startsWith("A code") &&
    panel.querySelector(".whimsy-totp-text")?.textContent, "The exists copy is translated");
  is(doc.getElementById("whimsy-totp-add-title").textContent, "A code for octocat-work is already saved", "The exists title");
  is(panel.querySelector(".whimsy-totp-text").textContent, "Replace it if example.com gave you a new one.", "and its line");
  await whimsyBothSchemes("w28-totp-exists", async () => whimsyStandInPopups());
  hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
  EventUtils.synthesizeMouseAtCenter(panel.querySelector("#whimsy-totp-replace"), {}, window);
  await hidden;
  logins = await codeLogins();
  is(logins.length, 1, "Replace keeps one code for the account");
  is(logins[0].QueryInterface(Ci.nsILoginMetaInfo).guid, login.QueryInterface(Ci.nsILoginMetaInfo).guid, "the same record");

  // Cancel saves nothing.
  panel = await openAddFrom(browser, "#svg");
  hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
  EventUtils.synthesizeMouseAtCenter(panel.querySelector("#whimsy-totp-cancel"), {}, window);
  await hidden;
  is((await codeLogins()).length, 1, "Cancel saves nothing");

  BrowserTestUtils.removeTab(tab);
  await Services.logins.removeAllUserFacingLoginsAsync();
  for (const l of await codeLogins()) {
    await Services.logins.removeLoginAsync(l);
  }
});

add_task(async function not_in_private_windows() {
  const win = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  const tab = await openPage(win);
  const menu = await rightClick(tab.linkedBrowser, "#img", win);
  ok(!(await itemShows(win)), "No item in a private window");
  await closeMenu(menu);
  await BrowserTestUtils.closeWindow(win);
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
