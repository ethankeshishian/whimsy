/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Form protection, W13-R1 (design: whimsy-handoff/wave13/r1-forms-design.md).
// Every test drives the real path: real key events into a real page, pages
// that fill themselves by script, an editor that autosaves to a .sjs, a
// site with its own beforeunload, the unload dialog, pinned ⌘W, and the
// refill offer after a reload.

const { WhimsyFormProtection } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyFormProtection.sys.mjs"
);
const { WhimsyArchive } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyArchive.sys.mjs");
const { WhimsyToast } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyToast.sys.mjs");
const { TabStateCache } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sessionstore/TabStateCache.sys.mjs"
);
const { TabStateFlusher } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sessionstore/TabStateFlusher.sys.mjs"
);

const ROOT = getRootDirectory(gTestPath).replace("chrome://mochitests/content/", "http://mochi.test:8888/");
const FORM_PAGE = ROOT + "whimsy_email_form.html";
const R1_PAGE = ROOT + "whimsy_form_r1.html";
const SCRIPT_PAGE = ROOT + "whimsy_script_form.html";
const AUTOSAVE_PAGE = ROOT + "whimsy_form_autosave.html";
const GUARDED_PAGE = ROOT + "whimsy_form_beforeunload.html";
const SAVE_URL = ROOT + "whimsy_form_save.sjs";
const PANEL_ID = "whimsy-form-unload";

const typed = tab => tab.hasAttribute("whimsy-form-typed");

async function typeInto(browser, id, text) {
  await SpecialPowers.spawn(browser, [id], fieldId => content.document.getElementById(fieldId).focus());
  for (const key of text) {
    await BrowserTestUtils.synthesizeKey(key, {}, browser);
  }
}

// Asks the page itself; the actor's earlier reports reach the parent first.
function askPage(browser) {
  return browser.browsingContext.currentWindowGlobal.getActor("WhimsyFormProtection").sendQuery("Whimsy:FormIsDirty");
}

function waitForAsk() {
  return BrowserTestUtils.waitForEvent(document, "popupshown", true, e => e.target.id == PANEL_ID).then(e => e.target);
}

function countAsks() {
  let count = 0;
  const onShown = e => {
    if (e.target.id == PANEL_ID) {
      count++;
      // Never leave a test hanging on a dialog it didn't expect.
      e.target.hidePopup();
    }
  };
  document.addEventListener("popupshown", onShown, true);
  return {
    get count() {
      return count;
    },
    stop() {
      document.removeEventListener("popupshown", onShown, true);
    },
  };
}

async function answer(panel, id) {
  const hidden = BrowserTestUtils.waitForEvent(panel, "popuphidden");
  panel.querySelector(`#${id}`).doCommand();
  await hidden;
}

async function savesSoFar() {
  return Number(await (await fetch(SAVE_URL + "?count")).text());
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["whimsy.feature.form-protection", true],
      ["whimsy.feature.auto-archive-tabs", true],
      ["whimsy.tabs.archive.idle-after", "12h"],
      ["zen.pinned-tab-manager.close-shortcut-behavior", "reset-unload-switch"],
    ],
  });
});

// Protect This Tab: auto-archive exemption and a lock, never the form
// dialog (old code asked "You started a form…" for it).
add_task(async function test_manual_protection() {
  const cmd = document.getElementById(WhimsyFormProtection.COMMAND_ID);
  ok(cmd, "Protect command is registered");
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, FORM_PAGE);
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?other");
  try {
    gBrowser.selectedTab = tab;
    cmd.doCommand();
    ok(tab.hasAttribute("whimsy-form-protected"), "Protected by hand");
    ok(WhimsyArchive.isSweepExempt(tab), "and exempt from the sweep");
    const marker = tab.querySelector(".whimsy-tab-form-marker");
    is(marker?.getAttribute("kind"), "lock", "Its lock shows");
    await document.l10n.translateFragment(marker);
    is(marker.getAttribute("aria-label"), "Protected tab", "labelled");

    gBrowser.selectedTab = other;
    const asks = countAsks();
    const result = await gBrowser.explicitUnloadTabs([tab]);
    asks.stop();
    is(asks.count, 0, "Unloading a tab protected by hand doesn't ask about a form");
    ok(result, "and unloads");
    tab._whimsyFormManual = false;
    WhimsyFormProtection.refreshTab(tab);
  } finally {
    BrowserTestUtils.removeTab(tab);
    BrowserTestUtils.removeTab(other);
  }
});

