/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Mini Whimsy (Arc's "Little Arc"; Cmd+Opt+N, and also where
// WhimsyExternalLinks lands a link when the target is "quick-window"): a
// small window with no sidebar, just the nav bar and the page, floating
// above every other window. Covers the main flow (open, a second link
// stacking a second window, float, move to space by button/Cmd+O/
// Cmd+Shift+O, Esc not closing it, Cmd+Opt+N's bar-only panel), the switch
// off, and closing it leaving no trace (including no geometry left behind
// for ordinary windows to inherit).

add_setup(async function isolate_mini_size() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.quick-window.size", ""]] });
});

const { WhimsyQuickWindow } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyQuickWindow.sys.mjs");

registerCleanupFunction(async () => {
  for (const win of WhimsyQuickWindow.windows()) {
    await WhimsyQuickWindow.whenReady(win);
    await BrowserTestUtils.closeWindow(win);
  }
});

add_task(async function test_open_hides_the_sidebar() {
  const win = WhimsyQuickWindow.open("https://example.com/");
  await WhimsyQuickWindow.whenReady(win);
  ok(win._whimsyQuickWindow, "Tagged as a quick window");
  await TestUtils.waitForCondition(
    () => win.document.documentElement.hasAttribute("whimsy-quick-window"),
    "whimsy-quick-window attribute set"
  );
  const sidebar = win.document.getElementById("navigator-toolbox");
  is(win.getComputedStyle(sidebar).visibility, "collapse", "The vertical sidebar is hidden");
  is(sidebar.getBoundingClientRect().width, 0, "...and takes no room beside the page");
  ok(!win.toolbar.visible, "Opened as a popup window (no trace once closed)");
  await BrowserTestUtils.closeWindow(win);
});

add_task(async function test_floats_above_other_windows_on_its_own_space() {
  const win = WhimsyQuickWindow.open("https://example.com/");
  await WhimsyQuickWindow.whenReady(win);
  // Same technique engine/dom/documentpip's browser_pip_ui.js uses: the
  // widget itself can't be introspected from here, but the chrome flags
  // that drive NSFloatingWindowLevel + FullScreenAuxiliary (and not
  // CanJoinAllSpaces) on macOS can be. Arc's Little Arc floats on its own
  // Space, not every Space (see the module's banner comment for the
  // evidence) -- CHROME_ALWAYS_ON_TOP alone would be a deviation from Arc.
  const chromeFlags = win.docShell.treeOwner
    .QueryInterface(Ci.nsIInterfaceRequestor)
    .getInterface(Ci.nsIAppWindow).chromeFlags;
  ok(
    chromeFlags & Ci.nsIWebBrowserChrome.CHROME_ALWAYS_ON_TOP,
    "Mini Whimsy floats (Arc parity)"
  );
  ok(
    chromeFlags & Ci.nsIWebBrowserChrome.CHROME_ALWAYS_ON_TOP_FULLSCREEN_AUX,
    "...but only above its own Space / a full-screen app, not every Space (Arc parity)"
  );
  await BrowserTestUtils.closeWindow(win);
});

add_task(async function test_does_not_persist_its_geometry() {
  // browser.xhtml's <html id="main-window"> persists screenX/screenY/
  // width/height under that id for every window, quick or not; a quick
  // window must not write its small size over an ordinary window's.
  const win = WhimsyQuickWindow.open("https://example.com/");
  await WhimsyQuickWindow.whenReady(win);
  is(
    win.document.documentElement.getAttribute("persist"),
    null,
    "Mini Whimsy doesn't persist its geometry (would clobber ordinary windows')"
  );
  await BrowserTestUtils.closeWindow(win);
});

// wave7: Arc opens a second Little Arc for a second link, stacked over the
// first and offset down (little-095501, 8.3-8.45 s), instead of replacing
// the page you were reading.
add_task(async function test_a_second_link_stacks_a_second_window() {
  const first = WhimsyQuickWindow.open("https://example.com/", { opener: window });
  await WhimsyQuickWindow.whenReady(first);
  const second = WhimsyQuickWindow.open("https://example.org/", { opener: window });
  try {
    await WhimsyQuickWindow.whenReady(second);
    isnot(first, second, "A second Mini window opens");
    ok(second._whimsyQuickWindow, "...and it is a Mini window");
    is(WhimsyQuickWindow.current(), second, "The newest Mini is the current one");
    Assert.deepEqual(WhimsyQuickWindow.windows(), [first, second], "Both stay open");
    await TestUtils.waitForCondition(
      () => second.gBrowser.selectedBrowser.currentURI.spec == "https://example.org/",
      "The second window shows the second link"
    );
    is(first.gBrowser.selectedBrowser.currentURI.spec, "https://example.com/", "The first keeps its page");
    const screen = first.screen;
    const roomBelow = first.screenY + 28 + second.outerHeight <= screen.availTop + screen.availHeight;
    if (roomBelow) {
      is(second.screenY - first.screenY, 28, "Stacked 28px below the first");
      is(second.screenX, first.screenX, "...at the same left edge");
    } else {
      ok(second.screenY >= first.screenY, "Stacked no higher than the first (clamped to the screen)");
    }
  } finally {
    await BrowserTestUtils.closeWindow(second);
    await BrowserTestUtils.closeWindow(first);
  }
});

