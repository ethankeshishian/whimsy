/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W11-P1: the harness ends every test file by waiting up to 5s for vsync to
// switch off (no animation or paint still running), then fails the file.
// On a loaded machine (the parallel verify, or a busy Mac) an animation the
// test's last step started (a panel closing, a Glance, a toast leaving) can
// take longer than that to finish. Wait for that same state, longer, as the
// file's very last cleanup; a real endless animation still fails the
// harness's check afterwards.
// wave13/toast: toasts stack and some stay for seconds, so one a file left
// up would sit above the next file's toasts. Each file starts clean.
registerCleanupFunction(function whimsyCloseToasts() {
  for (const win of Services.wm.getEnumerator("navigator:browser")) {
    win.gZenUIManager?.toasts?.getToasts({ includeClosing: true }).forEach(toast => toast.close({ instant: true }));
  }
});

// Form drafts and AI keys are encrypted with OSKeyStore. The real Keychain
// item only answers the build that made it: a rebuilt (ad-hoc signed) binary
// gets an "allow access" prompt nobody answers, and OSKeyStore's one serial
// queue then hangs every later call, the drafts' shutdown write too. Like
// Firefox's own tests (OSKeyStoreTestUtils), every file gets its own
// throwaway item, deleted after the file's own cleanups.
{
  const { OSKeyStore } = ChromeUtils.importESModule("resource://gre/modules/OSKeyStore.sys.mjs");
  const realLabel = OSKeyStore.STORE_LABEL;
  OSKeyStore.STORE_LABEL = "test-whimsy-" + Math.random().toString(36).slice(2);
  registerCleanupFunction(() => registerCleanupFunction(async function whimsyDropTestKeyStore() {
    const { WhimsyFormDrafts } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyFormProtection.sys.mjs");
    await WhimsyFormDrafts.flush();
    await OSKeyStore.cleanup().catch(() => {});
    OSKeyStore.STORE_LABEL = realLabel;
  }));
}

registerCleanupFunction(function whimsyQueueSettle() {
  // Registered from inside a cleanup, so it runs after the test's own.
  registerCleanupFunction(async function whimsySettleVsync() {
    if (!ChromeUtils.vsyncEnabled()) {
      return;
    }
    await TestUtils.waitForCondition(() => !ChromeUtils.vsyncEnabled(), "Animations have finished", 100, 300)
      .catch(() => {});
  });
});

// A snapshot of a window paints each remote frame in its own process. When
// one of those frames goes away or is replaced mid-paint (a tab closing or
// switching process, a page committing), Gecko drops its fragment and the
// whole snapshot rejects with NS_ERROR_LOSS_OF_SIGNIFICANT_DATA
// (CrossProcessPaint::LostFragment). That's a race with the page, not a
// failed check: paint again, once the frames have settled.
async function whimsySnapshot(windowGlobal, rect, scale = 1, background = "white") {
  for (let attempt = 1; ; attempt++) {
    try {
      return await windowGlobal.drawSnapshot(rect, scale, background);
    } catch (e) {
      if (e?.result != Cr.NS_ERROR_LOSS_OF_SIGNIFICANT_DATA || attempt >= 5) {
        throw e;
      }
      info(`Snapshot lost a frame mid-paint (attempt ${attempt}); painting again`);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }
  }
}

