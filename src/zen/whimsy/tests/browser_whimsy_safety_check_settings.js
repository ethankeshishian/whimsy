/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W29 safety-check: Settings → Privacy & Security → Safety Check
// (design/safety-check). The card, its four rows always in the same order,
// Check again, each row's action, and the Unused Site Permissions sheet
// (Remove, Remove all, Undo).

const { WhimsySafetyCheck } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySafetyCheck.sys.mjs");
const { WhimsyUndo } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyUndo.sys.mjs");

function principalFor(origin) {
  return Services.scriptSecurityManager.createContentPrincipalFromOrigin(origin);
}

function allOk() {
  WhimsySafetyCheck._readUpdates = async () => [null, { version: "1.24b-w3.7" }];
  WhimsySafetyCheck._getLogins = async () => [];
  WhimsySafetyCheck._getAddons = async () => [];
  WhimsySafetyCheck._getBreaches = async () => new Map();
  WhimsySafetyCheck._lastVisit = () => Date.now();
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.safety-check", true]] });
  registerCleanupFunction(() => {
    WhimsySafetyCheck._readUpdates = null;
    WhimsySafetyCheck._getLogins = null;
    WhimsySafetyCheck._getAddons = null;
    WhimsySafetyCheck._getBreaches = null;
    WhimsySafetyCheck._lastVisit = null;
    closeToasts();
  });
});

async function withSettings(callback) {
  await BrowserTestUtils.withNewTab("about:preferences#privacy", async browser => {
    const doc = browser.contentDocument;
    const win = browser.contentWindow;
    await TestUtils.waitForCondition(
      () => doc.getElementById("whimsySafetyCheckGroup") && !doc.getElementById("whimsySafetyCheckGroup").hidden,
      "The Safety Check card is shown"
    );
    await TestUtils.waitForCondition(
      () => doc.getElementById("whimsySafetyCheckLastRun").textContent.startsWith("Checked"),
      "The first run has landed"
    );
    await callback(win, doc);
  });
}

function row(doc, kind) {
  return doc.getElementById(`whimsySafetyCheckRow-${kind}`);
}

add_task(async function card_is_first_and_rows_are_in_fixed_order() {
  allOk();
  await withSettings(async (win, doc) => {
    const card = doc.getElementById("whimsySafetyCheckGroup");
    const autofill = doc.getElementById("whimsyAutofillGroup");
    if (autofill) {
      ok(
        card.compareDocumentPosition(autofill) & Node.DOCUMENT_POSITION_FOLLOWING,
        "Safety Check comes before Autofill"
      );
    }
    const ids = [...doc.querySelectorAll("#whimsySafetyCheckList .whimsy-safety-check-row")].map(r => r.id);
    is(
      ids.join(","),
      "whimsySafetyCheckRow-updates,whimsySafetyCheckRow-passwords,whimsySafetyCheckRow-extensions,whimsySafetyCheckRow-permissions",
      "Updates, Passwords, Extensions, Site permissions, always in that order"
    );
  });
});

add_task(async function all_ok_renders_ok_status_and_no_actions() {
  allOk();
  await withSettings(async (win, doc) => {
    for (const kind of ["updates", "passwords", "extensions", "permissions"]) {
      const r = row(doc, kind);
      await TestUtils.waitForCondition(() => r.classList.contains("is-ok"), `${kind} lands as ok`);
      ok(r.querySelector(".whimsy-safety-check-action").hidden, `${kind} has no action while ok`);
    }
    is(row(doc, "updates").querySelector(".whimsy-safety-check-status").textContent, "Whimsy is up to date", "Updates ok text");
    is(row(doc, "passwords").querySelector(".whimsy-safety-check-status").textContent, "No breached passwords", "Passwords ok text");
    is(row(doc, "extensions").querySelector(".whimsy-safety-check-status").textContent, "Extensions look fine", "Extensions ok text");
    is(row(doc, "permissions").querySelector(".whimsy-safety-check-status").textContent, "No unused permissions", "Permissions ok text");
  });
});

