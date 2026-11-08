/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W23: what AI may see. Private is a wall per tab, hidden spaces need their
// exact name, locked spaces are refused on every call, split view gives one
// chip per pane, and "the PDF I downloaded" is the newest normal PDF.

const { WhimsyAIContext } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIContext.sys.mjs");
const { WhimsyPrivate } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPrivate.sys.mjs");
const { WhimsyHiddenSpaces } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyHiddenSpaces.sys.mjs");
const { WhimsySpaceLock } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySpaceLock.sys.mjs");

const ROOT = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com");
const PAGE = ROOT + "whimsy_ai_sensitive.html";
const OTHER = "https://example.org/browser/zen/whimsy/tests/whimsy_ai_payment_host.html";

const initialTabs = new Set(gBrowser.tabs);
registerCleanupFunction(async () => {
  if (gZenViewSplitter.currentView >= 0) {
    gZenViewSplitter.unsplitCurrentView();
  }
  for (const tab of gBrowser.tabs.filter(t => !initialTabs.has(t))) {
    await BrowserTestUtils.removeTab(tab);
  }
});

// Swaps `obj[name]` for the test's length.
function stub(obj, name, value) {
  const real = obj[name];
  obj[name] = value;
  return () => {
    obj[name] = real;
  };
}

async function openPrivate(url) {
  const tab = WhimsyPrivate.openPrivateTab(window, { url, force: true });
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, url);
  return tab;
}

add_task(async function private_tab_has_no_context() {
  const tab = await openPrivate(PAGE);
  ok(WhimsyAIContext.isPrivate(tab), "A private tab in a normal window is private");
  ok(!PrivateBrowsingUtils.isWindowPrivate(window), "The window itself is normal");
  is(WhimsyAIContext.isOffLimits(tab), "private", "It's off limits");
  const context = await WhimsyAIContext.forTab(tab);
  is(context.chips.length, 0, "No chips");
  is(context.parts.length, 0, "No parts");
  is(context.leftOut.private, 1, "Counted as left out");
  const data = await WhimsyAIContext.extract(tab.linkedBrowser);
  is(data.text, "", "Extraction gives nothing for a private tab");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function context_all_tabs_skips_private_tab_in_normal_window() {
  const normal = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, OTHER);
  const secret = await openPrivate(PAGE + "?private");
  gBrowser.selectedTab = normal;
  const base = await WhimsyAIContext.forTab(normal);
  is(base.chips.length, 1, "The tab itself is one chip");
  const context = await WhimsyAIContext.widen(base, "Summarize all my tabs", window);
  is(context.leftOut.private, 1, "The private tab is left out and counted");
  const pages = context.parts.filter(p => p.kind == "page");
  ok(pages.some(p => p.url == OTHER), "Another normal tab is in");
  ok(!pages.some(p => p.url.includes("?private")), "The private tab isn't");
  ok(context.chips.some(c => c.kind == "tabs" && c.counts.pages == pages.length), "One All tabs chip, with its count");
  is(context.widened.find(w => w.kind == "tabs")?.leftOut.private, 1, "The Used line can say what was left out");
  const plain = await WhimsyAIContext.widen(base, "Summarize this", window);
  is(plain, base, "A prompt that doesn't ask for more doesn't widen");
  for (const tab of [normal, other, secret]) {
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function hidden_space_needs_exact_name() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const uuid = WhimsyAIContext.spaceOf(tab);
  ok(uuid, "The tab is in a space");
  const restore = [
    stub(WhimsyHiddenSpaces, "hidden", () => [{ uuid, name: "Work stuff" }]),
    stub(WhimsyAIContext, "spaces", () => [{ uuid, name: "Work stuff" }]),
  ];
  try {
    for (const text of ["summarize my work tabs", "homework stuffing", "work", "Work stuffs"]) {
      Assert.deepEqual(WhimsyAIContext.spacesNamedIn(text, window), [], `"${text}" doesn't name it`);
      is(WhimsyAIContext.isOffLimits(tab, { namedSpaceIds: WhimsyAIContext.spacesNamedIn(text, window) }), "hidden",
        `"${text}": still hidden`);
    }
    for (const text of ["what's in work stuff?", "Summarize WORK STUFF", "tabs in Work  stuff"]) {
      Assert.deepEqual(WhimsyAIContext.spacesNamedIn(text, window), [uuid], `"${text}" names it`);
      is(WhimsyAIContext.isOffLimits(tab, { namedSpaceIds: [uuid] }), false, `"${text}": allowed`);
    }
    is((await WhimsyAIContext.forTab(tab)).leftOut.hidden, 1, "Unnamed, a hidden space's tab is left out");
    is((await WhimsyAIContext.forTab(tab, { namedSpaceIds: [uuid] })).chips.length, 1, "Named, it's in");
  } finally {
    restore.forEach(r => r());
  }
  BrowserTestUtils.removeTab(tab);
});

add_task(async function locked_space_is_off_limits_even_when_named() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const uuid = WhimsyAIContext.spaceOf(tab);
  let covered = true;
  const restore = stub(WhimsySpaceLock, "coveringSpace", t => (covered && t == tab ? uuid : null));
  try {
    is(WhimsyAIContext.isOffLimits(tab, { namedSpaceIds: [uuid] }), "locked", "Named, a locked space is still off limits");
    const context = await WhimsyAIContext.forTab(tab, { namedSpaceIds: [uuid] });
    is(context.chips.length, 0, "No chips from a locked space");
    is(context.leftOut.locked, 1, "Counted as locked");
    covered = false;
    is(WhimsyAIContext.isOffLimits(tab), false, "Unlocked, it's allowed");
    covered = true;
    is(WhimsyAIContext.isOffLimits(tab), "locked", "Locked again, the next call is refused (nothing cached)");
  } finally {
    restore();
  }
  BrowserTestUtils.removeTab(tab);
});

