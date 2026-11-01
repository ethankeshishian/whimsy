/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W10-22: Settings search shows where the hit is: the matching row is
// boxed (and tagged when only a keyword matched), the rest of a long group
// folds into "Show N more", a breadcrumb leads to the row's pane, a count
// line says how many, Return moves between hits, and clearing the search
// takes it all away.

let lastQuery = null;
async function search(win, query) {
  const wanted = query.trim().toLowerCase();
  if (wanted == lastQuery) {
    return;
  }
  lastQuery = wanted;
  const done = BrowserTestUtils.waitForEvent(win, "PreferencesSearchCompleted", false, e => e.detail == wanted);
  const input = win.document.getElementById("searchInput");
  input.value = query;
  input.dispatchEvent(new win.InputEvent("input", { bubbles: true }));
  await done;
  // Our pass runs on the same event; let its strings land.
  await win.document.l10n.ready;
  await new Promise(r => win.requestAnimationFrame(r));
}

async function withSettings(fn) {
  lastQuery = null;
  await BrowserTestUtils.withNewTab("about:preferences#home", async browser => {
    const win = browser.contentWindow;
    await win.gSearchResultsPane.initializeCategories();
    await fn(browser.contentDocument, win);
    await search(win, "");
  });
}

add_task(async function trails_shows_the_one_row() {
  await withSettings(async (doc, win) => {
    await search(win, "trails");
    const trails = doc.getElementById("whimsyTrails");
    const hits = [...doc.querySelectorAll(".whimsy-search-hit")];
    ok(hits.includes(trails), "Trails is boxed as the hit");
    is(hits.filter(h => h.closest("groupbox") == trails.closest("groupbox")).length, 1, "It's the only hit in its group");
    const tag = trails.querySelector(".whimsy-search-keyword");
    ok(tag, "It says why it matched");
    await TestUtils.waitForCondition(() => tag.textContent.includes("Trails"), "Matches “Trails”");

    const group = trails.closest("groupbox");
    const more = group.querySelector(".whimsy-search-more");
    ok(more, "The rest of the group folds into one button");
    const folded = [...group.children].filter(
      el => el.classList.contains("whimsy-search-collapsed") && !el.classList.contains("whimsy-search-added")
    );
    ok(folded.length >= 2, `The other rows are folded (${folded.length})`);
    ok(folded.every(el => !el.checkVisibility()), "…and not drawn");
    const args = JSON.parse(more.getAttribute("data-l10n-args"));
    ok(args.count >= folded.length - 1, `Show ${args.count} more`);

    const crumb = group.previousElementSibling;
    ok(crumb?.classList.contains("whimsy-search-crumb"), "A breadcrumb sits above the group");
    ok(crumb.querySelector(".whimsy-search-show-in"), "…with Show in");

    const count = doc.querySelector(".whimsy-search-count");
    is(count?.getAttribute("role"), "status", "A count line is announced");
    const counted = JSON.parse(count.getAttribute("data-l10n-args"));
    Assert.greaterOrEqual(counted.count, hits.length, "It counts every boxed hit");
    is(counted.query, "trails", "…for the query");

    await TestUtils.waitForCondition(() => {
      const r = trails.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= win.innerHeight;
    }, "The hit scrolls into view");

    // Show more: the group comes back whole.
    more.dispatchEvent(new win.Event("command", { bubbles: true }));
    ok(folded.every(el => !el.classList.contains("whimsy-search-collapsed")), "Show more unfolds the group");
    ok(!more.isConnected, "…and goes");
  });
});

add_task(async function return_moves_between_hits() {
  await withSettings(async (doc, win) => {
    await search(win, "archive");
    const hits = [...doc.querySelectorAll(".whimsy-search-hit")];
    Assert.greater(hits.length, 1, "Archive matches several settings");
    const places = new Set(hits.map(h => h.closest("[data-category]")));
    const args = JSON.parse(doc.querySelector(".whimsy-search-count").getAttribute("data-l10n-args"));
    Assert.greaterOrEqual(args.count, hits.length, "The count covers every hit");
    Assert.greaterOrEqual(args.places, places.size, "…and every place");
    const input = doc.getElementById("searchInput");
    input.focus();
    EventUtils.synthesizeKey("KEY_Enter", {}, win);
    ok(hits[0].contains(doc.activeElement) || hits[0] == doc.activeElement, "Return focuses the first hit");
    EventUtils.synthesizeKey("KEY_Enter", {}, win);
    ok(hits[1].contains(doc.activeElement) || hits[1] == doc.activeElement, "Return again, the next");
    EventUtils.synthesizeKey("KEY_Enter", { shiftKey: true }, win);
    ok(hits[0].contains(doc.activeElement) || hits[0] == doc.activeElement, "Shift+Return goes back");
  });
});

add_task(async function clearing_removes_everything() {
  await withSettings(async (doc, win) => {
    await search(win, "trails");
    ok(doc.querySelector(".whimsy-search-hit"), "Marked");
    await search(win, "");
    ok(!doc.querySelector(".whimsy-search-hit, .whimsy-search-collapsed, .whimsy-search-added, mark.whimsy-search-mark"),
      "Clearing the search removes every mark, fold and line");
  });
});

add_task(async function tidy_titles_is_found() {
  await withSettings(async (doc, win) => {
    await search(win, "tidy titles");
    const row = doc.getElementById("whimsyAITidyTitles");
    ok(row?.classList.contains("whimsy-search-hit"), "Tidy Titles is the hit (W10-12)");
  });
});

add_task(async function menus_row_is_marked() {
  await withSettings(async (doc, win) => {
    await search(win, "archive tabs below");
    const detail = doc.getElementById("whimsyMenus-tab");
    await TestUtils.waitForCondition(() => detail.checkVisibility(), "The Tab menu shows");
    const row = detail.querySelector(".whimsy-menus-row.whimsy-search-hit");
    ok(row, "Its row is boxed");
    ok(row.querySelector("mark.whimsy-search-mark"), "…and the words are marked");
  });
  Services.prefs.clearUserPref("whimsy.menus.settings-last");
});

add_task(async function show_in_pane() {
  await withSettings(async (doc, win) => {
    await search(win, "trails");
    const trails = doc.getElementById("whimsyTrails");
    const go = trails.closest("groupbox").previousElementSibling.querySelector(".whimsy-search-show-in");
    go.dispatchEvent(new win.Event("command", { bubbles: true }));
    await TestUtils.waitForCondition(() => trails.classList.contains("whimsy-search-flash"), "The row is marked there");
    ok(!doc.location.hash.includes("search"), `Left the results (${doc.location.hash})`);
    ok(!doc.querySelector(".whimsy-search-added"), "The search's lines are gone");
    await TestUtils.waitForCondition(() => !trails.classList.contains("whimsy-search-flash"), "…for two seconds");
    lastQuery = "";
  });
});

add_task(async function no_results() {
  await withSettings(async (doc, win) => {
    await search(win, "trailzzqx");
    const box = doc.querySelector(".whimsy-search-none-box");
    ok(box, "Whimsy's no-results words show");
    ok(doc.getElementById("no-results-message").classList.contains("whimsy-search-none"), "…in place of Firefox's");
  });
});