add_task(async function test_move_to_space_adopts_the_tab_and_closes_the_window() {
  const spaceId = window.gZenWorkspaces.activeWorkspace;
  const win = WhimsyQuickWindow.open("https://example.com/", { opener: window });
  await WhimsyQuickWindow.whenReady(win);
  await TestUtils.waitForCondition(
    () => win.gBrowser.selectedBrowser.currentURI.spec == "https://example.com/",
    "The quick window loaded its page"
  );
  const tabCountBefore = gBrowser.tabs.length;
  const adopted = WhimsyQuickWindow.moveToSpace(win, spaceId);
  ok(adopted, "moveToSpace returns the adopted tab");
  is(gBrowser.tabs.length, tabCountBefore + 1, "The tab landed in this window");
  is(adopted.linkedBrowser.currentURI.spec, "https://example.com/", "It's the quick window's page");
  await TestUtils.waitForCondition(() => win.closed, "The quick window closes once the tab is adopted");
  BrowserTestUtils.removeTab(adopted);
});

add_task(async function test_cmd_o_opens_in_current_space() {
  // Arc parity: Cmd+O moves the page into the current space directly, no
  // picker. Zen's own Cmd+O ("Expand Glance") must not fire instead.
  const win = WhimsyQuickWindow.open("https://example.com/", { opener: window });
  await WhimsyQuickWindow.whenReady(win);
  await TestUtils.waitForCondition(
    () => win.gBrowser.selectedBrowser.currentURI.spec == "https://example.com/",
    "The quick window loaded its page"
  );
  const tabCountBefore = gBrowser.tabs.length;
  EventUtils.synthesizeKey("o", { accelKey: true }, win);
  await TestUtils.waitForCondition(() => win.closed, "Cmd+O moves the tab and closes the quick window");
  is(gBrowser.tabs.length, tabCountBefore + 1, "The tab landed in the current space");
  const adopted = gBrowser.tabs[gBrowser.tabs.length - 1];
  is(adopted.linkedBrowser.currentURI.spec, "https://example.com/", "It's the quick window's page");
  BrowserTestUtils.removeTab(adopted);
});

// fix7: the caret and Cmd+Shift+O both open the space dropdown (the user
// keeps the key; Show All Bookmarks gives it up in Mini only).
add_task(async function test_cmd_shift_o_and_caret_open_the_space_dropdown() {
  const win = WhimsyQuickWindow.open("https://example.com/", { opener: window });
  await WhimsyQuickWindow.whenReady(win);
  await SimpleTest.promiseFocus(win);
  const doc = win.document;
  is(doc.getElementById("key_whimsyQuickWindowChooseSpace")?.getAttribute("modifiers"), "accel,shift", "Cmd+Shift+O is bound");
  ok(!doc.getElementById("manBookmarkKb")?.getAttribute("key"), "Show All Bookmarks doesn't compete in Mini");
  const picker = () => doc.getElementById("whimsy-quick-window-space-picker");
  EventUtils.synthesizeKey("o", { accelKey: true, shiftKey: true }, win);
  await TestUtils.waitForCondition(() => picker()?.state == "open", "Cmd+Shift+O opens the dropdown");
  const popup = picker();
  ok(popup.firstElementChild.localName == "menucaption", "Headed by a caption");
  const rows = [...popup.querySelectorAll(".whimsy-mini-picker-space")];
  is(rows.length, gZenWorkspaces.getWorkspaces().length, "One row per space");
  ok(rows.every(row => row.getAttribute("image")), "Every row has an icon or colour dot");
  const current = rows.find(row => row.getAttribute("zen-workspace-id") == gZenWorkspaces.activeWorkspace);
  ok(current && !current.disabled, "The current space can be chosen");
  is(current.getAttribute("key"), "key_whimsyQuickWindowOpenInSpace", "...and shows Cmd+O");
  is(doc.getElementById("whimsy-quick-window-choose-space").getAttribute("open"), "true", "The caret reads as pressed");
  let hidden = BrowserTestUtils.waitForEvent(popup, "popuphidden");
  popup.hidePopup();
  await hidden;
  ok(!doc.getElementById("whimsy-quick-window-choose-space").hasAttribute("open"), "...until it closes");
  doc.getElementById("whimsy-quick-window-choose-space").doCommand();
  await TestUtils.waitForCondition(() => picker().state == "open", "The caret opens the same dropdown");
  const tabCountBefore = gBrowser.tabs.length;
  // The dropdown rebuilds its rows each time it opens.
  const row = picker().querySelector(`[zen-workspace-id="${gZenWorkspaces.activeWorkspace}"]`);
  picker().activateItem(row);
  await TestUtils.waitForCondition(() => win.closed, "Choosing a space opens the page there");
  is(gBrowser.tabs.length, tabCountBefore + 1, "The tab landed in that space");
  BrowserTestUtils.removeTab(gBrowser.tabs[gBrowser.tabs.length - 1]);
});

