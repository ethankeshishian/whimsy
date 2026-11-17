/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Many tasks, several page loads and two windows.
requestLongerTimeout(4);

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

let taskState = null;
let prefDepth = 0;

// File cleanup alone is too late: a rejected task otherwise leaves addTab
// intercepted, so the next task's openNewForegroundTab waits on a Glance.
// Snapshot before each task, including tabs opened before a load rejects.
// Failure-path audit (the normal tail cleanup is skipped on rejection):
// - site_lines_and_matching: no resources.
// - sheet_defaults_and_remembered_ticks: sheet/picker, session, mute, prefs.
// - all_off_is_just_a_timer: sheet, session, notch panel, mute pref.
// - start_and_end_early_restore_everything: two windows, session, DND/mute,
//   notch panel, and prefs.
// - the_time_runs_out: session, done/break timers, toasts, timing overrides.
// - listed_sites_are_paused: tabs, session/HTTP observer, prefs, screenshot theme.
// - reduced_motion: sheets, session, confetti/toasts, motion prefs, hold override.
// - turning_the_feature_off_ends_a_session: session and feature pref environment.
// - the_picker_is_swappable: detached picker elements only.
// - the_selector: sheets/picker pointer capture, session, motion prefs.
// - settings_group_and_edit_link: sheet, Settings tab, site prefs, theme.
// - stay_on_this_tab: session/tab interception, Glance, tabs, window, sheet,
//   notch panel, fake URL-bar row, and motion prefs.
// - stay_on_this_tab_screens: session/tab interception, tabs, motion/theme prefs.
// - screens: sheets/panel, stand-ins, session, done/break timers, toasts,
//   timing override, mute pref, and theme environments.
function addFocusTask(task) {
  const isolated = async function () {
    const windows = new Map([...Services.wm.getEnumerator("navigator:browser")].map(win =>
      [win, { tabs: new Set(win.gBrowser.tabs), selected: win.gBrowser.selectedTab }]));
    const prefs = [...Object.values(P), MUTE_PREF].map(name => {
      const type = Services.prefs.getPrefType(name);
      const hadUserValue = Services.prefs.prefHasUserValue(name);
      return { name, type, hadUserValue, value: hadUserValue ? whimsyReadPref(name, type) : undefined };
    });
    taskState = { windows, prefs, paused: WhimsyDoNotDisturb.paused, undo: [] };
    try {
      resetPrefs();
      WhimsyDoNotDisturb.setPaused(false);
      await task();
    } finally {
      await cleanupFocusTask();
    }
  };
  Object.defineProperty(isolated, "name", { value: task.name });
  add_task(isolated);
}

async function cleanupFocusTask() {
  if (!taskState) {
    return;
  }
  const snapshot = taskState;
  const errors = [];
  const clean = async (what, fn) => {
    try {
      await fn();
    } catch (error) {
      errors.push(new Error(`${what}: ${error}`));
    }
  };
  // End before clearing endsAt or removing tabs, to restore every wrapper,
  // notification state, muting, and the paused-site observer.
  await clean("Ending the task's focus session", () => {
    WhimsyFocusSession.dropBreak();
    WhimsyFocusSession.end();
  });
  for (const undo of snapshot.undo.reverse()) {
    await clean("Removing a screenshot stand-in", undo);
  }
  for (const win of Services.wm.getEnumerator("navigator:browser")) {
    await clean("Closing focus surfaces", async () => {
      for (const id of [SHEET_ID, PANEL_ID]) {
        const panel = win.document.querySelector(`panel#${id}`);
        if (panel) {
          await closeSheet({ panel });
        }
      }
    });
    await clean("Restoring focus UI", () => TestUtils.waitForCondition(() =>
      !win.document.documentElement.hasAttribute("whimsy-focus-tab") &&
      !win.document.getElementById(NOTCH_ID) &&
      !win.document.querySelector(".whimsy-focus-confetti"),
    "Task teardown removes the notch, confetti, and tab hiding"));
    await clean("Closing leftover Glance", async () => {
      const glance = win.gBrowser.tabs.find(tab => tab.hasAttribute("zen-glance-tab"));
      if (glance) {
        await closeGlanceTab(win, glance);
      }
    });
    win.gZenUIManager?.toasts?.getToasts({ includeClosing: true }).forEach(toast => toast.close({ instant: true }));
    const original = snapshot.windows.get(win);
    if (!original) {
      await clean("Closing a test window", () => within(BrowserTestUtils.closeWindow(win), "Closing a test window"));
      continue;
    }
    for (const tab of [...win.gBrowser.tabs]) {
      if (!original.tabs.has(tab)) {
        await clean("Removing a test tab", () => within(
          BrowserTestUtils.removeTab(tab, { skipPermitUnload: true }), "Removing a test tab"));
      }
    }
    if (original.selected.isConnected && win.gBrowser.selectedTab != original.selected) {
      await clean("Restoring the selected tab", () => within(
        BrowserTestUtils.switchTab(win.gBrowser, original.selected), "Restoring the selected tab"));
    }
  }
  while (prefDepth > 0) {
    await clean("Restoring task preferences", popFocusPrefs);
  }
  WhimsyFocusSession.breakMs = BREAK_MS;
  WhimsyFocusSession.doneHoldMs = HOLD_MS;
  WhimsyDoNotDisturb.setPaused(snapshot.paused);
  resetPrefs();
  for (const { name, type, hadUserValue, value } of snapshot.prefs) {
    if (hadUserValue) {
      whimsyWritePref(name, type, value);
    }
  }
  taskState = null;
  if (errors.length) {
    throw new AggregateError(errors, `Focus task teardown failed: ${errors.map(error => error.message).join("; ")}`);
  }
}

registerCleanupFunction(cleanupFocusTask);

async function pushFocusPrefs(env) {
  prefDepth++;
  await within(SpecialPowers.pushPrefEnv(env), "Applying task preferences");
}

async function popFocusPrefs() {
  prefDepth--;
  await within(SpecialPowers.popPrefEnv(), "Restoring task preferences");
}

function standInFocusPopups(doc = document) {
  const undo = whimsyStandInPopups(doc);
  taskState.undo.push(undo);
  return undo;
}

