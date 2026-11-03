/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W13 F06 (wave12 F06, option A): Settings → Menus uses each menu's own
// words, and a submenu's rows fold out under their parent row.
//  - The 37 fixes of the label audit: every fixed row reads, character for
//    character, like the menu row it stands for (checked against the
//    menu's own Fluent message), and a row whose label flips shows the
//    other label as its detail.
//  - Submenus (Move Tab ▸, Profile ▸, Live Folder ▸, Live Folder
//    Options ▸, Quick Actions ▸) nest; driven with real clicks and keys in
//    about:preferences.

const { WhimsyMenuPrefs } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyMenuPrefs.sys.mjs");

// The menus' own strings.
const MENU_STRINGS = new Localization(
  [
    "browser/tabContextMenu.ftl",
    "browser/browserContext.ftl",
    "browser/zen-general.ftl",
    "browser/zen-workspaces.ftl",
    "browser/zen-live-folders.ftl",
    "browser/zen-folders.ftl",
    "browser/zen-share.ftl",
    "browser/zen-split-view.ftl",
    "browser/whimsy.ftl",
  ],
  true
);
const WHIMSY = new Localization(["browser/whimsy.ftl"], true);

function label(l10n, id) {
  const [message] = l10n.formatMessagesSync([{ id }]);
  return (message?.value ?? message?.attributes?.find(a => a.name == "label")?.value ?? "").replace(/[⁨⁩]/g, "");
}
function rowOf(menuId, id) {
  return WhimsyMenuPrefs.items(menuId).find(entry => entry.id == id);
}

// [menu, row, the menu row's own message, its other label's message]
const FIXED = [
  ["tab", "new-tab", "tab-context-new-tab-open-vertical"],
  ["tab", "rename", "tab-context-zen-edit-title"],
  ["tab", "essentials", "tab-context-zen-add-essential", "tab-context-zen-remove-essential"],
  ["tab", "pin", "pin-tab", "unpin-tab"],
  ["tab", "share", null, "tab-context-share-selected-tabs"],
  ["tab", "move-to-new-space", "whimsy-menu-move-to-new-space"],
  ["link", "split", "zen-split-link"],
  ["link", "copy-email", "main-context-menu-copy-email", "main-context-menu-copy-phone"],
  ["page", "send-to-device", "main-context-menu-send-to-device-2"],
  ["selection", "quick-actions", "whimsy-context-quick-actions"],
  ["media", "play", "main-context-menu-media-play", "main-context-menu-media-pause"],
  ["media", "mute", "main-context-menu-media-mute", "main-context-menu-media-unmute"],
  ["media", "controls", "main-context-menu-media-hide-controls", "main-context-menu-media-show-controls"],
  ["media", "save", "main-context-menu-video-save-as", "main-context-menu-audio-save-as"],
  ["media", "copy-link", "main-context-menu-video-copy-link", "main-context-menu-audio-copy-link"],
  ["media", "email", "main-context-menu-video-email", "main-context-menu-audio-email"],
  ["space", "rename", "zen-workspaces-panel-change-name"],
  ["space", "edit-theme", "zen-workspaces-change-theme"],
  ["space", "unload-others", "zen-workspaces-panel-unload-others"],
  ["space", "new-profile", "whimsy-profile-create-menuitem"],
  ["sidebar", "new-live-folder", "zen-panel-ui-live-folder-create"],
  ["sidebar", "live-github-prs", "zen-live-folder-github-pull-requests"],
  ["sidebar", "live-github-issues", "zen-live-folder-github-issues"],
  ["sidebar", "live-rss", "zen-live-folder-type-rss"],
  ["sidebar", "live-jira", "whimsy-live-folder-jira-create"],
  ["sidebar", "live-linear", "whimsy-live-folder-linear-create"],
  ["sidebar", "live-local-servers", "whimsy-live-folder-local-servers-create"],
  ["folder", "live-options", "zen-live-folder-options"],
  ["folder", "live-resync", "whimsy-live-folder-resync"],
  ["folder", "rename", "zen-folders-panel-rename-folder"],
  ["folder", "unload", "zen-folders-unload-folder"],
  ["folder", "move-to-space", "zen-folders-panel-change-folder-space"],
  ["folder", "convert-to-space", "zen-folders-panel-convert-folder-to-space"],
  ["folder", "share", "zen-share-folder"],
  ["folder", "unpack", "zen-folders-panel-unpack-folder"],
  ["folder", "delete", "zen-folders-panel-delete-folder"],
  // The audit's last row was checked live: the pane's menu says "Copy
  // link as Markdown", which Settings already said.
  ["split-pane", "copy-markdown", "whimsy-split-pane-copy-markdown"],
];

