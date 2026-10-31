/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave5/verbs: Cmd+K lists verbs for the selection (or the page) in the
// command bar, and each verb does its thing (side effects stubbed).

const { WhimsyVerbs, parseEvent, buildICS } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyVerbs.sys.mjs"
);
const { UrlbarShared } = ChromeUtils.importESModule("chrome://browser/content/urlbar/UrlbarShared.mjs");
const { UrlbarTestUtils } = ChromeUtils.importESModule("resource://testing-common/UrlbarTestUtils.sys.mjs");
const { gWhimsyNotesStore } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyNotesSection.sys.mjs");

const PAGE =
  getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") + "whimsy_verbs.html";

UrlbarTestUtils.init(this);

// Records the side effects instead of opening tabs, mail, files or the
// clipboard.
function stubEffects() {
  const calls = [];
  const names = ["openTab", "openExternal", "copy", "launchFile", "calendarService"];
  const originals = Object.fromEntries(names.map(n => [n, WhimsyVerbs[n]]));
  // No macOS Calendar here, so Add to Calendar takes the .ics path (the
  // EventKit path: browser_whimsy_calendar_write.js).
  WhimsyVerbs.calendarService = () => null;
  WhimsyVerbs.openTab = (win, url) => calls.push({ what: "tab", url });
  WhimsyVerbs.openExternal = url => calls.push({ what: "external", url });
  WhimsyVerbs.copy = text => calls.push({ what: "copy", text });
  WhimsyVerbs.launchFile = path => calls.push({ what: "file", path });
  calls.restore = () => Object.assign(WhimsyVerbs, originals);
  return calls;
}

async function select(browser, id) {
  await SpecialPowers.spawn(browser, [id], elementId => {
    const selection = content.getSelection();
    selection.removeAllRanges();
    if (elementId) {
      const range = content.document.createRange();
      range.selectNodeContents(content.document.getElementById(elementId));
      selection.addRange(range);
    }
  });
}

async function shownVerbs() {
  await UrlbarTestUtils.promiseSearchComplete(window);
  const verbs = [];
  for (let i = 0; i < UrlbarTestUtils.getResultCount(window); i++) {
    const { result } = await UrlbarTestUtils.getDetailsOfResultAt(window, i);
    verbs.push(result.payload.whimsyVerb ?? `other:${result.payload.title ?? result.type}`);
  }
  return verbs;
}

async function closeBar() {
  await UrlbarTestUtils.promisePopupClose(window, () => gURLBar.blur());
  gURLBar.searchMode = null;
}

async function subjectFor(browser, id) {
  await select(browser, id);
  return WhimsyVerbs.subjectFor(window);
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["whimsy.feature.selection-verbs", true],
      ["browser.translations.enable", true],
      ["whimsy.verbs.skills", ""],
    ],
  });
  registerCleanupFunction(() => {
    gURLBar.searchMode = null;
    gURLBar.value = "";
  });
});

add_task(function test_cmd_k_is_taken_from_focus_search() {
  const key = document.getElementById("key_whimsySelectionVerbs");
  ok(key, "Whimsy's Cmd+K key exists");
  is(key.getAttribute("key"), "K", "On K");
  is(key.getAttribute("modifiers"), "accel", "With Cmd");
  ok(!document.getElementById("key_search")?.getAttribute("key"), "Firefox's Focus Search key moved to Whimsy's");
});

// Cmd+K with nothing selected is exactly Zen's Cmd+K: Firefox's web search
// (Tools:Search), never the page verbs.
add_task(async function test_cmd_k_without_selection_is_web_search() {
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await select(browser, null);
    const command = document.getElementById("Tools:Search");
    const searched = BrowserTestUtils.waitForEvent(command, "command");
    gBrowser.selectedBrowser.focus();
    EventUtils.synthesizeKey("k", { accelKey: true });
    await searched;
    ok(true, "Cmd+K ran Firefox's web search command");
    await TestUtils.waitForCondition(() => gURLBar.focused, "The web search has focus");
    ok(!WhimsyVerbs.sessions.get(window), "No verb session");
    isnot(gURLBar.searchMode?.source, UrlbarShared.RESULT_SOURCE.ZEN_ACTIONS, "Not the command bar's actions mode");
    gURLBar.blur();
    gURLBar.searchMode = null;
  });
});

