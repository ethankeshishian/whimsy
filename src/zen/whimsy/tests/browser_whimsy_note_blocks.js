/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Live blocks in Notes (whimsy.feature.note-blocks), after Arc Easels' Live
// Captures: "/embed" or a dropped tab adds a sandboxed, cropped, live view of
// the page in the tab's container; private tabs can't be embedded.

let blockFromTab, blockFromURL, parseEmbedCommand, cropFromSelection, BLOCK_SANDBOX_FLAGS, PAGE_WIDTH;
const { gWhimsyNotesStore } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyNotesSection.sys.mjs"
);

const PAGE = "https://example.com/";

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["whimsy.feature.notes", true],
      ["whimsy.feature.note-blocks", true],
    ],
  });
  // The module lives in the window's loader (with the Library sections).
  await customElements.whenDefined("whimsy-note-block");
  ({ blockFromTab, blockFromURL, parseEmbedCommand, cropFromSelection, BLOCK_SANDBOX_FLAGS, PAGE_WIDTH } =
    customElements.get("whimsy-note-block").helpers);
});

// A visible host in the chrome window, so IntersectionObserver fires.
function makeHost({ hidden = false } = {}) {
  const host = document.createElement("div");
  host.style.cssText = "position: fixed; top: 40px; left: 40px; width: 320px; z-index: 2147483647;";
  host.hidden = hidden;
  document.documentElement.append(host);
  registerCleanupFunction(() => host.remove());
  return host;
}

function makeBlock(block, host) {
  const el = document.createElement("whimsy-note-block");
  el.block = block;
  host.append(el);
  return el;
}

add_task(async function test_parse_and_validate() {
  Assert.deepEqual(parseEmbedCommand("/embed"), { url: null }, "Bare /embed embeds the current tab");
  Assert.deepEqual(parseEmbedCommand("  /embed example.org "), { url: "example.org" }, "/embed takes a URL");
  is(parseEmbedCommand("/embedded"), null, "Only the exact command matches");
  is(parseEmbedCommand("see /embed later"), null, "Mid-sentence text is not a command");

  is(blockFromURL("example.org").block.url, "https://example.org/", "A bare host becomes https");
  is(blockFromURL("about:preferences").error, "whimsy-note-block-unsupported", "Only web pages");
  is(blockFromURL("file:///etc/hosts").error, "whimsy-note-block-unsupported", "No local files");
  is(blockFromURL(PAGE, { isPrivate: true }).error, "whimsy-note-block-private", "Private never embeds");

  is(cropFromSelection({ left: 0, top: 0, width: 4, height: 4 }, 0.5), null, "A tiny drag means the whole page");
  Assert.deepEqual(
    cropFromSelection({ left: 10, top: 20, width: 100, height: 50 }, 0.5),
    { x: 20, y: 40, w: 200, h: 100 },
    "Frame px map to page px"
  );
  is(
    cropFromSelection({ left: 300, top: 0, width: 300, height: 100 }, 0.5).w,
    PAGE_WIDTH - 600,
    "The crop is clamped to the page"
  );
});

add_task(async function test_block_from_container_and_private_tabs() {
  const tab = BrowserTestUtils.addTab(gBrowser, PAGE, { userContextId: 2 });
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser);
  registerCleanupFunction(() => BrowserTestUtils.removeTab(tab));
  const { block } = blockFromTab(tab);
  is(block.url, PAGE, "The block takes the tab's page");
  is(block.userContextId, 2, "The block keeps the tab's container");

  const privateWin = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  const privateTab = BrowserTestUtils.addTab(privateWin.gBrowser, PAGE);
  await BrowserTestUtils.browserLoaded(privateTab.linkedBrowser);
  is(blockFromTab(privateTab).error, "whimsy-note-block-private", "Private tabs can't be embedded");
  await BrowserTestUtils.closeWindow(privateWin);
});