// Review design-full-4 L5: the command bar says Protect or Stop Protecting.
add_task(async function test_command_variants() {
  const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");
  const action = id => globalActions.find(a => a.l10nId == id);
  await BrowserTestUtils.withNewTab(FORM_PAGE, async browser => {
    const tab = gBrowser.getTabForBrowser(browser);
    ok(action("whimsy-action-protect-form-on")?.isAvailable(window), "Offers Protect on an unprotected tab");
    ok(!action("whimsy-action-protect-form-off")?.isAvailable(window), "No Stop Protecting yet");
    document.getElementById(WhimsyFormProtection.COMMAND_ID).doCommand();
    ok(tab.hasAttribute("whimsy-form-protected"), "Protected");
    ok(action("whimsy-action-protect-form-off")?.isAvailable(window), "Stop Protecting is offered");
    // Protection by hand survives a navigation in the tab.
    BrowserTestUtils.startLoadingURIString(browser, FORM_PAGE + "?again");
    await BrowserTestUtils.browserLoaded(browser);
    ok(tab.hasAttribute("whimsy-form-protected"), "Still protected after navigating");
    document.getElementById(WhimsyFormProtection.COMMAND_ID).doCommand();
    ok(!tab.hasAttribute("whimsy-form-protected"), "Stop Protecting clears it");
  });
});

// Real typing marks the tab; going back to what the field held before
// (here a draft the page restored by script) clears it. Old code compared
// with the HTML default ("") and stayed marked.
add_task(async function test_typing_and_reverting() {
  await BrowserTestUtils.withNewTab(R1_PAGE, async browser => {
    const tab = gBrowser.getTabForBrowser(browser);
    await SpecialPowers.spawn(browser, [], () =>
      ContentTaskUtils.waitForCondition(() => content.document.body.dataset.ready == "true", "Draft restored"));
    await typeInto(browser, "draft", "x");
    await TestUtils.waitForCondition(() => typed(tab), "Typing marks the tab");
    ok(tab.hasAttribute("whimsy-form-protected"), "protected");
    ok(tab.undiscardable, "and never discarded automatically");
    const tip = gBrowser.getTabTooltip(tab, true);
    ok(tip.includes("unsent form text"), "The tooltip says why");

    await BrowserTestUtils.synthesizeKey("KEY_Backspace", {}, browser);
    is(await askPage(browser), false, "Back to the restored draft: nothing unsaved");
    await TestUtils.waitForCondition(() => !typed(tab), "The mark goes");
    ok(!tab.hasAttribute("whimsy-form-protected"), "not protected");
    ok(!tab.undiscardable, "discardable again");
  });
});

// F33: a page that fills its own fields and editor is not a form in
// progress, even once Firefox's session copy of the form has landed
// (old code counted that copy as typing), and pinned ⌘W doesn't ask.
add_task(async function test_site_filled_fields_never_count() {
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?other");
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, SCRIPT_PAGE);
  const browser = tab.linkedBrowser;
  try {
    await SpecialPowers.spawn(browser, [], () =>
      ContentTaskUtils.waitForCondition(() => content.document.body.dataset.filled == "true", "The page filled itself"));
    await TabStateFlusher.flush(browser);
    ok(TabStateCache.get(browser.permanentKey)?.formdata, "Firefox's session has the page's own values");
    is(await askPage(browser), false, "The page says nothing is unsaved");
    ok(!typed(tab) && !WhimsyFormProtection.isFormProtected(tab), "The tab isn't marked or protected");

    gBrowser.pinTab(tab);
    gBrowser.selectedTab = tab;
    const asks = countAsks();
    EventUtils.synthesizeKey("w", { accelKey: true }, window);
    await TestUtils.waitForCondition(() => tab.hasAttribute("pending"), "Pinned ⌘W unloads it");
    asks.stop();
    is(asks.count, 0, "without asking");
  } finally {
    BrowserTestUtils.removeTab(tab);
    BrowserTestUtils.removeTab(other);
  }
});