add_task(async function test_selection_lists_only_verbs() {
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await select(browser, "event");
    EventUtils.synthesizeKey("k", { accelKey: true });
    await TestUtils.waitForCondition(() => WhimsyVerbs.sessions.get(window), "Verb session started");
    is(gURLBar.searchMode?.source, UrlbarShared.RESULT_SOURCE.ZEN_ACTIONS, "The command bar is in actions mode");
    const verbs = await shownVerbs();
    Assert.deepEqual(
      verbs,
      ["search", "translate", "map", "email", "copy-markdown", "note", "calendar"],
      "Only the selection's verbs, Search first, Add to Calendar for a date"
    );
    const { result } = await UrlbarTestUtils.getDetailsOfResultAt(window, 0);
    is(result.rowLabel?.args?.text, "Team sync Nov 3 at 3pm", "The row label shows the selection");
    const { SearchService } = ChromeUtils.importESModule(
      "moz-src:///toolkit/components/search/SearchService.sys.mjs"
    );
    const engine = await SearchService.getDefault();
    is(
      // Fluent wraps placeables in bidi isolation marks.
      result.payload.title.replace(/[\u2068\u2069]/g, ""),
      `Search ${engine.name} for “Team sync Nov 3 at 3pm”`,
      "The first verb searches the default engine for the selection"
    );

    // Typing filters the verbs.
    gURLBar.value = "map";
    gURLBar.startQuery({ allowAutofill: false });
    Assert.deepEqual(await shownVerbs(), ["map"], '"map" leaves Show in Maps');
    await closeBar();
    ok(!WhimsyVerbs.sessions.get(window), "Closing the bar ends the session");
  });
});

add_task(async function test_nothing_selected_acts_on_page() {
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await select(browser, null);
    const subject = await WhimsyVerbs.open(window);
    is(subject.kind, "page", "The page is the subject");
    is(subject.markdown, `[Verbs test page](${PAGE})`, "The page as a Markdown link");
    Assert.deepEqual(
      await shownVerbs(),
      ["translate", "email", "copy-markdown", "note"],
      "Page verbs only (no Search, Map or Calendar)"
    );
    await closeBar();
  });
});