// wave7: Arc's Little Arc ignores Esc (little-095501); Mini does too.
add_task(async function test_escape_does_not_close_the_window() {
  const win = WhimsyQuickWindow.open("https://example.com/", { opener: window });
  try {
    await readyMini(win);
    await SimpleTest.promiseFocus(win);
    EventUtils.synthesizeKey("KEY_Escape", {}, win);
    await new Promise(resolve => win.requestAnimationFrame(() => win.setTimeout(resolve, 200)));
    ok(!win.closed, "Esc leaves Mini open");
    ok(!win.document.documentElement.hasAttribute("whimsy-mini-closing"), "...and doesn't start closing it");
  } finally {
    await BrowserTestUtils.closeWindow(win);
  }
});

add_task(async function test_feature_off_does_nothing() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.quick-window", false]] });
  const win = WhimsyQuickWindow.open("https://example.com/");
  is(win, null, "No quick window opens with the feature off");
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_shortcut_opens_an_empty_focused_window() {
  const win = WhimsyQuickWindow.open(null, { opener: window });
  await WhimsyQuickWindow.whenReady(win);
  is(win.gBrowser.selectedBrowser.currentURI.spec, "about:blank", "An empty window for the bare shortcut");
  const oneOffs = win.gURLBar.view.oneOffSearchButtons;
  await BrowserTestUtils.closeWindow(win);
  const engineInfo = await oneOffs.getEngineInfo();
  is(engineInfo.engines.length, 0, "A late search callback has no engines after Mini closes");
});

// wave2: named destination, inherited theme and Arc's separate saved size.
async function readyMini(win) {
  await WhimsyQuickWindow.whenReady(win);
  await TestUtils.waitForCondition(
    () => win.document.getElementById("whimsy-quick-window-move-to-space"),
    "Mini chrome is ready"
  );
}

add_task(async function test_destination_name_and_theme_follow_the_target() {
  const original = gZenWorkspaces.getActiveWorkspace();
  let created;
  let win;
  try {
    await gZenWorkspaces.createAndSaveWorkspace("Design & café");
    created = gZenWorkspaces.getActiveWorkspace();
    created.theme = {
      type: "gradient", opacity: 0.7, texture: 0.3,
      gradientColors: [{
        c: [230, 60, 80], isPrimary: true, isCustom: false,
        position: { x: 10, y: 10 }, type: "primary", lightness: 50,
      }],
    };
    gZenThemePicker.onWorkspaceChange(created);
    win = WhimsyQuickWindow.open("https://example.com/", { opener: window });
    await readyMini(win);
    const button = win.document.getElementById("whimsy-quick-window-move-to-space");
    await TestUtils.waitForCondition(() =>
      win.document.l10n.getAttributes(button).args?.space == created.name,
    "Fluent receives the actual destination name");
    await win.document.l10n.translateElements([button]);
    ok(button.getAttribute("label").includes(created.name), "Open in names the space, including Unicode");
    ok(button.getAttribute("label").startsWith("Open in "), "Arc's exact action label");
    for (const [id, property] of [
      ["main-window", "--zen-primary-color"],
      ["main-window", "--toolbox-textcolor"],
      ["main-window", "--toolbar-color-scheme"],
      ["main-window", "color-scheme"],
      ["zen-browser-background", "--zen-main-browser-background"],
      ["zen-toolbar-background", "--zen-main-browser-background-toolbar"],
      ["zen-browser-background", "--zen-grainy-background-opacity"],
    ]) {
      await TestUtils.waitForCondition(() =>
        win.getComputedStyle(win.document.getElementById(id)).getPropertyValue(property) ==
        getComputedStyle(document.getElementById(id)).getPropertyValue(property),
      `Mini inherits ${property}`);
    }
    created.name = "Renamed space";
    window.dispatchEvent(new CustomEvent("ZenWorkspaceDataChanged"));
    await TestUtils.waitForCondition(() =>
      win.document.l10n.getAttributes(button).args?.space == created.name,
    "Renaming the destination updates Fluent");
    await gZenWorkspaces.changeWorkspace(original);
    await TestUtils.waitForCondition(() =>
      win.document.l10n.getAttributes(button).args?.space == original.name,
    "Switching the target space updates the action");
    await TestUtils.waitForCondition(() =>
      win.getComputedStyle(win.document.documentElement).getPropertyValue("--zen-primary-color") ==
      getComputedStyle(document.documentElement).getPropertyValue("--zen-primary-color"),
    "Switching the target space updates its colors too");
    is(WhimsyQuickWindow.defaultSpaceId(win), original.uuid, "Cmd+O and the label use the same destination");
  } finally {
    if (win && !win.closed) {
      await BrowserTestUtils.closeWindow(win);
    }
    await gZenWorkspaces.changeWorkspace(original);
    if (created) {
      await gZenWorkspaces.removeWorkspace(created.uuid);
    }
  }
});