add_task(async function check_again_reruns_and_shows_checking() {
  allOk();
  await withSettings(async (win, doc) => {
    const updatesRow = row(doc, "updates");
    await TestUtils.waitForCondition(() => updatesRow.classList.contains("is-ok"), "Lands ok first");

    WhimsySafetyCheck._readUpdates = async () => [{ staged: { version: "1.24b-w3.8" } }, { version: "1.24b-w3.7" }];
    const button = doc.getElementById("whimsySafetyCheckRun");
    EventUtils.synthesizeMouseAtCenter(button, {}, win);
    await TestUtils.waitForCondition(
      () => updatesRow.querySelector(".whimsy-safety-check-icon").classList.contains("is-spinning") || updatesRow.classList.contains("is-warn"),
      "Checking again shows a spinner (or has already landed)"
    );
    await TestUtils.waitForCondition(() => updatesRow.classList.contains("is-warn"), "Re-running picks up the new staged update");
    is(updatesRow.querySelector(".whimsy-safety-check-status").textContent, "An update is ready", "Updates warn text");
  });
});

add_task(async function updates_restart_action() {
  allOk();
  WhimsySafetyCheck._readUpdates = async () => [{ staged: { version: "1.24b-w3.8" } }, { version: "1.24b-w3.7" }];
  await withSettings(async (win, doc) => {
    const action = await TestUtils.waitForCondition(() => {
      const a = row(doc, "updates").querySelector(".whimsy-safety-check-action");
      return !a.hidden ? a : null;
    }, "The restart action shows");
    is(action.label, "Restart to update", "Its label");
    let quitFlags = null;
    const original = Services.startup.quit;
    Services.startup.quit = flags => {
      quitFlags = flags;
    };
    try {
      EventUtils.synthesizeMouseAtCenter(action, {}, win);
      is(quitFlags, Ci.nsIAppStartup.eAttemptQuit | Ci.nsIAppStartup.eRestart, "Asks to restart, not just quit");
    } finally {
      Services.startup.quit = original;
    }
  });
});

add_task(async function passwords_review_opens_about_logins_filtered_to_alerts() {
  allOk();
  WhimsySafetyCheck._getLogins = async () => [{ guid: "g1", origin: "https://breached.example" }];
  WhimsySafetyCheck._getBreaches = async () => new Map([["g1", { Domain: "breached.example" }]]);
  Services.prefs.clearUserPref("signon.management.page.sort");
  await withSettings(async (win, doc) => {
    const action = await TestUtils.waitForCondition(() => {
      const a = row(doc, "passwords").querySelector(".whimsy-safety-check-action");
      return !a.hidden ? a : null;
    }, "The Review action shows");
    is(action.label, "Review", "Its label");
    const opened = BrowserTestUtils.waitForNewTab(gBrowser, "about:logins");
    EventUtils.synthesizeMouseAtCenter(action, {}, win);
    const tab = await opened;
    is(Services.prefs.getCharPref("signon.management.page.sort"), "alerts", "Sorted to show the breached ones");
    BrowserTestUtils.removeTab(tab);
  });
  Services.prefs.clearUserPref("signon.management.page.sort");
});

add_task(async function extensions_review_opens_the_addon_in_about_addons() {
  allOk();
  WhimsySafetyCheck._getAddons = async () => [
    { id: "risky@ext", name: "Risky", hidden: false, blocklistState: Ci.nsIBlocklistService.STATE_NOT_BLOCKED,
      userPermissions: { origins: ["<all_urls>"] }, sourceURI: null },
  ];
  await withSettings(async (win, doc) => {
    const action = await TestUtils.waitForCondition(() => {
      const a = row(doc, "extensions").querySelector(".whimsy-safety-check-action");
      return !a.hidden ? a : null;
    }, "The Review action shows");
    is(action.label, "Review", "Its label");
    is(row(doc, "extensions").querySelector(".whimsy-safety-check-detail").textContent,
      "Risky isn't from addons.mozilla.org and can see every page you open.", "Names the extension");
    let openedView = null;
    const chromeWin = win.browsingContext.topChromeWindow;
    const original = chromeWin.BrowserAddonUI.openAddonsMgr;
    chromeWin.BrowserAddonUI.openAddonsMgr = view => {
      openedView = view;
    };
    try {
      EventUtils.synthesizeMouseAtCenter(action, {}, win);
      is(openedView, "addons://detail/risky%40ext", "Opens that extension's detail page");
    } finally {
      chromeWin.BrowserAddonUI.openAddonsMgr = original;
    }
  });
});

