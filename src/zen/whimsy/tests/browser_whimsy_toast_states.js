/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave10 design pass A: the Whimsy toast's additions for the dead-page
// offer (W10-15), the form refill (W10-25) and Fire (W10-30): an icon, a
// Fluent second line, a toast owned by one tab, in-place updates with a
// busy action, an action that keeps the toast, and "until dismissed".

const { WhimsyToast } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyToast.sys.mjs");

function cleanup() {
  const toast = WhimsyToast.current(window);
  if (toast) {
    WhimsyToast._dismissNow(toast);
  }
}

add_task(async function icon_and_fluent_detail() {
  const toast = WhimsyToast.show(window, {
    l10nId: "whimsy-archive-toast",
    detailL10nId: "whimsy-archive-toast-detail",
    icon: "chrome://browser/skin/zen-icons/selectable/time.svg",
  });
  try {
    await document.l10n.translateFragment(toast);
    const icon = toast.querySelector("img.whimsy-toast-icon");
    ok(icon, "The icon is drawn");
    is(icon.compareDocumentPosition(toast.querySelector(".whimsy-toast-text")) & Node.DOCUMENT_POSITION_FOLLOWING,
      Node.DOCUMENT_POSITION_FOLLOWING, "It comes before the text");
    const detail = toast.querySelector(".whimsy-toast-detail");
    is(detail.getAttribute("data-l10n-id"), "whimsy-archive-toast-detail", "The second line is Fluent");
    ok(detail.textContent.length > 0, "and translated");
  } finally {
    cleanup();
  }
});

add_task(async function update_in_place_and_busy() {
  let clicks = 0;
  const toast = WhimsyToast.show(window, {
    l10nId: "whimsy-archive-toast",
    timeout: 10000,
    action: { l10nId: "whimsy-archive-look", onCommand: () => { clicks++; return "keep"; } },
  });
  try {
    toast.querySelector(".whimsy-toast-action").click();
    is(clicks, 1, "The action ran");
    ok(toast.isConnected && !toast.hasAttribute("leaving"), "\"keep\" keeps the toast");

    toast.update({ detailL10nId: "whimsy-archive-looking", busy: true, action: { l10nId: "whimsy-archive-looking-button" } });
    is(WhimsyToast.current(window), toast, "Updated in place, not replaced");
    ok(toast.hasAttribute("busy"), "Busy");
    const button = toast.querySelector(".whimsy-toast-action");
    ok(button.disabled, "The action is disabled while busy");
    ok(toast.querySelector(".whimsy-toast-spinner").checkVisibility(), "A spinner shows in the action");
    button.click();
    is(clicks, 1, "A busy action doesn't run");

    toast.update({ busy: false, action: null, timeout: 50 });
    ok(!toast.querySelector(".whimsy-toast-action"), "The action can be removed");
    await TestUtils.waitForCondition(() => !toast.isConnected, "The new timeout applies");
  } finally {
    cleanup();
  }
});

add_task(async function timeout_zero_stays() {
  const toast = WhimsyToast.show(window, { l10nId: "whimsy-archive-toast", timeout: 0 });
  try {
    // eslint-disable-next-line mozilla/no-arbitrary-setTimeout
    await new Promise(resolve => setTimeout(resolve, 300));
    ok(toast.isConnected, "Stays until dismissed");
  } finally {
    cleanup();
  }
});

add_task(async function owned_by_a_tab() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?owned");
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.org/");
  try {
    await BrowserTestUtils.switchTab(gBrowser, tab);
    let toast = WhimsyToast.show(window, { l10nId: "whimsy-archive-toast", browser: tab.linkedBrowser, timeout: 0 });
    await BrowserTestUtils.switchTab(gBrowser, other);
    ok(!toast.isConnected, "Switching away dismisses it at once");

    await BrowserTestUtils.switchTab(gBrowser, tab);
    toast = WhimsyToast.show(window, { l10nId: "whimsy-archive-toast", browser: tab.linkedBrowser, timeout: 0 });
    // A same-document change (a hash) keeps it.
    await SpecialPowers.spawn(tab.linkedBrowser, [], () => { content.location.hash = "x"; });
    ok(toast.isConnected, "A hash change keeps it");
    const loaded = BrowserTestUtils.browserLoaded(tab.linkedBrowser);
    BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, "https://example.com/?next");
    await loaded;
    ok(!toast.isConnected, "Navigating the tab dismisses it");
  } finally {
    cleanup();
    BrowserTestUtils.removeTab(other);
    BrowserTestUtils.removeTab(tab);
  }
});
