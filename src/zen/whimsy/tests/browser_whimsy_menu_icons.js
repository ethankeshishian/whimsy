/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Menu icons (macOS 26 style), an option in Settings → Look and Feel, off
// by default. Off: no row of the tab, page, link or selection menus shows
// an icon, Firefox's own included. On: rows carry Zen's monochrome icons
// (Zen's and Whimsy's rows too), and within each section no row without
// an icon sits between rows with one; the menu's own order comes back
// when it closes.

const FEATURE = "whimsy.feature.menu-icons";
const OPTION = "whimsy.look.menu-icons";
const PAGE = `data:text/html,<a id="l" href="https://example.com/" style="display:block;padding:40px">go</a><p id="t" style="padding:40px">Some words to select</p><div id="blank" style="height:200px"></div>`;

registerCleanupFunction(() => {
  Services.prefs.clearUserPref(FEATURE);
  Services.prefs.clearUserPref(OPTION);
});

function visible(node) {
  return !node.hidden && node.getAttribute("hidden") != "true";
}

function iconOf(node) {
  const icon = node?.querySelector(":scope > .menu-icon");
  if (!icon) {
    return null;
  }
  const content = window.getComputedStyle(icon).content;
  return content.includes("url(") ? content : null;
}

function showsIcon(node) {
  return !!iconOf(node) || node.hasAttribute("image");
}

function rows(menu) {
  return [...menu.children].filter(visible);
}

// Sections between visible separators; in each, the rows with an icon
// come first, with no icon-less row among them.
function checkSections(menu, what) {
  const sections = [[]];
  for (const node of rows(menu)) {
    if (node.localName == "menuseparator") {
      sections.push([]);
    } else if (["menuitem", "menu"].includes(node.localName)) {
      sections.at(-1).push(node);
    }
  }
  for (const section of sections) {
    const flags = section.map(showsIcon);
    const last = flags.lastIndexOf(true);
    const gap = flags.slice(0, last + 1).indexOf(false);
    is(
      gap,
      -1,
      `${what}: no row without an icon between rows with one (${section.map(n => n.id || n.localName).join(", ")})`
    );
  }
}

function checkNoIcons(menu, what) {
  const withIcon = rows(menu).filter(node => ["menuitem", "menu"].includes(node.localName) && showsIcon(node));
  Assert.deepEqual(
    withIcon.map(n => n.id),
    [],
    `${what}: no row shows an icon`
  );
}

async function withContentMenu(tab, selector, fn) {
  const menu = document.getElementById("contentAreaContextMenu");
  const shown = BrowserTestUtils.waitForEvent(menu, "popupshown");
  await BrowserTestUtils.synthesizeMouseAtCenter(selector, { type: "contextmenu", button: 2 }, tab.linkedBrowser);
  await shown;
  try {
    await fn(menu);
  } finally {
    const hidden = BrowserTestUtils.waitForEvent(menu, "popuphidden");
    menu.hidePopup();
    await hidden;
  }
}

async function withTabMenu(tab, fn) {
  const menu = document.getElementById("tabContextMenu");
  const shown = BrowserTestUtils.waitForEvent(menu, "popupshown");
  EventUtils.synthesizeMouseAtCenter(tab, { type: "contextmenu", button: 2 });
  await shown;
  try {
    await fn(menu);
  } finally {
    const hidden = BrowserTestUtils.waitForEvent(menu, "popuphidden");
    menu.hidePopup();
    await hidden;
  }
}

async function selectText(tab) {
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    content.getSelection().selectAllChildren(content.document.getElementById("t"));
  });
}

add_task(async function test_off_by_default() {
  ok(!Services.prefs.getBoolPref(OPTION), "Off by default");
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  await withContentMenu(tab, "#l", menu => checkNoIcons(menu, "Link menu"));
  await withContentMenu(tab, "#blank", menu => checkNoIcons(menu, "Page menu"));
  await selectText(tab);
  await withContentMenu(tab, "#t", menu => checkNoIcons(menu, "Selection menu"));
  await withTabMenu(tab, menu => checkNoIcons(menu, "Tab menu"));
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_on() {
  Services.prefs.setBoolPref(OPTION, true);
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);

  const contentMenu = document.getElementById("contentAreaContextMenu");
  const before = [...contentMenu.children];
  await withContentMenu(tab, "#l", menu => {
    ok(iconOf(document.getElementById("context-openlinkintab"))?.includes("zen-icons/plus.svg"), "Open Link in New Tab");
    ok(iconOf(document.getElementById("context-copylink"))?.includes("zen-icons/link.svg"), "Copy Link");
    const glance = document.getElementById("context-zenOpenLinkInGlance");
    if (glance && visible(glance)) {
      ok(iconOf(glance), "Zen's Open Link in Glance has one too");
    }
    checkSections(menu, "Link menu");
  });
  await withContentMenu(tab, "#blank", menu => {
    ok(iconOf(document.getElementById("context-back")), "Back has an icon");
    checkSections(menu, "Page menu");
  });
  await selectText(tab);
  await withContentMenu(tab, "#t", menu => {
    ok(iconOf(document.getElementById("context-copy"))?.includes("zen-icons/edit-copy.svg"), "Copy");
    checkSections(menu, "Selection menu");
  });
  Assert.deepEqual(
    [...contentMenu.children].map(n => n.id),
    before.map(n => n.id),
    "Closing the menu puts its rows back in their own order"
  );

  const tabMenu = document.getElementById("tabContextMenu");
  await withTabMenu(tab, menu => {
    ok(iconOf(document.getElementById("context_duplicateTab"))?.includes("zen-icons/duplicate-tab.svg"), "Duplicate Tab");
    const copyLinks = document.getElementById("context_whimsyCopyLinks");
    if (copyLinks && visible(copyLinks)) {
      ok(iconOf(copyLinks), "Whimsy's Copy Links has one too");
    }
    checkSections(menu, "Tab menu");
  });
  const tabOrder = [...tabMenu.children].map(n => n.id);
  await withTabMenu(tab, () => {});
  Assert.deepEqual(
    [...tabMenu.children].map(n => n.id),
    tabOrder,
    "The tab menu's order is the same after every opening"
  );

  // Checkbox rows never take an icon.
  for (const node of contentMenu.querySelectorAll(':scope > menuitem[type="checkbox"]')) {
    ok(!iconOf(node), `${node.id} (checkbox) has no icon`);
  }

  Services.prefs.setBoolPref(FEATURE, false);
  await withContentMenu(tab, "#l", menu => checkNoIcons(menu, "Feature switch off"));
  Services.prefs.clearUserPref(FEATURE);
  Services.prefs.clearUserPref(OPTION);
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_setting() {
  await BrowserTestUtils.withNewTab("about:preferences#zenLooks", async browser => {
    const box = await TestUtils.waitForCondition(() => browser.contentDocument.getElementById("whimsyMenuIcons"));
    ok(box, "Settings → Look and Feel has the option");
    ok(!box.checked, "unchecked by default");
    box.click();
    ok(Services.prefs.getBoolPref(OPTION), "Checking it turns icons on");
    Services.prefs.clearUserPref(OPTION);
  });
});