add_task(function test_labels_are_the_menus_own() {
  is(FIXED.length, 37, "Every row of the audit");
  for (const [menuId, id, own, other] of FIXED) {
    const entry = rowOf(menuId, id);
    ok(entry, `${menuId}: ${id} is listed`);
    const shown = label(WHIMSY, entry.l10n);
    ok(shown && !shown.includes("▸") && !shown.includes(" / "), `${menuId}: "${shown}" is one label`);
    if (own) {
      is(shown, label(MENU_STRINGS, own), `${menuId}: ${id} reads like its menu row`);
    }
    if (other) {
      ok(entry.altL10n, `${menuId}: ${id} has a detail line`);
      is(label(WHIMSY, entry.altL10n), `or ${label(MENU_STRINGS, other)}`, `${menuId}: ${id}'s detail is its other label`);
    }
  }
});

add_task(function test_submenus_nest() {
  const nests = {
    tab: { "move-tab": ["move-to-new-space"] },
    space: { profile: ["new-profile"] },
    sidebar: {
      "new-live-folder": ["live-github-prs", "live-github-issues", "live-rss", "live-jira", "live-linear", "live-local-servers"],
    },
    folder: { "live-options": ["live-resync"] },
  };
  for (const [menuId, parents] of Object.entries(nests)) {
    for (const [parent, children] of Object.entries(parents)) {
      for (const child of children) {
        is(WhimsyMenuPrefs.parentOf(menuId, child)?.id, parent, `${menuId}: ${child} is under ${parent}`);
        ok(!WhimsyMenuPrefs.topItems(menuId).some(entry => entry.id == child), `${menuId}: ${child} isn't a row of its own`);
      }
    }
  }
  // Pref keys didn't change, so what people hid stays hidden.
  WhimsyMenuPrefs.setHidden("folder", "live-resync", true);
  ok(WhimsyMenuPrefs.isHidden("folder", "live-resync"), "A nested row's switch is the same pref entry");
  WhimsyMenuPrefs.restoreDefaults("folder");
});

