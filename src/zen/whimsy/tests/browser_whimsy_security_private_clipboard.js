/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave9/secfix (security-full-2 L3): Firefox marks what's copied in private
// browsing as private data (clipboard managers skip it; on macOS it's
// ConcealedType). Whimsy's own copy commands (Copy URL, Copy as Markdown,
// verbs, person cards) used the chrome window's context, which is never
// private for a private tab, so they now mark it themselves.

const { MockRegistrar } = ChromeUtils.importESModule("resource://testing-common/MockRegistrar.sys.mjs");
const { WhimsyPrivate } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPrivate.sys.mjs");
const { WhimsyCopy } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCopy.sys.mjs");
const { WhimsyVerbs } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyVerbs.sys.mjs");

const PRIVATE_URL = "https://example.com/?secfix-clip-private";
const NORMAL_URL = "https://example.org/?secfix-clip-normal";

// Records what reaches the system clipboard, and whether it was private.
const written = [];
const mockClipboard = {
  QueryInterface: ChromeUtils.generateQI(["nsIClipboard"]),
  setData(transferable) {
    const data = {};
    transferable.getTransferData("text/plain", data);
    written.push({
      text: data.value?.QueryInterface(Ci.nsISupportsString).data,
      isPrivate: transferable.isPrivateData,
    });
  },
  isClipboardTypeSupported: () => true,
};

add_setup(function () {
  const cid = MockRegistrar.register("@mozilla.org/widget/clipboard;1", mockClipboard);
  registerCleanupFunction(() => MockRegistrar.unregister(cid));
});

async function withTabs(fn) {
  const normal = await BrowserTestUtils.openNewForegroundTab(gBrowser, NORMAL_URL);
  const priv = WhimsyPrivate.openPrivateTab(window, { url: PRIVATE_URL, force: true });
  await BrowserTestUtils.browserLoaded(priv.linkedBrowser, false, PRIVATE_URL);
  try {
    await fn({ normal, priv });
  } finally {
    BrowserTestUtils.removeTab(priv);
    BrowserTestUtils.removeTab(normal);
  }
}

add_task(async function copy_url_of_a_private_tab_is_private() {
  await withTabs(async ({ normal, priv }) => {
    written.length = 0;
    WhimsyCopy.copy(window, WhimsyCopy.linksFor([priv]), { markdown: false });
    ok(written.at(-1)?.text?.includes("secfix-clip-private"), "The private tab's URL was copied");
    ok(written.at(-1)?.isPrivate, "…marked private");

    gBrowser.selectedTab = normal;
    WhimsyCopy.copy(window, WhimsyCopy.linksFor([normal]), { markdown: false });
    ok(written.at(-1)?.text?.includes("secfix-clip-normal"), "A normal tab's URL was copied");
    ok(!written.at(-1)?.isPrivate, "…not marked private");
  });
});

add_task(async function a_verb_copy_from_a_private_tab_is_private() {
  await withTabs(async ({ normal, priv }) => {
    written.length = 0;
    gBrowser.selectedTab = priv;
    WhimsyVerbs.copy("private words", window);
    is(written.at(-1)?.text, "private words", "The verb copied its text");
    ok(written.at(-1)?.isPrivate, "…marked private in a private tab");

    gBrowser.selectedTab = normal;
    WhimsyVerbs.copy("normal words", window);
    ok(!written.at(-1)?.isPrivate, "…and not in a normal tab");
  });
});