// Search boxes never count (old code counted type=search and name=q).
add_task(async function test_search_fields_never_count() {
  await BrowserTestUtils.withNewTab(R1_PAGE, async browser => {
    const tab = gBrowser.getTabForBrowser(browser);
    for (const id of ["search", "q", "site-find"]) {
      await typeInto(browser, id, "cats");
      is(await askPage(browser), false, `#${id} is a search box`);
    }
    ok(!typed(tab), "The tab isn't marked");
  });
});

// Typing into a contenteditable editor counts; deleting it all clears it.
add_task(async function test_contenteditable_typing_counts() {
  await BrowserTestUtils.withNewTab(R1_PAGE, async browser => {
    const tab = gBrowser.getTabForBrowser(browser);
    await typeInto(browser, "editor", "Dear team");
    await TestUtils.waitForCondition(() => typed(tab), "Typing into an editor marks the tab");
    for (let i = 0; i < "Dear team".length; i++) {
      await BrowserTestUtils.synthesizeKey("KEY_Backspace", {}, browser);
    }
    await TestUtils.waitForCondition(async () => !(await askPage(browser)), "Deleted again: nothing unsaved");
    await TestUtils.waitForCondition(() => !typed(tab), "The mark goes");
  });
});

// An editor that saves as you type (Sheets, Docs, beehiiv): its own POST
// after the edit is the save. Old code kept the tab marked forever.
add_task(async function test_autosave_clears() {
  await fetch(SAVE_URL + "?reset");
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?other");
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, AUTOSAVE_PAGE);
  const browser = tab.linkedBrowser;
  try {
    await typeInto(browser, "body", "Weekly letter");
    await TestUtils.waitForCondition(async () => (await savesSoFar()) >= 1, "The page saved to its server");
    await TestUtils.waitForCondition(() => !typed(tab), "The save clears the mark");
    is(await askPage(browser), false, "Nothing unsaved");

    gBrowser.selectedTab = other;
    const asks = countAsks();
    ok(await gBrowser.explicitUnloadTabs([tab]), "Unloads");
    asks.stop();
    is(asks.count, 0, "without asking");
  } finally {
    BrowserTestUtils.removeTab(tab);
    BrowserTestUtils.removeTab(other);
  }
});

// A submitted form is saved. Old code kept the tab marked.
add_task(async function test_submit_clears() {
  await BrowserTestUtils.withNewTab(R1_PAGE, async browser => {
    const tab = gBrowser.getTabForBrowser(browser);
    await typeInto(browser, "name", "Ada");
    await TestUtils.waitForCondition(() => typed(tab), "Typed");
    await BrowserTestUtils.synthesizeKey("KEY_Enter", {}, browser);
    await TestUtils.waitForCondition(() => !typed(tab), "Submitting clears the mark");
    ok(!WhimsyFormProtection.snapshotFor(browser, R1_PAGE), "and leaves nothing to offer back");
  });
});

// A site with its own beforeunload decides for itself: no Whimsy dialog,
// so never two. Old code asked first, then Firefox ran the site's guard.
add_task(async function test_site_beforeunload_owns_the_decision() {
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?other");
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, GUARDED_PAGE);
  try {
    await typeInto(tab.linkedBrowser, "name", "Ada");
    await TestUtils.waitForCondition(() => typed(tab), "Typed (the marker still shows)");
    ok(tab.linkedBrowser.hasBeforeUnload, "The page has its own guard");
    gBrowser.selectedTab = other;
    const asks = countAsks();
    ok(await gBrowser.explicitUnloadTabs([tab]), "Unloads (the site didn't object)");
    asks.stop();
    is(asks.count, 0, "Whimsy didn't ask");
  } finally {
    BrowserTestUtils.removeTab(tab);
    BrowserTestUtils.removeTab(other);
  }
});

