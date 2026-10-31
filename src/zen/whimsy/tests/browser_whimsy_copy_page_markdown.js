/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Copy page as Markdown (whimsy.feature.copy-page-markdown). Covers the
// article flow from the page menu (title, source, headings, links, lists,
// code, no nav/ads/scripts/footer), a selection copying only itself, the
// command bar, a page Readability can't read (hidden and sponsored blocks
// stripped, tables kept), the converter's edge cases, an empty page, Zen's
// own Markdown link copy left alone, and the switch.

const DIR = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com");
const ARTICLE = DIR + "whimsy_markdown_article.html";
const PLAIN = DIR + "whimsy_markdown_plain.html";
const { WhimsyMarkdownCopy } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyMarkdownCopy.sys.mjs");
const { htmlToMarkdown } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPageMarkdown.sys.mjs");

const toasts = [];
const realToast = gZenUIManager.showToast;
add_setup(() => {
  gZenUIManager.showToast = id => toasts.push(id);
  registerCleanupFunction(() => {
    gZenUIManager.showToast = realToast;
  });
});

function clipboardText() {
  return SpecialPowers.getClipboardData("text/plain");
}

async function openMenu(browser, selector) {
  const menu = document.getElementById("contentAreaContextMenu");
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  await BrowserTestUtils.synthesizeMouseAtCenter(selector, { type: "contextmenu", button: 2 }, browser);
  await shown;
  return menu;
}

async function closeMenu(menu) {
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.hidePopup();
  await hidden;
}

add_task(async function test_page_menu_copies_article() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, ARTICLE);
  const menu = await openMenu(tab.linkedBrowser, "h2");
  const item = document.getElementById("context-whimsy-copy-markdown");
  ok(!item.hidden, "shown on the page");
  is(item.getAttribute("data-l10n-id"), "whimsy-context-copy-page-markdown", "labelled for the page");
  ok(item.parentNode.querySelector("#context-savepage ~ #context-whimsy-copy-markdown"), "after Save Page As");
  isnot(
    item.getAttribute("data-l10n-id"),
    "zen-text-action-copy-url-markdown-shortcut",
    "not Zen's Copy current URL as Markdown"
  );
  toasts.length = 0;
  menu.activateItem(item);
  await TestUtils.waitForCondition(() => toasts.length, "a toast confirms");
  is(toasts[0], "whimsy-copy-page-markdown-toast", "the page toast");

  const md = clipboardText();
  ok(md.startsWith("# How Balloons Float\n\nSource: <" + ARTICLE + ">"), "title then the source link");
  is(md.match(/# How Balloons Float/g).length, 1, "the title isn't repeated");
  ok(md.includes("\n## The physics\n"), "headings keep their level");
  ok(md.includes("[the buoyancy page](https://example.com/wiki/Buoyancy)"), "relative links become absolute");
  ok(md.includes("[Archimedes](https://example.org/archimedes)"), "links keep their text");
  ok(md.includes("**inert**") && md.includes("_safe_"), "emphasis");
  ok(md.includes("`lift = volume * density`"), "inline code is kept verbatim");
  ok(md.includes("- A balloon\n- Helium\n  - From a tank"), "nested lists");
  ok(md.includes("1. Inflate the balloon") && md.includes("2. Tie the end."), "ordered lists");
  ok(md.includes("```js\nconst lift = volume * density;\nconsole.log(lift);\n```"), "fenced code with its language");
  ok(md.includes("> A balloon is a tiny sky"), "quotes");
  for (const junk of ["About the nav", "Buy now", "never copied", "Footer text"]) {
    ok(!md.includes(junk), `no page chrome: ${junk}`);
  }
  await TestUtils.waitForCondition(() => !menu.state || menu.state == "closed");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_selection_copies_only_selection() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, ARTICLE);
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    const p = content.document.getElementById("sel");
    const range = content.document.createRange();
    range.selectNodeContents(p);
    content.getSelection().removeAllRanges();
    content.getSelection().addRange(range);
  });
  const menu = await openMenu(tab.linkedBrowser, "#sel strong");
  const item = document.getElementById("context-whimsy-copy-markdown");
  ok(!item.hidden, "shown for a selection");
  is(item.getAttribute("data-l10n-id"), "whimsy-context-copy-selection-markdown", "labelled for the selection");
  is(item.previousElementSibling?.id, "context-copy", "beside Copy");
  toasts.length = 0;
  menu.activateItem(item);
  await TestUtils.waitForCondition(() => toasts.length);
  is(toasts[0], "whimsy-copy-selection-markdown-toast", "the selection toast");
  const md = clipboardText();
  ok(md.startsWith("Helium is **inert**"), "only the selection");
  ok(!md.includes("# How Balloons Float") && !md.includes("Source:"), "no title or source for a selection");

  // The command bar copies the selection too.
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    const range = content.document.createRange();
    range.selectNodeContents(content.document.querySelector("pre"));
    content.getSelection().removeAllRanges();
    content.getSelection().addRange(range);
  });
  const result = await WhimsyMarkdownCopy.copy(window);
  is(result.kind, "selection", "the command copies the selection");
  ok(result.markdown.startsWith("```js\nconst lift"), "a selection inside code stays a code block");

  // With no selection, the command copies the page.
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => content.getSelection().removeAllRanges());
  const page = await WhimsyMarkdownCopy.copy(window);
  is(page.kind, "page", "no selection: the page");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_command_bar_action() {
  const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");
  const action = globalActions.find(a => a.l10nId == "whimsy-action-copy-page-markdown");
  ok(action, "the command bar action is registered");
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PLAIN);
  ok(action.isAvailable(window), "available on a web page");
  toasts.length = 0;
  document.getElementById("cmd_whimsyCopyPageMarkdown").doCommand();
  await TestUtils.waitForCondition(() => toasts.length);
  const md = clipboardText();
  ok(md.startsWith("# Short page\n\nSource: <" + PLAIN + ">"), "title and source");
  ok(md.includes("A short note with a [link](https://example.org/x)."), "the text and its link");
  ok(md.includes("| Name | Size |\n| --- | --- |\n| Ann | 3 |"), "tables become Markdown tables");
  for (const junk of ["Navigation link", "Sponsored words", "Hidden words", "Invisible words"]) {
    ok(!md.includes(junk), `stripped: ${junk}`);
  }
  BrowserTestUtils.removeTab(tab);

  const blank = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:robots");
  ok(!action.isAvailable(window), "not on the browser's own pages");
  BrowserTestUtils.removeTab(blank);
});

