/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W9-03: Form protection: tabs with half-filled forms are exempt from
// Whimsy's archive sweep, and typed text is restored after reload/crash.
// W10-25: an in-progress form glyph only after typing; unloading a tab
// with a form asks first (Keep Loaded is the default); after a reload a
// toast offers to fill the answers back in (only on Fill In, only empty
// fields, never passwords).

const { WhimsyFormProtection } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyFormProtection.sys.mjs"
);
const { WhimsyArchive } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyArchive.sys.mjs"
);
const { TabStateCache } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sessionstore/TabStateCache.sys.mjs"
);

const ROOT = getRootDirectory(gTestPath).replace("chrome://mochitests/content/", "http://mochi.test:8888/");
const FORM_PAGE = ROOT + "whimsy_email_form.html";

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["whimsy.feature.form-protection", true],
      ["whimsy.feature.auto-archive-tabs", true],
      ["whimsy.tabs.archive.idle-after", "12h"],
    ],
  });
});

add_task(async function test_defaults_and_command() {
  ok(WhimsyFormProtection.enabled, "Form protection is enabled by default");
  const cmd = document.getElementById(WhimsyFormProtection.COMMAND_ID);
  ok(cmd, "Protect form command is registered");

  await BrowserTestUtils.withNewTab(FORM_PAGE, async browser => {
    const tab = gBrowser.getTabForBrowser(browser);
    ok(tab, "Tab exists");
    ok(!tab.hasAttribute("whimsy-form-protected"), "Tab has no form protection initially");

    // Command toggles protection manually
    cmd.doCommand();
    ok(tab.hasAttribute("whimsy-form-protected"), "Command marks tab protected");
    ok(WhimsyArchive.isSweepExempt(tab), "Protected tab is sweep exempt");

    cmd.doCommand();
    ok(!tab.hasAttribute("whimsy-form-protected"), "Command toggles protection off");
  });
});

// Review design-full-4 L5: the command bar says Protect or Stop Protecting.
add_task(async function test_command_variants() {
  const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");
  const action = id => globalActions.find(a => a.l10nId == id);
  await BrowserTestUtils.withNewTab(FORM_PAGE, async browser => {
    const tab = gBrowser.getTabForBrowser(browser);
    ok(action("whimsy-action-protect-form-on")?.isAvailable(window), "Offers Protect on an unprotected tab");
    ok(!action("whimsy-action-protect-form-off")?.isAvailable(window), "No Stop Protecting yet");
    ok(await document.l10n.formatValue("whimsy-action-protect-form-off"), "Stop Protecting is localized");

    document.getElementById(WhimsyFormProtection.COMMAND_ID).doCommand();
    ok(tab.hasAttribute("whimsy-form-protected"), "Protected");
    ok(!action("whimsy-action-protect-form-on")?.isAvailable(window), "Protect is no longer offered");
    ok(action("whimsy-action-protect-form-off")?.isAvailable(window), "Stop Protecting is offered");

    // Protection by hand survives a navigation in the tab.
    BrowserTestUtils.startLoadingURIString(browser, FORM_PAGE + "?again");
    await BrowserTestUtils.browserLoaded(browser);
    ok(tab.hasAttribute("whimsy-form-protected"), "Still protected after navigating");

    document.getElementById(WhimsyFormProtection.COMMAND_ID).doCommand();
    ok(!tab.hasAttribute("whimsy-form-protected"), "Stop Protecting clears it");
    ok(action("whimsy-action-protect-form-on")?.isAvailable(window), "Protect is offered again");
  });
});

