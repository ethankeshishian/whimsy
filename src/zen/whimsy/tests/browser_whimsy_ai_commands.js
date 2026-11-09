/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W23 commands: the store, Link commands (nothing sent to AI), the old
// whimsy.verbs.skills lines moving over silently, Auto following the
// provider order, and Settings › AI › Commands (switches, the sheet with
// token chips, delete with Undo and ⌘Z). A stub stands in for every provider.

const { WhimsyAICommands, parseSkills, linkFor } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAICommands.sys.mjs");
const { WhimsyAIProviders } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIProviders.sys.mjs");
const { WhimsyAIStore } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIStore.sys.mjs");

// TEMP diagnostic (reverted once the leak is found): L07 bisect for
// test_cmd_k_without_selection_is_web_search. Never removed (deliberately,
// for this diagnostic run only) so it also catches writes in the files run
// after this one.
Services.prefs.addObserver("whimsy.ai.enabled", function whimsyTempLeakWatch() {
  dump(
    `TEMP LEAK WATCH whimsy.ai.enabled=${Services.prefs.getBoolPref("whimsy.ai.enabled", false)} at ${new Date().toISOString()}\n${new Error().stack}\n`
  );
});

const TOUCHED = ["whimsy.ai.enabled", "whimsy.ai.order", "whimsy.ai.off", "whimsy.ai.quick-text-apple", "whimsy.verbs.skills", "whimsy.feature.ai-commands"];
const saved = new Map(
  TOUCHED.map(name => {
    const type = Services.prefs.getPrefType(name);
    return [name, Services.prefs.prefHasUserValue(name) ? { type, value: whimsyReadPref(name, type) } : null];
  })
);

function restorePrefs() {
  for (const [name, was] of saved) {
    if (was) {
      whimsyWritePref(name, was.type, was.value);
    } else {
      Services.prefs.clearUserPref(name);
    }
  }
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.ai-hints", false]] });
  registerCleanupFunction(async () => {
    WhimsyAIProviders.setTestProvider(null);
    await WhimsyAICommands._resetForTesting();
    restorePrefs();
    await WhimsyAICommands.init();
    closeToasts();
  });
});

async function fresh() {
  await WhimsyAICommands._resetForTesting();
  await WhimsyAICommands.init();
}

function stub() {
  const calls = [];
  WhimsyAIProviders.setTestProvider(async function* (provider, request) {
    calls.push({ provider, request });
    yield { type: "text", delta: `from ${provider}` };
  });
  return calls;
}

const visible = node => !!node?.checkVisibility();
const click = (page, node) => EventUtils.synthesizeMouseAtCenter(node, {}, page.win);

async function openCommands() {
  Services.prefs.setBoolPref("whimsy.ai.enabled", true);
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:preferences#whimsyAI");
  const win = tab.linkedBrowser.contentWindow;
  const doc = win.document;
  await TestUtils.waitForCondition(() => win.WhimsyAISettings?.root && doc.getElementById("whimsyAIPage")?.checkVisibility(), "Settings › AI shows");
  const $ = id => doc.getElementById(id);
  await TestUtils.waitForCondition(() => $("whimsyCommandsList")?.dataset.ready == "true", "Commands are listed");
  $("whimsyAISection-commands").scrollIntoView({ block: "start" });
  return { tab, win, doc, $, S: win.WhimsyAISettings };
}

async function closePage(page) {
  page.S.closeSheet({ restore: false });
  BrowserTestUtils.removeTab(page.tab);
  closeToasts();
}

async function settled(page) {
  const running = page.doc.getAnimations().filter(a => a.playState == "running" && a.effect?.getComputedTiming().iterations != Infinity);
  await Promise.all(running.map(a => a.finished.catch(() => {})));
}

async function commandSheet(page) {
  const sheet = await TestUtils.waitForCondition(() => {
    const node = page.$("whimsyAISheet");
    return node?.dataset.sheet == "command" && visible(node) && node;
  }, "The command sheet opens");
  await settled(page);
  return sheet;
}

