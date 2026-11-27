/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// perf (I6): Settings builds each pane when it's first shown, not when
// Settings opens (Firefox used to set up every pane in an idle callback
// right after opening). The first search builds them all first, so it
// still finds settings on panes never opened, and links to a pane or a
// setting still land on it.

// Shown: no hidden or visually-hidden ancestor inside the settings page.
function shown(el) {
  for (let node = el; node && node.id != "mainPrefPane"; node = node.parentElement) {
    if (node.hidden || node.classList.contains("visually-hidden")) {
      return false;
    }
  }
  return !!el?.isConnected;
}

// Firefox queued its set-up-every-pane callback when Settings loaded; an
// idle callback asked for now runs after it.
function idle(win) {
  return new Promise(resolve => win.requestIdleCallback(resolve));
}

// Types a query the way the search field reports it.
async function search(win, query) {
  const wanted = query.trim().toLowerCase();
  const done = BrowserTestUtils.waitForEvent(win, "PreferencesSearchCompleted", false, e => e.detail == wanted);
  const input = win.document.getElementById("searchInput");
  input.value = query;
  input.dispatchEvent(new win.InputEvent("input", { bubbles: true }));
  await done;
}

function assertUnbuilt(win, doc, what) {
  is(win.gSearchResultsPane._categoriesInitialized, null, `${what}: not every pane was set up`);
  ok(doc.getElementById("template-whimsyLinks"), `${what}: Links isn't built`);
  ok(!doc.getElementById("whimsyGlanceSizeRow"), `${what}: so its rows aren't in the page`);
  ok(!win.WhimsyAISettings._sectionsLoaded, `${what}: Settings › AI's section files aren't loaded`);
  ok(!win.WhimsyAISettings._sections.has("agent"), `${what}: so its outside agents aren't registered`);
}

add_task(async function search_finds_controls_in_unbuilt_panes() {
  await BrowserTestUtils.withNewTab("about:preferences#home", async browser => {
    const win = browser.contentWindow;
    const doc = browser.contentDocument;
    await TestUtils.waitForCondition(() => win.gLastCategory?.category == "paneHome", "Home shows");
    await idle(win);
    assertUnbuilt(win, doc, "Settings opened on Home");
    ok(doc.getElementById("template-whimsyAI"), "Settings › AI isn't built");

    // Links: a row in a template until its pane is built.
    await search(win, "glance size");
    const glance = doc.getElementById("whimsyGlanceSizeRow");
    ok(glance, "The first search built Links");
    await TestUtils.waitForCondition(() => shown(glance), "Searching “glance size” shows its row");
    ok(win.gSearchResultsPane._categoriesInitialized, "Every pane is set up now");

    // Settings › AI: a row a section file builds, loaded with the page.
    ok(win.WhimsyAISettings._sectionsLoaded, "Settings › AI's section files loaded for the search");
    for (const id of ["providers", "connectors", "commands", "memory", "agent", "outside-agents", "activity", "features"]) {
      ok(win.WhimsyAISettings._sections.has(id), `The ${id} section is registered`);
    }
    await search(win, "claude code");
    const outside = doc.getElementById("whimsyAIOutsideEnable")?.closest(".whimsy-ai-item");
    await TestUtils.waitForCondition(() => outside?.checkVisibility(), "Searching “claude code” shows Outside agents");
    ok(outside.closest("#whimsyAISection-outside-agents"), "…in its section of Settings › AI");

    await search(win, "");
  });
});

add_task(async function links_to_a_pane_build_only_that_pane() {
  await BrowserTestUtils.withNewTab("about:preferences#whimsyLinks", async browser => {
    const win = browser.contentWindow;
    const doc = browser.contentDocument;
    await TestUtils.waitForCondition(() => win.gLastCategory?.category == "paneWhimsyLinks", "#whimsyLinks opens Links");
    const apps = await TestUtils.waitForCondition(() => doc.getElementById("whimsyLinksAppsGroup"), "Links is built");
    await TestUtils.waitForCondition(() => shown(apps), "…and shown");
    await idle(win);
    is(win.gSearchResultsPane._categoriesInitialized, null, "Not every pane was set up");
    ok(doc.getElementById("template-whimsyAI"), "Settings › AI isn't built");
    ok(doc.getElementById("template-whimsyPrivacy"), "nor Privacy's Whimsy groups");
  });

  await BrowserTestUtils.withNewTab("about:preferences#whimsyAI", async browser => {
    const win = browser.contentWindow;
    const doc = browser.contentDocument;
    await TestUtils.waitForCondition(
      () => win.WhimsyAISettings?.root && doc.getElementById("whimsyAIPage")?.checkVisibility(),
      "#whimsyAI opens Settings › AI"
    );
    ok(win.WhimsyAISettings._sectionsLoaded, "Its section files loaded");
    ok(doc.getElementById("whimsyAISection-providers"), "Providers is built");
    ok(doc.getElementById("whimsyAIProviderList"), "…with its list");
    await idle(win);
    is(win.gSearchResultsPane._categoriesInitialized, null, "Not every pane was set up");
    ok(doc.getElementById("template-whimsyLinks"), "Links isn't built");
  });
});

add_task(async function link_to_a_setting_in_an_unbuilt_pane() {
  await BrowserTestUtils.withNewTab("about:preferences#home", async browser => {
    const win = browser.contentWindow;
    const doc = browser.contentDocument;
    await TestUtils.waitForCondition(() => win.gLastCategory?.category == "paneHome", "Home shows");
    await idle(win);
    ok(!doc.getElementById("whimsyDensityRow"), "Look and Feel isn't built");

    // Old Window density links land on Whimsy's Density row, which goes in
    // when Look and Feel is first shown, after Firefox's spotlight ran.
    await win.gotoPref("appearance-windowDensity");
    is(win.gLastCategory.category, "paneZenLooks", "The link opens Look and Feel");
    const row = doc.getElementById("whimsyDensityRow");
    ok(row, "Look and Feel is built");
    await TestUtils.waitForCondition(() => shown(row), "The Density row shows");
    await TestUtils.waitForCondition(() => row.classList.contains("spotlight"), "…spotlit");
  });
});
