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