add_task(async function skills_lines_become_link_commands_silently() {
  await WhimsyAICommands._resetForTesting();
  closeToasts();
  Services.prefs.setStringPref(
    "whimsy.verbs.skills",
    ["Wikipedia | https://en.wikipedia.org/w/index.php?search=%s", "# a comment", "Not a link | ftp://example.com/%s", "Search Linear | https://linear.app/search?q=%s"].join("\n")
  );
  await WhimsyAICommands.init();
  const links = WhimsyAICommands.list().filter(c => c.result == "link");
  Assert.deepEqual(
    links.map(c => [c.name, c.url, c.builtIn, c.model]),
    [
      ["Wikipedia", "https://en.wikipedia.org/w/index.php?search=%s", false, "auto"],
      ["Search Linear", "https://linear.app/search?q=%s", false, "auto"],
    ],
    "Each line became a Link command; the comment and the non-web line didn't"
  );
  ok(!Services.prefs.prefHasUserValue("whimsy.verbs.skills"), "The old list is cleared, so there's one place to edit them");
  is(currentToast(), null, "No banner or toast about the move");
  const doc = await WhimsyAIStore.readDoc("commands");
  ok(doc.migrated, "The store remembers it moved them");

  await WhimsyAICommands._resetForTesting();
  await WhimsyAICommands.init();
  is(WhimsyAICommands.list().filter(c => !c.builtIn).length, 0, "An empty list moves nothing");
  Assert.deepEqual(parseSkills("A | https://a.test/%s\n\n|https://b.test"), [{ name: "A", result: "link", url: "https://a.test/%s" }], "Lines without a label are skipped");
  restorePrefs();
});

add_task(async function link_command_sends_nothing_to_ai() {
  await fresh();
  const calls = stub();
  Services.prefs.setBoolPref("whimsy.ai.enabled", true);
  WhimsyAIProviders.setOrder(["claude"]);
  const cmd = await WhimsyAICommands.save({ name: "Wikipedia", result: "link", url: "https://example.com/search?q=%s&from=%u", prompt: "ignored" });
  ok(!("prompt" in cmd), "A Link command keeps no prompt");
  const opened = BrowserTestUtils.waitForNewTab(gBrowser, url => url.startsWith("https://example.com/search"));
  const out = await WhimsyAICommands.run(window, cmd.id, { kind: "selection", text: "cats & dogs", url: "https://a.test/page", title: "Page" });
  const tab = await opened;
  is(out.kind, "link", "It ran as a link");
  is(tab.linkedBrowser.currentURI.spec, "https://example.com/search?q=cats%20%26%20dogs&from=https%3A%2F%2Fa.test%2Fpage", "%s is the selection and %u the page's address, encoded");
  is(calls.length, 0, "No provider was asked anything");
  is(linkFor("https://x.test/?q=%s", { kind: "page", url: "https://a.test/" }), "https://x.test/?q=https%3A%2F%2Fa.test%2F", "With no selection, %s is the page's address");
  BrowserTestUtils.removeTab(tab);

  Services.prefs.setBoolPref("whimsy.ai.enabled", false);
  const again = BrowserTestUtils.waitForNewTab(gBrowser, url => url.startsWith("https://example.com/search"));
  await WhimsyAICommands.run(window, cmd.id, { kind: "selection", text: "x", url: "https://a.test/" });
  BrowserTestUtils.removeTab(await again);
  ok(true, "Link commands work with AI off");
  WhimsyAIProviders.setTestProvider(null);
  restorePrefs();
});

add_task(async function auto_model_follows_order() {
  await fresh();
  const calls = stub();
  Services.prefs.setBoolPref("whimsy.ai.enabled", true);
  WhimsyAIProviders.setOrder(["claude", "openai"]);
  const cmd = await WhimsyAICommands.save({ name: "Make it a post", result: "copy", prompt: "Rewrite {selection} as a post.", model: "auto" });
  let out = await WhimsyAICommands.run(window, cmd.id, { kind: "selection", text: "Hello there", url: "https://a.test/" });
  is(out.result.provider, "claude", "Auto: the first provider in the order answers");
  is(out.text, "from claude", "The answer comes back as text");
  is(calls[0].request.messages.at(-1).content, "Rewrite Hello there as a post.", "{selection} is filled in");

  WhimsyAIProviders.setOrder(["openai", "claude"]);
  out = await WhimsyAICommands.run(window, cmd.id, { kind: "selection", text: "Hi", url: "https://a.test/" });
  is(out.result.provider, "openai", "Reordered: Auto follows");

  await WhimsyAICommands.save({ ...cmd, model: "claude" });
  out = await WhimsyAICommands.run(window, cmd.id, { kind: "selection", text: "Hi", url: "https://a.test/" });
  is(out.result.provider, "claude", "A chosen model goes first whatever the order");

  const card = "4111" + " 1111 " + "1111 1111";
  await WhimsyAICommands.run(window, cmd.id, { kind: "selection", text: `pay with ${card}`, url: "https://a.test/" });
  ok(!calls.at(-1).request.messages.at(-1).content.includes(card), "A card number in the selection is redacted");
  WhimsyAIProviders.setTestProvider(null);
  restorePrefs();
});

