/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Copy & share (WhimsyCopy.sys.mjs): Zen's copy shortcuts copy a titled
// link, every selected tab, and Markdown lists; the tab menu's Copy Link(s).

const { WhimsyCopy } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCopy.sys.mjs");

const PAGE_1 = "https://example.com/browser/";
const PAGE_2 = "https://example.org/";

function clipboard(flavor) {
  return SpecialPowers.getClipboardData(flavor);
}

async function waitForClipboard(expected, message) {
  await TestUtils.waitForCondition(() => clipboard("text/plain") == expected, message).catch(() => {});
  is(clipboard("text/plain"), expected, message);
}

// The selected tabs' URLs in tab order (Zen may open new tabs at the top).
function selectedURLs() {
  return gBrowser.selectedTabs.map(t => t.linkedBrowser.currentURI.spec).join("\n");
}

function command(id) {
  document.getElementById(id).doCommand();
}

function toastLabel(messageId) {
  const toast = [...document.getElementById("zen-toast-container").children].find(
    t => t._messageId == messageId
  );
  return toast;
}

async function clearClipboard() {
  SpecialPowers.clipboardCopyString("");
  await TestUtils.waitForCondition(() => clipboard("text/plain") == "");
}

async function openTabs() {
  const tabs = [];
  for (const url of [PAGE_1, PAGE_2]) {
    tabs.push(await BrowserTestUtils.openNewForegroundTab(gBrowser, url));
  }
  return tabs;
}

function closeTabs(tabs) {
  gBrowser.clearMultiSelectedTabs();
  for (const tab of tabs) {
    BrowserTestUtils.removeTab(tab);
  }
}

function selectBoth(tabs) {
  gBrowser.selectedTab = tabs[0];
  gBrowser.addToMultiSelectedTabs(tabs[0]);
  gBrowser.addToMultiSelectedTabs(tabs[1]);
}

async function openTabMenu(tab) {
  const menu = document.getElementById("tabContextMenu");
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  EventUtils.synthesizeMouseAtCenter(tab, { type: "contextmenu", button: 2 });
  await shown;
  return menu;
}

async function closeMenu(menu) {
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.hidePopup();
  await hidden;
}

add_task(async function test_switch_exists() {
  ok(Services.prefs.getBoolPref("whimsy.feature.copy"), "whimsy.feature.copy is on by default");
  is(
    document.getElementById("zen-copy-url").getAttribute("command"),
    "cmd_zenCopyCurrentURL",
    "Whimsy builds on Zen's Cmd+Shift+C, it doesn't add its own key"
  );
});

add_task(async function test_single_tab_rich_link() {
  const tabs = await openTabs();
  await clearClipboard();
  command("cmd_zenCopyCurrentURL");
  await waitForClipboard(PAGE_2, "Plain URL copied");
  const html = clipboard("text/html");
  ok(html.includes(`href="${PAGE_2}"`), "The HTML flavor links to the page");
  ok(html.includes(`>${gBrowser.selectedTab.label}</a>`), "with the tab title as link text");
  const toast = await TestUtils.waitForCondition(() => toastLabel("whimsy-copy-toast"), "A toast confirms");
  is(toast.querySelector(".whimsy-copy-url")?.getAttribute("value"), PAGE_2, "The toast shows the URL");
  closeTabs(tabs);
});

add_task(async function test_multiple_selected_tabs() {
  const tabs = await openTabs();
  selectBoth(tabs);
  is(gBrowser.multiSelectedTabsCount, 2, "Two tabs selected");
  await clearClipboard();
  command("cmd_zenCopyCurrentURL");
  await waitForClipboard(selectedURLs(), "Both URLs, one per line, in tab order");
  const html = clipboard("text/html");
  is((html.match(/<li><a href=/g) || []).length, 2, "Both as an HTML list of titled links");
  const toast = await TestUtils.waitForCondition(() => toastLabel("whimsy-copy-toast"));
  const label = toast.querySelector("label");
  Assert.deepEqual(document.l10n.getAttributes(label).args, { count: 2, stripped: "no" }, "The toast counts the links");
  ok(!toast.querySelector(".whimsy-copy-url"), "No single URL under a count");
  await TestUtils.waitForCondition(() => label.textContent.includes("2"), "Copied 2 links");

  // Markdown variant: a list.
  await clearClipboard();
  command("cmd_zenCopyCurrentURLMarkdown");
  const expected = gBrowser.selectedTabs.map(t => `- [${t.label}](${t.linkedBrowser.currentURI.spec})`).join("\n");
  await waitForClipboard(expected, "A Markdown list");
  ok(toastLabel("whimsy-copy-markdown-toast"), "The Markdown toast");
  closeTabs(tabs);
});

