/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W29 focus sessions: Start Focus Session opens a sheet with a time picker
// and "During the session" ticks (Do Not Disturb, Pause distracting sites,
// Break reminder ticked; Mute background tabs not). A countdown notch sits
// top right; its panel ends the session early and names only what was
// ticked. Listed sites show a paused page. At the end: confetti, Done, a
// toast, and a break reminder 5 minutes later.

const { WhimsyFocusSession, siteFromLine, hostMatches, SOCIAL_SITES, VIDEO_SITES } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyFocusSession.sys.mjs"
);
const { WhimsyFocusNotch, NOTCH_ID } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyFocusNotch.sys.mjs");
const { SHEET_ID } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyFocusSheet.sys.mjs");
const { WhimsyFocusPicker } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyFocusPicker.sys.mjs");
const { WhimsyDoNotDisturb } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyDoNotDisturb.sys.mjs");
const { WhimsySurface } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySurface.sys.mjs");
const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");

const P = WhimsyFocusSession.PREFS;
const MUTE_PREF = "whimsy.media.background-mute";
const PANEL_ID = WhimsyFocusNotch.PANEL_ID;
const action = id => globalActions.find(a => a.l10nId == id);
const XHTML = "http://www.w3.org/1999/xhtml";

const BREAK_MS = WhimsyFocusSession.breakMs;
const HOLD_MS = WhimsyFocusSession.doneHoldMs;

function resetPrefs() {
  for (const name of Object.values(P)) {
    Services.prefs.clearUserPref(name);
  }
  Services.prefs.clearUserPref(MUTE_PREF);
}

registerCleanupFunction(() => {
  WhimsyFocusSession.dropBreak();
  WhimsyFocusSession.end();
  WhimsyFocusSession.breakMs = BREAK_MS;
  WhimsyFocusSession.doneHoldMs = HOLD_MS;
  WhimsyDoNotDisturb.setPaused(false);
  closeToasts();
  resetPrefs();
});

async function openSheet(win = window) {
  const parts = WhimsyFocusSession.openSheet(win);
  ok(parts, "The sheet opens");
  await TestUtils.waitForCondition(() => parts.panel.state == "open", "The sheet is open");
  await win.document.l10n.translateFragment(parts.panel);
  return parts;
}

async function closeSheet(parts) {
  if (parts.panel.state != "closed") {
    const hidden = BrowserTestUtils.waitForEvent(parts.panel, "popuphidden");
    WhimsySurface.close(parts.panel);
    await hidden;
  }
}

async function startFromSheet(parts) {
  const hidden = BrowserTestUtils.waitForEvent(parts.panel, "popuphidden");
  parts.footer.querySelector(`#${SHEET_ID}-start`).click();
  await hidden;
  ok(WhimsyFocusSession.isActive, "Start starts the session");
}

async function endSession() {
  WhimsyFocusSession.end();
  await TestUtils.waitForCondition(() => !document.getElementById(NOTCH_ID), "The notch goes");
}

