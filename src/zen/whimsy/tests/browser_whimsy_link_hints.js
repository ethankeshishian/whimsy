/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave6/zap: Link hints. Cmd+J puts letter badges on what's clickable on
// screen; typing a badge clicks it, Shift opens a link in a new tab, Esc
// cancels, and the page never sees the hint keys.

const { WhimsyLinkHints } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyLinkHints.sys.mjs");
const { hintLabels, keyLetter, ALPHABET } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyLinkHintsChild.sys.mjs"
);
const { AppConstants } = ChromeUtils.importESModule("resource://gre/modules/AppConstants.sys.mjs");

const ROOT = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com");
const PAGE = ROOT + "whimsy_link_hints.html";

function peek(browser) {
  return browser.browsingContext.currentWindowGlobal.getActor("WhimsyLinkHints").sendQuery("Whimsy:Hints:Peek");
}

async function showHints(browser) {
  document.getElementById(WhimsyLinkHints.COMMAND_ID).doCommand();
  await TestUtils.waitForCondition(async () => (await peek(browser)).active, "Hints show");
  return peek(browser);
}

async function labelFor(browser, id) {
  const { ids, labels } = await peek(browser);
  const label = labels[ids.indexOf(id)];
  ok(label, `#${id} has a hint (${label})`);
  return label;
}

function type(text, { shiftLast = false } = {}) {
  [...text].forEach((ch, i) => {
    EventUtils.synthesizeKey(ch, shiftLast && i == text.length - 1 ? { shiftKey: true } : {}, window);
  });
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.link-hints", true]] });
});

add_task(function labels_and_layouts() {
  Assert.deepEqual(hintLabels(0), [], "No targets, no labels");
  const few = hintLabels(5);
  is(few.length, 5, "One label per target");
  ok(few.every(l => l.length == 1), "A handful of targets get single letters");
  const many = hintLabels(300);
  is(new Set(many).size, 300, "Labels are unique");
  ok(
    many.every(a => many.every(b => a == b || !b.startsWith(a))),
    "No label is the start of another, so a complete label clicks at once"
  );
  ok(many.every(l => [...l].every(ch => ALPHABET.includes(ch))), "Only home-row-first letters are used");

  is(keyLetter({ key: "a", code: "KeyA" }), "a", "QWERTY");
  is(keyLetter({ key: "A", code: "KeyA" }), "a", "Shift doesn't change the letter");
  is(keyLetter({ key: "e", code: "KeyD" }), "e", "Dvorak/Colemak: the letter typed, not the key's place");
  is(keyLetter({ key: "ф", code: "KeyA" }), "a", "Non-Latin layouts: the key's place");
  is(keyLetter({ key: "Enter", code: "Enter" }), null, "Other keys aren't letters");
});

add_task(async function shortcut_and_action() {
  const key = document.getElementById("key_whimsyLinkHints");
  ok(key, "Link hints has a <key>");
  is(key.getAttribute("key"), "J", "on J");
  is(key.getAttribute("modifiers"), "accel", "with Cmd");
  if (AppConstants.platform != "linux") {
    const downloads = document.getElementById("key_openDownloads");
    ok(
      !(downloads?.getAttribute("key") == "J" && downloads.getAttribute("modifiers") == "accel"),
      "Downloads gave up Cmd+J"
    );
    // Arc's Shift+Cmd+J (WhimsyShortcuts): Downloads stays reachable.
    is(downloads?.getAttribute("key")?.toUpperCase(), "J", "Downloads keeps a J shortcut");
    is(downloads?.getAttribute("modifiers"), "accel,shift", "on Shift+Cmd+J");
  }
  const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");
  const action = globalActions.find(a => a.l10nId == "whimsy-action-link-hints");
  ok(action, "Link Hints is a command bar action");
  is(action.commandId, WhimsyLinkHints.COMMAND_ID, "running the same command");
  await BrowserTestUtils.withNewTab("about:blank", async () => {
    ok(!action.isAvailable(window), "Not offered on about:blank");
  });
});

add_task(async function hints_cover_only_what_can_be_clicked() {
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    const { ids, labels } = await showHints(browser);
    Assert.deepEqual(ids, ["first", "second", "button", "field", "custom"], "Links, buttons, fields and ARIA buttons on screen");
    ok(!ids.includes("hidden") && !ids.includes("ariahidden"), "Nothing hidden");
    ok(!ids.includes("far"), "Nothing scrolled out of view");
    ok(!ids.includes("covered"), "Nothing covered by something else");
    is(labels.length, 5, "One badge each (a link's nested text gets none)");

    const status = await TestUtils.waitForCondition(
      () => document.getElementById("whimsy-link-hints-status")?.textContent,
      "Screen readers hear about the hints"
    );
    ok(status.includes("5"), `The status says how many (${status})`);
    is(document.getElementById("whimsy-link-hints-status").getAttribute("role"), "status", "politely");

    EventUtils.synthesizeKey("KEY_Escape", {}, window);
    await TestUtils.waitForCondition(async () => !(await peek(browser)).active, "Esc puts the hints away");
    const keys = await SpecialPowers.spawn(browser, [], () => content.wrappedJSObject.keysSeen);
    is(keys, 0, "The page never saw the keys");
  });
});