add_task(async function test_markdown_single() {
  const tabs = await openTabs();
  await clearClipboard();
  command("cmd_zenCopyCurrentURLMarkdown");
  const tab = gBrowser.selectedTab;
  await waitForClipboard(`[${tab.label}](${PAGE_2})`, "A Markdown link");
  closeTabs(tabs);
});

add_task(async function test_format_edge_cases() {
  const md = WhimsyCopy.format([{ url: "https://a.test/", title: "A [b] c" }], { markdown: true });
  is(md.text, "[A \\[b\\] c](https://a.test/)", "Brackets in titles are escaped for Markdown");
  ok(!("html" in md), "Markdown is plain text only");
  const rich = WhimsyCopy.format([{ url: "https://a.test/?x=1&y=<2>", title: "" }], { markdown: false });
  is(
    rich.html,
    '<a href="https://a.test/?x=1&amp;y=&lt;2&gt;">https://a.test/?x=1&amp;y=&lt;2&gt;</a>',
    "HTML is escaped, and an untitled page uses its URL as text"
  );
  is(WhimsyCopy.linksFor([]).length, 0, "No tabs, no links");
});

add_task(async function test_context_menu_item() {
  const tabs = await openTabs();
  let menu = await openTabMenu(tabs[1]);
  const item = document.getElementById("context_whimsyCopyLinks");
  ok(item && !item.hidden, "Copy Link is in the tab menu");
  is(document.l10n.getAttributes(item).args.count, 1, "Singular for one tab");
  await TestUtils.waitForCondition(() => item.getAttribute("label") == "Copy Link");
  await clearClipboard();
  menu.activateItem(item);
  await waitForClipboard(PAGE_2, "Copies the tab's URL");

  selectBoth(tabs);
  menu = await openTabMenu(tabs[0]);
  await TestUtils.waitForCondition(() => item.getAttribute("label") == "Copy Links", "Plural label");
  await clearClipboard();
  menu.activateItem(item);
  await waitForClipboard(selectedURLs(), "Copies all");
  gBrowser.clearMultiSelectedTabs();

  // A blank tab has nothing to copy.
  const blank = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
  menu = await openTabMenu(blank);
  ok(item.hidden, "Hidden on a blank tab");
  await closeMenu(menu);
  BrowserTestUtils.removeTab(blank);
  closeTabs(tabs);
});

add_task(async function test_switch_off_falls_back_to_zen() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.copy", false]] });
  const tabs = await openTabs();
  selectBoth(tabs);
  await clearClipboard();
  command("cmd_zenCopyCurrentURL");
  await waitForClipboard(PAGE_1, "Zen copies the current tab only");
  ok(!clipboard("text/html"), "Zen copies plain text");
  ok(toastLabel("zen-copy-current-url-confirmation"), "Zen's own toast");
  gBrowser.clearMultiSelectedTabs();
  const menu = await openTabMenu(tabs[0]);
  const item = document.getElementById("context_whimsyCopyLinks");
  ok(!item || item.hidden, "No Copy Link menu item");
  await closeMenu(menu);
  closeTabs(tabs);
  await SpecialPowers.popPrefEnv();
});

// W10-33: the toast says "without trackers" only when Copy Clean Link's list
// actually removed tracking parameters.
const TRACKER = "utm" + "_source";
const TRACKED = `https://example.com/browser/?${TRACKER}=newsletter&keep=1`;
const CLEANED = "https://example.com/browser/?keep=1";

async function withStripOnShare(enabled, fn) {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["privacy.query_stripping.strip_on_share.enabled", enabled],
      // Keep the tracker in the page's URL: only the copy may strip it.
      ["privacy.query_stripping.enabled", false],
      ["privacy.query_stripping.enabled.pbmode", false],
    ],
  });
  await Cc["@mozilla.org/query-stripping-list-service;1"]
    .getService(Ci.nsIURLQueryStrippingListService)
    .testWaitForInit();
  try {
    await fn();
  } finally {
    await SpecialPowers.popPrefEnv();
  }
}