add_task(async function test_empty_page() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/document-builder.sjs?html=<body></body>");
  toasts.length = 0;
  const result = await WhimsyMarkdownCopy.copy(window);
  is(result, null, "nothing to copy");
  is(toasts[0], "whimsy-copy-markdown-empty-toast", "says so");
  BrowserTestUtils.removeTab(tab);
});

add_task(function test_converter_edge_cases() {
  const parse = html => new DOMParser().parseFromString(html, "text/html").body;
  const md = (html, base = "https://example.com/a/") => htmlToMarkdown(parse(html), { baseURL: base });
  is(md("<p>snake_case and *stars* and [brackets]</p>"), "snake_case and \\*stars\\* and \\[brackets\\]", "escapes Markdown, not words");
  is(md("<p><code>a `tick`</code></p>"), "`` a `tick` ``", "code spans grow their fence");
  ok(md("<pre>```\ninner\n```</pre>").startsWith("````\n```"), "code blocks grow their fence");
  is(md("<p><a href='javascript:alert(1)'>x</a> <a href='#top'>top</a></p>"), "x top", "no script or in-page links");
  is(md("<p><a href='b c'>sp</a></p>"), "[sp](https://example.com/a/b%20c)", "URLs with spaces stay links");
  is(md("<img src='p.png' alt='A [pic]'><img src='t.gif' width='1' height='1'>"), "![A  pic](https://example.com/a/p.png)", "images, no tracking pixels");
  is(md("<ol start='3'><li>c</li><li>d</li></ol>"), "3. c\n4. d", "ordered lists keep their start");
  is(md("<h2> Spaced   <em>title</em> </h2>"), "## Spaced _title_", "headings on one line");
  is(md("<p>one<br>two</p>"), "one  \ntwo", "hard line breaks");
  is(md("<blockquote><p>a</p><p>b</p></blockquote>"), "> a\n>\n> b", "multi-paragraph quotes");
  is(md("<table><tr><td>a|b</td><td>c</td></tr></table>"), "| a\\|b | c |\n| --- | --- |", "pipes in cells are escaped");
  is(md("<p></p><div>  </div>"), "", "empty content gives nothing");
});

add_task(async function test_feature_switch_off() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.copy-page-markdown", false]] });
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, ARTICLE);
  const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");
  ok(!globalActions.find(a => a.l10nId == "whimsy-action-copy-page-markdown").isAvailable(window), "no command bar action");
  const menu = await openMenu(tab.linkedBrowser, "h2");
  ok(document.getElementById("context-whimsy-copy-markdown").hidden, "no menu item");
  await closeMenu(menu);
  is(await WhimsyMarkdownCopy.copy(window), null, "copy does nothing");
  ok(document.getElementById("cmd_zenCopyCurrentURLMarkdown"), "Zen's own Markdown link copy is untouched");
  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
});