// Bound individual screenshot steps, so finally runs before task teardown.
async function focusBothSchemes(name, prepare) {
  for (const dark of [false, true]) {
    let cleanup;
    try {
      await pushFocusPrefs({ set: [
        ["ui.systemUsesDarkTheme", dark ? 1 : 0],
        ["browser.theme.toolbar-theme", dark ? 0 : 1],
        ["browser.theme.content-theme", dark ? 0 : 1],
      ] });
      const want = dark ? "dark" : "light";
      await TestUtils.waitForCondition(() => window.matchMedia(`(prefers-color-scheme: ${want})`).matches,
        `${name}: the window uses the ${want} scheme`);
      window.gZenThemePicker?.onWorkspaceChange?.(window.gZenWorkspaces?.getActiveWorkspace?.());
      await within(new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        `${name}: painting the colour scheme`);
      cleanup = await prepare(dark);
      await within(focusSettled(), `${name}: settling animations`);
      await within(whimsyShot(`${name}-${dark ? "dark" : "light"}`), `${name}: capturing the window`);
    } finally {
      try {
        await cleanup?.();
      } finally {
        await popFocusPrefs();
      }
    }
  }
}

// The shared screenshot helper logs and swallows animation timeouts. Here a
// persistent animation must fail at the step that owns it.
async function focusSettled(doc = document) {
  await TestUtils.waitForCondition(() => doc.getAnimations().every(animation =>
    animation.playState != "running" || animation.effect?.getComputedTiming().iterations == Infinity),
  "The focus document's finite animations finish");
}

async function openSheet(win = window) {
  const parts = WhimsyFocusSession.openSheet(win);
  ok(parts, "The sheet opens");
  await within(TestUtils.waitForCondition(() => parts.panel.state == "open", "The sheet is open"), "Opening the focus sheet");
  await within(win.document.l10n.translateFragment(parts.panel), "Translating the focus sheet");
  return parts;
}

async function closeSheet(parts) {
  if (parts.panel.state != "closed") {
    WhimsySurface.close(parts.panel);
    await TestUtils.waitForCondition(() => parts.panel.state == "closed",
      `The focus popup ${parts.panel.id} closes`);
  }
}

async function startFromSheet(parts) {
  parts.footer.querySelector(`#${SHEET_ID}-start`).click();
  await TestUtils.waitForCondition(() => parts.panel.state == "closed", "Start closes the focus sheet");
  ok(WhimsyFocusSession.isActive, "Start starts the session");
}

async function clickNotch(notch) {
  // Closing the sheet doesn't finish the notch's @starting-style entrance.
  // While it is still sliding into the page, a mouse click can miss it.
  // getAnimations() flushes styles and includes the entrance transitions.
  await within(Promise.all(notch.getAnimations().map(animation => animation.finished)),
    "Waiting for the notch's entrance");
  EventUtils.synthesizeMouseAtCenter(notch, {});
}

// A step that should finish soon; a hang fails with its name instead of
// timing out the whole file.
async function within(promise, what, ms = 15000) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} didn't finish in ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}

// The countdown as shown: a digit mid-flip holds its outgoing glyph too,
// so read only the ones staying.
function notchTime(notch) {
  return [...notch.querySelectorAll(".whimsy-focus-ch > i:not(.is-out)")].map(i => i.textContent).join("");
}

async function endSession() {
  WhimsyFocusSession.end();
  await TestUtils.waitForCondition(() => !document.getElementById(NOTCH_ID), "The notch goes");
}