add_task(async function test_live_block_loads_sandboxed_in_container() {
  const host = makeHost();
  const { block } = blockFromURL(PAGE, { userContextId: 2, title: "Example" });
  const el = makeBlock(block, host);
  const browser = await TestUtils.waitForCondition(() => el.browser, "A visible block loads its page");
  await TestUtils.waitForCondition(
    () => browser.currentURI?.spec == PAGE && !browser.webProgress?.isLoadingDocument,
    "The block's page has loaded"
  );
  is(browser.getAttribute("usercontextid"), "2", "Same container as the tab's space");
  is(browser.browsingContext.originAttributes.userContextId, 2, "Loaded in that container");
  is(browser.browsingContext.sandboxFlags & BLOCK_SANDBOX_FLAGS, BLOCK_SANDBOX_FLAGS, "The block is sandboxed");
  ok(browser.isRemoteBrowser, "The page runs out of process");
  is(el.querySelector(".whimsy-note-block-title").textContent, "Example", "Shows the page title");

  // Reload.
  const reloaded = BrowserTestUtils.browserLoaded(browser, false, PAGE);
  el.querySelector('[data-action="reload"]').click();
  await reloaded;
  ok(true, "The reload button reloads the page");

  // Crop: pick a region over the whole-page view.
  let changed = null;
  el.onBlockChange = b => (changed = b);
  el.querySelector('[data-action="crop"]').click();
  ok(el.picking && el.querySelector(".whimsy-note-block-picker"), "Crop shows the region picker");
  const scale = el.scale;
  el.applySelection({ left: 0, top: 0, width: 160, height: 80 });
  ok(!el.picking, "Picking ends after a selection");
  ok(changed?.crop, "The crop is saved");
  is(changed.crop.w, Math.round(160 / scale), "Crop width in page px");
  const frame = el.querySelector(".whimsy-note-block-frame");
  await TestUtils.waitForCondition(
    () => Math.abs(parseFloat(frame.style.height) - (frame.clientWidth / changed.crop.w) * changed.crop.h) <= 1,
    "The frame keeps the crop's aspect ratio"
  );

  // Escape cancels picking without changing the crop.
  el.querySelector('[data-action="crop"]').click();
  const picker = el.querySelector(".whimsy-note-block-picker");
  picker.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  ok(!el.picking, "Escape leaves picking");
  is(el.block.crop.w, changed.crop.w, "Escape keeps the crop");

  // Open page in a tab in the same container.
  const opened = BrowserTestUtils.waitForNewTab(gBrowser, PAGE, true);
  el.querySelector('[data-action="open"]').click();
  const newTab = await opened;
  is(newTab.userContextId, 2, "Open page keeps the container");
  BrowserTestUtils.removeTab(newTab);

  // Remove.
  let removed = null;
  el.onBlockRemove = b => (removed = b);
  el.querySelector('[data-action="remove"]').click();
  is(removed?.id, block.id, "Remove asks the note to drop the block");

  el.remove();
  ok(!browser.isConnected && !el.browser, "A closed block frees its page");
});

add_task(async function test_blocks_load_lazily() {
  const host = makeHost({ hidden: true });
  const el = makeBlock(blockFromURL(PAGE).block, host);
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  await TestUtils.waitForTick();
  ok(!el.browser, "An off-screen block doesn't load");
  host.hidden = false;
  await TestUtils.waitForCondition(() => el.browser, "It loads once visible");
  el.remove();
});

add_task(async function test_notes_section_embed_and_switch() {
  const library = document.querySelector("zen-library");
  if (!library) {
    ok(true, "No <zen-library> in this window; nothing to check");
    return;
  }
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  registerCleanupFunction(() => BrowserTestUtils.removeTab(tab));
  const note = await gWhimsyNotesStore.create();
  registerCleanupFunction(() => gWhimsyNotesStore.remove(note.id));

  const wasOpen = library.constructor.isLibraryOpen;
  await TestUtils.waitForCondition(() => library.zenLibrarySections["whimsy-notes"]);
  library.activeTab = "whimsy-notes";
  await library.constructor.animateProgress(1);
  registerCleanupFunction(() => library.constructor.animateProgress(wasOpen ? 1 : 0));
  const section = await TestUtils.waitForCondition(() =>
    library.querySelector("whimsy-library-notes-section")
  );
  await section.updateComplete;
  section.editingId = note.id;
  await section.updateComplete;

  // "/embed" + Enter in the note text.
  const textarea = await TestUtils.waitForCondition(() => section.querySelector("textarea"));
  textarea.value = "groceries\n/embed";
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  textarea.dispatchEvent(enter);
  ok(enter.defaultPrevented, "Enter on /embed is the command, not a newline");
  let stored = await TestUtils.waitForCondition(async () => {
    const n = (await gWhimsyNotesStore.list()).find(x => x.id == note.id);
    return n?.blocks?.length == 1 && n;
  }, "The block is saved with the note");
  is(stored.text, "groceries", "The command line is removed from the text");
  is(stored.blocks[0].url, PAGE, "It embeds the current tab");
  await TestUtils.waitForCondition(
    () => section.querySelector("whimsy-note-block"),
    "The note shows the live block"
  );

  // A plain Enter is still a newline.
  textarea.value = "plain";
  const plain = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  textarea.dispatchEvent(plain);
  ok(!plain.defaultPrevented, "Other lines keep Enter");

  // Switch off: blocks are hidden and /embed is plain text.
  Services.prefs.setBoolPref("whimsy.feature.note-blocks", false);
  registerCleanupFunction(() => Services.prefs.clearUserPref("whimsy.feature.note-blocks"));
  section.requestUpdate();
  await section.updateComplete;
  ok(!section.querySelector("whimsy-note-block"), "Switch off hides live blocks");
  textarea.value = "/embed";
  const off = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  textarea.dispatchEvent(off);
  ok(!off.defaultPrevented, "Switch off: /embed is just text");
  Services.prefs.clearUserPref("whimsy.feature.note-blocks");
});