add_task(async function test_verb_actions() {
  const calls = stubEffects();
  const translate = { select: null, page: null };
  const originalSelect = window.SelectTranslationsPanel?.open;
  const originalPage = window.FullPageTranslationsPanel?.open;
  window.SelectTranslationsPanel.open = async (...args) => {
    translate.select = args;
  };
  window.FullPageTranslationsPanel.open = async (...args) => {
    translate.page = args;
  };
  try {
    await BrowserTestUtils.withNewTab(PAGE, async browser => {
      let subject = await subjectFor(browser, "place");
      ok(await WhimsyVerbs.runVerb(window, "translate", subject), "Translate ran");
      is(translate.select?.[3], "1 Infinite Loop, Cupertino", "Firefox Translations gets the selection");

      await WhimsyVerbs.runVerb(window, "search", subject);
      ok(calls.at(-1).url.includes("Infinite"), "Search opens the default engine's results");

      await WhimsyVerbs.runVerb(window, "map", subject);
      is(calls.at(-1).url, "https://maps.apple.com/?q=1%20Infinite%20Loop%2C%20Cupertino", "Map opens Apple Maps");

      await WhimsyVerbs.runVerb(window, "email", subject);
      ok(calls.at(-1).url.startsWith("mailto:?subject=Verbs%20test%20page&body=1%20Infinite"), "Email drafts a mail");

      subject = await subjectFor(browser, "rich");
      await WhimsyVerbs.runVerb(window, "copy-markdown", subject);
      is(
        calls.at(-1).text,
        "Read the **bold** [docs](https://example.com/docs) and `run()`.",
        "Copy as Markdown keeps emphasis, links (absolute) and code"
      );
      subject = await subjectFor(browser, "list");
      await WhimsyVerbs.runVerb(window, "copy-markdown", subject);
      is(calls.at(-1).text, "- One\n- Two", "A selected list stays a list");

      await WhimsyVerbs.runVerb(window, "note", subject);
      const [note] = await gWhimsyNotesStore.list();
      ok(note.text.startsWith("- One\n- Two"), "Add to Note saves the selection as Markdown");
      ok(note.text.includes(`[Verbs test page](${PAGE})`), "...with a link back to the page");
      await gWhimsyNotesStore.remove(note.id);

      subject = await subjectFor(browser, "event");
      await WhimsyVerbs.runVerb(window, "calendar", subject);
      const ics = await IOUtils.readUTF8(calls.at(-1).path);
      ok(/DTSTART:\d{4}1103T150000/.test(ics), "The event starts Nov 3 at 3pm");
      ok(ics.includes("SUMMARY:Team sync"), "Titled from the rest of the text");
      await IOUtils.remove(calls.at(-1).path);

      // Linear only with a Linear live folder.
      ok(!WhimsyVerbs.verbsFor(window, subject).some(v => v.id.startsWith("linear")), "No Linear verbs by default");
      const originalLinear = WhimsyVerbs.linearConfigured;
      WhimsyVerbs.linearConfigured = () => true;
      try {
        const ids = WhimsyVerbs.verbsFor(window, subject).map(v => v.id);
        Assert.deepEqual(ids.slice(-2), ["linear-new", "linear-search"], "Linear verbs come last");
        await WhimsyVerbs.runVerb(window, "linear-new", subject);
        ok(calls.at(-1).url.startsWith("https://linear.new?title=Team%20sync"), "New Linear Issue prefilled");
        await WhimsyVerbs.runVerb(window, "linear-search", subject);
        ok(calls.at(-1).url.includes("linear.app/") && calls.at(-1).url.includes("q=Team"), "Search Linear");
      } finally {
        WhimsyVerbs.linearConfigured = originalLinear;
      }

      // The whole page.
      subject = await subjectFor(browser, null);
      await WhimsyVerbs.runVerb(window, "translate", subject);
      ok(translate.page, "Translate Page opens Firefox's page translation");
      await WhimsyVerbs.runVerb(window, "copy-markdown", subject);
      is(calls.at(-1).text, `[Verbs test page](${PAGE})`, "Copy as Markdown copies the page link");
    });
  } finally {
    calls.restore();
    window.SelectTranslationsPanel.open = originalSelect;
    window.FullPageTranslationsPanel.open = originalPage;
  }
});

add_task(async function test_picking_a_row_runs_it() {
  const calls = stubEffects();
  try {
    await BrowserTestUtils.withNewTab(PAGE, async browser => {
      await select(browser, "rich");
      await WhimsyVerbs.open(window);
      gURLBar.value = "markdown";
      gURLBar.startQuery({ allowAutofill: false });
      Assert.deepEqual(await shownVerbs(), ["copy-markdown"], "Filtered to Copy as Markdown");
      EventUtils.synthesizeKey("KEY_Enter");
      await TestUtils.waitForCondition(() => calls.some(c => c.what == "copy"), "Enter ran the verb");
      gURLBar.searchMode = null;
    });
  } finally {
    calls.restore();
  }
});

