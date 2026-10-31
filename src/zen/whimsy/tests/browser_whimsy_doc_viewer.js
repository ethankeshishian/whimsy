/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Markdown/CSV viewer (whimsy.feature.doc-viewer). Covers a raw .md served
// as text/plain (reader page, contents, unique heading ids, code, tables),
// safety (no script, no HTML from the file, no javascript: links, CSP), the
// Source toggle, CSV parsing and column sorting (mouse and keyboard), a
// local file re-rendering on save with the toggle kept, TSV, what it never
// claims (frames, other files) and the switch.

const DIR = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com");
const MD = DIR + "whimsy_viewer.md";
const CSV = DIR + "whimsy_viewer.csv";

async function writeTemp(name, text) {
  const path = PathUtils.join(PathUtils.tempDir, name);
  await IOUtils.writeUTF8(path, text);
  registerCleanupFunction(() => IOUtils.remove(path, { ignoreAbsent: true }));
  return { path, url: PathUtils.toFileURI(path) };
}

add_task(async function test_markdown_over_http() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, MD);
  const info = await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    const doc = content.document;
    return {
      type: doc.contentType,
      title: doc.title,
      h1: doc.querySelector("article h1")?.id,
      ids: [...doc.querySelectorAll("article h2")].map(h => h.id),
      toc: [...doc.querySelectorAll(".toc a")].map(a => a.getAttribute("href")),
      code: doc.querySelector("article pre code")?.className,
      table: !!doc.querySelector("article table"),
      bold: doc.querySelector("article strong")?.textContent,
      link: doc.querySelector("article a[href='https://example.org/']")?.textContent,
      scripts: doc.querySelectorAll("script").length,
      handlers: doc.querySelectorAll("[onerror]").length,
      jsLinks: doc.querySelectorAll("a[href^='javascript']").length,
      shownAsText: doc.querySelector("article").textContent.includes("<script>"),
      pwned: !!content.wrappedJSObject.pwned,
      csp: doc.querySelector("meta[http-equiv='Content-Security-Policy']")?.content,
      meta: doc.querySelector(".bar .meta")?.textContent,
    };
  });
  // Rendered as a page, but like Firefox's JSON viewer the document keeps
  // the file's own type, so Save Page As saves the file, not the rendering.
  is(info.type, "text/plain", "the document keeps the file's type");
  is(info.title, "Balloon Notes", "titled by the first heading");
  is(info.h1, "h-balloon-notes", "headings get ids");
  Assert.deepEqual(info.ids, ["h-getting-started", "h-getting-started-1"], "repeated headings get unique ids");
  ok(info.toc.length >= 3 && info.toc.includes("#h-getting-started-1"), "a table of contents links each heading");
  is(info.code, "language-js", "code blocks keep their language");
  ok(info.table, "Markdown tables render");
  is(info.bold, "bold", "inline formatting");
  is(info.link, "link", "links");
  is(info.scripts, 0, "no script element");
  is(info.handlers, 0, "no event handler attributes");
  is(info.jsLinks, 0, "no javascript: links");
  ok(info.shownAsText, "HTML in the file is shown as text");
  ok(!info.pwned, "nothing from the file ran");
  ok(info.csp?.includes("default-src 'none'"), "a strict CSP");
  ok(/Markdown · \d+ words/.test(info.meta), "the bar says what the file is");

  // Source toggle (CSS only: works with the page's script disabled).
  await BrowserTestUtils.synthesizeMouseAtCenter(".bar .switch", {}, tab.linkedBrowser);
  const shown = await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    const doc = content.document;
    const visible = sel => content.getComputedStyle(doc.querySelector(sel)).display != "none";
    return { raw: visible(".raw"), layout: visible(".layout"), source: doc.querySelector(".raw").textContent };
  });
  ok(shown.raw && !shown.layout, "Source shows the file instead of the preview");
  ok(shown.source.startsWith("# Balloon Notes"), "the file as it is");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_csv_table_sorts() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, CSV);
  const browser = tab.linkedBrowser;
  const column = col =>
    SpecialPowers.spawn(browser, [col], c =>
      [...content.document.querySelectorAll("tbody tr")].map(r => r.cells[c].textContent)
    );
  const header = await SpecialPowers.spawn(browser, [], () =>
    [...content.document.querySelectorAll("thead th")].map(th => th.textContent)
  );
  Assert.deepEqual(header, ["Name", "Size", "Note"], "the first row is the header");
  Assert.deepEqual(await column(2), ["red, round", 'says "hi"', "", "fruit"], "quoted fields, commas and quotes");

  await BrowserTestUtils.synthesizeMouseAtCenter("th[data-col='1']", {}, browser);
  Assert.deepEqual(await column(1), ["2", "2.5", "10", "100"], "numbers sort as numbers");
  await BrowserTestUtils.synthesizeMouseAtCenter("th[data-col='1']", {}, browser);
  Assert.deepEqual(await column(1), ["100", "10", "2.5", "2"], "a second click sorts descending");
  await BrowserTestUtils.synthesizeMouseAtCenter("th[data-col='1']", {}, browser);
  Assert.deepEqual(await column(0), ["Balloon", "Kite", "Zeppelin", "Apple"], "a third click restores the file's order");

  await SpecialPowers.spawn(browser, [], () => content.document.querySelector("th[data-col='0']").focus());
  EventUtils.synthesizeKey("KEY_Enter", {}, window);
  await TestUtils.waitForCondition(async () => (await column(0))[0] == "Apple", "Enter sorts too");
  const sortState = await SpecialPowers.spawn(browser, [], () =>
    content.document.querySelector("th[data-col='0']").getAttribute("aria-sort")
  );
  is(sortState, "ascending", "the header says how it's sorted");

  await BrowserTestUtils.synthesizeMouseAtCenter("th[data-col='2']", {}, browser);
  is((await column(2)).at(-1), "", "empty cells sort last");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_local_file_live_reload() {
  const { path, url } = await writeTemp("whimsy-viewer-live.md", "# One\n\nFirst version.\n");
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, url);
  const browser = tab.linkedBrowser;
  const heading = () => SpecialPowers.spawn(browser, [], () => content.document.querySelector("article h1")?.textContent);
  is(await heading(), "One", "a local file renders");
  await SpecialPowers.spawn(browser, [], () => {
    content.document.getElementById("whimsy-doc-raw").checked = true;
  });

  await IOUtils.writeUTF8(path, "# Two\n\nSaved again.\n");
  await IOUtils.setModificationTime(path, Date.now() + 5000);
  await TestUtils.waitForCondition(async () => (await heading()) == "Two", "re-rendered after a save", 200, 50);
  const state = await SpecialPowers.spawn(browser, [], () => ({
    raw: content.document.getElementById("whimsy-doc-raw").checked,
    source: content.document.querySelector(".raw").textContent,
    title: content.document.title,
  }));
  ok(state.raw, "Source stays open across a reload");
  ok(state.source.includes("Saved again."), "the source updated too");
  is(state.title, "Two", "the title follows");
  BrowserTestUtils.removeTab(tab);

  const tsv = await writeTemp("whimsy-viewer.tsv", "a\tb\n1\tx, y\n");
  const tsvTab = await BrowserTestUtils.openNewForegroundTab(gBrowser, tsv.url);
  const cells = await SpecialPowers.spawn(tsvTab.linkedBrowser, [], () =>
    [...content.document.querySelectorAll("td")].map(td => td.textContent)
  );
  Assert.deepEqual(cells, ["1", "x, y"], "TSV splits on tabs");
  BrowserTestUtils.removeTab(tsvTab);
});