add_task(async function permissions_sheet_remove_undo_and_remove_all() {
  allOk();
  const cameraOrigin = "https://camera-stale.example.com";
  const micOrigin = "https://mic-stale.example.com";
  const cameraPrincipal = principalFor(cameraOrigin);
  const micPrincipal = principalFor(micOrigin);
  Services.perms.addFromPrincipal(cameraPrincipal, "camera", Services.perms.ALLOW_ACTION);
  Services.perms.addFromPrincipal(micPrincipal, "microphone", Services.perms.ALLOW_ACTION);
  const march = new Date(2026, 2, 15).getTime();
  const july = new Date(2026, 6, 10).getTime();
  WhimsySafetyCheck._lastVisit = host => {
    if (host == "camera-stale.example.com") {
      return march;
    }
    if (host == "mic-stale.example.com") {
      return july;
    }
    return null;
  };

  try {
    await withSettings(async (win, doc) => {
      const permRow = row(doc, "permissions");
      await TestUtils.waitForCondition(() => permRow.classList.contains("is-warn"), "Two unused sites: warn");
      is(permRow.querySelector(".whimsy-safety-check-status").textContent, "2 sites you haven't visited in 90 days still have access", "Counts both sites");
      is(permRow.querySelector(".whimsy-safety-check-detail").textContent, "Camera and microphone.", "Names the flagged permission types");

      const action = permRow.querySelector(".whimsy-safety-check-action");
      ok(!action.hidden, "Review shows");
      EventUtils.synthesizeMouseAtCenter(action, {}, win);

      const sheet = await TestUtils.waitForCondition(() => doc.getElementById("whimsy-safety-check-sheet"), "The sheet opens");
      await TestUtils.waitForCondition(() => sheet.state == "open", "and is actually shown");
      is(sheet.querySelector(".whimsy-surface-title")?.textContent, "Unused site permissions", "Its title");
      const sheetRows = () => [...sheet.querySelectorAll("[data-origin]")];
      is(sheetRows().length, 2, "One row per unused site");
      const rowText = sheetRows().map(r => r.textContent);
      ok(rowText.some(t => t.includes("Camera") && t.includes("March")), `A camera row for March (${rowText})`);
      ok(rowText.some(t => t.includes("Microphone") && t.includes("July")), `A microphone row for July (${rowText})`);

      // Remove the camera row; it goes, offering Undo.
      const cameraRow = sheetRows().find(r => r.dataset.origin == cameraOrigin);
      const removeButton = cameraRow.querySelector("button.whimsy-surface-text-button");
      ok(removeButton, "Remove is a quiet text button, not a footer button");
      EventUtils.synthesizeMouseAtCenter(removeButton, {}, win);
      await TestUtils.waitForCondition(() => sheetRows().length == 1, "The row is removed from the sheet");
      is(Services.perms.testPermissionFromPrincipal(cameraPrincipal, "camera"), Services.perms.UNKNOWN_ACTION, "and from the permission manager");
      const chromeWin = win.browsingContext.topChromeWindow;
      const toast = await TestUtils.waitForCondition(() => toastFor("whimsy-safety-check-removed-toast", chromeWin), "Offers Undo in a toast");
      ok(toast, "The toast is there");
      ok(WhimsyUndo.undo(chromeWin), "Undo restores it");
      is(Services.perms.testPermissionFromPrincipal(cameraPrincipal, "camera"), Services.perms.ALLOW_ACTION, "The permission is back");
      await TestUtils.waitForCondition(() => sheetRows().length == 2, "and the row is back in the sheet");
      closeToasts(chromeWin);

      // Remove all closes the sheet and takes both sites' access with it.
      const removeAll = [...sheet.querySelectorAll("button.whimsy-surface-button")].find(b => b.label == "Remove all");
      ok(removeAll, "Remove all is there");
      EventUtils.synthesizeMouseAtCenter(removeAll, {}, win);
      await TestUtils.waitForCondition(() => sheet.state != "open", "Remove all closes the sheet");
      is(Services.perms.testPermissionFromPrincipal(cameraPrincipal, "camera"), Services.perms.UNKNOWN_ACTION, "camera gone");
      is(Services.perms.testPermissionFromPrincipal(micPrincipal, "microphone"), Services.perms.UNKNOWN_ACTION, "microphone gone");
      await TestUtils.waitForCondition(() => row(doc, "permissions").classList.contains("is-ok"), "The card re-runs and lands ok");
    });
  } finally {
    Services.perms.removeFromPrincipal(cameraPrincipal, "camera");
    Services.perms.removeFromPrincipal(micPrincipal, "microphone");
  }
});