add_task(async function test_user_skills_share_the_registry() {
  const calls = stubEffects();
  await SpecialPowers.pushPrefEnv({
    set: [["whimsy.verbs.skills", "# comment\nWiki | https://en.wikipedia.org/w/index.php?search=%s\nBroken | ftp://x/%s"]],
  });
  WhimsyVerbs.registerVerb({
    id: "test-skill",
    label: "Shout",
    scope: "selection",
    run: (w, s) => calls.push({ what: "shout", text: s.text.toUpperCase() }),
  });
  try {
    await BrowserTestUtils.withNewTab(PAGE, async browser => {
      const subject = await subjectFor(browser, "place");
      const ids = WhimsyVerbs.verbsFor(window, subject).map(v => v.id);
      Assert.deepEqual(ids.slice(-2), ["test-skill", "skill:Wiki"], "Registered skills, then pref skills, last");
      ok(!ids.includes("skill:Broken"), "Only http(s) skills");
      await WhimsyVerbs.runVerb(window, "skill:Wiki", subject);
      is(calls.at(-1).url, "https://en.wikipedia.org/w/index.php?search=1%20Infinite%20Loop%2C%20Cupertino", "%s is the selection");
      await WhimsyVerbs.runVerb(window, "test-skill", subject);
      is(calls.at(-1).text, "1 INFINITE LOOP, CUPERTINO", "A registered verb runs");
    });
  } finally {
    WhimsyVerbs.unregisterVerb("test-skill");
    calls.restore();
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_switch_off() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.selection-verbs", false]] });
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await select(browser, "event");
    let searched = false;
    const command = document.getElementById("Tools:Search");
    const onCommand = () => {
      searched = true;
    };
    command.addEventListener("command", onCommand);
    try {
      is(await WhimsyVerbs.open(window), null, "No verb session with the switch off");
      ok(searched, "Cmd+K falls back to Firefox's Focus Search");
      ok(!WhimsyVerbs.sessions.get(window), "No session");
      gURLBar.searchMode = null;
      // "/" commands are Zen's own again.
      gURLBar.focus();
      gURLBar.searchMode = { source: UrlbarShared.RESULT_SOURCE.ZEN_ACTIONS, isPreview: false };
      gURLBar.startQuery({ allowAutofill: false });
      ok(!(await shownVerbs()).some(v => !v.startsWith("other:")), "No verbs in the command bar");
    } finally {
      command.removeEventListener("command", onCommand);
      await closeBar();
    }
  });
  await SpecialPowers.popPrefEnv();
});

add_task(function test_parse_event() {
  const now = new Date(2026, 9, 30, 10, 0); // Friday Oct 30 2026, 10:00
  const check = (text, start, end, allDay, title) => {
    const event = parseEvent(text, now);
    ok(event, `"${text}" has a date`);
    is(event.start.getTime(), start.getTime(), `"${text}" start`);
    is(event.end.getTime(), end.getTime(), `"${text}" end`);
    is(event.allDay, allDay, `"${text}" all-day`);
    is(event.title, title, `"${text}" title`);
  };
  check("Team sync Nov 3 at 3pm", new Date(2026, 10, 3, 15), new Date(2026, 10, 3, 16), false, "Team sync");
  check("Dinner tomorrow 7:30 pm", new Date(2026, 9, 31, 19, 30), new Date(2026, 9, 31, 20, 30), false, "Dinner");
  check("Offsite 3 December 2026", new Date(2026, 11, 3), new Date(2026, 11, 4), true, "Offsite");
  check("Standup 15:00-15:30", new Date(2026, 9, 30, 15), new Date(2026, 9, 30, 15, 30), false, "Standup");
  check("Call next Friday 10-11am", new Date(2026, 10, 6, 10), new Date(2026, 10, 6, 11), false, "Call");
  check("Q4 planning, Wednesday, Nov 4, 2026 from 2 to 3pm", new Date(2026, 10, 4, 14), new Date(2026, 10, 4, 15), false, "Q4 planning");
  check("Party on 1/14", new Date(2027, 0, 14), new Date(2027, 0, 15), true, "Party");
  is(parseEvent("Version 3.2 released", now), null, "No date, no event");
  const ics = buildICS({ start: new Date(2026, 10, 3, 15), end: new Date(2026, 10, 3, 16), allDay: false, title: "A, B; C" });
  ok(ics.includes("SUMMARY:A\\, B\\; C\r\n"), "iCalendar text is escaped, CRLF lines");
});