add_task(async function test_resize_is_remembered_only_for_mini() {
  const pref = "whimsy.quick-window.size";
  Services.prefs.setStringPref(pref, "");
  const normalSize = [window.outerWidth, window.outerHeight];
  let win = WhimsyQuickWindow.open("about:blank", { opener: window });
  try {
    await readyMini(win);
    const before = [win.innerWidth, win.innerHeight];
    win.resizeBy(-40, -40);
    await TestUtils.waitForCondition(() => {
      const saved = WhimsyQuickWindow.savedSize();
      return saved.width == win.innerWidth && saved.height == win.innerHeight &&
        (saved.width != before[0] || saved.height != before[1]);
    }, "The resized Mini dimensions are saved");
    const size = WhimsyQuickWindow.savedSize();
    await BrowserTestUtils.closeWindow(win);
    win = WhimsyQuickWindow.open("about:blank", { opener: window });
    await readyMini(win);
    is(win.innerWidth, size.width, "Reopened Mini restores its width");
    is(win.innerHeight, size.height, "Reopened Mini restores its height");
    is(window.outerWidth, normalSize[0], "Ordinary window width is unchanged");
    is(window.outerHeight, normalSize[1], "Ordinary window height is unchanged");
    ok(!win.document.documentElement.hasAttribute("persist"), "Shared XUL geometry stays disabled");
  } finally {
    await BrowserTestUtils.closeWindow(win);
  }
  for (const value of ["invalid", "null", '{"width":-1,"height":0}', '{"width":"480","height":720}']) {
    Services.prefs.setStringPref(pref, value);
    Assert.deepEqual(WhimsyQuickWindow.savedSize(), { width: 1260, height: 780 }, "Invalid saved size uses measured defaults");
  }
});