add_task(async function builtin_hide_switch() {
  await fresh();
  const page = await openCommands();
  const row = page.doc.querySelector('.whimsy-commands-row[data-command="improve"]');
  ok(visible(row), "Improve writing is listed");
  const toggle = row.querySelector("moz-toggle");
  ok(toggle.pressed, "Shown by default");
  ok(!row.querySelector(".whimsy-commands-iconbtn"), "A built-in has a switch, not an edit button");
  toggle.scrollIntoView({ block: "center" });
  click(page, toggle.buttonEl);
  await TestUtils.waitForCondition(() => WhimsyAICommands.get("improve").hidden, "Hidden in the store");
  await TestUtils.waitForCondition(() => row.hasAttribute("data-off"), "The row dims");
  is(page.doc.querySelector('.whimsy-commands-row[data-command="improve"]'), row, "The row is updated in place");
  ok(toggle.isConnected && !toggle.pressed, "The switch stays where it was, off");
  click(page, toggle.buttonEl);
  await TestUtils.waitForCondition(() => !WhimsyAICommands.get("improve").hidden, "Shown again");
  await closePage(page);
});

add_task(async function delete_undo_cmd_z_on_settings_page() {
  await fresh();
  await WhimsyAICommands.save({ name: "Make it a post", result: "copy", prompt: "Rewrite {selection} as a post." });
  const page = await openCommands();
  const edit = await TestUtils.waitForCondition(() => page.doc.querySelector("#whimsyCommandsYours .whimsy-commands-iconbtn"), "Yours has an edit button");
  edit.scrollIntoView({ block: "center" });
  click(page, edit);
  await commandSheet(page);
  click(page, page.$("whimsyCommandDelete"));
  const toast = await TestUtils.waitForCondition(() => toastFor("whimsy-commands-deleted-toast"), "The Undo toast shows");
  ok(toast, "Deleted, with Undo");
  await TestUtils.waitForCondition(() => visible(page.$("whimsyCommandsEmpty")), "Yours is empty");
  is(WhimsyAICommands.list().filter(c => !c.builtIn).length, 0, "Gone from the store");
  await TestUtils.waitForCondition(() => page.doc.activeElement == page.$("whimsyCommandsNew"), "Focus lands on New command");
  EventUtils.synthesizeKey("z", { accelKey: true }, page.win);
  await TestUtils.waitForCondition(() => WhimsyAICommands.list().some(c => c.name == "Make it a post"), "⌘Z on the Settings page puts it back");
  await TestUtils.waitForCondition(() => page.doc.querySelector('#whimsyCommandsYours .whimsy-commands-row'), "and it's listed again");
  ok(!visible(page.$("whimsyCommandsEmpty")), "The empty row is gone");
  await closePage(page);
});

add_task(async function no_show_in_field() {
  await fresh();
  const page = await openCommands();
  click(page, page.$("whimsyCommandsNew"));
  const sheet = await commandSheet(page);
  is(page.$("whimsyAISheetTitle").textContent, "New command", "A new command");
  is(sheet.querySelectorAll('input[type="checkbox"], moz-checkbox, [role="checkbox"]').length, 0, "No Show in checkboxes");
  ok(!sheet.textContent.includes("Show in"), "No Show in label");
  is(page.doc.activeElement, page.$("whimsyCommandName"), "Name has focus");
  const order = [];
  for (let i = 0; i < 6; i++) {
    const node = page.doc.activeElement;
    order.push(node.id || node.dataset.result || node.textContent);
    EventUtils.synthesizeKey("KEY_Tab", {}, page.win);
  }
  Assert.deepEqual(order, ["whimsyCommandName", "copy", "whimsyCommandPrompt", "whimsyCommandModel", "Cancel", "whimsyCommandSave"], "Tab order: Name, Result, Prompt, Model, Cancel, Save");

  // Link swaps the prompt and model for an address.
  page.doc.querySelector('#whimsyCommandResult [data-result="copy"]').focus();
  EventUtils.synthesizeKey("KEY_ArrowRight", {}, page.win);
  is(page.doc.activeElement.dataset.result, "link", "→ moves the result");
  ok(!visible(page.$("whimsyCommandPrompt")) && !visible(page.$("whimsyCommandModel")), "Link has no prompt or model");
  ok(visible(page.$("whimsyCommandAddress")), "but an address");
  page.$("whimsyCommandName").focus();
  EventUtils.sendString("Wiki", page.win);
  page.$("whimsyCommandAddress").focus();
  EventUtils.sendString("https://en.wikipedia.org/wiki/Special:Search", page.win);
  click(page, page.$("whimsyCommandSave"));
  await TestUtils.waitForCondition(() => visible(page.$("whimsyCommandAddressError")), "The missing %s shows under the address");
  is(page.$("whimsyCommandAddressError").textContent, "Add %s where the selected text goes.", "It says what to add");
  is(page.doc.activeElement, page.$("whimsyCommandAddress"), "and focus stays there");
  is(page.$("whimsyCommandAddress").getAttribute("aria-invalid"), "true", "The field is marked");
  EventUtils.sendString("?search=%s", page.win);
  click(page, page.$("whimsyCommandSave"));
  await TestUtils.waitForCondition(() => !page.$("whimsyAISheet"), "Saved and closed");
  const made = WhimsyAICommands.list().find(c => c.name == "Wiki");
  is(made?.url, "https://en.wikipedia.org/wiki/Special:Search?search=%s", "The Link command is saved");
  await closePage(page);
});

