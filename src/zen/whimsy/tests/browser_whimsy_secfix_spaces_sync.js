/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W30 S9 (security audit): a synced tab record is remote data. Only http(s)
// pages open from one (never file:, javascript:, about:, chrome:), and the
// tab it opens carries a null principal, never the browser's own
// (whimsy/overlay.py hotfixes on ZenSpacesSyncApplier).

const { ZenSpacesSyncApplier } = ChromeUtils.importESModule("resource:///modules/zen/ZenSpacesSyncApplier.sys.mjs");
const { ZenWindowSync } = ChromeUtils.importESModule("resource:///modules/zen/ZenWindowSync.sys.mjs");
const { RECORD_KINDS } = ChromeUtils.importESModule("resource:///modules/zen/ZenSpacesSyncModel.sys.mjs");

function tabRecord(id, url) {
  return {
    id,
    cleartext: {
      id,
      kind: RECORD_KINDS.TAB,
      data: { url, title: id, pinned: true, workspaceUuid: gZenWorkspaces.activeWorkspace?.uuid ?? null },
    },
  };
}

add_task(async function test_only_web_pages_open_from_synced_records() {
  await gZenWorkspaces.promiseInitialized;
  const synced = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ZenWindowSync), "firstSyncedWindow");
  Object.defineProperty(ZenWindowSync, "firstSyncedWindow", { configurable: true, get: () => window });
  const before = gBrowser.tabs.length;
  const unsafe = [
    ["whimsy-sync-file", "file:///etc/hosts"],
    ["whimsy-sync-js", "javascript:alert(1)"],
    ["whimsy-sync-about", "about:config"],
    ["whimsy-sync-chrome", "chrome://browser/content/browser.xhtml"],
    ["whimsy-sync-data", "data:text/html,hi"],
  ];
  const opened = [];
  try {
    const failed = await ZenSpacesSyncApplier.applyBatch(unsafe.map(([id, url]) => tabRecord(id, url)));
    is(gBrowser.tabs.length, before, "No tab opens for a file:, javascript:, about:, chrome:, or data: record");
    ok(!unsafe.some(([id]) => document.getElementById(id)), "and none of them is in the window");
    ok(!failed.length, "They're skipped, not retried");

    await ZenSpacesSyncApplier.applyBatch([tabRecord("whimsy-sync-web", "https://example.com/?synced")]);
    const tab = document.getElementById("whimsy-sync-web");
    ok(tab, "A web record opens its tab");
    opened.push(tab);
    ok(tab.pinned, "pinned as the record says");
    is(gBrowser.tabs.length, before + 1, "one tab");
  } finally {
    if (synced) {
      delete ZenWindowSync.firstSyncedWindow;
    }
    for (const tab of opened) {
      gBrowser.unpinTab(tab);
      BrowserTestUtils.removeTab(tab);
    }
  }
});

add_task(async function test_synced_tabs_never_carry_the_system_principal() {
  const source = await (await fetch("resource:///modules/zen/ZenSpacesSyncApplier.sys.mjs")).text();
  ok(!source.includes("addTrustedTab("), "The applier never opens a synced record as the browser itself");
  ok(source.includes("createNullPrincipal({ userContextId })"), "it opens with a null principal in the record's container");
  ok(source.includes("/^https?:\\/\\//i.test(data.url)"), "and takes only web addresses");
});
