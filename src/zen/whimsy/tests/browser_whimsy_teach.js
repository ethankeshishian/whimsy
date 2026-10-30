/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Teach once (whimsy.feature.teach-once). A hint shows once, anchored, with
// the live shortcut as a key cap; Esc, the close button and the switch work;
// it never reappears (the synced pref remembers it); pressing its shortcut
// retires it unseen; one a minute, never stacked, never during onboarding,
// never under automation unless asked; "Reset Tips" brings hints back; a
// registry trigger (on()) fires it; and every built-in hint has its string
// and a real <key>.

const { WhimsyTeach, HINTS, on } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyTeach.sys.mjs");

const SEEN_PREF = "whimsy.teach.seen";
const ENABLED_PREF = "whimsy.teach.enabled";
const FEATURE_PREF = "whimsy.feature.teach-once";
const KEY_ID = "whimsy-teach-test-key";
const COMMAND_ID = "cmd_whimsyTeachTest";

const HINT_A = "test-teach-a";
const HINT_B = "test-teach-b";
const HINT_EVENT = "test-teach-event";

function hint(id, extra = {}) {
  return {
    id,
    l10nId: "whimsy-teach-pin",
    key: KEY_ID,
    anchor: () => gBrowser.selectedTab,
    ...extra,
  };
}

async function shown(panel) {
  ok(panel, "the hint opened");
  if (panel.state != "open") {
    await BrowserTestUtils.waitForPopupEvent(panel, "shown");
  }
  is(panel.state, "open", "the hint is open");
  return panel;
}

async function hidden(panel) {
  if (panel.isConnected && panel.state != "closed") {
    await BrowserTestUtils.waitForPopupEvent(panel, "hidden");
  }
  ok(!panel.isConnected, "the hint is gone once hidden");
}

add_setup(async () => {
  await SpecialPowers.pushPrefEnv({
    set: [
      [SEEN_PREF, ""],
      [ENABLED_PREF, true],
      [FEATURE_PREF, true],
      ["zen.welcome-screen.seen", true],
    ],
  });
  await SimpleTest.promiseFocus(window);

  // A command and a <key> to teach.
  const command = document.createXULElement("command");
  command.id = COMMAND_ID;
  command.addEventListener("command", () => {});
  document.getElementById("mainCommandSet").append(command);
  const keyset = document.createXULElement("keyset");
  keyset.id = "whimsy-teach-test-keyset";
  const key = document.createXULElement("key");
  key.id = KEY_ID;
  key.setAttribute("key", "Y");
  key.setAttribute("modifiers", "accel,alt,shift");
  key.setAttribute("command", COMMAND_ID);
  keyset.append(key);
  document.documentElement.append(keyset);

  WhimsyTeach.allowInAutomation = true;
  WhimsyTeach.register(hint(HINT_A));
  WhimsyTeach.register(hint(HINT_B));
  WhimsyTeach._resetSession();

  registerCleanupFunction(() => {
    WhimsyTeach.allowInAutomation = false;
    WhimsyTeach._resetSession();
    for (const id of [HINT_A, HINT_B, HINT_EVENT]) {
      WhimsyTeach.unregister(id);
    }
    keyset.remove();
    command.remove();
  });
});

add_task(async function test_registry() {
  const ids = HINTS.map(h => h.id);
  is(new Set(ids).size, ids.length, "hint ids are unique");
  for (const h of HINTS.filter(h => !h.id.startsWith("test-"))) {
    const text = await document.l10n.formatValue(h.l10nId, { key: "⌘X" });
    ok(text?.includes("⌘X"), `${h.id}: its string exists and shows the key`);
    ok(typeof h.trigger == "function" && typeof h.anchor == "function", `${h.id}: has a trigger and an anchor`);
    if (typeof h.key == "string" && (h.window ?? "main") == "main") {
      ok(document.getElementById(h.key)?.localName == "key", `${h.id}: teaches a real <key> (${h.key})`);
    }
  }
  ok(document.getElementById("cmd_whimsyTeachReset"), "Reset Tips is a registered command");
});

add_task(async function test_shows_once_and_esc_dismisses() {
  WhimsyTeach._resetSession();
  const panel = await shown(await WhimsyTeach.trigger(window, HINT_A));
  is(panel.anchorNode, gBrowser.selectedTab, "it points at its anchor");
  const text = panel.querySelector(".whimsy-teach-text");
  const kbd = text.querySelector("kbd");
  ok(kbd?.textContent.includes("Y"), `the live shortcut is a key cap (${kbd?.textContent})`);
  ok(panel.querySelector(".whimsy-teach-close")?.getAttribute("aria-label"), "the close button has a name");
  ok(WhimsyTeach.hasSeen(HINT_A), "it's remembered as soon as it shows");
  ok(Services.prefs.getStringPref(SEEN_PREF).split(",").includes(HINT_A), "in the synced pref");
  isnot(document.activeElement?.closest?.("panel"), panel, "it doesn't take focus");

  EventUtils.synthesizeKey("KEY_Escape");
  await hidden(panel);

  WhimsyTeach._resetSession();
  is(await WhimsyTeach.trigger(window, HINT_A), null, "it never shows again");
  ok(!document.getElementById("whimsy-teach"), "no hint is open");
});