// wave4: Arc's Little Arc layout. One bar (window controls, Back, address,
// Copy URL, Open in <Space> + caret) over the page card; no Zen nav bar, no
// native title bar; the address opens the floating command bar.
add_task(async function test_bar_has_arcs_controls_in_order() {
  const win = WhimsyQuickWindow.open("https://example.com/", { opener: window });
  try {
    await readyMini(win);
    const doc = win.document;
    const bar = doc.getElementById("whimsy-quick-window-bar");
    ok(bar && win.getComputedStyle(bar).display != "none", "Mini has its own bar");
    const ids = [...bar.children].map(el => el.id || el.className);
    Assert.deepEqual(ids.filter(id => id.startsWith("whimsy-quick-window")), [
      "whimsy-quick-window-back",
      // wave7/profiles: the page's profile pill, just before the strip.
      "whimsy-quick-window-profile",
      "whimsy-quick-window-address-field",
      "whimsy-quick-window-open",
    ], "Back, the profile pill, the address strip, then Open in <Space>");
    // fix7: Little Arc puts Extensions and Copy Link inside the strip, at
    // its right end.
    const field = doc.getElementById("whimsy-quick-window-address-field");
    Assert.deepEqual([...field.children].map(el => el.id), [
      "whimsy-quick-window-address",
      "unified-extensions-button",
      "whimsy-quick-window-copy-link",
    ], "Address, then Extensions and Copy Link inside the strip");
    const fieldRect = field.getBoundingClientRect();
    const copyRect = doc.getElementById("whimsy-quick-window-copy-link").getBoundingClientRect();
    Assert.lessOrEqual(fieldRect.right - copyRect.right, 4, "Copy Link sits at the strip's right end");
    const group = doc.getElementById("whimsy-quick-window-open");
    ok(group.contains(doc.getElementById("whimsy-quick-window-move-to-space")) &&
      group.contains(doc.getElementById("whimsy-quick-window-choose-space")),
      "Open in <Space> and its caret form one split button");
    is(win.getComputedStyle(doc.getElementById("zen-appcontent-navbar-wrapper")).visibility, "collapse",
      "Zen's own nav bar is not shown");
    ok(bar.querySelector(".titlebar-buttonbox-container"), "The window controls sit in the bar");
    const extensions = doc.getElementById("unified-extensions-button");
    ok(field.contains(extensions) && extensions.getBoundingClientRect().width > 0,
      "Mini shows the real extensions button despite Zen's hidden-button default");
    is(win.gUnifiedExtensions._button, extensions, "The extensions panel uses the visible Mini anchor");
    const extLabel = extensions.querySelector(".toolbarbutton-text");
    ok(!extLabel || win.getComputedStyle(extLabel).display == "none", "Extensions is the puzzle icon alone, as in Arc");
    ok(doc.documentElement.hasAttribute("customtitlebar"), "No native title bar above it (Arc has none)");
    const barRect = bar.getBoundingClientRect();
    Assert.lessOrEqual(Math.round(barRect.top), 4, "The bar is the top edge of the window");
    is(Math.round(barRect.height), 48, "Bar matches the measured 48pt height");
    const card = win.gBrowser.selectedBrowser.closest(".browserSidebarContainer");
    is(win.getComputedStyle(card).borderTopLeftRadius, "0px", "Page meets bar without a card inset");
    Assert.greaterOrEqual(card.getBoundingClientRect().top, barRect.bottom, "The card sits below the bar");
  } finally {
    await BrowserTestUtils.closeWindow(win);
  }
});

add_task(async function test_address_shows_the_host_and_back_follows_history() {
  const win = WhimsyQuickWindow.open("https://example.com/", { opener: window });
  try {
    await readyMini(win);
    const doc = win.document;
    const address = doc.getElementById("whimsy-quick-window-address");
    const host = address.querySelector(".whimsy-mini-host");
    await TestUtils.waitForCondition(() => host.textContent == "example.com", "The address shows the bare host");
    ok(!address.querySelector(".whimsy-mini-favicon"), "Measured address has no site favicon");
    is(address.parentElement.previousElementSibling?.id, "whimsy-quick-window-profile", "The profile pill sits just before the address strip");
    const back = doc.getElementById("whimsy-quick-window-back");
    ok(back.disabled, "Back is dimmed with no history (it never moves)");
    ok(!doc.getElementById("whimsy-quick-window-copy-link").disabled, "Copy URL is available for a page");
    const browser = win.gBrowser.selectedBrowser;
    const loaded = BrowserTestUtils.browserLoaded(browser, false, "https://example.org/");
    BrowserTestUtils.startLoadingURIString(browser, "https://example.org/");
    await loaded;
    await TestUtils.waitForCondition(() => host.textContent == "example.org", "The address follows navigation");
    await TestUtils.waitForCondition(() => !back.disabled, "Back becomes available");
  } finally {
    await BrowserTestUtils.closeWindow(win);
  }
});

add_task(async function test_address_opens_the_floating_command_bar() {
  const win = WhimsyQuickWindow.open("https://example.com/", { opener: window });
  try {
    await readyMini(win);
    await SimpleTest.promiseFocus(win);
    ok(!win.gURLBar.readOnly, "Mini's address can be edited (popups' is read-only)");
    win.document.getElementById("whimsy-quick-window-address").click();
    await TestUtils.waitForCondition(() => win.gURLBar.focused, "The command bar takes focus");
    // A fresh test profile may have no top sites to show before typing.
    EventUtils.sendString("example", win);
    await TestUtils.waitForCondition(() => win.gURLBar.view.isOpen, "The command bar opens");
    ok(win.gURLBar.hasAttribute("zen-floating-urlbar"), "It floats over the page");
    is(win.getComputedStyle(win.gURLBar).visibility, "visible", "...visibly, though the sidebar is hidden");
    EventUtils.synthesizeKey("KEY_Escape", {}, win);
    await TestUtils.waitForCondition(() => !win.gURLBar.view.isOpen, "Esc closes the command bar first");
    ok(!win.closed, "...without closing Mini");
  } finally {
    if (!win.closed) {
      await BrowserTestUtils.closeWindow(win);
    }
  }
});