add_task(async function split_view_gives_one_chip_per_pane() {
  const a = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const b = await BrowserTestUtils.openNewForegroundTab(gBrowser, OTHER);
  gZenViewSplitter.splitTabs([a, b], "vsep");
  await TestUtils.waitForCondition(() => gZenViewSplitter._data.find(g => g.tabs.includes(a))?.tabs.length == 2, "Split");
  const context = await WhimsyAIContext.forSplit(a);
  is(context.chips.length, 2, "One chip per pane");
  ok(context.chips.every(c => c.kind == "pane"), "Both are panes");
  Assert.deepEqual(context.chips.map(c => c.url), [PAGE, OTHER], "In pane order");
  ok(context.parts.some(p => p.chipId == context.chips[1].id && p.text.includes("Store page text")), "Each pane's text is tied to its chip");
  gZenViewSplitter.unsplitCurrentView();
  BrowserTestUtils.removeTab(a);
  BrowserTestUtils.removeTab(b);
});

add_task(async function newest_pdf_in_downloads() {
  const dir = await IOUtils.createUniqueDirectory(PathUtils.tempDir, "whimsy-ai-pdf");
  const file = async name => {
    const path = PathUtils.join(dir, name);
    await IOUtils.writeUTF8(path, "%PDF-1.4");
    return path;
  };
  const older = await file("older.pdf");
  const privatePdf = await file("private.pdf");
  const notPdf = await file("notes.txt");
  const download = (path, endTime, extra = {}) => ({
    succeeded: true, endTime, target: { path, exists: true, size: 8 }, source: { url: "https://example.com/x", isPrivate: false }, ...extra,
  });
  const restore = stub(WhimsyAIContext, "downloadList", async () => [
    download(older, 1000),
    download(privatePdf, 4000, { source: { url: "https://example.com/p", isPrivate: true } }),
    download(notPdf, 5000),
    download(PathUtils.join(dir, "gone.pdf"), 6000),
    download(PathUtils.join(dir, "failed.pdf"), 7000, { succeeded: false }),
  ]);
  try {
    is((await WhimsyAIContext.newestPdf())?.target.path, older, "The newest normal PDF that still exists");
    const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
    const context = await WhimsyAIContext.widen(await WhimsyAIContext.forTab(tab), "What does the PDF I downloaded say?", window);
    const chip = context.chips.find(c => c.kind == "pdf");
    is(chip?.label, "older.pdf", "A PDF chip for it");
    is(context.parts.find(p => p.chipId == chip.id)?.path, older, "Its part points at the file");
    BrowserTestUtils.removeTab(tab);
  } finally {
    restore();
    await IOUtils.remove(dir, { recursive: true });
  }
});

add_task(async function destination_names_where_it_goes() {
  Assert.deepEqual(WhimsyAIContext.describeDestination("apple", "on-device"),
    { provider: "apple", model: "on-device", method: "local", leavesMac: false }, "Apple stays on this Mac");
  is(WhimsyAIContext.describeDestination("ollama", "llama3").leavesMac, false, "Ollama on localhost stays");
  is(WhimsyAIContext.describeDestination("gemini", "gemini-2.5-flash").method, "key", "Gemini is a key");
  ok(WhimsyAIContext.describeDestination("claude", "sonnet").leavesMac, "Claude leaves this Mac");
});