add_task(async function test_close_button_and_auto_dismissals() {
  WhimsyTeach._resetSession();
  const panel = await shown(await WhimsyTeach.trigger(window, HINT_B));
  EventUtils.synthesizeMouseAtCenter(panel.querySelector(".whimsy-teach-close"), {});
  await hidden(panel);
  ok(WhimsyTeach.hasSeen(HINT_B), "dismissing keeps it seen");
});

add_task(async function test_tab_switch_dismisses() {
  Services.prefs.setStringPref(SEEN_PREF, "");
  WhimsyTeach._resetSession();
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  const panel = await shown(await WhimsyTeach.trigger(window, HINT_A));
  await BrowserTestUtils.switchTab(gBrowser, gBrowser.tabs.find(t => t != tab && !t.pinned) ?? gBrowser.tabs[0]);
  await hidden(panel);
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_one_a_minute_never_stacked() {
  Services.prefs.setStringPref(SEEN_PREF, "");
  WhimsyTeach._resetSession();
  const panel = await shown(await WhimsyTeach.trigger(window, HINT_A));

  WhimsyTeach._lastShownAt = 0;
  is(await WhimsyTeach.trigger(window, HINT_B), null, "not while another hint is open");
  ok(!WhimsyTeach.hasSeen(HINT_B), "and that one isn't used up");

  WhimsyTeach.dismiss();
  await hidden(panel);
  WhimsyTeach._lastShownAt = Date.now();
  is(await WhimsyTeach.trigger(window, HINT_B), null, "not within a minute of the last one");
  ok(!WhimsyTeach.hasSeen(HINT_B), "still not used up");
});

add_task(async function test_switches() {
  Services.prefs.setStringPref(SEEN_PREF, "");
  WhimsyTeach._resetSession();

  await SpecialPowers.pushPrefEnv({ set: [[ENABLED_PREF, false]] });
  is(await WhimsyTeach.trigger(window, HINT_A), null, "Show tips off: nothing");
  await SpecialPowers.popPrefEnv();

  await SpecialPowers.pushPrefEnv({ set: [[FEATURE_PREF, false]] });
  is(await WhimsyTeach.trigger(window, HINT_A), null, "feature switch off: nothing");
  await SpecialPowers.popPrefEnv();

  WhimsyTeach.allowInAutomation = false;
  is(await WhimsyTeach.trigger(window, HINT_A), null, "under automation: nothing unless asked");
  WhimsyTeach.allowInAutomation = true;

  document.documentElement.setAttribute("zen-welcome-stage", "true");
  is(await WhimsyTeach.trigger(window, HINT_A), null, "during onboarding: nothing");
  document.documentElement.removeAttribute("zen-welcome-stage");

  ok(!WhimsyTeach.hasSeen(HINT_A), "none of that used the hint up");

  // Turning tips off closes an open one.
  const panel = await shown(await WhimsyTeach.trigger(window, HINT_A));
  await SpecialPowers.pushPrefEnv({ set: [[ENABLED_PREF, false]] });
  await hidden(panel);
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_using_the_shortcut_retires_it() {
  Services.prefs.setStringPref(SEEN_PREF, "");
  WhimsyTeach._resetSession();
  document.getElementById(KEY_ID).doCommand();
  ok(WhimsyTeach.hasSeen(HINT_A), "pressing the shortcut counts as knowing it");
  ok(WhimsyTeach.hasSeen(HINT_B), "for every hint that teaches it");
  is(await WhimsyTeach.trigger(window, HINT_A), null, "so it's never shown");
});

add_task(async function test_unbound_key_waits() {
  Services.prefs.setStringPref(SEEN_PREF, "");
  WhimsyTeach._resetSession();
  const key = document.getElementById(KEY_ID);
  key.removeAttribute("key");
  is(await WhimsyTeach.trigger(window, HINT_A), null, "no shortcut to teach: no hint");
  ok(!WhimsyTeach.hasSeen(HINT_A), "it waits until there is one");
  key.setAttribute("key", "Y");
});

add_task(async function test_reset_tips() {
  Services.prefs.setStringPref(SEEN_PREF, `${HINT_A},${HINT_B}`);
  WhimsyTeach._lastShownAt = Date.now();
  document.getElementById("cmd_whimsyTeachReset").doCommand();
  is(Services.prefs.getStringPref(SEEN_PREF), "", "Reset Tips forgets every hint");
  const panel = await shown(await WhimsyTeach.trigger(window, HINT_A));
  WhimsyTeach.dismiss();
  await hidden(panel);
});

add_task(async function test_registry_trigger() {
  Services.prefs.setStringPref(SEEN_PREF, "");
  WhimsyTeach._resetSession();
  WhimsyTeach.register(hint(HINT_EVENT, { trigger: on(win => win, "WhimsyTeachTestEvent") }));
  const opened = BrowserTestUtils.waitForEvent(document, "popupshown", false, e => e.target.id == "whimsy-teach");
  window.dispatchEvent(new CustomEvent("WhimsyTeachTestEvent"));
  const event = await opened;
  is(event.target.dataset.hint, HINT_EVENT, "one registry entry: its trigger shows it");
  WhimsyTeach.dismiss();
  await hidden(event.target);

  // Once seen, its trigger is disarmed.
  WhimsyTeach._resetSession();
  window.dispatchEvent(new CustomEvent("WhimsyTeachTestEvent"));
  await new Promise(resolve => setTimeout(resolve, 500));
  ok(!document.getElementById("whimsy-teach"), "a seen hint's trigger does nothing");
});