add_task(async function test_fold_out_in_settings() {
  await BrowserTestUtils.withNewTab("about:preferences#whimsyMenus-folder", async browser => {
    const doc = browser.contentDocument;
    const win = browser.contentWindow;
    const detail = await TestUtils.waitForCondition(() => doc.getElementById("whimsyMenus-folder"), "Built");
    await TestUtils.waitForCondition(() => detail.checkVisibility(), "The Folder menu shows");
    const parent = detail.querySelector('.whimsy-menus-row-parent[data-item="live-options"]');
    ok(parent, "Live Folder Options is a submenu row");
    const kids = parent.nextElementSibling;
    ok(kids.classList.contains("whimsy-menus-kids"), "Its rows follow it");
    ok(!kids.checkVisibility(), "Collapsed at first");
    const count = parent.querySelector(".whimsy-menus-kids-count");
    await TestUtils.waitForCondition(() => count.textContent.replace(/[⁨⁩]/g, "") == "1 of 1 on", "It says how many of its rows are on");

    // Every row's name starts at the same edge (the chevron's column).
    const names = [...detail.querySelectorAll(":scope .whimsy-menus-rows > .whimsy-menus-row .whimsy-menus-row-label")];
    is(new Set(names.map(n => Math.round(n.getBoundingClientRect().left))).size, 1, "Names line up with or without a chevron");

    // A real click on the chevron opens it, and leaves the switch alone.
    const disclose = parent.querySelector(".whimsy-menus-disclose");
    const box = parent.querySelector(".whimsy-menus-check");
    is(disclose.getAttribute("aria-expanded"), "false", "The chevron says it's closed");
    EventUtils.synthesizeMouseAtCenter(disclose, {}, win);
    await TestUtils.waitForCondition(() => kids.checkVisibility(), "A click folds the rows out");
    is(disclose.getAttribute("aria-expanded"), "true", "…and the chevron says so");
    ok(box.checked && !WhimsyMenuPrefs.isHidden("folder", "live-options"), "The click didn't turn the row off");
    const resync = kids.querySelector('.whimsy-menus-row[data-item="live-resync"]');
    ok(resync.checkVisibility(), "Resync shows under it");
    Assert.greater(resync.querySelector(".whimsy-menus-row-label").getBoundingClientRect().left,
      parent.querySelector(".whimsy-menus-row-label").getBoundingClientRect().left, "…indented");
    isnot(win.getComputedStyle(kids).borderInlineStartWidth, "0px", "…behind a hairline");

    // Turning the submenu off dims its rows (disabled, still checked).
    EventUtils.synthesizeMouseAtCenter(box, {}, win);
    await TestUtils.waitForCondition(() => WhimsyMenuPrefs.isHidden("folder", "live-options"), "Off");
    const child = resync.querySelector(".whimsy-menus-check");
    await TestUtils.waitForCondition(() => child.disabled, "Its rows can't be changed while it's off");
    ok(child.checked, "…but keep their own state");
    is(win.getComputedStyle(resync).opacity, "0.5", "…and dim");
    EventUtils.synthesizeMouseAtCenter(box, {}, win);
    await TestUtils.waitForCondition(() => !child.disabled, "On again");

    // Keys: Left closes from the row, Right opens, Left from a child goes back up.
    box.focus();
    EventUtils.synthesizeKey("KEY_ArrowLeft", {}, win);
    ok(!kids.checkVisibility() && disclose.getAttribute("aria-expanded") == "false", "Left folds it");
    EventUtils.synthesizeKey("KEY_ArrowDown", {}, win);
    ok(!kids.contains(doc.activeElement), "Down skips the folded rows");
    box.focus();
    EventUtils.synthesizeKey("KEY_ArrowRight", {}, win);
    ok(kids.checkVisibility(), "Right folds it out");
    EventUtils.synthesizeKey("KEY_ArrowDown", {}, win);
    is(doc.activeElement, child, "Down goes into its rows");
    EventUtils.synthesizeKey("KEY_ArrowLeft", {}, win);
    is(doc.activeElement, box, "Left from a row goes back to the submenu's row");
    ok(!kids.checkVisibility(), "…and folds it");
  });
  WhimsyMenuPrefs.restoreDefaults("folder");
  Services.prefs.clearUserPref("whimsy.menus.settings-last");
});

add_task(async function test_detail_line_and_search() {
  await BrowserTestUtils.withNewTab("about:preferences#whimsyMenus-tab", async browser => {
    const doc = browser.contentDocument;
    const win = browser.contentWindow;
    const detail = await TestUtils.waitForCondition(() => doc.getElementById("whimsyMenus-tab"), "Built");
    await TestUtils.waitForCondition(() => detail.checkVisibility(), "The Tab menu shows");
    const pin = detail.querySelector('.whimsy-menus-row[data-item="pin"]');
    await TestUtils.waitForCondition(() => pin.querySelector(".whimsy-menus-row-label").textContent == "Pin Tab", "Pin Tab, as the menu says it");
    const alt = pin.querySelector(".whimsy-menus-row-alt");
    await TestUtils.waitForCondition(() => alt.textContent == "or Unpin Tab", "The other label is its detail");
    isnot(win.getComputedStyle(alt).color, win.getComputedStyle(pin.querySelector(".whimsy-menus-row-label")).color, "…in the muted colour");
    is(pin.querySelector(".whimsy-menus-check").getAttribute("aria-describedby"), alt.id, "…and describes the checkbox");

    // Settings search finds a row inside a folded submenu and folds it out.
    const kids = detail.querySelector('.whimsy-menus-row-parent[data-item="move-tab"]').nextElementSibling;
    ok(!kids.checkVisibility(), "Move Tab's rows start folded");
    const search = doc.getElementById("searchInput");
    search.focus();
    EventUtils.sendString("New Space", win);
    const row = kids.querySelector('.whimsy-menus-row[data-item="move-to-new-space"]');
    await TestUtils.waitForCondition(() => row.classList.contains("whimsy-search-hit") && row.checkVisibility(),
      "The hit shows, its submenu folded out");
    search.select();
    EventUtils.synthesizeKey("KEY_Backspace", {}, win);
    await TestUtils.waitForCondition(() => !row.classList.contains("whimsy-search-hit"), "Search cleared");
  });
  Services.prefs.clearUserPref("whimsy.menus.settings-last");
});
