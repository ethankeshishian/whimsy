/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave7/small: Teach once hints for Link hints (Cmd+J) and Instant result
// (Shift+Enter). They register only when WhimsyTeach exists; their
// triggers are tested directly so the moments are right either way.

const { WhimsyTeachHints, HINTS, linkHintsTrigger, instantTrigger, instantUsed } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyTeachHints.sys.mjs"
);

function teachModule() {
  try {
    return ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyTeach.sys.mjs").WhimsyTeach;
  } catch (e) {
    return null;
  }
}

add_task(async function test_registers_only_with_teach() {
  const teach = teachModule();
  const registered = WhimsyTeachHints.init();
  if (!teach) {
    ok(!registered, "No WhimsyTeach in this build: nothing registers, nothing breaks");
    return;
  }
  ok(registered, "Registered with WhimsyTeach");
  for (const id of ["link-hints", "instant-result"]) {
    ok(teach.get(id), `${id} is in the registry`);
  }
  is(teach.get("link-hints").key, "key_whimsyLinkHints", "Link hints teaches Cmd+J's own <key>");
  ok(document.getElementById("key_whimsyLinkHints"), "and that key exists");
  ok(WhimsyTeachHints.init(), "A second init is a no-op");
});

add_task(async function test_hint_entries() {
  for (const hint of HINTS) {
    ok(hint.id && hint.l10nId && hint.trigger && hint.anchor, `${hint.id} is a full entry`);
    const [message] = await document.l10n.formatValues([{ id: hint.l10nId, args: { key: "K" } }]);
    ok(message?.includes("K"), `${hint.l10nId} names the key`);
    ok(hint.anchor(window, {}), `${hint.id} has something to point at`);
  }
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.link-hints", false], ["whimsy.feature.instant-result", false]] });
  for (const hint of HINTS) {
    ok(!hint.isAvailable(window), `${hint.id} follows its feature's switch`);
  }
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_quick_find_links_triggers_link_hints() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  let shown = 0;
  const cleanup = linkHintsTrigger(window, () => shown++);
  const findbar = await gBrowser.getFindBar();
  findbar.open(findbar.FIND_NORMAL);
  await TestUtils.waitForTick();
  is(shown, 0, "Plain Find isn't the moment");
  findbar.close(true);
  findbar.open(findbar.FIND_LINKS);
  await TestUtils.waitForCondition(() => shown == 1, "Quick Find (links only) is");
  findbar.close(true);
  cleanup();
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_plain_enter_on_a_search_triggers_instant() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
  let shown = 0;
  let used = 0;
  const cleanup = instantTrigger(window, () => shown++);
  const cleanupUsed = instantUsed(window, () => used++);
  gURLBar.focus();
  gURLBar.value = "https://example.com/";
  const input = gURLBar.inputField;
  const press = init =>
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init }));
  // An address isn't a search: Instant result has nothing to skip.
  const original = WhimsySearchDeckInstant(null);
  press({});
  is(shown, 0, "Enter on an address isn't the moment");
  WhimsySearchDeckInstant({ query: "cats", url: "https://example.com/?q=cats" });
  press({ shiftKey: true });
  is(shown, 0, "Shift+Enter isn't plain Enter");
  is(used, 1, "and counts as knowing it");
  press({});
  is(shown, 1, "Plain Enter on a search is the moment");
  WhimsySearchDeckInstant(original);
  cleanup();
  cleanupUsed();
  gURLBar.handleRevert();
  BrowserTestUtils.removeTab(tab);
});

// Swaps WhimsySearchDeck.instantQuery for a fixed answer; returns the old one.
function WhimsySearchDeckInstant(answer) {
  const { WhimsySearchDeck } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySearchDeck.sys.mjs");
  const previous = WhimsySearchDeck.instantQuery;
  if (typeof answer == "function") {
    WhimsySearchDeck.instantQuery = answer;
  } else {
    WhimsySearchDeck.instantQuery = () => answer;
  }
  return previous;
}