add_task(async function prompt_tokens_are_chips() {
  await fresh();
  await WhimsyAICommands.save({ name: "Explain", result: "insert-after", prompt: "Explain {selection} from {page}." });
  const page = await openCommands();
  const edit = page.doc.querySelector("#whimsyCommandsYours .whimsy-commands-iconbtn");
  edit.scrollIntoView({ block: "center" });
  click(page, edit);
  await commandSheet(page);
  const prompt = page.$("whimsyCommandPrompt");
  Assert.deepEqual([...prompt.querySelectorAll(".whimsy-commands-token")].map(c => c.textContent), ["selection", "page"], "Stored tokens show as chips");
  is(prompt.textContent, "Explain selection from page.", "with plain text around them");

  // Backspace right after a chip takes the whole chip.
  prompt.focus();
  const last = prompt.lastChild;
  const range = page.doc.createRange();
  range.setStart(last, 0);
  range.collapse(true);
  page.win.getSelection().removeAllRanges();
  page.win.getSelection().addRange(range);
  EventUtils.synthesizeKey("KEY_Backspace", {}, page.win);
  Assert.deepEqual([...prompt.querySelectorAll(".whimsy-commands-token")].map(c => c.textContent), ["selection"], "The page chip went as one unit");

  // "{" offers the tokens; Enter picks the active one.
  EventUtils.sendString(" and {", page.win);
  const picker = await TestUtils.waitForCondition(() => page.$("whimsyCommandsTokens"), "Typing { opens the token picker");
  Assert.deepEqual([...picker.querySelectorAll('[role="option"]')].map(o => o.dataset.value), ["selection", "page", "link"], "Three tokens");
  is(page.doc.activeElement, prompt, "Focus stays in the prompt");
  EventUtils.synthesizeKey("KEY_ArrowDown", {}, page.win);
  EventUtils.synthesizeKey("KEY_ArrowDown", {}, page.win);
  is(prompt.getAttribute("aria-activedescendant"), "whimsyCommandsToken-link", "Arrows move through the tokens");
  EventUtils.synthesizeKey("KEY_Enter", {}, page.win);
  ok(!page.$("whimsyCommandsTokens"), "The picker closes");
  click(page, page.$("whimsyCommandSave"));
  await TestUtils.waitForCondition(() => !page.$("whimsyAISheet"), "Saved");
  is(WhimsyAICommands.list().find(c => c.name == "Explain").prompt, "Explain {selection} from  and {link}.", "Chips are stored as {token} text");
  await closePage(page);
});

add_task(async function save_as_command_on_a_reused_prompt() {
  await fresh();
  const msg = { id: "m-test", role: "ai", text: "An answer" };
  WhimsyAICommands._promptOf = new Map([["m-test", "Summarize this in three bullets"]]);
  const { WhimsyChat } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyChat.sys.mjs");
  ok(WhimsyChat.answerActions(msg).some(a => a.id == "save-command"), "An answer to a prompt sent before offers Save as a command");
  ok(!WhimsyChat.answerActions({ id: "m-other", role: "ai", text: "x" }).some(a => a.id == "save-command"), "A one-off doesn't");
  Services.prefs.setBoolPref("whimsy.ai.enabled", true);
  WhimsyChat.answerActions(msg).find(a => a.id == "save-command").run(window, msg);
  const tab = await TestUtils.waitForCondition(() => gBrowser.selectedBrowser.currentURI.spec.startsWith("about:preferences") && gBrowser.selectedTab, "Settings opens");
  await TestUtils.waitForCondition(() => tab.linkedBrowser.contentWindow?.WhimsyAISettings?.root, "Settings › AI is up");
  const win = tab.linkedBrowser.contentWindow;
  const sheet = await TestUtils.waitForCondition(() => win.document.getElementById("whimsyAISheet")?.dataset.sheet == "command" && win.document.getElementById("whimsyAISheet"), "The command sheet opens");
  is(win.document.getElementById("whimsyCommandPrompt").textContent, "Summarize this in three bullets", "with the prompt filled in");
  ok(sheet, "Save as a command opens the sheet");
  win.WhimsyAISettings.closeSheet({ restore: false });
  BrowserTestUtils.removeTab(tab);
  WhimsyAICommands._promptOf = new Map();
  restorePrefs();
});