// --- contrast (as browser_whimsy_ai_style.js) ------------------------------
function resolvedRGB(win, value) {
  const canvas = win.document.createElementNS(XHTML, "canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, 1, 1);
  ctx.fillStyle = value;
  ctx.fillRect(0, 0, 1, 1);
  return [...ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)];
}
function luminance([r, g, b]) {
  const lin = c => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function contrastRatio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
function backgroundOf(win, el) {
  for (let node = el; node && node.nodeType == 1; node = node.parentElement) {
    const color = win.getComputedStyle(node).backgroundColor;
    if (!/rgba\(\s*0,\s*0,\s*0,\s*0\s*\)|transparent/.test(color)) {
      return color;
    }
  }
  return win.getComputedStyle(win.document.documentElement).backgroundColor;
}
function checkContrast(win, el, what, min = 4.5) {
  const fg = resolvedRGB(win, win.getComputedStyle(el).color);
  const bg = resolvedRGB(win, backgroundOf(win, el));
  const ratio = contrastRatio(fg, bg);
  Assert.greaterOrEqual(ratio, min, `${what}: contrast ${ratio.toFixed(2)} is at least ${min}`);
}
function notClipped(el, what) {
  Assert.lessOrEqual(el.scrollWidth, el.clientWidth + 1, `${what} isn't clipped`);
}

// --- pure helpers -------------------------------------------------------------

add_task(async function site_lines_and_matching() {
  is(siteFromLine("  "), "", "A blank line is skipped");
  is(siteFromLine("https://www.Reddit.com/r/all"), "reddit.com", "A URL becomes its site");
  is(siteFromLine("news.ycombinator.com"), "news.ycombinator.com", "A host stays");
  is(siteFromLine("not a site"), null, "Words aren't a site");
  ok(hostMatches("m.youtube.com", "youtube.com"), "Subdomains are paused too");
  ok(hostMatches("youtube.com", "youtube.com"), "The site itself is paused");
  ok(!hostMatches("notyoutube.com", "youtube.com"), "Another site that ends the same way isn't");

  const parsed = WhimsyFocusSession.parseSites("example.org\n\nhttps://example.com/x\nexample.org");
  Assert.deepEqual(parsed.sites, ["example.org", "example.com"], "The list is cleaned and de-duplicated");
  is(WhimsyFocusSession.parseSites("example.org\nnope nope").invalid, "nope nope", "A bad line is named");

  Assert.greater(SOCIAL_SITES.length, 3, "Social media sites are listed");
  Assert.greater(VIDEO_SITES.length, 3, "Video sites are listed");
});

// --- the sheet: defaults, prefs, Just a timer ---------------------------------

add_task(async function sheet_defaults_and_remembered_ticks() {
  resetPrefs();
  const parts = await openSheet();
  const { boxes, picker, justTimer } = parts;
  is(picker.value, 25, "The first time, 25 minutes");
  ok(boxes.dnd.checked, "Do Not Disturb is ticked by default");
  ok(boxes.pauseSites.checked, "Pause distracting sites is ticked by default");
  ok(boxes.breakReminder.checked, "Break reminder is ticked by default");
  ok(!boxes.muteBackground.checked, "Mute background tabs isn't");
  ok(justTimer.hidden, "Just a timer is hidden while something's ticked");
  ok(document.getElementById(`${SHEET_ID}-pauseSites`).querySelector(".whimsy-focus-edit"), "Pause has an Edit link");
  ok(parts.ends.textContent.length, "Ends at shows");
  is(boxes.dnd.getAttribute("aria-labelledby"), `${SHEET_ID}-dnd-label`, "Each box is labelled by its row");

  // The whole row ticks; the keyboard moves the dial.
  EventUtils.synthesizeMouseAtCenter(document.getElementById(`${SHEET_ID}-muteBackground-label`), {});
  ok(boxes.muteBackground.checked, "Clicking the row ticks its box");
  picker.element.focus();
  EventUtils.synthesizeKey("KEY_ArrowUp", {});
  EventUtils.synthesizeKey("KEY_PageUp", {});
  is(picker.value, 31, "Arrow up adds a minute, Page Up five");
  is(picker.element.getAttribute("aria-valuenow"), "31", "The slider says its value");

  for (const name of ["dnd", "pauseSites", "breakReminder"]) {
    boxes[name].click();
  }
  await startFromSheet(parts);
  is(Services.prefs.getIntPref(P.lastLength), 31, "The length is remembered");
  ok(!Services.prefs.getBoolPref(P.dnd), "Do Not Disturb unticked is remembered");
  ok(!Services.prefs.getBoolPref(P.pauseSites), "Pause unticked is remembered");
  ok(Services.prefs.getBoolPref(P.muteBackground), "Mute ticked is remembered");
  ok(!Services.prefs.getBoolPref(P.breakReminder), "Break unticked is remembered");
  await endSession();

  const again = await openSheet();
  is(again.picker.value, 31, "Next time, the last length");
  ok(!again.boxes.dnd.checked && again.boxes.muteBackground.checked, "Next time, the last ticks");
  await closeSheet(again);
  resetPrefs();
});

add_task(async function all_off_is_just_a_timer() {
  resetPrefs();
  Services.prefs.setStringPref(MUTE_PREF, "off");
  WhimsyDoNotDisturb.setPaused(false);
  const parts = await openSheet();
  for (const name of ["dnd", "pauseSites", "breakReminder"]) {
    EventUtils.synthesizeMouseAtCenter(parts.boxes[name], {});
  }
  ok(!parts.justTimer.hidden, "With nothing ticked, the caption says Just a timer");
  await document.l10n.translateFragment(parts.panel);
  ok(parts.justTimer.textContent.trim().length, "Just a timer has its text");
  await startFromSheet(parts);

  ok(!WhimsyDoNotDisturb.paused, "Do Not Disturb stays off");
  is(Services.prefs.getStringPref(MUTE_PREF), "off", "Background muting is unchanged");
  ok(document.getElementById(NOTCH_ID), "The countdown still shows");

  // The panel has no list, just the end time.
  EventUtils.synthesizeMouseAtCenter(document.getElementById(NOTCH_ID), {});
  const panel = await TestUtils.waitForCondition(() => {
    const p = document.getElementById(PANEL_ID);
    return p?.state == "open" && p;
  }, "The notch's panel opens");
  const text = panel.querySelector(`#${PANEL_ID}-text`);
  is(text.getAttribute("data-l10n-id"), "whimsy-focus-panel-ends", "Nothing ticked: only when it ends");
  const hidden = BrowserTestUtils.waitForEvent(panel, "popuphidden");
  panel.querySelector(`#${PANEL_ID}-end`).click();
  await hidden;
  ok(!WhimsyFocusSession.isActive, "End session ends it");
  await TestUtils.waitForCondition(() => !document.getElementById(NOTCH_ID), "The notch goes");
  ok(!currentToast(), "Ending early shows no toast");
  resetPrefs();
});

// --- start and end ----------------------------------------------------------------

add_task(async function start_and_end_early_restore_everything() {
  resetPrefs();
  Services.prefs.setStringPref(MUTE_PREF, "off");
  WhimsyDoNotDisturb.setPaused(false);

  ok(action("whimsy-action-focus-start").isAvailable(window), "Start Focus Session is in the command bar");
  ok(!action("whimsy-action-focus-end").isAvailable(window), "End Focus Session isn't, yet");

  const win2 = await BrowserTestUtils.openNewBrowserWindow();
  WhimsyFocusSession.start(window, { minutes: 25, dnd: true, pauseSites: true, muteBackground: true, breakReminder: true });
  ok(WhimsyFocusSession.isActive, "The session is on");
  Assert.greater(Services.prefs.getIntPref(P.endsAt), 1e9, "endsAt is stored in seconds");
  Assert.less(Math.abs(WhimsyFocusSession.endsAt - (Date.now() + 25 * 60000)), 5000, "It ends in 25 minutes");
  ok(WhimsyDoNotDisturb.paused, "Do Not Disturb is on");
  isnot(Services.prefs.getStringPref(MUTE_PREF), "off", "Background tabs are muted");
  ok(Services.prefs.getBoolPref(P.mutedBySession), "The session remembers it muted them");
  ok(document.getElementById(NOTCH_ID), "The notch shows here");
  ok(win2.document.getElementById(NOTCH_ID), "The notch shows in the other window");
  ok(action("whimsy-action-focus-end").isAvailable(window), "End Focus Session is offered");
  ok(!action("whimsy-action-focus-start").isAvailable(window), "Start isn't");

  // A window opened mid-session gets the notch too.
  const win3 = await BrowserTestUtils.openNewBrowserWindow();
  await TestUtils.waitForCondition(() => win3.document.getElementById(NOTCH_ID), "A new window gets the notch");
  await BrowserTestUtils.closeWindow(win3);

  // The notch: a timer, labelled, and its time.
  const notch = document.getElementById(NOTCH_ID);
  is(notch.getAttribute("role"), "timer", "The notch is a timer");
  await TestUtils.waitForCondition(() => notch.getAttribute("aria-label"), "The notch is labelled");
  ok(/^2[45]:\d\d$/.test(notch.querySelector(".whimsy-focus-time").textContent.trim()), "It counts down from 25:00");
  const toastTop = document.getElementById("zen-toast-container");
  if (toastTop) {
    const offset = getComputedStyle(document.documentElement).getPropertyValue("--whimsy-focus-notch-bottom");
    ok(offset, "Toasts are moved below the notch");
  }

  // The panel names only what's ticked.
  EventUtils.synthesizeMouseAtCenter(notch, {});
  const panel = await TestUtils.waitForCondition(() => {
    const p = document.getElementById(PANEL_ID);
    return p?.state == "open" && p;
  }, "The panel opens");
  const text = panel.querySelector(`#${PANEL_ID}-text`);
  await TestUtils.waitForCondition(() => text.textContent.length, "The panel has its text");
  ok(/Do Not Disturb/.test(text.textContent), "It names Do Not Disturb");
  ok(/paused/.test(text.textContent), "It names the paused sites");
  ok(/,/.test(text.textContent), "Four things are listed with commas");
  WhimsySurface.close(panel);

  WhimsyFocusSession.end();
  ok(!WhimsyFocusSession.isActive, "Ending it ends it");
  ok(!WhimsyDoNotDisturb.paused, "Do Not Disturb goes back off");
  is(Services.prefs.getStringPref(MUTE_PREF), "off", "Background muting goes back off");
  ok(!Services.prefs.prefHasUserValue(P.mutedBySession), "The mute note is forgotten");
  is(Services.prefs.getIntPref(P.endsAt), 0, "endsAt is cleared");
  await TestUtils.waitForCondition(
    () => !document.getElementById(NOTCH_ID) && !win2.document.getElementById(NOTCH_ID),
    "The notch goes from every window"
  );
  ok(!document.documentElement.hasAttribute("whimsy-focus"), "The toast offset is dropped");
  await BrowserTestUtils.closeWindow(win2);

  // Do Not Disturb that was already on stays on.
  WhimsyDoNotDisturb.setPaused(true);
  WhimsyFocusSession.start(window, { minutes: 5, dnd: true, pauseSites: false, muteBackground: false, breakReminder: false });
  WhimsyFocusSession.end();
  ok(WhimsyDoNotDisturb.paused, "Do Not Disturb that was on before stays on");
  WhimsyDoNotDisturb.setPaused(false);
  await TestUtils.waitForCondition(() => !document.getElementById(NOTCH_ID), "The notch goes");
  resetPrefs();
});

add_task(async function the_time_runs_out() {
  resetPrefs();
  closeToasts();
  WhimsyFocusSession.doneHoldMs = 200;
  WhimsyFocusSession.breakMs = 600;
  WhimsyDoNotDisturb.setPaused(false);
  WhimsyFocusSession.start(window, { minutes: 1, dnd: true, pauseSites: false, muteBackground: false, breakReminder: true });
  // Bring the end close.
  Services.prefs.setIntPref(P.endsAt, Math.ceil(Date.now() / 1000) + 1);
  WhimsyFocusSession.arm();
  const notch = document.getElementById(NOTCH_ID);
  await TestUtils.waitForCondition(() => notch.classList.contains("is-done"), "The notch says Done");
  ok(!WhimsyFocusSession.isActive, "The session is over");
  ok(!WhimsyDoNotDisturb.paused, "Do Not Disturb is off again");

  const toast = await TestUtils.waitForCondition(() => toastFor("whimsy-focus-done-toast"), "The done toast shows");
  ok(toast.element.querySelector("[data-l10n-id='whimsy-focus-done-break']") ||
    toast.element.innerHTML.includes("whimsy-focus-done-break"), "It mentions the break");
  ok(toast.element.querySelector("#whimsy-focus-start-another"), "It offers Start another");
  await TestUtils.waitForCondition(() => !document.getElementById(NOTCH_ID), "The notch goes after Done");

  const brk = await TestUtils.waitForCondition(() => toastFor("whimsy-focus-break-over"), "The break reminder shows");
  ok(brk, "Break's over");
  closeToasts();

  // Start another: the same length, at once.
  WhimsyFocusSession.startAnother(window, 1);
  ok(WhimsyFocusSession.isActive, "Start another starts one");
  is(WhimsyFocusSession.lastLength, 1, "With the same length");
  await endSession();

  // No break line when Break reminder is off.
  WhimsyFocusSession.start(window, { minutes: 1, dnd: false, pauseSites: false, muteBackground: false, breakReminder: false });
  WhimsyFocusSession.finish();
  const plain = await TestUtils.waitForCondition(() => toastFor("whimsy-focus-done-toast"), "The done toast shows");
  ok(!plain.element.innerHTML.includes("whimsy-focus-done-break"), "No break line without the reminder");
  ok(!WhimsyFocusSession.breakPending, "No break reminder is pending");
  closeToasts();
  await TestUtils.waitForCondition(() => !document.getElementById(NOTCH_ID), "The notch goes");
  WhimsyFocusSession.doneHoldMs = HOLD_MS;
  WhimsyFocusSession.breakMs = BREAK_MS;
  resetPrefs();
});

// --- pausing sites -----------------------------------------------------------------

add_task(async function listed_sites_are_paused() {
  resetPrefs();
  Services.prefs.setBoolPref(P.social, false);
  Services.prefs.setBoolPref(P.video, false);
  Services.prefs.setStringPref(P.sites, "example.org");
  is(WhimsyFocusSession.pausedSites.join(), "example.org", "Only the owner's site is listed");

  // A tab already on the site is left alone.
  const before = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.org/");
  WhimsyFocusSession.start(window, { minutes: 25, dnd: false, pauseSites: true, muteBackground: false, breakReminder: false });
  BrowserTestUtils.reloadTab(before);
  await BrowserTestUtils.browserLoaded(before.linkedBrowser);
  is(before.linkedBrowser.currentURI.host, "example.org", "A tab that was open stays");
  BrowserTestUtils.removeTab(before);

  // A new load is paused.
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
  const browser = tab.linkedBrowser;
  BrowserTestUtils.startLoadingURIString(browser, "https://example.org/");
  await TestUtils.waitForCondition(
    () => browser.currentURI.spec.startsWith("about:whimsy?focus&url="),
    "The site shows the paused page"
  );
  await TestUtils.waitForCondition(
    () => browser.contentDocument?.getElementById("whimsy-focus-heading")?.textContent.includes("example.org"),
    "The paused page names the site"
  );
  const doc = browser.contentDocument;
  ok(!doc.getElementById("whimsy-focus-open").hidden, "Open anyway is offered");

  // Other sites aren't.
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  is(other.linkedBrowser.currentURI.host, "example.com", "An unlisted site opens");
  BrowserTestUtils.removeTab(other);
  await BrowserTestUtils.switchTab(gBrowser, tab);

  await whimsyBothSchemes("focus-paused-page", async () => {
    await whimsySettled(doc);
    checkContrast(doc.defaultView, doc.getElementById("whimsy-focus-back"), "Go back");
    checkContrast(doc.defaultView, doc.getElementById("whimsy-focus-heading"), "The paused heading");
    notClipped(doc.getElementById("whimsy-focus-open"), "Open anyway");
  });

  // Open anyway: this tab, this site, for the rest of the session.
  const loaded = BrowserTestUtils.browserLoaded(browser, false, "https://example.org/");
  EventUtils.synthesizeMouseAtCenter(doc.getElementById("whimsy-focus-open"), {}, doc.defaultView);
  await loaded;
  is(browser.currentURI.host, "example.org", "Open anyway opens the site");
  BrowserTestUtils.startLoadingURIString(browser, "https://example.org/?again");
  await BrowserTestUtils.browserLoaded(browser);
  is(browser.currentURI.host, "example.org", "It stays open in that tab");

  // Ending the session opens paused tabs.
  const second = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
  BrowserTestUtils.startLoadingURIString(second.linkedBrowser, "https://sub.example.org/");
  await TestUtils.waitForCondition(
    () => second.linkedBrowser.currentURI.spec.startsWith("about:whimsy?focus"),
    "A subdomain is paused too"
  );
  const reopened = BrowserTestUtils.browserLoaded(second.linkedBrowser);
  WhimsyFocusSession.end();
  await reopened;
  is(second.linkedBrowser.currentURI.host, "sub.example.org", "Ending the session opens the site");

  BrowserTestUtils.removeTab(second);
  BrowserTestUtils.removeTab(tab);
  await TestUtils.waitForCondition(() => !document.getElementById(NOTCH_ID), "The notch goes");
  resetPrefs();
});

// --- reduced motion ---------------------------------------------------------------

add_task(async function reduced_motion() {
  resetPrefs();
  await SpecialPowers.pushPrefEnv({ set: [["ui.prefersReducedMotion", 1]] });
  const parts = await openSheet();
  const big = parts.picker.element.querySelector(".whimsy-focus-dial-value");
  parts.picker.element.focus();
  EventUtils.synthesizeKey("KEY_ArrowUp", {});
  ok(!big.classList.contains("is-bump"), "No bump with Reduce Motion");
  await closeSheet(parts);

  WhimsyFocusSession.doneHoldMs = 100;
  WhimsyFocusSession.start(window, { minutes: 1, dnd: false, pauseSites: false, muteBackground: false, breakReminder: false });
  WhimsyFocusSession.finish();
  ok(!document.querySelector(".whimsy-focus-confetti"), "No confetti with Reduce Motion");
  ok(document.getElementById(NOTCH_ID)?.classList.contains("is-done"), "Done still shows");
  await TestUtils.waitForCondition(() => toastFor("whimsy-focus-done-toast"), "The toast still shows");
  closeToasts();
  await TestUtils.waitForCondition(() => !document.getElementById(NOTCH_ID), "The notch goes");
  WhimsyFocusSession.doneHoldMs = HOLD_MS;
  await SpecialPowers.popPrefEnv();

  // With motion: the dial bumps and confetti falls.
  await SpecialPowers.pushPrefEnv({ set: [["ui.prefersReducedMotion", 0]] });
  const moving = await openSheet();
  moving.picker.element.focus();
  EventUtils.synthesizeKey("KEY_ArrowUp", {});
  ok(moving.picker.element.querySelector(".whimsy-focus-dial-value").classList.contains("is-bump"), "The number bumps");
  await closeSheet(moving);
  WhimsyFocusSession.doneHoldMs = 100;
  WhimsyFocusSession.start(window, { minutes: 1, dnd: false, pauseSites: false, muteBackground: false, breakReminder: false });
  WhimsyFocusSession.finish();
  ok(document.querySelector(".whimsy-focus-confetti"), "Confetti falls");
  await TestUtils.waitForCondition(() => toastFor("whimsy-focus-done-toast"), "The toast shows");
  closeToasts();
  await TestUtils.waitForCondition(
    () => !document.getElementById(NOTCH_ID) && !document.querySelector(".whimsy-focus-confetti"),
    "The notch and the confetti go"
  );
  WhimsyFocusSession.doneHoldMs = HOLD_MS;
  await SpecialPowers.popPrefEnv();
  resetPrefs();
});

// --- the feature switch, the picker interface --------------------------------------

add_task(async function turning_the_feature_off_ends_a_session() {
  resetPrefs();
  WhimsyFocusSession.start(window, { minutes: 10, dnd: false, pauseSites: true, muteBackground: false, breakReminder: false });
  ok(WhimsyFocusSession.isActive, "A session is on");
  await SpecialPowers.pushPrefEnv({ set: [[WhimsyFocusSession.FEATURE_PREF, false]] });
  ok(!WhimsyFocusSession.isActive, "Turning focus sessions off ends it");
  ok(!action("whimsy-action-focus-start").isAvailable(window), "The command goes");
  is(WhimsyFocusSession.openSheet(window), null, "The sheet doesn't open");
  await TestUtils.waitForCondition(() => !document.getElementById(NOTCH_ID), "The notch goes");
  await SpecialPowers.popPrefEnv();
  resetPrefs();
});

add_task(async function the_picker_is_swappable() {
  const changes = [];
  const picker = WhimsyFocusPicker.create(document, { value: 40, onChange: v => changes.push(v) });
  ok(picker.element, "A picker has an element");
  is(picker.value, 40, "It starts at the given value");
  picker.value = 200;
  is(picker.value, 120, "It holds 1 to 120 minutes");
  is(changes.length, 0, "Setting the value doesn't report a change");
  is(typeof picker.focus, "function", "It can take focus");
});

// --- Settings › General › Focus Sessions -------------------------------------------

add_task(async function settings_group_and_edit_link() {
  resetPrefs();
  const parts = await openSheet();
  const tabOpened = BrowserTestUtils.waitForNewTab(gBrowser, url => url.startsWith("about:preferences"), true);
  EventUtils.synthesizeMouseAtCenter(parts.panel.querySelector(".whimsy-focus-edit"), {});
  const tab = await tabOpened;
  const win = tab.linkedBrowser.contentWindow;
  const doc = win.document;
  await TestUtils.waitForCondition(() => doc.getElementById("whimsyFocusGroup")?.checkVisibility(), "Edit opens Focus Sessions");
  is(parts.panel.state, "closed", "Edit closes the sheet");

  const social = doc.getElementById("whimsyFocusSocial");
  ok(social.checked && doc.getElementById("whimsyFocusVideo").checked, "Social media and video are paused by default");
  social.click();
  ok(!Services.prefs.getBoolPref(P.social), "The social box is bound to its pref");
  social.click();
  await TestUtils.waitForCondition(() => doc.getElementById("whimsyFocusSocialSample").textContent.includes("x.com"), "The samples show");

  const list = doc.getElementById("whimsyFocusSites");
  const status = doc.getElementById("whimsyFocusStatus");
  list.value = "nope nope";
  doc.getElementById("whimsyFocusSave").doCommand();
  is(list.getAttribute("aria-invalid"), "true", "A bad line is refused");
  is(status.getAttribute("data-l10n-id"), "whimsy-focus-settings-invalid", "And named");
  is(Services.prefs.getStringPref(P.sites, ""), "", "Nothing is saved");

  list.value = "https://www.example.org/x\n\nexample.com";
  doc.getElementById("whimsyFocusSave").doCommand();
  is(Services.prefs.getStringPref(P.sites), "example.org\nexample.com", "The cleaned list is saved");
  is(status.getAttribute("data-l10n-id"), "whimsy-focus-settings-saved", "Saved is said");
  ok(!list.hasAttribute("aria-invalid"), "The field is valid");

  await whimsyBothSchemes("focus-settings", async () => {
    doc.getElementById("whimsyFocusGroup").scrollIntoView();
    await whimsySettled(doc);
    checkContrast(win, doc.getElementById("whimsyFocusSocialSample"), "A sample line", 4.5);
  });
  BrowserTestUtils.removeTab(tab);
  resetPrefs();
});

// --- screenshots and contrast -------------------------------------------------------

add_task(async function screens() {
  resetPrefs();
  Services.prefs.setStringPref(MUTE_PREF, "off");
  await whimsyBothSchemes("focus-sheet", async () => {
    const parts = await openSheet();
    await whimsySettled();
    const start = parts.footer.querySelector(`#${SHEET_ID}-start`);
    checkContrast(window, start, "Start");
    checkContrast(window, parts.ends, "Ends at");
    checkContrast(window, parts.panel.querySelector(".whimsy-focus-edit"), "Edit");
    for (const row of parts.panel.querySelectorAll(".whimsy-surface-row-label")) {
      notClipped(row, `The ${row.textContent} label`);
    }
    const undo = whimsyStandInPopups(document);
    return async () => {
      undo?.();
      await closeSheet(parts);
    };
  });

  await whimsyBothSchemes("focus-sheet-just-timer", async () => {
    const parts = await openSheet();
    for (const box of Object.values(parts.boxes)) {
      box.checked = false;
      box.dispatchEvent(new Event("change"));
    }
    await whimsySettled();
    const undo = whimsyStandInPopups(document);
    return async () => {
      undo?.();
      await closeSheet(parts);
    };
  });

  WhimsyFocusSession.start(window, { minutes: 25, dnd: false, pauseSites: true, muteBackground: false, breakReminder: true });
  await whimsyBothSchemes("focus-notch", async () => {
    const notch = document.getElementById(NOTCH_ID);
    await TestUtils.waitForCondition(() => notch.querySelector(".whimsy-focus-time").textContent, "The time shows");
    checkContrast(window, notch.querySelector(".whimsy-focus-time"), "The countdown");
  });
  await whimsyBothSchemes("focus-notch-panel", async () => {
    const parts = await WhimsyFocusNotch.openPanel(window);
    await TestUtils.waitForCondition(() => parts.panel.state == "open", "The panel is open");
    await whimsySettled();
    checkContrast(window, parts.footer.querySelector(`#${PANEL_ID}-end`), "End session");
    const undo = whimsyStandInPopups(document);
    return async () => {
      undo?.();
      const hidden = BrowserTestUtils.waitForEvent(parts.panel, "popuphidden");
      WhimsySurface.close(parts.panel);
      await hidden;
    };
  });
  await endSession();

  WhimsyFocusSession.doneHoldMs = 50;
  await whimsyBothSchemes("focus-done-toast", async () => {
    WhimsyFocusSession.start(window, { minutes: 25, dnd: false, pauseSites: false, muteBackground: false, breakReminder: true });
    WhimsyFocusSession.finish();
    const toast = await TestUtils.waitForCondition(() => toastFor("whimsy-focus-done-toast"), "The toast shows");
    await whimsySettled();
    const notch = document.getElementById(NOTCH_ID);
    if (notch) {
      Assert.greaterOrEqual(
        toast.element.getBoundingClientRect().top,
        notch.getBoundingClientRect().bottom - 1,
        "The toast sits below the notch"
      );
    }
    return async () => {
      WhimsyFocusSession.dropBreak();
      closeToasts();
      await TestUtils.waitForCondition(() => !document.getElementById(NOTCH_ID), "The notch goes");
    };
  });
  WhimsyFocusSession.doneHoldMs = HOLD_MS;
  resetPrefs();
});