add_task(async function typing_a_hint_clicks_it() {
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await showHints(browser);
    type(await labelFor(browser, "first"));
    await TestUtils.waitForCondition(
      () => SpecialPowers.spawn(browser, [], () => content.location.hash == "#first-clicked"),
      "The link was followed"
    );
    ok(!(await peek(browser)).active, "Hints close after a click");

    await showHints(browser);
    type(await labelFor(browser, "button"));
    await TestUtils.waitForCondition(() => browser.contentTitle == "button clicked", "The button was clicked");

    await showHints(browser);
    type(await labelFor(browser, "custom"));
    await TestUtils.waitForCondition(() => browser.contentTitle == "custom clicked", "An ARIA button is clicked too");

    await showHints(browser);
    type(await labelFor(browser, "field"));
    await TestUtils.waitForCondition(
      () => SpecialPowers.spawn(browser, [], () => content.document.activeElement?.id == "field"),
      "A text field is focused, ready to type"
    );
    const keys = await SpecialPowers.spawn(browser, [], () => content.wrappedJSObject.keysSeen);
    is(keys, 0, "Hint letters never reached the page");
  });
});

add_task(async function shift_opens_a_new_tab() {
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await showHints(browser);
    const label = await labelFor(browser, "second");
    const newTab = BrowserTestUtils.waitForNewTab(gBrowser, PAGE + "?second", true);
    type(label, { shiftLast: true });
    const tab = await newTab;
    ok(tab, "Shift on the last letter opened the link in a new tab");
    is(gBrowser.selectedTab, tab, "and switched to it");
    is(
      await SpecialPowers.spawn(browser, [], () => content.location.href),
      PAGE,
      "The original page stayed where it was"
    );
    BrowserTestUtils.removeTab(tab);
  });
});

// wave7/security M4: the parent never trusts a principal from the content
// process; it uses the page's own and checks the link itself.
add_task(async function parent_ignores_a_forged_principal() {
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    const parent = browser.browsingContext.currentWindowGlobal.getActor("WhimsyLinkHints");
    const system = Services.scriptSecurityManager.getSystemPrincipal();
    const before = gBrowser.tabs.length;
    for (const href of ["about:preferences", "file:///", "chrome://browser/content/browser.xhtml"]) {
      parent.receiveMessage({ name: "Whimsy:Hints:OpenTab", data: { href, triggeringPrincipal: system } });
    }
    is(gBrowser.tabs.length, before, "Privileged links don't open, whatever principal the message claims");

    const newTab = BrowserTestUtils.waitForNewTab(gBrowser, PAGE + "?second", true);
    parent.receiveMessage({ name: "Whimsy:Hints:OpenTab", data: { href: PAGE + "?second" } });
    const tab = await newTab;
    ok(tab.linkedBrowser.contentPrincipal.isContentPrincipal, "An ordinary link opens with the page's principal");
    BrowserTestUtils.removeTab(tab);
  });
});

add_task(async function narrowing_backspace_and_wrong_letters() {
  // Enough targets for two-letter labels.
  const links =
    "<style>a { display: inline !important; margin: 0 4px !important; }</style>" +
    Array.from({ length: 30 }, (_, i) => `<a id="l${i}" href="#l${i}">Link ${i}</a>`).join(" ");
  const url = ROOT + "whimsy_link_hints.html";
  await BrowserTestUtils.withNewTab(url, async browser => {
    await SpecialPowers.spawn(browser, [links], html => {
      content.document.body.innerHTML = html;
    });
    const { labels } = await showHints(browser);
    is(labels.length, 30, "Every link has a hint");
    const target = labels.find(l => l.length == 2);
    ok(target, "Some labels have two letters");
    type(target[0]);
    let state = await peek(browser);
    ok(state.active, "One letter of two keeps hints open");
    ok(state.labels.every(l => l.startsWith(target[0])), "and narrows them to that letter");
    EventUtils.synthesizeKey("KEY_Backspace", {}, window);
    state = await peek(browser);
    is(state.typed, "", "Backspace takes the letter back");
    is(state.labels.length, 30, "and every hint returns");
    const unused = [...ALPHABET].find(ch => !labels.some(l => l.startsWith(ch)));
    if (unused) {
      type(unused);
      state = await peek(browser);
      ok(state.active && state.typed == "", "A letter no hint starts with is ignored");
    }
    EventUtils.synthesizeKey("KEY_Escape", {}, window);
    await TestUtils.waitForCondition(async () => !(await peek(browser)).active, "Esc cancels");
  });
});

add_task(async function toggles_and_closes() {
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await showHints(browser);
    document.getElementById(WhimsyLinkHints.COMMAND_ID).doCommand();
    await TestUtils.waitForCondition(async () => !(await peek(browser)).active, "The shortcut again closes them");

    await showHints(browser);
    await SpecialPowers.spawn(browser, [], () => content.scrollBy(0, 200));
    await TestUtils.waitForCondition(async () => !(await peek(browser)).active, "Scrolling closes them");
  });
});

add_task(async function page_with_nothing_to_click() {
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await SpecialPowers.spawn(browser, [], () => {
      content.document.body.textContent = "Just text.";
    });
    document.getElementById(WhimsyLinkHints.COMMAND_ID).doCommand();
    await TestUtils.waitForCondition(
      () => document.getElementById("whimsy-link-hints-status")?.textContent.includes("No links"),
      "It says there's nothing to hint"
    );
    ok(!(await peek(browser)).active, "and shows no hints");
  });
});

add_task(async function switch_off() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.link-hints", false]] });
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    ok(!WhimsyLinkHints.canHint(window), "Nothing offers hints with the switch off");
    document.getElementById(WhimsyLinkHints.COMMAND_ID).doCommand();
    await new Promise(resolve => setTimeout(resolve, 300));
    ok(!(await peek(browser)).active, "The command does nothing");
  });
  await SpecialPowers.popPrefEnv();
});