add_task(async function test_blank_mini_shows_the_placeholder() {
  const win = WhimsyQuickWindow.open(null, { opener: window });
  try {
    await readyMini(win);
    const address = win.document.getElementById("whimsy-quick-window-address");
    ok(address.hasAttribute("blank"), "A blank Mini marks its address empty");
    ok(win.document.getElementById("whimsy-quick-window-copy-link").disabled, "Nothing to copy yet");
    const host = address.querySelector(".whimsy-mini-host");
    await TestUtils.waitForCondition(() => host.textContent.length, "The placeholder is localized");
  } finally {
    await BrowserTestUtils.closeWindow(win);
  }
});

add_task(async function test_space_icon_images() {
  is(WhimsyQuickWindow.spaceIcon(null), null, "No space, no icon");
  is(WhimsyQuickWindow.spaceIcon({ icon: "" }), null, "A space without an icon shows none");
  is(WhimsyQuickWindow.spaceIcon({ icon: "chrome://browser/skin/zen-icons/link.svg" }),
    "chrome://browser/skin/zen-icons/link.svg", "SVG icons are used as they are");
  const emoji = WhimsyQuickWindow.spaceIcon({ icon: "🎨" });
  ok(emoji.startsWith("data:image/svg+xml,"), "Emoji icons are drawn into an SVG");
  ok(decodeURIComponent(emoji).includes("🎨"), "...with the emoji in it");
});

add_task(async function mini_controls_are_keyboard_reachable() {
  const win = WhimsyQuickWindow.open("https://example.com/", { opener: window });
  try {
    await readyMini(win);
    await SimpleTest.promiseFocus(win);
    const doc = win.document;
    const copy = doc.getElementById("whimsy-quick-window-copy-link");
    const extensions = doc.getElementById("unified-extensions-button");
    extensions.focus();
    is(doc.activeElement, extensions, "Extensions receives keyboard focus");
    copy.focus();
    is(doc.activeElement, copy, "Copy receives keyboard focus");
    EventUtils.synthesizeKey("KEY_Tab", {}, win);
    is(doc.activeElement.id, "whimsy-quick-window-move-to-space", "Tab reaches Open in Space");
    EventUtils.synthesizeKey("KEY_Tab", {}, win);
    is(doc.activeElement.id, "whimsy-quick-window-choose-space", "Tab reaches the space picker");
    EventUtils.synthesizeKey(" ", {}, win);
    await TestUtils.waitForCondition(() => doc.querySelector("#whimsy-quick-window-space-picker")?.state == "open", "Keyboard activates the picker");
  } finally {
    await BrowserTestUtils.closeWindow(win);
  }
});