// The dialog: everything inside the panel, one choice per row, in the F08
// order; Cancel has focus; Esc cancels the whole unload (old code unloaded
// the other tabs anyway and its buttons overflowed the 300px panel).
add_task(async function test_unload_dialog_layout_and_cancel() {
  const formTab = await BrowserTestUtils.openNewForegroundTab(gBrowser, FORM_PAGE);
  const plainTab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?plain");
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.org/");
  try {
    gBrowser.selectedTab = formTab;
    await typeInto(formTab.linkedBrowser, "name", "Ada Lovelace");
    await TestUtils.waitForCondition(() => typed(formTab), "Typed");
    gBrowser.selectedTab = other;

    const shown = waitForAsk();
    const unloading = gBrowser.explicitUnloadTabs([formTab, plainTab]);
    const panel = await shown;
    await document.l10n.translateFragment(panel);
    is(panel.querySelector(".whimsy-surface-title").textContent, "Unload this tab?", "Asks about the tab with the form");
    ok(panel.querySelector(".whimsy-form-unload-body b"), "naming the site");
    const buttons = [...panel.querySelectorAll(".whimsy-surface-footer button")];
    is(buttons.map(b => b.label).join("|"), "Unload Without Saving|Save and Unload|Cancel", "The three choices, in order");
    await TestUtils.waitForCondition(() => document.activeElement?.id == "whimsy-form-unload-keep", "Cancel has the keyboard");

    const box = panel.getBoundingClientRect();
    const inside = el => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.left >= box.left - 0.5 && r.right <= box.right + 0.5 && r.bottom <= box.bottom + 0.5;
    };
    for (const el of [panel.querySelector(".whimsy-surface-title"), panel.querySelector(".whimsy-form-unload-body"), ...buttons]) {
      ok(inside(el), `${el.id || el.className} sits inside the panel`);
    }
    const body = panel.querySelector(".whimsy-form-unload-body");
    ok(body.scrollWidth <= body.clientWidth + 1, "The body wraps instead of running out");
    for (let i = 1; i < buttons.length; i++) {
      ok(buttons[i - 1].getBoundingClientRect().bottom <= buttons[i].getBoundingClientRect().top + 0.5,
        `${buttons[i - 1].label} and ${buttons[i].label} don't overlap`);
    }

    EventUtils.synthesizeKey("KEY_Escape", {}, window);
    is(await unloading, false, "Esc: the unload reports it didn't happen");
    ok(formTab.linkedPanel && !formTab.hasAttribute("pending"), "The form tab is still loaded");
    ok(plainTab.linkedPanel && !plainTab.hasAttribute("pending"), "and so is the other tab: Cancel cancels the whole unload");
    is(await SpecialPowers.spawn(formTab.linkedBrowser, [], () => content.document.getElementById("name").value),
      "Ada Lovelace", "What was typed is still there");
  } finally {
    for (const tab of [formTab, plainTab, other]) {
      BrowserTestUtils.removeTab(tab);
    }
  }
});

// Unload Without Saving drops what was typed, Firefox's session copy too
// (old code left that, so the tab filled itself back in); Save and Unload
// keeps it.
add_task(async function test_unload_with_and_without_saving() {
  for (const save of [false, true]) {
    const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, FORM_PAGE);
    const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.org/?other");
    const browser = tab.linkedBrowser;
    try {
      gBrowser.selectedTab = tab;
      await typeInto(browser, "name", "Ada");
      await TestUtils.waitForCondition(() => typed(tab), "Typed");
      await TabStateFlusher.flush(browser);
      ok(TabStateCache.get(browser.permanentKey)?.formdata, "Firefox's session has the typed text");
      gBrowser.selectedTab = other;
      const shown = waitForAsk();
      const unloading = gBrowser.explicitUnloadTabs([tab]);
      await answer(await shown, save ? "whimsy-form-unload-accept" : "whimsy-form-unload-discard");
      ok(await unloading, "Unloaded");
      ok(tab.hasAttribute("pending"), "The tab is unloaded");
      // Let the page's last words (a pagehide snapshot) arrive, if any.
      await new Promise(resolve => setTimeout(resolve, 300));
      if (save) {
        ok(WhimsyFormProtection.snapshotFor(browser, FORM_PAGE), "Save and Unload keeps what was typed");
      } else {
        ok(!WhimsyFormProtection.snapshotFor(browser, FORM_PAGE), "Without saving: Whimsy's copy is gone");
        ok(!TabStateCache.get(browser.permanentKey)?.formdata, "and Firefox's");
        await BrowserTestUtils.switchTab(gBrowser, tab);
        await TestUtils.waitForCondition(() => !tab.hasAttribute("pending") && !tab.hasAttribute("busy"), "Back");
        is(await SpecialPowers.spawn(browser, [], () => content.document.getElementById("name").value), "",
          "The form comes back empty");
      }
    } finally {
      BrowserTestUtils.removeTab(other);
      BrowserTestUtils.removeTab(tab);
    }
  }
});