// W27: a handful of prefs get written by almost every test as a side effect
// of ordinary browsing (opening a tab, ctrl-tab, an update/teach tip banner
// being marked seen) rather than by anything the test is actually checking.
// checkPreferencesAfterTest compares against a snapshot taken when the file
// starts, so each test file otherwise has to restore these itself; doing it
// once here means a new test doesn't need to know about them at all. Restore
// runs last, so a test's own cleanup (which may write them again) goes
// first: cleanup functions run in the order they were registered, so this
// one, registered first, queues the restore behind all the others.
const WHIMSY_SHARED_LEAK_PREFS = [
  "whimsy.stats.tabs-opened",
  "whimsy.updates.seen-install",
  "whimsy.teach.seen",
  "browser.engagement.ctrlTab.has-used",
  // Zen's URL bar learner records every pick (ZenUBResultsLearner).
  "zen.urlbar.suggestions-learner",
  // W23: the ⌘E hint shows after any page load once the browser is idle,
  // so it can land in whichever test runs next.
  "whimsy.ai.hints.seen",
  "whimsy.ai.hints.today",
  // Opening about:preferences lazily caches a default device name (from the
  // FxAccounts device list) the first time anything reads it.
  "identity.fxaccounts.account.device.name",
  // wave13: several Library-opening tests leave the Library on whichever tab
  // they last switched to.
  "zen.library.last-tab",
  // migrateDefaults() bumps this to the current version; several files
  // exercise it directly.
  "whimsy.menus.defaults-version",
  // Toggling real Picture-in-Picture, as the pip_* tests do, is Firefox's
  // own first-run bookkeeping for the feature.
  "media.videocontrols.picture-in-picture.video-toggle.has-used",
  "media.videocontrols.picture-in-picture.video-toggle.first-seen-secs",
  // Side effects of opening windows, panels and profiles that the files
  // after them never look at.
  "whimsy.quick-window.size",
  "whimsy.profiles.login-tags",
  "whimsy.profiles.download-dirs",
  "whimsy.profiles.search-engines",
  "whimsy.profiles.extensions",
  "whimsy.useragent.sites",
  "whimsy.stats.zapped",
  "screenshots.browser.component.last-screenshot-method",
  "screenshots.browser.component.last-saved-method",
  // Firefox's VPN panel records its own first open and dismisses its
  // location badge whenever any file opens it.
  "browser.ipProtection.everOpenedPanel",
  "browser.ipProtection.locationButtonBadgeDismissed",
  "browser.ipProtection.added",
  // ETP's own record that its exceptions settings were touched.
  "privacy.trackingprotection.allow_list.hasUserInteractedWithETPSettings",
  // Zen's last active space, written by every window that opens or switches
  // space; each window keeps its own active space in memory.
  "zen.workspaces.active",
];

function whimsyReadPref(name, type) {
  switch (type) {
    case Services.prefs.PREF_BOOL:
      return Services.prefs.getBoolPref(name);
    case Services.prefs.PREF_INT:
      return Services.prefs.getIntPref(name);
    default:
      return Services.prefs.getStringPref(name);
  }
}

function whimsyWritePref(name, type, value) {
  switch (type) {
    case Services.prefs.PREF_BOOL:
      Services.prefs.setBoolPref(name, value);
      break;
    case Services.prefs.PREF_INT:
      Services.prefs.setIntPref(name, value);
      break;
    default:
      Services.prefs.setStringPref(name, value);
      break;
  }
}

add_setup(function whimsySnapshotLeakedPrefs() {
  const snapshot = WHIMSY_SHARED_LEAK_PREFS.map(name => {
    const hadUserValue = Services.prefs.prefHasUserValue(name);
    const type = Services.prefs.getPrefType(name);
    return { name, hadUserValue, type, value: hadUserValue ? whimsyReadPref(name, type) : undefined };
  });

  registerCleanupFunction(() => registerCleanupFunction(function whimsyRestoreLeakedPrefs() {
    const { WhimsySyncedMap } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyProfileSync.sys.mjs");
    for (const pref of snapshot) {
      // A synced map (whimsy.profiles.*) would merge its cache straight back.
      if (WhimsySyncedMap.restoreForTesting(pref.name, pref.value)) {
        continue;
      }
      if (!pref.hadUserValue) {
        Services.prefs.clearUserPref(pref.name);
      } else {
        whimsyWritePref(pref.name, pref.type, pref.value);
      }
    }
  }));
});

// wave13/toast: Whimsy's toasts are Zen's (gZenUIManager.toasts,
// WhimsyZenToasts.sys.mjs). The newest toast showing in `win`, as the
// handle open() returned (element, messageId, update(), close()), or null.
function currentToast(win = window) {
  return win.gZenUIManager.toasts.getToasts()[0] ?? null;
}

// The toast showing in `win` for this message, or null.
function toastFor(messageId, win = window) {
  return win.gZenUIManager.toasts.getToasts().find(t => t.messageId == messageId) ?? null;
}

// Takes every toast down at once, without motion, including any still
// fading out.
function closeToasts(win = window) {
  for (const toast of win.gZenUIManager.toasts.getToasts({ includeClosing: true })) {
    toast.close({ instant: true });
  }
}