// W10-25: the marker is an in-progress form glyph after the title, only
// once the person typed into a form (not for manual protection or an
// untouched form). Its meaning is in the tooltip, not a title the tab
// tooltip overrides (review design-full-4 M10).
add_task(async function test_indicator_and_tooltip() {
  await BrowserTestUtils.withNewTab(FORM_PAGE, async browser => {
    const tab = gBrowser.getTabForBrowser(browser);
    const stack = tab.querySelector(".tab-icon-stack");
    const afterBefore = getComputedStyle(stack, "::after").cssText || getComputedStyle(stack, "::after").content;
    const plain = gBrowser.getTabTooltip(tab, true);
    ok(!tab.querySelector(".whimsy-tab-form-marker")?.checkVisibility(), "No marker for an untouched form");

    WhimsyFormProtection.updateTabProtection(tab, true);
    ok(tab.hasAttribute("whimsy-form-protected"), "Typed text protects the tab");
    ok(tab.hasAttribute("whimsy-form-typed"), "and marks it typed");
    const marker = tab.querySelector(".whimsy-tab-form-marker");
    ok(marker?.checkVisibility(), "The in-progress form glyph shows");
    is(marker.getAttribute("src"), "chrome://browser/content/whimsy/whimsy-form-badge.svg", "a form with a pencil");
    is(marker.previousElementSibling, tab.querySelector(".tab-label-container"), "right after the title");
    is(getComputedStyle(stack, "::before").content, "none", "The old dot is gone");
    is(
      getComputedStyle(stack, "::after").cssText || getComputedStyle(stack, "::after").content,
      afterBefore,
      "::after (unread count, title-changed dot) is untouched"
    );
    ok(!tab.hasAttribute("title"), "No title attribute on the tab");
    const tip = gBrowser.getTabTooltip(tab, true);
    ok(tip.startsWith(plain), "The tab's tooltip keeps its own text");
    ok(tip.includes("Protected from auto-archive"), "and says why the tab is protected");
    ok(gBrowser.getTabTooltip(tab, false).includes("Protected from auto-archive"), "as does its accessible description");

    WhimsyFormProtection.updateTabProtection(tab, false);
    ok(!tab.hasAttribute("whimsy-form-protected"), "Clearing the form unprotects it");
    ok(!marker.checkVisibility(), "No glyph");
    is(gBrowser.getTabTooltip(tab, true), plain, "Tooltip back to normal");

    // Manual protection: protected, but nothing was typed, so no glyph.
    WhimsyFormProtection.toggleTabProtection(tab);
    ok(tab.hasAttribute("whimsy-form-protected") && !tab.hasAttribute("whimsy-form-typed"), "Manual: protected, not typed");
    ok(!marker.checkVisibility(), "and no glyph");
    WhimsyFormProtection.toggleTabProtection(tab);
  });
});

add_task(async function test_typing_protects_tab_and_exempts_from_sweep() {
  await BrowserTestUtils.withNewTab(FORM_PAGE, async browser => {
    const tab = gBrowser.getTabForBrowser(browser);

    // Type text into the input field (real key events).
    await SpecialPowers.spawn(browser, [], () => content.document.getElementById("name").focus());
    for (const key of "Whimsy User") {
      await BrowserTestUtils.synthesizeKey(key, {}, browser);
    }

    await TestUtils.waitForCondition(
      () => tab.hasAttribute("whimsy-form-protected"),
      "Tab becomes form-protected after typing"
    );
    ok(WhimsyFormProtection.isFormProtected(tab), "isFormProtected returns true");
    ok(WhimsyArchive.isSweepExempt(tab), "Tab with half-filled form is exempt from auto-archive sweep");

    // Now test that the sweep does not archive this tab even when past the idle threshold
    const twelveHoursAgo = Date.now() - 13 * 3600 * 1000;
    tab.updateLastAccessed(twelveHoursAgo);

    // Open a second, clean tab to be the selected tab and one idle clean tab
    const cleanTab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com");
    cleanTab.updateLastAccessed(twelveHoursAgo);

    // Run the sweep
    WhimsyArchive.sweepWindow(window);

    // Form-protected tab must survive the sweep
    ok(tab.isConnected && !tab.closing, "Form-protected tab survived the sweep");

    BrowserTestUtils.removeTab(cleanTab);
  });
});

add_task(async function test_sessionstore_formdata_preservation() {
  await BrowserTestUtils.withNewTab(FORM_PAGE, async browser => {
    const tab = gBrowser.getTabForBrowser(browser);

    // Populate TabStateCache mock formdata to test SessionStore restoration awareness
    TabStateCache.update(browser.permanentKey, {
      formdata: {
        id: { name: "Saved Draft" },
      },
    });

    ok(WhimsyFormProtection.hasSessionRestoreFormData(tab), "Detects SessionStore form data in cache");
    ok(WhimsyFormProtection.isFormProtected(tab), "Tab is protected via SessionStore cache");
    ok(WhimsyArchive.isSweepExempt(tab), "Tab with cached form data is exempt from sweep");

    // Clear TabStateCache mock
    TabStateCache.update(browser.permanentKey, { formdata: null });
  });
});

add_task(async function test_switch_off() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.form-protection", false]] });
  await BrowserTestUtils.withNewTab(FORM_PAGE, async browser => {
    const tab = gBrowser.getTabForBrowser(browser);
    tab.setAttribute("whimsy-form-protected", "true");
    ok(!WhimsyFormProtection.isFormProtected(tab), "With feature switch off, tab is not form protected");
  });
  await SpecialPowers.popPrefEnv();
});