// Pinned ⌘W (Zen resets and unloads it): ask BEFORE Zen moves to another
// tab or unloads; Cancel leaves it exactly as it was. Old code switched
// away first and asked afterwards.
add_task(async function test_pinned_cmd_w_asks_first() {
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?other");
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, FORM_PAGE);
  gBrowser.pinTab(tab);
  const browser = tab.linkedBrowser;
  try {
    await typeInto(browser, "name", "Ada");
    await TestUtils.waitForCondition(() => typed(tab), "Typed");

    let shown = waitForAsk();
    EventUtils.synthesizeKey("w", { accelKey: true }, window);
    let panel = await shown;
    is(gBrowser.selectedTab, tab, "While asking, the tab is still the selected one");
    ok(!tab.hasAttribute("pending"), "and loaded");
    await answer(panel, "whimsy-form-unload-keep");
    await new Promise(resolve => setTimeout(resolve, 500));
    is(gBrowser.selectedTab, tab, "Cancel: still selected");
    ok(!tab.hasAttribute("pending"), "still loaded");
    is(await SpecialPowers.spawn(browser, [], () => content.document.getElementById("name").value), "Ada",
      "and the answer is still there");

    shown = waitForAsk();
    EventUtils.synthesizeKey("w", { accelKey: true }, window);
    panel = await shown;
    await answer(panel, "whimsy-form-unload-accept");
    await TestUtils.waitForCondition(() => tab.hasAttribute("pending"), "Save and Unload: Zen unloads it");
    isnot(gBrowser.selectedTab, tab, "and moves on");
  } finally {
    BrowserTestUtils.removeTab(tab);
    BrowserTestUtils.removeTab(other);
  }
});

// Zen's "reset" behaviours navigate the pinned tab back without unloading:
// they ask too (old code never asked, and the form was gone).
add_task(async function test_pinned_reset_asks() {
  await SpecialPowers.pushPrefEnv({ set: [["zen.pinned-tab-manager.close-shortcut-behavior", "reset-switch"]] });
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?other");
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, FORM_PAGE);
  gBrowser.pinTab(tab);
  try {
    await typeInto(tab.linkedBrowser, "name", "Grace");
    await TestUtils.waitForCondition(() => typed(tab), "Typed");
    const shown = waitForAsk();
    EventUtils.synthesizeKey("w", { accelKey: true }, window);
    await answer(await shown, "whimsy-form-unload-keep");
    await new Promise(resolve => setTimeout(resolve, 500));
    is(gBrowser.selectedTab, tab, "Cancel: still selected");
    is(await SpecialPowers.spawn(tab.linkedBrowser, [], () => content.document.getElementById("name").value), "Grace",
      "not reset");
  } finally {
    BrowserTestUtils.removeTab(tab);
    BrowserTestUtils.removeTab(other);
    await SpecialPowers.popPrefEnv();
  }
});