async function toastText(messageId, expected, message) {
  const toast = await TestUtils.waitForCondition(() => toastLabel(messageId), `${messageId} shows`);
  const label = toast.querySelector("label:not(.whimsy-copy-url)");
  await TestUtils.waitForCondition(() => label.textContent == expected, message).catch(() => {});
  is(label.textContent, expected, message);
  return toast;
}

async function openURLs(urls) {
  const tabs = [];
  for (const url of urls) {
    tabs.push(await BrowserTestUtils.openNewForegroundTab(gBrowser, url));
  }
  return tabs;
}

add_task(async function test_strip_result() {
  await withStripOnShare(true, async () => {
    let result = WhimsyCopy.strip(Services.io.newURI(TRACKED));
    ok(result.stripped, "A tracking parameter is stripped");
    is(result.uri.spec, CLEANED, "Only the tracker goes");
    result = WhimsyCopy.strip(Services.io.newURI(CLEANED));
    ok(!result.stripped, "A clean link has nothing stripped");
    is(result.uri.spec, CLEANED, "and is unchanged");
  });
  await withStripOnShare(false, async () => {
    const result = WhimsyCopy.strip(Services.io.newURI(TRACKED));
    ok(!result.stripped, "Strip-on-share off: nothing stripped");
    is(result.uri.spec, TRACKED, "and the link is unchanged");
  });
});

add_task(async function test_toast_with_trackers() {
  await withStripOnShare(true, async () => {
    const tabs = await openURLs([TRACKED]);
    is(gBrowser.currentURI.spec, TRACKED, "The page keeps its tracker");
    await clearClipboard();
    command("cmd_zenCopyCurrentURL");
    await waitForClipboard(CLEANED, "The copy drops the tracker");
    const toast = await toastText("whimsy-copy-toast", "Copied link without trackers", "Says the trackers went");
    is(toast.querySelector(".whimsy-copy-url")?.getAttribute("value"), CLEANED, "Shows the clean URL");

    await clearClipboard();
    command("cmd_zenCopyCurrentURLMarkdown");
    await waitForClipboard(`[${gBrowser.selectedTab.label}](${CLEANED})`, "Markdown drops it too");
    await toastText("whimsy-copy-markdown-toast", "Copied link as Markdown without trackers", "Markdown toast says so");
    closeTabs(tabs);
  });
});

add_task(async function test_toast_without_trackers() {
  await withStripOnShare(true, async () => {
    const tabs = await openURLs([CLEANED]);
    await clearClipboard();
    command("cmd_zenCopyCurrentURL");
    await waitForClipboard(CLEANED, "A clean link is copied as is");
    await toastText("whimsy-copy-toast", "Copied link", "No tracker claim for a clean link");

    await clearClipboard();
    command("cmd_zenCopyCurrentURLMarkdown");
    await waitForClipboard(`[${gBrowser.selectedTab.label}](${CLEANED})`, "Markdown");
    await toastText("whimsy-copy-markdown-toast", "Copied link as Markdown", "No tracker claim in Markdown");
    closeTabs(tabs);
  });
});

add_task(async function test_toast_strip_on_share_off() {
  await withStripOnShare(false, async () => {
    const tabs = await openURLs([TRACKED]);
    await clearClipboard();
    command("cmd_zenCopyCurrentURL");
    await waitForClipboard(TRACKED, "Strip-on-share off keeps the tracker");
    await toastText("whimsy-copy-toast", "Copied link", "so the toast doesn't claim it was removed");
    closeTabs(tabs);
  });
});

add_task(async function test_toast_several_tabs() {
  await withStripOnShare(true, async () => {
    let tabs = await openURLs([TRACKED, PAGE_2]);
    selectBoth(tabs);
    await clearClipboard();
    command("cmd_zenCopyCurrentURL");
    await TestUtils.waitForCondition(() => clipboard("text/plain").includes(CLEANED), "Both copied");
    ok(!clipboard("text/plain").includes(TRACKER), "Without the tracker");
    await toastText("whimsy-copy-toast", "Copied 2 links without trackers", "One link had trackers removed");
    closeTabs(tabs);

    tabs = await openURLs([CLEANED, PAGE_2]);
    selectBoth(tabs);
    await clearClipboard();
    command("cmd_zenCopyCurrentURL");
    await TestUtils.waitForCondition(() => clipboard("text/plain").includes(CLEANED), "Both copied");
    await toastText("whimsy-copy-toast", "Copied 2 links", "No link had trackers");
    closeTabs(tabs);
  });
});
