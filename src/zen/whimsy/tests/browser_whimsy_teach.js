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
  // The hints point at the selected tab: start from a real, visible one
  // (an earlier test file may leave Zen's hidden empty tab selected).
  const anchorTab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
  registerCleanupFunction(() => BrowserTestUtils.removeTab(anchorTab));

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
  // A real tab to switch to: not Zen's hidden empty tab, which would leave
  // later hints nothing visible to point at.
  await BrowserTestUtils.switchTab(gBrowser,
    gBrowser.tabs.find(t => t != tab && !t.pinned && !t.hasAttribute("zen-empty-tab")) ?? gBrowser.tabs[0]);
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

// wave9/designfix (M11): Esc closes the tip but still reaches whatever it
// was meant for (a page's dialog, the find bar, the address bar).
add_task(async function test_esc_is_not_taken() {
  Services.prefs.setStringPref(SEEN_PREF, "");
  WhimsyTeach._resetSession();
  const panel = await shown(await WhimsyTeach.trigger(window, HINT_A));
  let seen = null;
  const listener = event => {
    if (event.key == "Escape") {
      seen = { prevented: event.defaultPrevented };
    }
  };
  document.addEventListener("keydown", listener);
  EventUtils.synthesizeKey("KEY_Escape");
  document.removeEventListener("keydown", listener);
  await hidden(panel);
  ok(seen, "the Esc went on past the tip");
  ok(!seen?.prevented, "and wasn't cancelled");
});

// wave9/designfix (H2): "Turn Off Tips" on the tip itself; its toast undoes.
add_task(async function test_turn_off_from_the_tip() {
  Services.prefs.setStringPref(SEEN_PREF, "");
  WhimsyTeach._resetSession();
  const panel = await shown(await WhimsyTeach.trigger(window, HINT_A));
  const off = panel.querySelector(".whimsy-teach-off");
  ok(off, "the tip has a Turn Off Tips button");
  is(off.textContent, "Turn Off Tips", "it says so in words");
  EventUtils.synthesizeMouseAtCenter(off, {});
  await hidden(panel);
  ok(!Services.prefs.getBoolPref(ENABLED_PREF), "tips are off");
  const toast = await TestUtils.waitForCondition(() => currentToast(), "a toast says so");
  await TestUtils.waitForCondition(
    () => toast.element.querySelector("label")?.textContent.includes("Look and Feel"),
    "and says where to turn them on again"
  );
  Services.prefs.setStringPref(SEEN_PREF, "");
  WhimsyTeach._resetSession();
  is(await WhimsyTeach.trigger(window, HINT_A), null, "no more tips");

  const undo = toast.element.querySelector(".whimsy-toast-button");
  ok(undo, "the toast offers Undo");
  undo.click();
  ok(Services.prefs.getBoolPref(ENABLED_PREF), "Undo turns tips back on");
  Services.prefs.setBoolPref(ENABLED_PREF, true);
});

// W10-58: opening the command bar with the mouse (the New Tab button, or a
// click in the address bar) is the slow way to do what ⌘T / ⌘L do. Once it
// closes again, one hint names the shortcut; the keyboard never triggers
// it; and it shows only once.
async function openAndCloseCommandBar(target) {
  if (target) {
    // A click: a mousedown held on the New Tab button would open its
    // long-press menu (new-tab-popup) instead.
    target.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true, composed: true }));
    target.dispatchEvent(new MouseEvent("mouseup", { button: 0, bubbles: true, composed: true }));
  }
  gURLBar.focus();
  // Right after the last hint, Zen can float the bar and let it go again
  // (W10-27's close then runs); focus it again once that's over.
  await TestUtils.waitForCondition(() => {
    if (!gURLBar.focused) {
      gURLBar.focus();
    }
    return gURLBar.focused;
  }, "the command bar has focus");
  gURLBar.view.close();
  gBrowser.selectedBrowser.focus();
  await TestUtils.waitForCondition(() => !gURLBar.focused, "the command bar closed");
  // W10-27: and has finished animating out.
  await TestUtils.waitForCondition(() => gURLBar.getAttribute("zen-floating-urlbar") != "true", "the command bar is hidden");
}

async function expectHint(id) {
  const event = await BrowserTestUtils.waitForEvent(document, "popupshown", false, e => e.target.id == "whimsy-teach");
  is(event.target.dataset.hint, id, `${id}: the hint shows`);
  return event.target;
}

add_task(async function test_w10_58_command_bar_by_mouse() {
  for (const id of ["command-bar-new-tab", "command-bar-address"]) {
    ok(WhimsyTeach.get(id), `${id} is registered`);
  }
  Services.prefs.setStringPref(SEEN_PREF, "");
  WhimsyTeach._resetSession();

  // The keyboard (⌘L, ⌘T) opens it: nothing to teach.
  await openAndCloseCommandBar(null);
  await new Promise(resolve => setTimeout(resolve, 1000));
  ok(!document.getElementById("whimsy-teach"), "Opening it from the keyboard shows no hint");

  // The New Tab button.
  const button = [...document.querySelectorAll("#tabs-newtab-button, #new-tab-button")].find(b => b.checkVisibility()) ??
    document.querySelector("#tabs-newtab-button, #new-tab-button");
  ok(button, "there is a New Tab button");
  let opened = expectHint("command-bar-new-tab");
  await openAndCloseCommandBar(button);
  let panel = await shown(await opened);
  const text = panel.textContent;
  const keyLabel = WhimsyTeach.keyLabel(window, WhimsyTeach.get("command-bar-new-tab"));
  ok(keyLabel && text.includes(keyLabel), `It names the shortcut (${keyLabel})`);
  WhimsyTeach.dismiss();
  await hidden(panel);
  ok(WhimsyTeach.hasSeen("command-bar-new-tab"), "and is used up");

  // A click in the address bar teaches ⌘L.
  WhimsyTeach._resetSession();
  opened = expectHint("command-bar-address");
  await openAndCloseCommandBar(gURLBar.inputField);
  panel = await shown(await opened);
  WhimsyTeach.dismiss();
  await hidden(panel);

  // Only once.
  WhimsyTeach._resetSession();
  await openAndCloseCommandBar(button);
  await openAndCloseCommandBar(gURLBar.inputField);
  await new Promise(resolve => setTimeout(resolve, 1200));
  ok(!document.getElementById("whimsy-teach"), "Neither hint shows a second time");
});

add_task(async function test_w10_58_pressing_the_shortcut_retires_it() {
  Services.prefs.setStringPref(SEEN_PREF, "");
  WhimsyTeach._resetSession();
  WhimsyTeach.noteKey("key_newNavigatorTab");
  WhimsyTeach.noteKey("focusURLBar");
  ok(WhimsyTeach.hasSeen("command-bar-new-tab"), "⌘T retires the New Tab hint");
  ok(WhimsyTeach.hasSeen("command-bar-address"), "⌘L retires the address bar hint");
  Services.prefs.setStringPref(SEEN_PREF, "");
});