add_task(async function test_never_claimed() {
  // A frame keeps the file as text.
  const tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "https://example.com/document-builder.sjs?html=" + encodeURIComponent(`<iframe src="${MD}"></iframe>`)
  );
  await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
    const frame = content.document.querySelector("iframe");
    await ContentTaskUtils.waitForCondition(() => frame.contentDocument?.readyState == "complete");
  });
  const framed = await SpecialPowers.spawn(tab.linkedBrowser.browsingContext.children[0], [], () => ({
    type: content.document.contentType,
    viewer: !!content.document.querySelector(".bar"),
  }));
  is(framed.type, "text/plain", "frames show the file as text");
  ok(!framed.viewer, "frames are left alone");
  BrowserTestUtils.removeTab(tab);

  const other = await writeTemp("whimsy-viewer.txt", "# Not markdown\n");
  const txt = await BrowserTestUtils.openNewForegroundTab(gBrowser, other.url);
  const type = await SpecialPowers.spawn(txt.linkedBrowser, [], () => content.document.contentType);
  is(type, "text/plain", "other text files are left alone");
  BrowserTestUtils.removeTab(txt);
});

add_task(async function test_feature_switch_off() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.doc-viewer", false]] });
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, MD);
  const info = await SpecialPowers.spawn(tab.linkedBrowser, [], () => ({
    type: content.document.contentType,
    bar: !!content.document.querySelector(".bar"),
  }));
  is(info.type, "text/plain", "with the switch off the file shows as plain text");
  ok(!info.bar, "no viewer");
  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
});