// F29 (the user's pick B): an 11px pencil with no backing, inside the
// Essential's tile and at the end of a row, hidden while the row is hovered
// (the close button takes its place), and inside the tile in the collapsed
// sidebar. Old code drew a disc outside the tile's corner.
add_task(async function test_marker_inside_tile_and_row() {
  const essential = await BrowserTestUtils.openNewForegroundTab(gBrowser, FORM_PAGE);
  gZenPinnedTabManager.addToEssentials(essential);
  await TestUtils.waitForCondition(() => essential.hasAttribute("zen-essential"), "An Essential");
  const row = await BrowserTestUtils.openNewForegroundTab(gBrowser, FORM_PAGE + "?row");
  try {
    gBrowser.selectedTab = essential;
    await typeInto(essential.linkedBrowser, "name", "Ada");
    gBrowser.selectedTab = row;
    await typeInto(row.linkedBrowser, "name", "Ada");
    await TestUtils.waitForCondition(() => typed(essential) && typed(row), "Both typed");
    await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?away");
    const awayTab = gBrowser.selectedTab;
    EventUtils.synthesizeMouseAtCenter(document.getElementById("tabbrowser-tabpanels"), { type: "mousemove" });

    const marker = essential.querySelector(".whimsy-tab-form-marker");
    ok(marker?.checkVisibility(), "The Essential shows the marker");
    const m = marker.getBoundingClientRect();
    const tile = essential.querySelector(".tab-background").getBoundingClientRect();
    ok(m.left >= tile.left && m.right <= tile.right && m.top >= tile.top && m.bottom <= tile.bottom,
      `inside the tile (${JSON.stringify(m)} in ${JSON.stringify(tile)})`);
    is(marker.getAttribute("src"), "chrome://browser/content/whimsy/whimsy-form-pencil.svg", "a pencil");
    ok(Math.round(m.width) == 11 && Math.round(m.height) == 11, `11px (${m.width}x${m.height})`);
    ok(m.left - tile.left <= 8 && tile.bottom - m.bottom <= 8, "in the tile's bottom-start corner");
    is(getComputedStyle(essential.querySelector(".tab-icon-stack"), "::before").content, "none", "no disc on the icon");

    const rowMarker = row.querySelector(".whimsy-tab-form-marker");
    ok(rowMarker?.checkVisibility(), "The row shows the marker");
    is(rowMarker.previousElementSibling, row.querySelector(".tab-label-container"), "after the title");
    const r = rowMarker.getBoundingClientRect();
    const rowBox = row.getBoundingClientRect();
    ok(r.left >= rowBox.left && r.right <= rowBox.right, "inside the row");
    ok(rowBox.right - r.right <= 12, "at the end of the row");

    // Hovered, the row's close button takes the marker's place.
    EventUtils.synthesizeMouseAtCenter(row, { type: "mousemove" });
    await TestUtils.waitForCondition(() => row.matches(":hover"), "Row hovered");
    ok(!rowMarker.checkVisibility(), "Hovered: no marker on the row");
    EventUtils.synthesizeMouseAtCenter(document.getElementById("tabbrowser-tabpanels"), { type: "mousemove" });
    await TestUtils.waitForCondition(() => rowMarker.checkVisibility(), "Away: the marker is back");

    // The collapsed sidebar: the row is a tile, the pencil inside it.
    await SpecialPowers.pushPrefEnv({ set: [["zen.view.sidebar-expanded", false]] });
    try {
      await TestUtils.waitForCondition(() => document.documentElement.getAttribute("zen-sidebar-expanded") != "true", "Collapsed");
      const insideTile = (tab, pencil) => {
        const box = tab.querySelector(".tab-background").getBoundingClientRect();
        const pen = pencil.getBoundingClientRect();
        return pencil.checkVisibility() && pen.left >= box.left && pen.right <= box.right && pen.top >= box.top && pen.bottom <= box.bottom;
      };
      await TestUtils.waitForCondition(() => insideTile(row, rowMarker), "Collapsed: the row's pencil is inside its tile");
      ok(insideTile(essential, marker), "and the Essential's inside its (narrower) tile");
    } finally {
      await SpecialPowers.popPrefEnv();
    }
    BrowserTestUtils.removeTab(awayTab);
  } finally {
    BrowserTestUtils.removeTab(row);
    BrowserTestUtils.removeTab(essential);
  }
});

// W10-25: type, reload, and a toast asks to fill the answers back in; Fill
// In fills only empty fields, never the password.
add_task(async function test_refill_after_reload_asks_first() {
  await BrowserTestUtils.withNewTab(FORM_PAGE, async browser => {
    const tab = gBrowser.getTabForBrowser(browser);
    await typeInto(browser, "name", "Ada Lovelace");
    await typeInto(browser, "password", "hunter2");
    await TestUtils.waitForCondition(() => typed(tab), "Typed");

    const loaded = BrowserTestUtils.browserLoaded(browser);
    browser.reloadWithFlags(Ci.nsIWebNavigation.LOAD_FLAGS_BYPASS_CACHE);
    await loaded;
    await SpecialPowers.spawn(browser, [], () => {
      // A reload that bypasses the cache starts with empty fields.
      for (const el of content.document.querySelectorAll("input")) {
        el.value = "";
      }
    });
    const toast = await TestUtils.waitForCondition(() => {
      const t = WhimsyToast.current(window);
      return t?._messageId == "whimsy-form-refill-ask" && t;
    }, "A toast asks to fill the answers back in");
    await document.l10n.translateFragment(toast);
    ok(/^Fill in \d+ answers? you typed before\?$/.test(toast.querySelector(".whimsy-toast-message").textContent),
      toast.querySelector(".whimsy-toast-message").textContent);
    is(await SpecialPowers.spawn(browser, [], () => content.document.getElementById("name").value), "",
      "Nothing is filled before Fill In");
    toast.querySelector(".whimsy-toast-action").click();
    await TestUtils.waitForCondition(async () =>
      (await SpecialPowers.spawn(browser, [], () => content.document.getElementById("name").value)) == "Ada Lovelace",
    "Fill In fills the answer back in");
    is(await SpecialPowers.spawn(browser, [], () => content.document.getElementById("password").value), "",
      "never the password");
    await TestUtils.waitForCondition(() => typed(tab), "What was filled back is unsaved again");
  });
});