// W10-25: unloading a tab with a form asks first, beside the sidebar; Esc
// and Return keep it loaded; Unload unloads; a tab without one unloads
// without asking.
add_task(async function test_unload_asks_first() {
  const formTab = await BrowserTestUtils.openNewForegroundTab(gBrowser, FORM_PAGE);
  const plainTab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?plain");
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.org/");
  try {
    WhimsyFormProtection.updateTabProtection(formTab, true);
    const ask = async how => {
      const shown = BrowserTestUtils.waitForEvent(document, "popupshown", true, e => e.target.id == "whimsy-form-unload");
      const unloading = gBrowser.explicitUnloadTabs([formTab]);
      await shown;
      const panel = document.getElementById("whimsy-form-unload");
      ok(panel.classList.contains("whimsy-surface"), "A Whimsy surface");
      await document.l10n.translateFragment(panel);
      is(panel.querySelector(".whimsy-surface-title").textContent, "Unload this tab?", "Unload this tab?");
      ok(panel.querySelector(".whimsy-form-unload-body b"), "naming the site in bold");
      await TestUtils.waitForCondition(() => document.activeElement?.id == "whimsy-form-unload-keep", "Keep Loaded has the keyboard");
      await how(panel);
      await unloading;
    };
    await ask(() => EventUtils.synthesizeKey("KEY_Escape", {}, window));
    ok(formTab.linkedPanel, "Esc keeps it loaded");
    await ask(() => EventUtils.synthesizeKey("KEY_Enter", {}, window));
    ok(formTab.linkedPanel, "Return keeps it loaded");
    await ask(panel => panel.querySelector("#whimsy-form-unload-accept").doCommand());
    await TestUtils.waitForCondition(() => !formTab.linkedPanel, "Unload unloads it");

    let asked = false;
    const onShown = e => (asked ||= e.target.id == "whimsy-form-unload");
    document.addEventListener("popupshown", onShown, true);
    await gBrowser.explicitUnloadTabs([plainTab]);
    document.removeEventListener("popupshown", onShown, true);
    ok(!asked, "A tab without a form doesn't ask");
    await TestUtils.waitForCondition(() => !plainTab.linkedPanel, "and unloads");
  } finally {
    for (const tab of [formTab, plainTab, other]) {
      BrowserTestUtils.removeTab(tab);
    }
  }
});

// W10-25: type, reload, and a toast asks to fill the answers back in; Fill
// In fills only empty fields, never the password.
add_task(async function test_refill_after_reload_asks_first() {
  await BrowserTestUtils.withNewTab(FORM_PAGE, async browser => {
    const tab = gBrowser.getTabForBrowser(browser);
    await SpecialPowers.spawn(browser, [], () => {
      const doc = content.document;
      doc.getElementById("name").focus();
    });
    for (const key of "Ada Lovelace") {
      await BrowserTestUtils.synthesizeKey(key, {}, browser);
    }
    await SpecialPowers.spawn(browser, [], () => content.document.getElementById("password").focus());
    for (const key of "hunter2") {
      await BrowserTestUtils.synthesizeKey(key, {}, browser);
    }
    await TestUtils.waitForCondition(() => tab.hasAttribute("whimsy-form-typed"), "Typed");

    const { WhimsyToast } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyToast.sys.mjs");
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
  });
});

// W10-25: a private tab's snapshot stays in memory, never in the session.
add_task(async function test_private_snapshot_stays_in_memory() {
  const { WhimsyPrivate } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPrivate.sys.mjs");
  const { SessionStore } = ChromeUtils.importESModule("moz-src:///browser/components/sessionstore/SessionStore.sys.mjs");
  const tab = WhimsyPrivate.openPrivateTab(window, { url: FORM_PAGE, force: true });
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser);
  try {
    ok(WhimsyFormProtection.storeSnapshot(tab.linkedBrowser, FORM_PAGE, { id: { name: "Private Person" } }), "Stored");
    ok(WhimsyFormProtection.snapshotFor(tab.linkedBrowser, FORM_PAGE + "#x"), "Found again for the same page (ignoring the hash)");
    is(SessionStore.getCustomTabValue(tab, "whimsy-formdata"), "", "never written to the session");
  } finally {
    BrowserTestUtils.removeTab(tab);
  }

  // A normal tab: in the session too, so a restart keeps it.
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
