/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { WhimsyFaviconHome } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyFaviconHome.sys.mjs"
);
const HOME = "https://example.com/";
const PAGE = HOME + "?favicon-home-test";

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [
    ["whimsy.feature.favicon-home", true],
    ["zen.view.sidebar-expanded", true],
    ["zen.tabs.rename-tabs", true],
  ] });
  await gZenWorkspaces.promiseInitialized;
  await TestUtils.waitForCondition(() => WhimsyFaviconHome.expanded(window), "Expanded sidebar");
});

// Each task owns all tabs it creates, including native pinned-reset extras.
async function withTabs(task) {
  const before = new Set(gBrowser.tabs);
  try {
    await task();
  } finally {
    for (const tab of gBrowser.tabs.filter(t => !before.has(t))) {
      if (tab.isConnected && !tab.closing) {
        tab.removeAttribute("zen-essential");
        tab.removeAttribute("zen-glance-tab");
        if (tab.pinned) {
          gBrowser.unpinTab(tab);
        }
        await BrowserTestUtils.removeTab(tab);
      }
    }
  }
}

async function openPage(url = PAGE, options = {}) {
  const tab = BrowserTestUtils.addTab(gBrowser, url, options);
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, url);
  return tab;
}

async function ready(tab) {
  await TestUtils.waitForCondition(() => tab.hasAttribute("whimsy-home-ready"), "Home affordance ready");
  tab.scrollIntoView();
  const button = tab.querySelector(".whimsy-home-button");
  await TestUtils.waitForCondition(() => button.getBoundingClientRect().width > 0, "Favicon laid out");
  return button;
}

add_task(async function background_click_and_back() {
  await withTabs(async () => {
    const tab = await openPage();
    const foreground = await openPage("https://example.org/");
    gBrowser.selectedTab = foreground;
    const button = await ready(tab);
    const loaded = BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, HOME);
    EventUtils.synthesizeMouseAtCenter(button, {});
    is(gBrowser.selectedTab, tab, "Click selects the background tab");
    await loaded;
    is(tab.linkedBrowser.currentURI.spec, HOME, "Clicked tab navigates to origin root");
    is(foreground.linkedBrowser.currentURI.spec, "https://example.org/", "Other tab untouched");
    await TestUtils.waitForCondition(() => tab.linkedBrowser.canGoBack, "History retained");
    // Back may restore from bfcache, which fires no load event.
    tab.linkedBrowser.goBack();
    await TestUtils.waitForCondition(
      () => tab.linkedBrowser.currentURI.spec == PAGE, "Back returns to the page");
    await ready(tab);
  });
});

add_task(async function root_nonweb_and_exclusions() {
  await withTabs(async () => {
    const root = await openPage(HOME);
    const blank = BrowserTestUtils.addTab(gBrowser, "about:blank");
    WhimsyFaviconHome.refresh(window, blank);
    ok(!root.hasAttribute("whimsy-home-ready"), "Origin root has no affordance");
    ok(!blank.hasAttribute("whimsy-home-ready"), "about:blank has no affordance");
    const rootIcon = root.querySelector(".tab-icon-image");
    EventUtils.synthesizeMouseAtCenter(rootIcon, {});
    is(root.linkedBrowser.currentURI.spec, HOME, "Normal root favicon click retains URL");
    const tab = await openPage();
    await ready(tab);
    for (const attr of ["zen-essential", "zen-glance-tab"]) {
      tab.setAttribute(attr, "true");
      await TestUtils.waitForCondition(() => !tab.hasAttribute("whimsy-home-ready"), `${attr} excluded`);
      EventUtils.synthesizeMouseAtCenter(tab.querySelector(".tab-icon-image"), {});
      is(tab.linkedBrowser.currentURI.spec, PAGE, "Excluded favicon does not navigate");
      tab.removeAttribute(attr);
      await ready(tab);
    }
    for (const url of [HOME + "#hash", HOME + "?query"]) {
      const away = await openPage(url);
      await ready(away);
      is(WhimsyFaviconHome.home(window, away), HOME, "Query and fragment roots are away from home");
    }
  });
});

add_task(async function pinned_reset_still_belongs_to_zen() {
  await withTabs(async () => {
    const tab = await openPage(PAGE);
    gBrowser.pinTab(tab);
    await TestUtils.waitForCondition(() => !!tab._zenPinnedInitialState?.entry, "Zen stored pinned URL");
    ok(!tab.hasAttribute("whimsy-home-ready"), "Unchanged pin has no home action");
    const changed = HOME + "?away-from-pin";
    const loaded = BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, changed);
    BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, changed);
    await loaded;
    await TestUtils.waitForCondition(() => tab.getAttribute("zen-pinned-changed") == "true", "Zen reset offered");
    ok(!tab.hasAttribute("whimsy-home-ready"), "Changed pin still excluded");
    EventUtils.synthesizeMouseAtCenter(tab.querySelector(".tab-reset-pin-button"), {});
    await TestUtils.waitForCondition(() => tab.linkedBrowser.currentURI.spec == PAGE, "Zen restores pinned URL, not origin root");
  });
});