// F08: most sites build their form after the page loads; the refill offer
// waits for it.
add_task(async function test_refill_offered_for_late_form() {
  const PAGE = ROOT + "whimsy_late_form.html";
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    const tab = gBrowser.getTabForBrowser(browser);
    await SpecialPowers.spawn(browser, [], () =>
      ContentTaskUtils.waitForCondition(() => !!content.document.getElementById("name"), "The form appeared"));
    await typeInto(browser, "name", "Grace");
    await TestUtils.waitForCondition(() => typed(tab), "Typed");
    const loaded = BrowserTestUtils.browserLoaded(browser);
    browser.reload();
    await loaded;
    const toast = await TestUtils.waitForCondition(() => {
      const t = WhimsyToast.current(window);
      return t?._messageId == "whimsy-form-refill-ask" && t;
    }, "Once the form appears, a toast asks to fill the answer back in");
    toast.querySelector(".whimsy-toast-action").click();
    await TestUtils.waitForCondition(async () =>
      (await SpecialPowers.spawn(browser, [], () => content.document.getElementById("name").value)) == "Grace",
    "Fill In fills it back in");
  });
});

// W10-25: a private tab's snapshot stays in memory, never in the session.
add_task(async function test_private_snapshot_stays_in_memory() {
  const { WhimsyPrivate } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPrivate.sys.mjs");
  const { SessionStore } = ChromeUtils.importESModule("moz-src:///browser/components/sessionstore/SessionStore.sys.mjs");
  const tab = WhimsyPrivate.openPrivateTab(window, { url: FORM_PAGE, force: true });
  await TestUtils.waitForCondition(() => tab.linkedBrowser.currentURI?.spec == FORM_PAGE && !tab.hasAttribute("busy"),
    "The private tab loaded");
  try {
    ok(WhimsyFormProtection.storeSnapshot(tab.linkedBrowser, FORM_PAGE, { id: { name: "Private Person" } }), "Stored");
    ok(WhimsyFormProtection.snapshotFor(tab.linkedBrowser, FORM_PAGE + "#x"), "Found again for the same page (ignoring the hash)");
    is(SessionStore.getCustomTabValue(tab, "whimsy-formdata"), "", "never written to the session");
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
  await BrowserTestUtils.withNewTab(FORM_PAGE, async browser => {
    const normal = gBrowser.getTabForBrowser(browser);
    WhimsyFormProtection.storeSnapshot(browser, FORM_PAGE, { id: { name: "Saved" } });
    const stored = JSON.parse(SessionStore.getCustomTabValue(normal, "whimsy-formdata"));
    is(stored.data.id.name, "Saved", "kept in the session");
    ok(!WhimsyFormProtection.snapshotFor(browser, "https://example.org/other"), "not offered to another page");
    WhimsyFormProtection.clearSnapshot(browser);
    is(SessionStore.getCustomTabValue(normal, "whimsy-formdata"), "", "cleared");
  });
});

add_task(async function test_switch_off() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.form-protection", false]] });
  await BrowserTestUtils.withNewTab(FORM_PAGE, async browser => {
    const tab = gBrowser.getTabForBrowser(browser);
    await typeInto(browser, "name", "Ada");
    await new Promise(resolve => setTimeout(resolve, 300));
    ok(!WhimsyFormProtection.isFormProtected(tab), "With the switch off, nothing is protected");
    ok(!typed(tab), "or marked");
  });
  await SpecialPowers.popPrefEnv();
});