// W23: screenshot helpers shared by every browser_whimsy_screens*.js file.
// Without WHIMSY_SHOTS they only run the setup (a quick smoke check).
const WHIMSY_SHOTS_DIR = Services.env.get("WHIMSY_SHOTS");

async function whimsyShot(name, windowGlobal = window.browsingContext.currentWindowGlobal) {
  if (!WHIMSY_SHOTS_DIR) {
    return;
  }
  // A page's snapshot defaults to the window's size; crop it to the page's
  // own viewport so no white margin shows beside or below it.
  const embedder = windowGlobal.browsingContext.embedderElement;
  const rect = embedder?.localName == "browser" ?
    new DOMRect(0, 0, embedder.clientWidth, embedder.clientHeight) : null;
  const bitmap = await whimsySnapshot(windowGlobal, rect);
  const canvas = document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d").drawImage(bitmap, 0, 0);
  const blob = await new Promise(resolve => canvas.toBlob(resolve));
  const path = PathUtils.join(WHIMSY_SHOTS_DIR, `${name}.png`);
  await IOUtils.write(path, new Uint8Array(await blob.arrayBuffer()));
  info(`Saved ${path}`);
}

// Dark shots must really be dark. The system pref alone flips
// prefers-color-scheme, but Zen paints the window from its space theme in
// JS, so repaint it and wait for the change to land before drawing. Pops
// with SpecialPowers.popPrefEnv().
async function whimsySetScheme(dark) {
  await SpecialPowers.pushPrefEnv({ set: [
    ["ui.systemUsesDarkTheme", dark ? 1 : 0],
    ["browser.theme.toolbar-theme", dark ? 0 : 1],
    ["browser.theme.content-theme", dark ? 0 : 1],
  ] });
  const want = dark ? "dark" : "light";
  await TestUtils.waitForCondition(() =>
    window.matchMedia(`(prefers-color-scheme: ${want})`).matches, `The window is ${want}`);
  window.gZenThemePicker?.onWorkspaceChange?.(window.gZenWorkspaces?.getActiveWorkspace?.());
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
}

// Waits until every finite animation in the document has finished, so a
// sheet or dialog isn't caught mid-fade.
async function whimsySettled(doc = document) {
  await TestUtils.waitForCondition(() =>
    doc.getAnimations().every(a =>
      a.playState != "running" || a.effect?.getComputedTiming().iterations == Infinity),
  "Animations have settled").catch(() => info("Some animation kept running"));
}

// Shoots `<name>-light` and `<name>-dark`. `prepare(dark)` shows the state
// and may return a cleanup function, run before the scheme is popped.
async function whimsyBothSchemes(name, prepare) {
  for (const dark of [false, true]) {
    await whimsySetScheme(dark);
    let cleanup = null;
    try {
      cleanup = await prepare(dark);
      await whimsySettled();
      await whimsyShot(`${name}-${dark ? "dark" : "light"}`);
    } finally {
      await cleanup?.();
      await SpecialPowers.popPrefEnv();
    }
  }
}

// Holds the animation `getAnimation()` returns at `ms` and shoots
// `<name>-mid-<ms>`, then lets it finish. A Web Animation or Motion's
// controls (whimsyCaptureMotion).
async function whimsyShotMid(name, getAnimation, ms) {
  // Motion's controls are thenable: waitForCondition would await them.
  await TestUtils.waitForCondition(() => !!getAnimation(), `${name}: the animation started`);
  const animation = getAnimation();
  animation.pause();
  if ("currentTime" in animation) {
    animation.currentTime = ms;
  } else {
    animation.time = ms / 1000;
  }
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  try {
    await whimsyShot(`${name}-mid-${ms}`);
  } finally {
    animation.play();
  }
}

// Zen animates with Motion (JS, no Web Animation to hold). Until the
// returned stop() runs, Motion's controls for `element` (or the first
// element `match` accepts) are kept; get() returns the latest.
function whimsyCaptureMotion(match, win = window) {
  const real = win.gZenUIManager.motion;
  let latest = null;
  win.Motion = {
    ...real,
    animate(target, ...rest) {
      const controls = real.animate(target, ...rest);
      if (typeof match == "function" ? match(target) : target == match) {
        latest = controls;
      }
      return controls;
    },
  };
  return {
    get: () => latest,
    stop() {
      win.Motion = real;
    },
  };
}