// wave5/uxfix: Mini's chrome follows the theme (light frame in light mode,
// dark in dark), with readable text and a pressed fill you can see.
function resolvedRGB(win, value) {
  const canvas = win.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, 1, 1);
  ctx.fillStyle = value;
  ctx.fillRect(0, 0, 1, 1);
  return [...ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)];
}
function luminance([r, g, b]) {
  const lin = c => (c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

add_task(async function mini_chrome_follows_light_and_dark() {
  for (const dark of [0, 1]) {
    await SpecialPowers.pushPrefEnv({ set: [["ui.systemUsesDarkTheme", dark]] });
    const win = WhimsyQuickWindow.open("https://example.com/", { opener: window });
    try {
      await readyMini(win);
      const bar = win.document.getElementById("whimsy-quick-window-bar");
      const style = win.getComputedStyle(bar);
      const frame = resolvedRGB(win, style.backgroundColor);
      const text = resolvedRGB(win, style.color);
      // Resolve the pressed token on an element (it uses light-dark()).
      const probe = win.document.createXULElement("box");
      probe.style.background = "var(--whimsy-mini-fill-active)";
      bar.append(probe);
      const active = resolvedRGB(win, win.getComputedStyle(probe).backgroundColor);
      probe.remove();
      const scheme = dark ? "dark" : "light";
      is(luminance(frame) > 0.4, !dark, `Mini's frame is ${scheme} in ${scheme} mode`);
      Assert.greaterOrEqual(contrast(frame, text), 4.5, `Bar text is readable in ${scheme} mode`);
      Assert.greater(contrast(frame, active), 1.15, `Pressed fill stands off the frame in ${scheme} mode`);
    } finally {
      await BrowserTestUtils.closeWindow(win);
      await SpecialPowers.popPrefEnv();
    }
  }
});

// wave5/uxfix: Mini opens like Little Arc: quickly (wave6/parity measured
// ~90ms), no bounce; reduced motion opens it still.
add_task(async function mini_open_motion_matches_arc() {
  for (const reduce of [0, 1]) {
    await SpecialPowers.pushPrefEnv({ set: [["ui.prefersReducedMotion", reduce]] });
    const win = WhimsyQuickWindow.open("https://example.com/", { opener: window });
    try {
      await readyMini(win);
      const style = win.getComputedStyle(win.document.getElementById("browser"));
      if (reduce) {
        is(style.animationName, "none", "Reduced motion: no opening animation");
      } else {
        is(style.animationName, "whimsy-mini-open", "Mini animates open");
        Assert.lessOrEqual(parseFloat(style.animationDuration), 0.16, "...in under 160ms");
        ok(!/1\.\d+,\s*0?\.\d+,\s*0?\.\d+\)$/.test(style.animationTimingFunction) &&
          !style.animationTimingFunction.includes("1.27"), "...without overshoot");
      }
    } finally {
      await BrowserTestUtils.closeWindow(win);
      await SpecialPowers.popPrefEnv();
    }
  }
});

// wave6/parity: Little Arc's measured motion: ~90 ms grow with no overshoot,
// ~100 ms fade on close.
add_task(async function test_mini_motion_tokens_and_fade() {
  const win = WhimsyQuickWindow.open("https://example.com/", { opener: window });
  await WhimsyQuickWindow.whenReady(win);
  const root = win.document.documentElement;
  const style = win.getComputedStyle(root);
  is(style.getPropertyValue("--whimsy-mini-open-duration").trim(), "90ms", "Opens in ~90 ms");
  is(style.getPropertyValue("--whimsy-mini-close-duration").trim(), "100ms", "Closes in ~100 ms");
  ok(!/1\.[0-9]/.test(style.getPropertyValue("--whimsy-mini-ease-out").split(",")[1] ?? ""), "Ease-out without overshoot");
  const closed = BrowserTestUtils.domWindowClosed(win);
  win.close();
  ok(win.closed || root.hasAttribute("whimsy-mini-closing"), "Closing fades first (or closes at once with reduced motion)");
  await closed;
});

// fix7: icon-only buttons centre their glyph (an empty flex label used to
// push it left), and Zen's toolbar re-layout can't take Extensions out of
// the address strip.
add_task(async function test_mini_icons_are_centred_and_extensions_stay() {
  const win = WhimsyQuickWindow.open("https://example.com/", { opener: window });
  try {
    await readyMini(win);
    const doc = win.document;
    for (const id of ["whimsy-quick-window-copy-link", "whimsy-quick-window-choose-space", "whimsy-quick-window-back"]) {
      const button = doc.getElementById(id);
      const icon = button.querySelector(".toolbarbutton-icon").getBoundingClientRect();
      const box = button.getBoundingClientRect();
      Assert.lessOrEqual(Math.abs((icon.left + icon.right) / 2 - (box.left + box.right) / 2), 0.5, `${id}: icon centred horizontally`);
      Assert.lessOrEqual(Math.abs((icon.top + icon.bottom) / 2 - (box.top + box.bottom) / 2), 0.5, `${id}: icon centred vertically`);
    }
    const extensions = doc.getElementById("unified-extensions-button");
    doc.getElementById("navigator-toolbox").append(extensions);
    const field = doc.getElementById("whimsy-quick-window-address-field");
    await TestUtils.waitForCondition(() => extensions.parentNode == field, "Extensions returns to the strip");
    is(extensions.nextElementSibling?.id, "whimsy-quick-window-copy-link", "...before Copy Link");
  } finally {
    await BrowserTestUtils.closeWindow(win);
  }
});

// fix7: the traffic lights stay painted whatever Zen's mono-window-controls
// hover tracking says (opacity 0 drops their theme geometry, and Cocoa then
// hides the native buttons, which read as a flicker).
add_task(async function test_mini_traffic_lights_never_hide() {
  await SpecialPowers.pushPrefEnv({ set: [["zen.widget.mac.mono-window-controls", true]] });
  const win = WhimsyQuickWindow.open("https://example.com/", { opener: window });
  try {
    await readyMini(win);
    const container = win.document.querySelector("#whimsy-quick-window-bar > .titlebar-buttonbox-container");
    ok(container, "The window controls are in Mini's bar");
    const box = container.querySelector(".titlebar-buttonbox");
    for (const hover of [false, true, false]) {
      if (hover) {
        container.setAttribute("zen-has-hover", "true");
      } else {
        container.removeAttribute("zen-has-hover");
      }
      is(win.getComputedStyle(box).opacity, "1", `Buttons stay painted (hover: ${hover})`);
    }
    is(win.getComputedStyle(container).backgroundImage, "none", "No stand-in dots under them");
    win.document.documentElement.setAttribute("zen-window-buttons-reversed", "true");
    is(win.getComputedStyle(container).marginLeft, "0px", "Zen's collapsed-sidebar margin can't push them off");
    win.document.documentElement.removeAttribute("zen-window-buttons-reversed");
  } finally {
    await BrowserTestUtils.closeWindow(win);
    await SpecialPowers.popPrefEnv();
  }
});

// wave7: Cmd+Opt+N first shows only a floating command-bar panel at the
// screen's top-right (Arc: ~510x335pt). Return materialises the full window,
// right-anchored, with the space's gradient standing in until the page loads.
add_task(async function test_shortcut_opens_a_bar_only_panel_that_materialises() {
  const win = WhimsyQuickWindow.open(null, { opener: window });
  try {
    await readyMini(win);
    await SimpleTest.promiseFocus(win);
    const root = win.document.documentElement;
    ok(root.hasAttribute("whimsy-mini-bar-only"), "The shortcut opens the bar-only panel");
    ok(win.innerWidth <= 520 && win.innerHeight <= 345, `A panel-sized window (${win.innerWidth}x${win.innerHeight})`);
    const screen = win.screen;
    ok(win.screenX + win.outerWidth >= screen.availLeft + screen.availWidth - 24, "...at the screen's right edge");
    ok(win.screenY <= screen.availTop + 24, "...and its top");
    is(win.getComputedStyle(win.document.getElementById("whimsy-quick-window-bar")).display, "none",
      "No Mini bar in the panel");
    is(win.getComputedStyle(win.document.getElementById("tabbrowser-tabbox")).visibility, "hidden",
      "No page in the panel");
    await TestUtils.waitForCondition(() => win.gURLBar.focused, "Its command bar takes focus");
    const right = win.screenX + win.outerWidth;

    const placeholder = TestUtils.waitForCondition(
      () => root.hasAttribute("whimsy-mini-placeholder"), "The space gradient stands in for the page");
    EventUtils.sendString("https://example.com/", win);
    EventUtils.synthesizeKey("KEY_Enter", {}, win);
    await placeholder;
    ok(!root.hasAttribute("whimsy-mini-bar-only"), "Return materialises the window");
    ok(!win._whimsyMiniBarOnly, "...for good");
    is(win.getComputedStyle(win.document.getElementById("whimsy-quick-window-bar")).display, "flex",
      "The Mini bar is back");
    await TestUtils.waitForCondition(() => win.innerWidth > 520 && win.innerHeight > 345,
      "The window grows to Mini's full size");
    ok(Math.abs(win.screenX + win.outerWidth - right) <= 24 ||
      win.screenX == screen.availLeft, "...still anchored at the panel's right edge");
    await TestUtils.waitForCondition(
      () => win.gBrowser.selectedBrowser.currentURI.spec == "https://example.com/", "The page loads");
    await TestUtils.waitForCondition(() => !root.hasAttribute("whimsy-mini-placeholder"),
      "The placeholder gives way to the loaded page");
    ok(WhimsyQuickWindow.savedSize().width > 520, "The panel's size was never saved as Mini's");
  } finally {
    await BrowserTestUtils.closeWindow(win);
  }
});

add_task(async function test_escape_dismisses_the_bar_only_panel() {
  const win = WhimsyQuickWindow.open(null, { opener: window });
  await readyMini(win);
  await SimpleTest.promiseFocus(win);
  await TestUtils.waitForCondition(() => win.gURLBar.focused, "The panel's command bar has focus");
  const closed = BrowserTestUtils.domWindowClosed(win);
  EventUtils.synthesizeKey("KEY_Escape", {}, win);
  await closed;
  ok(win.closed, "Esc dismisses the panel: the command bar is all it has");
});

add_task(async function test_open_in_space_waits_for_a_page() {
  const win = WhimsyQuickWindow.open(null, { opener: window });
  try {
    await readyMini(win);
    await SimpleTest.promiseFocus(win);
    const tabCountBefore = gBrowser.tabs.length;
    EventUtils.synthesizeKey("o", { accelKey: true }, win);
    await new Promise(resolve => win.setTimeout(resolve, 100));
    ok(!win.closed, "Cmd+O in the bar-only panel has nothing to open");
    is(gBrowser.tabs.length, tabCountBefore, "...so no blank tab lands in a space");
  } finally {
    await BrowserTestUtils.closeWindow(win);
  }
});