add_task(async function accel_opens_adjacent_same_container() {
  // A container tab lives in a space bound to that container.
  const homeSpace = gZenWorkspaces.activeWorkspace;
  const space = await gZenWorkspaces.createAndSaveWorkspace("Favicon Home", undefined, true, 1);
  try {
    await gZenWorkspaces.changeWorkspaceWithID(space.uuid);
    await withTabs(async () => {
      const tab = await openPage(PAGE, { userContextId: 1 });
      const button = await ready(tab);
      const opened = BrowserTestUtils.waitForNewTab(gBrowser, HOME, true);
      EventUtils.synthesizeMouseAtCenter(button, { accelKey: true });
      const home = await opened;
      is(gBrowser.tabs.indexOf(home), gBrowser.tabs.indexOf(tab) + 1, "New home is adjacent");
      is(home.userContextId, tab.userContextId, "Container preserved");
      is(tab.linkedBrowser.currentURI.spec, PAGE, "Original navigation untouched");
      is(gBrowser.selectedTab, tab, "Clicked tab selected, like Zen reset");
    });
  } finally {
    await gZenWorkspaces.changeWorkspaceWithID(homeSpace.uuid);
    await gZenWorkspaces.removeWorkspace(space.uuid);
  }
});

add_task(async function drag_does_not_navigate_and_double_click_does_not_rename() {
  await withTabs(async () => {
    const tab = await openPage();
    gBrowser.selectedTab = tab;
    const button = await ready(tab);
    let started = false;
    const onStart = () => {
      started = true;
      ok(gBrowser.tabContainer.hasAttribute("whimsy-home-dragging"), "Hover disarmed while dragging");
    };
    button.addEventListener("dragstart", onStart, { once: true });
    try {
      await EventUtils.synthesizePlainDragAndDrop({
        // The tab is the drag source; start the press on its favicon.
        srcElement: tab,
        srcX: button.getBoundingClientRect().x + button.getBoundingClientRect().width / 2 - tab.getBoundingClientRect().x,
        srcY: button.getBoundingClientRect().y + button.getBoundingClientRect().height / 2 - tab.getBoundingClientRect().y,
        destElement: gBrowser.selectedBrowser, srcWindow: window, destWindow: window,
        logFunc: info,
      });
    } finally {
      button.removeEventListener("dragstart", onStart);
    }
    ok(started, "Native drag starts from the favicon");
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 1 }));
    is(tab.linkedBrowser.currentURI.spec, PAGE, "Drag and trailing click did not navigate");
    const loaded = BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, HOME);
    EventUtils.synthesizeMouseAtCenter(button, {});
    ok(gBrowser.tabContainer._blockDblClick, "Same double-click blocking flag as Zen reset");
    EventUtils.synthesizeMouseAtCenter(button, { clickCount: 2 });
    await loaded;
    ok(!document.getElementById("tab-label-input"), "Double click did not open tab rename");
  });
});

add_task(async function pref_off_removes_affordance_and_behavior() {
  await withTabs(async () => {
    const tab = await openPage();
    await ready(tab);
    await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.favicon-home", false]] });
    try {
      await TestUtils.waitForCondition(() => !tab.hasAttribute("whimsy-home-ready"), "Pref off clears attribute");
      ok(!tab.querySelector(".whimsy-home-button"), "Control removed");
      EventUtils.synthesizeMouseAtCenter(tab.querySelector(".tab-icon-image"), {});
      is(tab.linkedBrowser.currentURI.spec, PAGE, "Favicon click does not navigate with pref off");
    } finally {
      await SpecialPowers.popPrefEnv();
    }
  });
});

add_task(async function strings_and_accel_sublabel_resolve() {
  await withTabs(async () => {
    const tab = await openPage();
    const button = await ready(tab);
    const ids = ["whimsy-favicon-home-sublabel", "whimsy-favicon-home-sublabel-new-tab",
      "whimsy-favicon-home-button", "whimsy-favicon-home-setting",
      "whimsy-favicon-home-description", "whimsy-action-site-home"];
    const messages = await document.l10n.formatMessages(ids.map(id => ({ id })));
    for (let i = 0; i < ids.length; i++) {
      ok(messages[i] && (messages[i].value || messages[i].attributes?.length), `${ids[i]} resolves`);
    }
    EventUtils.synthesizeMouseAtCenter(button, { type: "mouseover" });
    const accelKey = Services.appinfo.OS == "Darwin" ? "KEY_Meta" : "KEY_Control";
    EventUtils.synthesizeKey(accelKey, { type: "keydown" });
    const label = tab.querySelector(".whimsy-home-sublabel");
    await TestUtils.waitForCondition(() => label.dataset.l10nId == ids[1], "Accel updates sublabel");
    EventUtils.synthesizeKey(accelKey, { type: "keyup" });
    await TestUtils.waitForCondition(() => label.dataset.l10nId == ids[0], "Release restores sublabel");
    await document.l10n.translateElements([label]);
    is(label.textContent, "Back to site home", "Translated native-style sublabel");
  });
});

add_task(async function multiselection_navigates_only_clicked_tab() {
  await withTabs(async () => {
    const tab = await openPage();
    const other = await openPage(HOME + "?other-selected");
    gBrowser.selectedTab = other;
    gBrowser.addToMultiSelectedTabs(other);
    gBrowser.addToMultiSelectedTabs(tab);
    const button = await ready(tab);
    const loaded = BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, HOME);
    EventUtils.synthesizeMouseAtCenter(button, {});
    await loaded;
    is(other.linkedBrowser.currentURI.spec, HOME + "?other-selected", "Other multiselected tab unchanged");
  });
});