// --- contrast (as browser_whimsy_ai_style.js) ------------------------------
function resolvedRGB(win, value, background = "#000") {
  const canvas = win.document.createElementNS(XHTML, "canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = background;
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
  const layers = [];
  for (let node = el; node && node.nodeType == 1; node = node.parentElement) {
    // Panel surfaces paint in their shadow content, behind their children.
    const surface = node.localName == "panel" && node.shadowRoot?.querySelector("[part~='content']");
    if (surface) {
      layers.push(win.getComputedStyle(surface).backgroundColor);
    }
    layers.push(win.getComputedStyle(node).backgroundColor);
  }
  // Tracks and muted text have alpha: composite over the actual surface,
  // rather than treating the first translucent track as a black-backed fill.
  return layers.reverse().reduce((bg, color) =>
    `rgb(${resolvedRGB(win, color, bg).join(", ")})`, "Canvas");
}
function describeOpened(tab) {
  return tab ? JSON.stringify({
    uri: tab.linkedBrowser?.currentURI?.spec,
    glance: tab.hasAttribute("zen-glance-tab"),
    attributes: Object.fromEntries([...tab.attributes].map(a => [a.name, a.value])),
  }) : "null";
}
function checkContrast(win, el, what, min = 4.5) {
  const background = backgroundOf(win, el);
  const fg = resolvedRGB(win, win.getComputedStyle(el).color, background);
  const bg = resolvedRGB(win, background);
  const ratio = contrastRatio(fg, bg);
  Assert.greaterOrEqual(ratio, min, `${what}: contrast ${ratio.toFixed(2)} is at least ${min}`);
}
function notClipped(el, what) {
  Assert.lessOrEqual(el.scrollWidth, el.clientWidth + 1, `${what} isn't clipped`);
}

// --- pure helpers -------------------------------------------------------------

addFocusTask(async function site_lines_and_matching() {
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

addFocusTask(async function sheet_defaults_and_remembered_ticks() {
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

  // The whole row ticks; the keyboard moves the picker.
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

addFocusTask(async function all_off_is_just_a_timer() {
  resetPrefs();
  Services.prefs.setStringPref(MUTE_PREF, "off");
  WhimsyDoNotDisturb.setPaused(false);
  const parts = await openSheet();
  for (const name of ["dnd", "pauseSites", "breakReminder"]) {
    EventUtils.synthesizeMouseAtCenter(parts.boxes[name], {});
  }
  ok(!parts.justTimer.hidden, "With nothing ticked, the caption says Just a timer");
  await within(document.l10n.translateFragment(parts.panel), "Translating Just a timer");
  ok(parts.justTimer.textContent.trim().length, "Just a timer has its text");
  await startFromSheet(parts);

  ok(!WhimsyDoNotDisturb.paused, "Do Not Disturb stays off");
  is(Services.prefs.getStringPref(MUTE_PREF), "off", "Background muting is unchanged");
  ok(document.getElementById(NOTCH_ID), "The countdown still shows");

  // The panel has no list, just the end time.
  await clickNotch(document.getElementById(NOTCH_ID));
  const panel = await TestUtils.waitForCondition(() => {
    const p = document.getElementById(PANEL_ID);
    return p?.state == "open" && p;
  }, "The notch's panel opens");
  const text = panel.querySelector(`#${PANEL_ID}-text`);
  is(text.getAttribute("data-l10n-id"), "whimsy-focus-panel-ends", "Nothing ticked: only when it ends");
  panel.querySelector(`#${PANEL_ID}-end`).click();
  await TestUtils.waitForCondition(() => panel.state == "closed", "End session closes the notch panel");
  ok(!WhimsyFocusSession.isActive, "End session ends it");
  await TestUtils.waitForCondition(() => !document.getElementById(NOTCH_ID), "The notch goes");
  ok(!currentToast(), "Ending early shows no toast");
  resetPrefs();
});

// --- start and end ----------------------------------------------------------------

addFocusTask(async function start_and_end_early_restore_everything() {
  resetPrefs();
  Services.prefs.setStringPref(MUTE_PREF, "off");
  WhimsyDoNotDisturb.setPaused(false);

  ok(action("whimsy-action-focus-start").isAvailable(window), "Start Focus Session is in the command bar");
  ok(!action("whimsy-action-focus-end").isAvailable(window), "End Focus Session isn't, yet");

  const win2 = await within(BrowserTestUtils.openNewBrowserWindow(), "Opening another browser window");
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
  const win3 = await within(BrowserTestUtils.openNewBrowserWindow(), "Opening another browser window");
  await TestUtils.waitForCondition(() => win3.document.getElementById(NOTCH_ID), "A new window gets the notch");
  await within(BrowserTestUtils.closeWindow(win3), "Closing another browser window");

  // The notch: a timer, labelled, and its time.
  const notch = document.getElementById(NOTCH_ID);
  is(notch.getAttribute("role"), "timer", "The notch is a timer");
  await TestUtils.waitForCondition(() => notch.getAttribute("aria-label"), "The notch is labelled");
  ok(/^2[45]:\d\d$/.test(notchTime(notch)), "It counts down from 25:00");
  const toastTop = document.getElementById("zen-toast-container");
  if (toastTop) {
    const offset = getComputedStyle(document.documentElement).getPropertyValue("--whimsy-focus-notch-bottom");
    ok(offset, "Toasts are moved below the notch");
  }

  // The panel names only what's ticked.
  await clickNotch(notch);
  const panel = await TestUtils.waitForCondition(() => {
    const p = document.getElementById(PANEL_ID);
    return p?.state == "open" && p;
  }, "The panel opens");
  const text = panel.querySelector(`#${PANEL_ID}-text`);
  await TestUtils.waitForCondition(() => text.textContent.length, "The panel has its text");
  ok(/Do Not Disturb/.test(text.textContent), "It names Do Not Disturb");
  ok(/paused/.test(text.textContent), "It names the paused sites");
  ok(/,/.test(text.textContent), "Four things are listed with commas");
  await closeSheet({ panel });

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
  await within(BrowserTestUtils.closeWindow(win2), "Closing another browser window");

  // Do Not Disturb that was already on stays on.
  WhimsyDoNotDisturb.setPaused(true);
  WhimsyFocusSession.start(window, { minutes: 5, dnd: true, pauseSites: false, muteBackground: false, breakReminder: false });
  WhimsyFocusSession.end();
  ok(WhimsyDoNotDisturb.paused, "Do Not Disturb that was on before stays on");
  WhimsyDoNotDisturb.setPaused(false);
  await TestUtils.waitForCondition(() => !document.getElementById(NOTCH_ID), "The notch goes");
  resetPrefs();
});

addFocusTask(async function the_time_runs_out() {
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

addFocusTask(async function listed_sites_are_paused() {
  resetPrefs();
  Services.prefs.setBoolPref(P.social, false);
  Services.prefs.setBoolPref(P.video, false);
  Services.prefs.setStringPref(P.sites, "example.org");
  is(WhimsyFocusSession.pausedSites.join(), "example.org", "Only the owner's site is listed");

  // A tab already on the site is left alone.
  const before = await within(BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.org/"), "Opening example.org");
  WhimsyFocusSession.start(window, { minutes: 25, dnd: false, pauseSites: true, muteBackground: false, breakReminder: false });
  // reloadTab resolves once the reload has loaded.
  await within(BrowserTestUtils.reloadTab(before), "Reloading the open tab");
  is(before.linkedBrowser.currentURI.host, "example.org", "A tab that was open stays");
  await within(BrowserTestUtils.removeTab(before), "Removing the focus test tab");

  info("A new load is paused");
  const tab = await within(BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank"), "Opening a blank tab");
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
  info("The paused page shows");
  ok(!doc.getElementById("whimsy-focus-open").hidden, "Open anyway is offered");

  // Other sites aren't.
  const other = await within(BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/"), "Opening example.com");
  is(other.linkedBrowser.currentURI.host, "example.com", "An unlisted site opens");
  await within(BrowserTestUtils.removeTab(other), "Removing the focus test tab");
  // Closing it usually selects the paused tab again; switchTab would wait
  // forever for a switch that already happened.
  if (gBrowser.selectedTab != tab) {
    await within(BrowserTestUtils.switchTab(gBrowser, tab), "Switching back");
  }
  info("Paused-page shots");

  await focusBothSchemes("focus-paused-page", async () => {
    await within(focusSettled(doc), "Settling the content document");
    checkContrast(doc.defaultView, doc.getElementById("whimsy-focus-back"), "Go back");
    checkContrast(doc.defaultView, doc.getElementById("whimsy-focus-heading"), "The paused heading");
    notClipped(doc.getElementById("whimsy-focus-open"), "Open anyway");
  });

  info("Open anyway");
  // Open anyway: this tab, this site, for the rest of the session.
  const loaded = BrowserTestUtils.browserLoaded(browser, false, "https://example.org/");
  EventUtils.synthesizeMouseAtCenter(doc.getElementById("whimsy-focus-open"), {}, doc.defaultView);
  await within(loaded, "Open anyway loading the site");
  is(browser.currentURI.host, "example.org", "Open anyway opens the site");
  const loadedAgain = BrowserTestUtils.browserLoaded(browser, false, "https://example.org/?again");
  BrowserTestUtils.startLoadingURIString(browser, "https://example.org/?again");
  await within(loadedAgain, "Loading it again");
  is(browser.currentURI.host, "example.org", "It stays open in that tab");

  info("Ending reopens paused tabs");
  // Ending the session opens paused tabs.
  const second = await within(BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank"), "Opening a second blank tab");
  // Use a subdomain registered with Mochitest's HTTPS server/certificate.
  BrowserTestUtils.startLoadingURIString(second.linkedBrowser, "https://test1.example.org/");
  await TestUtils.waitForCondition(
    () => second.linkedBrowser.currentURI.spec.startsWith("about:whimsy?focus"),
    "A subdomain is paused too"
  );
  const reopened = BrowserTestUtils.browserLoaded(second.linkedBrowser, false, "https://test1.example.org/");
  WhimsyFocusSession.end();
  await within(reopened, "Reopening the paused tab");
  is(second.linkedBrowser.currentURI.host, "test1.example.org", "Ending the session opens the site");

  await within(BrowserTestUtils.removeTab(second), "Removing the focus test tab");
  await within(BrowserTestUtils.removeTab(tab), "Removing the focus test tab");
  await TestUtils.waitForCondition(() => !document.getElementById(NOTCH_ID), "The notch goes");
  resetPrefs();
});

// --- reduced motion ---------------------------------------------------------------

addFocusTask(async function reduced_motion() {
  resetPrefs();
  await pushFocusPrefs({ set: [["ui.prefersReducedMotion", 1]] });
  const parts = await openSheet();
  const big = parts.picker.element.querySelector(".whimsy-focus-selector-value");
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
  await popFocusPrefs();

  // With motion: the reading bumps and confetti falls.
  await pushFocusPrefs({ set: [["ui.prefersReducedMotion", 0]] });
  const moving = await openSheet();
  moving.picker.element.focus();
  EventUtils.synthesizeKey("KEY_ArrowUp", {});
  ok(moving.picker.element.querySelector(".whimsy-focus-selector-value").classList.contains("is-bump"), "The number bumps");
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
  await popFocusPrefs();
  resetPrefs();
});

// --- the feature switch, the picker interface --------------------------------------

addFocusTask(async function turning_the_feature_off_ends_a_session() {
  resetPrefs();
  WhimsyFocusSession.start(window, { minutes: 10, dnd: false, pauseSites: true, muteBackground: false, breakReminder: false });
  ok(WhimsyFocusSession.isActive, "A session is on");
  await pushFocusPrefs({ set: [[WhimsyFocusSession.FEATURE_PREF, false]] });
  ok(!WhimsyFocusSession.isActive, "Turning focus sessions off ends it");
  ok(!action("whimsy-action-focus-start").isAvailable(window), "The command goes");
  is(WhimsyFocusSession.openSheet(window), null, "The sheet doesn't open");
  await TestUtils.waitForCondition(() => !document.getElementById(NOTCH_ID), "The notch goes");
  await popFocusPrefs();
  resetPrefs();
});

addFocusTask(async function the_picker_is_swappable() {
  const changes = [];
  const picker = WhimsyFocusPicker.create(document, { value: 40, onChange: v => changes.push(v) });
  ok(picker.element, "A picker has an element");
  is(picker.value, 40, "It starts at the given value");
  picker.value = 200;
  is(picker.value, 120, "It holds 1 to 120 minutes");
  is(changes.length, 0, "Setting the value doesn't report a change");
  is(typeof picker.focus, "function", "It can take focus");
  const dial = WhimsyFocusPicker.create(document, { value: 30, kind: "dial" });
  ok(dial.element.classList.contains("whimsy-focus-dial"), "The W28 dial is still a kind");
  ok(picker.element.classList.contains("whimsy-focus-selector"), "The default is the Selector");
});

// --- R · the Selector ---------------------------------------------------------------

const SEL_ANGLE = v => -135 + (v / 120) * 270;

// The knob's angle, read from its transform.
function pointsAt(picker, minutes, what) {
  Assert.less(Math.abs(selectorAngle(picker) - SEL_ANGLE(minutes)), 0.01, what);
}

function selectorAngle(picker) {
  const t = picker.element.querySelector(".whimsy-focus-selector-rot").getAttribute("transform");
  return parseFloat(/rotate\(([-\d.]+)/.exec(t)[1]);
}

// A point on the scale at `minutes`, in the picker's own coordinates.
function selectorPoint(picker, minutes) {
  const svg = picker.element.querySelector("svg");
  const r = svg.getBoundingClientRect();
  const a = (SEL_ANGLE(minutes) * Math.PI) / 180;
  const sx = r.width / 240;
  const sy = r.height / 204;
  return [(120 + 70 * Math.sin(a)) * sx, (100 - 70 * Math.cos(a)) * sy];
}

function selectorMouse(picker, minutes, type) {
  const [x, y] = selectorPoint(picker, minutes);
  EventUtils.synthesizeMouse(picker.element, x, y, { type }, picker.element.ownerDocument.defaultView);
}

addFocusTask(async function the_selector() {
  resetPrefs();
  await pushFocusPrefs({ set: [["ui.prefersReducedMotion", 1]] });
  const parts = await openSheet();
  const { picker } = parts;
  const el = picker.element;
  ok(el.classList.contains("whimsy-focus-selector"), "The sheet's picker is the Selector");
  is(el.getAttribute("role"), "slider", "It's a slider");
  is(el.getAttribute("aria-label"), "Length", "Called Length");
  is(el.getAttribute("aria-valuemin"), "1", "From 1");
  is(el.getAttribute("aria-valuemax"), "120", "To 120");
  await TestUtils.waitForCondition(() => el.getAttribute("aria-valuetext")?.startsWith("25 minutes, ends at "), "It reads 25 minutes and the end time");
  is(el.querySelectorAll(".whimsy-focus-selector-tick").length, 25, "A mark every 5 minutes");
  is(el.querySelectorAll(".whimsy-focus-selector-tick.is-15").length, 9, "Quarter hours are longer");
  is(
    [...el.querySelectorAll(".whimsy-focus-selector-label")].map(t => t.textContent).join(" "),
    "15 30 45 60 75 90 105 120",
    "Quarter hours are labelled"
  );
  pointsAt(picker, 25, "The knob points at 25");

  // Keys and the wheel move it by single minutes, between the marks.
  el.focus();
  const keys = [
    ["KEY_ArrowUp", {}, 26],
    ["KEY_ArrowRight", {}, 27],
    ["KEY_ArrowDown", {}, 26],
    ["KEY_ArrowLeft", {}, 25],
    ["KEY_ArrowUp", { shiftKey: true }, 30],
    ["KEY_ArrowDown", { shiftKey: true }, 25],
    ["KEY_PageUp", {}, 30],
    ["KEY_PageDown", {}, 25],
    ["KEY_End", {}, 120],
    ["KEY_Home", {}, 1],
  ];
  for (const [key, mods, want] of keys) {
    EventUtils.synthesizeKey(key, mods);
    is(picker.value, want, `${key}${mods.shiftKey ? " with Shift" : ""} goes to ${want}`);
    pointsAt(picker, want, "With Reduce Motion the knob jumps there");
    ok(!picker.moving, "And asks for no frames");
  }
  await TestUtils.waitForCondition(() => el.getAttribute("aria-valuetext")?.startsWith("1 minute, ends at "), "One minute is singular");
  picker.value = 25;
  EventUtils.synthesizeWheel(el, 20, 20, { deltaY: -1, deltaMode: WheelEvent.DOM_DELTA_LINE });
  is(picker.value, 26, "Scrolling up adds a minute");
  EventUtils.synthesizeWheel(el, 20, 20, { deltaY: 1, deltaMode: WheelEvent.DOM_DELTA_LINE });
  is(picker.value, 25, "Scrolling down takes one off");

  // A drag clunks into the 5-minute stops.
  selectorMouse(picker, 47, "mousedown");
  ok(el.classList.contains("is-held"), "The knob is held");
  is(picker.value, 45, "Pressing near 47 lands on 45");
  selectorMouse(picker, 62, "mousemove");
  is(picker.value, 60, "Dragging to 62 lands on 60");
  selectorMouse(picker, 88, "mousemove");
  is(picker.value, 90, "And 88 on 90");
  pointsAt(picker, 90, "The knob jumps with Reduce Motion");
  ok(!picker.moving, "No frames with Reduce Motion");
  selectorMouse(picker, 88, "mouseup");
  ok(!el.classList.contains("is-held"), "Letting go releases it");

  // There's a stop at each end; the pointer can't jump across the gap.
  selectorMouse(picker, 119, "mousedown");
  is(picker.value, 120, "Up to the top stop");
  selectorMouse(picker, 2, "mousemove");
  is(picker.value, 120, "Crossing the gap doesn't flip to the start");
  selectorMouse(picker, 2, "mouseup");
  selectorMouse(picker, 1, "mousedown");
  is(picker.value, 5, "A drag's lowest stop is 5");
  selectorMouse(picker, 1, "mouseup");
  is(document.activeElement, el, "Dragging focuses the picker");

  for (const name of ["dnd", "pauseSites", "breakReminder"]) {
    parts.boxes[name].click();
  }
  await startFromSheet(parts);
  is(Services.prefs.getIntPref(P.lastLength), 5, "Start remembers the pick");
  await endSession();
  const again = await openSheet();
  is(again.picker.value, 5, "The next sheet opens at it");
  pointsAt(again.picker, 5, "Pointing at it");
  await closeSheet(again);
  await popFocusPrefs();

  // With motion: the knob springs to each stop, then stops asking for frames.
  await pushFocusPrefs({ set: [["ui.prefersReducedMotion", 0]] });
  const moving = await openSheet();
  const p = moving.picker;
  selectorMouse(p, 30, "mousedown");
  is(p.value, 30, "Pressing at 30 lands on 30");
  ok(p.moving, "The knob springs there");
  ok(p.element.querySelector(".whimsy-focus-selector-value").classList.contains("is-bump"), "The reading bumps");
  await TestUtils.waitForCondition(() => !p.moving, "The spring settles");
  pointsAt(p, 30, "On the stop");
  selectorMouse(p, 30, "mouseup");
  p.element.focus();
  EventUtils.synthesizeKey("KEY_ArrowUp", {});
  ok(p.moving, "Keys use the settle spring");
  await TestUtils.waitForCondition(() => !p.moving, "It settles");
  pointsAt(p, 31, "Between the marks");
  const before = p.element.querySelector(".whimsy-focus-selector-rot").getAttribute("transform");
  await within(new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))), "Drawing two idle picker frames");
  is(p.element.querySelector(".whimsy-focus-selector-rot").getAttribute("transform"), before, "Idle, it draws nothing");
  ok(!p.moving, "And asks for no frames");
  await closeSheet(moving);
  await popFocusPrefs();
  resetPrefs();
});

// --- Settings › General › Focus Sessions -------------------------------------------

addFocusTask(async function settings_group_and_edit_link() {
  resetPrefs();
  // openPreferences may reuse the selected blank tab. Give it a test-owned
  // one so it cannot navigate the harness's original tab to Settings.
  await within(BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank"),
    "Opening the tab from which Edit should open Settings");
  const parts = await openSheet();
  EventUtils.synthesizeMouseAtCenter(parts.panel.querySelector(".whimsy-focus-edit"), {});
  // openPreferences can reuse a tab (including about:settings), so there
  // need not be a TabOpen or a new load event to wait for.
  const tab = await TestUtils.waitForCondition(() =>
    /^about:(preferences|settings)([?#]|$)/.test(gBrowser.selectedBrowser.currentURI.spec) && gBrowser.selectedTab,
  "Edit selects the Settings tab");
  await TestUtils.waitForCondition(() =>
    tab.linkedBrowser.contentDocument?.readyState == "complete" &&
    tab.linkedBrowser.contentDocument.getElementById("whimsyFocusGroup")?.checkVisibility(),
  "Edit loads and shows Settings > General > Focus Sessions");
  const win = tab.linkedBrowser.contentWindow;
  const doc = win.document;
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

  await focusBothSchemes("focus-settings", async () => {
    doc.getElementById("whimsyFocusGroup").scrollIntoView();
    await within(focusSettled(doc), "Settling the content document");
    checkContrast(win, doc.getElementById("whimsyFocusSocialSample"), "A sample line", 4.5);
  });
  if (!taskState.windows.get(window).tabs.has(tab)) {
    await within(BrowserTestUtils.removeTab(tab), "Removing the test Settings tab");
  }
  resetPrefs();
});

// --- Stay on this tab (intake-w29/designs/focus-this-tab.md) -------------------------

const { WhimsyFocusTab } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyFocusTab.sys.mjs");
const STAY = { minutes: 25, dnd: false, pauseSites: false, muteBackground: false, breakReminder: false, stayOnTab: true };

function glanceOver(keep) {
  const id = keep.getAttribute("glance-id");
  return id ? gBrowser.tabs.find(t => t != keep && t.hasAttribute("zen-glance-tab") && t.getAttribute("glance-id") == id) : null;
}

async function closeGlance(keep) {
  const glance = glanceOver(keep);
  if (!glance) {
    return;
  }
  // Stay on this tab blocks promotion, not dismissal. The test must dismiss
  // its own Glance before testing the next link. Zen's noAnimation path only
  // quick-closes the view; it never finalizes/removes the Glance tab.
  await closeGlanceTab(window, glance);
  await TestUtils.waitForCondition(() => gBrowser.selectedTab == keep, "Closing Glance selects the kept tab");
}

async function closeGlanceTab(win, glance) {
  const manager = win.gZenGlanceManager;
  if (manager.closingGlance) {
    await TestUtils.waitForCondition(() => !glance.isConnected && !manager.closingGlance,
      "The already-closing Glance finishes dismissal");
    return;
  }
  // A tab has its Glance attributes before the asynchronous opening animation
  // finishes. closeGlance silently returns while opening, so wait for readiness.
  await TestUtils.waitForCondition(() =>
    manager.browserWrapper?.hasAttribute("has-finished-animation") &&
    !manager.animatingOpen && !manager._animating,
  "The Glance finishes opening before dismissal");
  await within(manager.closeGlance({ skipPermitUnload: true }), "Dismissing the Glance");
  await TestUtils.waitForCondition(() => !glance.isConnected && !manager.closingGlance,
    "Dismissing Glance removes its tab and finishes closing");
}

addFocusTask(async function stay_on_this_tab() {
  resetPrefs();
  const others = [
    await within(BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.org/"), "Opening focus test tab https://example.org/"),
    await within(BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.net/"), "Opening focus test tab https://example.net/"),
  ];
  const keep = await within(BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/"), "Opening focus test tab https://example.com/");
  const win2 = await within(BrowserTestUtils.openNewBrowserWindow(), "Opening another browser window");
  await within(SimpleTest.promiseFocus(window), "Focusing the test window");

  // The sheet: a tick under Pause distracting sites, off by default.
  const parts = await openSheet();
  ok(parts.boxes.stayOnTab, "The sheet has Stay on this tab");
  ok(!parts.boxes.stayOnTab.checked, "It's off by default");
  const rows = [...parts.panel.querySelectorAll(".whimsy-focus-check-row")].map(r => r.id);
  is(rows.indexOf(`${SHEET_ID}-stayOnTab`), rows.indexOf(`${SHEET_ID}-pauseSites`) + 1, "It sits under Pause distracting sites");
  await closeSheet(parts);

  // Start, with motion: the other tabs fade, then hide.
  await pushFocusPrefs({ set: [["ui.prefersReducedMotion", 0]] });
  WhimsyFocusSession.start(window, STAY);
  ok(Services.prefs.getBoolPref(WhimsyFocusSession.PREFS.stayOnTab), "The tick is remembered");
  const root = document.documentElement;
  is(root.getAttribute("whimsy-focus-tab"), "leaving", "The other tabs fade out first");
  await TestUtils.waitForCondition(() => root.getAttribute("whimsy-focus-tab") == "on", "Then they hide");
  {
    // What the hiding looks like, for a failure.
    const cs = el => el && window.getComputedStyle(el);
    const ln = document.querySelector(".whimsy-focus-tab-line");
    const box = ln?.parentNode;
    info(
      `Diag root=${root.getAttribute("whimsy-focus-tab")} others=${others
        .map(t => `${t.parentNode?.localName}.${t.parentNode?.className}:${cs(t).display}`)
        .join(",")} line=${ln?.getBoundingClientRect().width}/${ln?.lastElementChild?.clientWidth}/${ln?.lastElementChild?.scrollWidth} box=${box?.localName}.${box?.className}:${cs(box)?.display}/${cs(box)?.flexDirection}/${box?.getBoundingClientRect().width}`
    );
  }
  ok(keep.hasAttribute("whimsy-focus-keep"), "The tab it started on is kept");
  ok(keep.checkVisibility(), "The kept tab shows");
  for (const tab of others) {
    ok(!tab.checkVisibility(), "Another tab is hidden");
  }
  ok(!win2.document.documentElement.hasAttribute("whimsy-focus-tab"), "The other window is untouched");

  const line = document.querySelector(".whimsy-focus-tab-line");
  ok(line?.checkVisibility(), "A line says what's hidden");
  await TestUtils.waitForCondition(() => line.textContent.includes("hidden until"), "The line has its text");
  ok(line.textContent.includes(`${WhimsyFocusTab.hiddenCount(window)} tabs hidden`), "It counts the hidden tabs");
  notClipped(line.lastElementChild, "The hidden-tabs line");

  // Key dispatch is synchronous: the capturing handler cancels switching.
  EventUtils.synthesizeKey("KEY_Tab", { ctrlKey: true });
  is(gBrowser.selectedTab, keep, "Ctrl+Tab does nothing");
  EventUtils.synthesizeKey("1", { accelKey: true, code: "Digit1" });
  is(gBrowser.selectedTab, keep, "Cmd+1 does nothing");
  gBrowser.selectedTab = others[0];
  await TestUtils.waitForCondition(() => gBrowser.selectedTab == keep, "Any other way back gives way to the kept tab");
  await within(gZenWorkspaces.changeWorkspace?.(gZenWorkspaces.getActiveWorkspace?.()), "Attempting to change workspace during focus");
  ok(Object.hasOwn(gZenWorkspaces, "changeWorkspace"), "Spaces are held");

  // New tabs open in Glance, and Glance can't become a tab.
  openTrustedLinkIn("https://example.org/?glance", "tab");
  const glance = await TestUtils.waitForCondition(() => glanceOver(keep), "A new tab opens in Glance");
  is(gBrowser.selectedTab, glance, "The Glance shows");
  await within(gZenGlanceManager.fullyOpenGlance(), "Attempting to promote Glance during focus");
  ok(glance.hasAttribute("zen-glance-tab"), "Glance can't become a tab");
  info(
    `Diag glance buttons=${[...document.querySelectorAll(".zen-glance-sidebar-open")]
      .map(b => `${b.parentNode?.id || b.parentNode?.className}:${window.getComputedStyle(b).display}:${b.checkVisibility()}`)
      .join(",")} root=${document.documentElement.getAttribute("whimsy-focus-tab")}`
  );
  ok(!document.querySelector(".zen-glance-sidebar-open")?.checkVisibility(), "Its open-as-tab button is hidden");
  // With a Glance open, the next link loads in it.
  const before = gBrowser.tabs.length;
  openTrustedLinkIn("https://example.net/?again", "tab");
  await TestUtils.waitForCondition(() => glance.linkedBrowser.currentURI.spec.startsWith("https://example.net/"), "The link loads in the Glance");
  is(gBrowser.tabs.length, before, "No tab is added");
  await closeGlance(keep);

  // A target=_blank link too. Dismissal must not leave a stale Glance that
  // would make openTabInGlance bail before adopting the content-created tab.
  is(WhimsyFocusTab.glanceOf(window), null, "The previous Glance is fully dismissed");
  await TestUtils.waitForCondition(() => keep.linkedBrowser.checkVisibility() && keep.linkedBrowser.docShellIsActive,
    "The kept browser is visible and active after Glance closes");
  const tabsBeforeBlank = new Set(gBrowser.tabs);
  await within(SpecialPowers.spawn(keep.linkedBrowser, [], () => {
    const a = content.document.createElement("a");
    a.href = "https://example.org/?blank";
    a.target = "_blank";
    a.id = "whimsy-blank";
    a.textContent = "link";
    // The server root is a long directory listing; appending an inline link
    // puts it below the viewport. synthesizeMouseAtCenter does not scroll.
    a.style.cssText = "position: fixed; top: 20px; left: 20px; z-index: 2147483647";
    content.document.body.append(a);
    const rect = a.getBoundingClientRect();
    Assert.equal(content.document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2),
      a, "The target=_blank fixture's center is in view and receives clicks");
  }), "Adding the target=_blank fixture");
  let openedBlank = null;
  gBrowser.tabContainer.addEventListener("TabOpen", e => { openedBlank ??= e.target; });
  const windowsBeforeBlank = [...Services.wm.getEnumerator("navigator:browser")].length;
  await within(BrowserTestUtils.synthesizeMouseAtCenter("#whimsy-blank", {}, keep.linkedBrowser), "Clicking the target=_blank fixture");
  // Diagnostics only: wait for the click's outcome so the line below reports it.
  await TestUtils.waitForCondition(() => openedBlank || glanceOver(keep), "The target=_blank click opens something").catch(() => {});
  info(`Diag target=_blank opened=${describeOpened(openedBlank)} windows=${windowsBeforeBlank}->` +
    `${[...Services.wm.getEnumerator("navigator:browser")].length} keepURI=${keep.linkedBrowser.currentURI.spec}`);
  const blankTabs = gBrowser.tabs.filter(tab => !tabsBeforeBlank.has(tab));
  const describeBlankTab = tab => tab ? JSON.stringify({
    uri: tab.linkedBrowser?.currentURI?.spec,
    connected: tab.isConnected,
    closing: !!tab.closing,
    selected: tab == gBrowser.selectedTab,
    attributes: Object.fromEntries([...tab.attributes].map(a => [a.name, a.value])),
  }) : "null";
  info(`Diag target=_blank tabs=${tabsBeforeBlank.size}->${gBrowser.tabs.length} newTab=${!!blankTabs.length} ` +
    `newTabs=${blankTabs.map(describeBlankTab).join(",")} keepGlanceId=${keep.getAttribute("glance-id")} ` +
    `glanceOver=${describeBlankTab(glanceOver(keep))} glanceOf=${describeBlankTab(WhimsyFocusTab.glanceOf(window))} ` +
    `closingGlance=${gZenGlanceManager.closingGlance} animatingOpen=${gZenGlanceManager.animatingOpen}`);
  const contentGlance = await TestUtils.waitForCondition(() => glanceOver(keep), "A target=_blank link opens in Glance");
  await TestUtils.waitForCondition(() => contentGlance.linkedBrowser.currentURI.spec == "https://example.org/?blank",
    "The content-created browser loads the target URL in Glance");
  is(gBrowser.selectedTab, contentGlance, "The content-created Glance is selected");
  await closeGlance(keep);

  // ⌘K: no switch-to-tab rows.
  const results = document.getElementById("urlbar-results");
  if (results) {
    const fake = document.createElementNS(XHTML, "div");
    fake.className = "urlbarView-row";
    fake.setAttribute("type", "switchtab");
    taskState.undo.push(() => fake.remove());
    results.append(fake);
    await TestUtils.waitForCondition(() => fake.hidden, "A switch-to-tab row is hidden");
    fake.setAttribute("type", "url");
    await TestUtils.waitForCondition(() => !fake.hidden, "The row shows again as another result");
    fake.remove();
  }

  // The panel says the tabs come back.
  const panel = await within(WhimsyFocusNotch.openPanel(window), "Opening the focus notch panel");
  await TestUtils.waitForCondition(() => panel.panel.state == "open", "The panel opens");
  const back = panel.panel.querySelector(`#${PANEL_ID}-tabs`);
  is(back?.getAttribute("data-l10n-id"), "whimsy-focus-panel-tabs", "It says the other tabs come back");
  await closeSheet(panel);

  // Ending brings everything back, with a fade.
  WhimsyFocusSession.end();
  is(root.getAttribute("whimsy-focus-tab"), "returning", "The tabs fade back in");
  await TestUtils.waitForCondition(() => !root.hasAttribute("whimsy-focus-tab"), "Then the window is back");
  ok(!keep.hasAttribute("whimsy-focus-keep"), "The kept tab is ordinary again");
  ok(others.every(t => t.checkVisibility()), "The other tabs show");
  ok(!document.querySelector(".whimsy-focus-tab-line"), "The line goes");
  ok(!Object.hasOwn(gBrowser, "addTab"), "New tabs open as tabs again");
  ok(!Object.hasOwn(gZenWorkspaces, "changeWorkspace"), "Spaces change again");
  ok(!Object.hasOwn(gZenGlanceManager, "fullyOpenGlance"), "Glance opens as a tab again");
  gBrowser.selectedTab = others[0];
  await within(TestUtils.waitForTick(), "Processing tab selection after ending focus");
  is(gBrowser.selectedTab, others[0], "Switching tabs works again");
  await popFocusPrefs();

  // Reduce Motion: straight to hidden, straight back. Closing the kept tab
  // ends the hiding.
  await pushFocusPrefs({ set: [["ui.prefersReducedMotion", 1]] });
  gBrowser.selectedTab = keep;
  WhimsyFocusSession.start(window, STAY);
  is(root.getAttribute("whimsy-focus-tab"), "on", "With Reduce Motion the tabs hide at once");
  await within(BrowserTestUtils.removeTab(keep), "Removing the focus test tab");
  await TestUtils.waitForCondition(() => !root.hasAttribute("whimsy-focus-tab"), "Closing the kept tab brings the others back");
  ok(WhimsyFocusSession.isActive, "The session goes on");
  await endSession();
  await popFocusPrefs();

  await within(BrowserTestUtils.closeWindow(win2), "Closing another browser window");
  for (const tab of others) {
    await within(BrowserTestUtils.removeTab(tab), "Removing the focus test tab");
  }
  resetPrefs();
});

addFocusTask(async function stay_on_this_tab_screens() {
  resetPrefs();
  const keep = await within(BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/"), "Opening focus test tab https://example.com/");
  const other = await within(BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.org/"), "Opening focus test tab https://example.org/");
  gBrowser.selectedTab = keep;
  await pushFocusPrefs({ set: [["ui.prefersReducedMotion", 1]] });
  WhimsyFocusSession.start(window, STAY);
  await focusBothSchemes("focus-stay-on-tab", async () => {
    const line = document.querySelector(".whimsy-focus-tab-line");
    await TestUtils.waitForCondition(() => line.textContent.includes("hidden"), "The line has its text");
    // The sidebar isn't a filled surface (it shows the window's material),
    // so the shot is the check here.
    notClipped(line.lastElementChild, "The hidden-tabs line");
  });
  await endSession();
  await popFocusPrefs();
  await within(BrowserTestUtils.removeTab(other), "Removing the focus test tab");
  await within(BrowserTestUtils.removeTab(keep), "Removing the focus test tab");
  resetPrefs();
});

// --- screenshots and contrast -------------------------------------------------------

addFocusTask(async function screens() {
  resetPrefs();
  Services.prefs.setStringPref(MUTE_PREF, "off");
  await focusBothSchemes("focus-sheet", async () => {
    const parts = await openSheet();
    await within(focusSettled(), "Settling the focus surface");
    const start = parts.footer.querySelector(`#${SHEET_ID}-start`);
    checkContrast(window, start, "Start");
    checkContrast(window, parts.ends, "Ends at");
    checkContrast(window, parts.panel.querySelector(".whimsy-focus-edit"), "Edit");
    // Text tokens must remain readable even for extreme space accents.
    for (const accent of ["white", "black", "yellow", "cyan"]) {
      parts.panel.style.setProperty("--zen-primary-color", accent);
      checkContrast(window, parts.ends, `Ends at with ${accent} accent`);
      checkContrast(window, parts.panel.querySelector(".whimsy-focus-edit"), `Edit with ${accent} accent`);
    }
    parts.panel.style.removeProperty("--zen-primary-color");
    for (const row of parts.panel.querySelectorAll(".whimsy-surface-row-label")) {
      notClipped(row, `The ${row.textContent} label`);
    }
    const undo = standInFocusPopups(document);
    return async () => {
      undo?.();
      await closeSheet(parts);
    };
  });

  await focusBothSchemes("focus-sheet-just-timer", async () => {
    const parts = await openSheet();
    for (const box of Object.values(parts.boxes)) {
      box.checked = false;
      box.dispatchEvent(new Event("change"));
    }
    await within(focusSettled(), "Settling the focus surface");
    const undo = standInFocusPopups(document);
    return async () => {
      undo?.();
      await closeSheet(parts);
    };
  });

  WhimsyFocusSession.start(window, { minutes: 25, dnd: false, pauseSites: true, muteBackground: false, breakReminder: true });
  await focusBothSchemes("focus-notch", async () => {
    const notch = document.getElementById(NOTCH_ID);
    await TestUtils.waitForCondition(() => notch.querySelector(".whimsy-focus-time").textContent, "The time shows");
    checkContrast(window, notch.querySelector(".whimsy-focus-time"), "The countdown");
  });
  await focusBothSchemes("focus-notch-panel", async () => {
    const parts = await within(WhimsyFocusNotch.openPanel(window), "Opening the focus notch panel");
    await TestUtils.waitForCondition(() => parts.panel.state == "open", "The panel is open");
    await within(focusSettled(), "Settling the focus surface");
    checkContrast(window, parts.footer.querySelector(`#${PANEL_ID}-end`), "End session");
    const undo = standInFocusPopups(document);
    return async () => {
      undo?.();
      await closeSheet(parts);
    };
  });
  await endSession();

  WhimsyFocusSession.doneHoldMs = 50;
  await focusBothSchemes("focus-done-toast", async () => {
    WhimsyFocusSession.start(window, { minutes: 25, dnd: false, pauseSites: false, muteBackground: false, breakReminder: true });
    WhimsyFocusSession.finish();
    const toast = await TestUtils.waitForCondition(() => toastFor("whimsy-focus-done-toast"), "The toast shows");
    await within(focusSettled(), "Settling the focus surface");
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
