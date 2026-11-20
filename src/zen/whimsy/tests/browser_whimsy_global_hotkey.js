/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W29: the shortcut that opens Mini Whimsy from any app. The Carbon hot
// key itself (hotkey/nsWhimsyGlobalHotKey.mm) is replaced with a fake, so
// this covers the shortcut format, macOS's reserved keys, registering
// with the setting, the press opening and closing the bar-only Mini, the
// Settings recorder, and the onboarding step. Registering a real key needs
// a hand check (press it in another app).

const {
  WhimsyGlobalHotKey,
  MOD,
  ENABLED_PREF,
  KEY_PREF,
  parseShortcut,
  serializeShortcut,
  displayShortcut,
  isAllowed,
} = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyGlobalHotKey.sys.mjs");
const { WhimsyQuickWindow } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyQuickWindow.sys.mjs");
const { WhimsyWelcome } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyWelcome.sys.mjs");

// A stand-in for nsIWhimsyGlobalHotKey. Keys in `taken` belong to "another app".
class FakeHotKey {
  constructor() {
    this.current = null;
    this.taken = new Set();
    this.system = [];
    this.activated = 0;
    this.restored = 0;
  }
  register(code, modifiers) {
    const key = `${modifiers}:${code}`;
    if (this.taken.has(key)) {
      return "taken";
    }
    this.current = key;
    return "ok";
  }
  unregister() {
    this.current = null;
  }
  get registered() {
    return !!this.current;
  }
  get systemHotKeys() {
    return JSON.stringify(this.system);
  }
  activate() {
    this.activated++;
  }
  restorePreviousApp() {
    this.restored++;
  }
}

let fake;
let realNative;

add_setup(async function () {
  realNative = WhimsyGlobalHotKey._native;
  fake = new FakeHotKey();
  WhimsyGlobalHotKey._native = fake;
  await SpecialPowers.pushPrefEnv({
    set: [
      ["whimsy.feature.global-hotkey", true],
      [ENABLED_PREF, false],
    ],
  });
  Services.prefs.clearUserPref(KEY_PREF);
  WhimsyGlobalHotKey.uninit();
  WhimsyGlobalHotKey.init();
});

registerCleanupFunction(async () => {
  for (const win of WhimsyQuickWindow.windows()) {
    await BrowserTestUtils.closeWindow(win);
  }
  Services.prefs.clearUserPref(KEY_PREF);
  Services.prefs.clearUserPref(ENABLED_PREF);
  WhimsyGlobalHotKey.uninit();
  WhimsyGlobalHotKey._native = realNative;
  WhimsyGlobalHotKey.init();
});

add_task(function test_shortcut_format() {
  Assert.deepEqual(parseShortcut("Alt+Space"), { code: "Space", modifiers: MOD.Alt }, "⌥Space parses");
  Assert.deepEqual(parseShortcut("F5"), { code: "F5", modifiers: 0 }, "an F-key alone parses");
  is(parseShortcut("Hyper+KeyK"), null, "an unknown modifier doesn't");
  is(parseShortcut(""), null, "nothing is no shortcut");
  is(serializeShortcut({ code: "KeyK", modifiers: MOD.Shift | MOD.Cmd }), "Cmd+Shift+KeyK", "stored modifiers first");
  is(displayShortcut({ code: "KeyK", modifiers: MOD.Cmd | MOD.Shift | MOD.Alt | MOD.Ctrl }), "⌃⌥⇧⌘K", "Apple's order");
  is(displayShortcut({ code: "Space", modifiers: MOD.Alt }), "⌥Space", "⌥Space shows as such");
  ok(isAllowed({ code: "Space", modifiers: MOD.Alt }), "⌥ is enough");
  ok(isAllowed({ code: "F6", modifiers: 0 }), "an F-key needs nothing");
  ok(!isAllowed({ code: "KeyK", modifiers: MOD.Shift }), "⇧ alone isn't enough");
  ok(!isAllowed({ code: "KeyK", modifiers: 0 }), "a bare letter isn't allowed");
});

add_task(function test_macos_reserved_keys() {
  fake.system = [];
  is(WhimsyGlobalHotKey.systemConflict({ code: "Space", modifiers: MOD.Cmd })?.feature, "spotlight", "⌘Space is Spotlight by default");
  is(WhimsyGlobalHotKey.systemConflict({ code: "Space", modifiers: MOD.Alt }), null, "⌥Space is free on a stock Mac");

  // The user turned Spotlight's shortcut off and moved Input Sources to ⌥Space.
  fake.system = [
    { id: 64, code: "Space", modifiers: MOD.Cmd, enabled: false },
    { id: 60, code: "Space", modifiers: MOD.Alt, enabled: true },
  ];
  is(WhimsyGlobalHotKey.systemConflict({ code: "Space", modifiers: MOD.Cmd }), null, "a turned-off macOS shortcut is free");
  is(
    WhimsyGlobalHotKey.systemConflict({ code: "Space", modifiers: MOD.Alt })?.feature,
    "input-sources",
    "what the user set in System Settings counts"
  );
  is(WhimsyGlobalHotKey.check({ code: "Space", modifiers: MOD.Alt }).result, "system", "check refuses it");
  is(WhimsyGlobalHotKey.check({ code: "KeyK", modifiers: MOD.Shift }).result, "not-allowed", "and ⇧K");
  fake.system = [];
});

add_task(async function test_registers_with_the_setting() {
  Services.prefs.clearUserPref(KEY_PREF);
  ok(!fake.registered, "nothing registered while the setting is off");
  Services.prefs.setBoolPref(ENABLED_PREF, true);
  is(fake.current, `${MOD.Alt}:Space`, "⌥Space registers when it's turned on");
  Services.prefs.setStringPref(KEY_PREF, "Ctrl+Alt+KeyM");
  is(fake.current, `${MOD.Ctrl | MOD.Alt}:KeyM`, "a new shortcut replaces it");
  Services.prefs.setStringPref(KEY_PREF, "");
  ok(!fake.registered, "clearing the shortcut lets the key go");
  Services.prefs.clearUserPref(KEY_PREF);
  is(fake.current, `${MOD.Alt}:Space`, "back to ⌥Space");
  Services.prefs.setBoolPref(ENABLED_PREF, false);
  ok(!fake.registered, "turning it off lets the key go");
});

add_task(async function test_press_opens_and_closes_the_bar() {
  const before = fake.activated;
  const opened = BrowserTestUtils.waitForNewWindow();
  Services.obs.notifyObservers(null, "whimsy-global-hotkey");
  const win = await opened;
  ok(win._whimsyMiniBarOnly, "the press opens Mini's bar-only panel");
  ok(WhimsyQuickWindow.windows().includes(win), "it's a Mini window");
  is(fake.activated, before + 1, "Whimsy comes forward for it");

  const restored = fake.restored;
  const closed = BrowserTestUtils.domWindowClosed(win);
  Services.obs.notifyObservers(null, "whimsy-global-hotkey");
  await closed;
  await TestUtils.waitForCondition(() => fake.restored == restored + 1, "the app that was in front gets focus back");

  // Esc closes it the same way.
  const again = BrowserTestUtils.waitForNewWindow();
  Services.obs.notifyObservers(null, "whimsy-global-hotkey");
  const second = await again;
  await SimpleTest.promiseFocus(second);
  const escClosed = BrowserTestUtils.domWindowClosed(second);
  EventUtils.synthesizeKey("KEY_Escape", {}, second);
  await escClosed;
  await TestUtils.waitForCondition(() => fake.restored == restored + 2, "Esc hands focus back too");
});

add_task(async function test_settings_recorder() {
  Services.prefs.clearUserPref(KEY_PREF);
  Services.prefs.setBoolPref(ENABLED_PREF, false);
  await BrowserTestUtils.withNewTab("about:preferences#zenLooks", async browser => {
    const doc = browser.contentDocument;
    const win = browser.contentWindow;
    const field = await TestUtils.waitForCondition(() => doc.getElementById("whimsyGlobalHotKeyField"), "the field is built");
    const box = doc.getElementById("whimsyGlobalHotKey");
    const error = doc.getElementById("whimsyGlobalHotKeyError");
    ok(!box.checked, "off by default");
    ok(field.classList.contains("is-disabled"), "the field is dimmed while it's off");
    is(field.querySelector("kbd")?.textContent, "⌥Space", "it shows ⌥Space");

    box.click();
    await TestUtils.waitForCondition(() => Services.prefs.getBoolPref(ENABLED_PREF), "ticking the box turns it on");
    await TestUtils.waitForCondition(() => !field.classList.contains("is-disabled"), "and wakes the field");

    // Clear: the key goes, the box stays ticked.
    field.querySelector(".whimsy-hotkey-clear").click();
    is(Services.prefs.getStringPref(KEY_PREF), "", "clearing forgets the shortcut");
    ok(box.checked, "but leaves the box ticked");
    ok(!fake.registered, "and lets the key go");

    field.click();
    ok(field.classList.contains("is-recording"), "clicking the field records");
    const placeholder = field.querySelector(".whimsy-hotkey-placeholder");
    is(placeholder?.getAttribute("data-l10n-id"), "whimsy-look-global-hotkey-recording", "it says Press a shortcut");

    EventUtils.synthesizeKey("k", { shiftKey: true }, win);
    await TestUtils.waitForCondition(() => !error.hidden, "⇧K is refused");
    is(error.getAttribute("data-l10n-id"), "whimsy-look-global-hotkey-not-allowed", "with Key cannot be used");

    EventUtils.synthesizeKey(" ", { metaKey: true }, win);
    await TestUtils.waitForCondition(
      () => error.getAttribute("data-l10n-id") == "whimsy-look-global-hotkey-system",
      "⌘Space is macOS's"
    );
    is(JSON.parse(error.getAttribute("data-l10n-args")).feature, "spotlight", "named as Spotlight");

    fake.taken.add(`${MOD.Ctrl | MOD.Alt}:KeyJ`);
    EventUtils.synthesizeKey("j", { ctrlKey: true, altKey: true }, win);
    await TestUtils.waitForCondition(
      () => error.getAttribute("data-l10n-id") == "whimsy-look-global-hotkey-taken",
      "another app's key is refused"
    );
    is(Services.prefs.getStringPref(KEY_PREF), "", "and isn't stored");

    EventUtils.synthesizeKey("m", { ctrlKey: true, altKey: true }, win);
    await TestUtils.waitForCondition(() => Services.prefs.getStringPref(KEY_PREF) == "Ctrl+Alt+KeyM", "⌃⌥M is stored");
    ok(error.hidden, "the message goes");
    ok(!field.classList.contains("is-recording"), "recording stops");
    is(field.querySelector("kbd")?.textContent, "⌃⌥M", "the field shows it");
    is(fake.current, `${MOD.Ctrl | MOD.Alt}:KeyM`, "and it's registered");

    field.click();
    EventUtils.synthesizeKey("KEY_Escape", {}, win);
    ok(!field.classList.contains("is-recording"), "Esc stops recording");
    is(Services.prefs.getStringPref(KEY_PREF), "Ctrl+Alt+KeyM", "and keeps the shortcut");
    is(fake.current, `${MOD.Ctrl | MOD.Alt}:KeyM`, "registered again");
  });
  fake.taken.clear();
  Services.prefs.clearUserPref(KEY_PREF);
  Services.prefs.setBoolPref(ENABLED_PREF, false);
});

function onboardingPage() {
  const pages = WhimsyWelcome.extendPages(window, [{ id: "search" }, { id: "essentials" }, { id: "finish" }], {
    kNextButton: { l10n: "next" },
    createOption({ id, group, checked, l10n }) {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "radio";
      input.id = id;
      input.name = group;
      input.checked = !!checked;
      label.append(input);
      const text = document.createElement("span");
      text.className = "zen-welcome-option-label";
      text.setAttribute("data-l10n-id", l10n);
      label.append(text);
      return label;
    },
  });
  const ids = pages.map(page => page.id);
  is(ids.indexOf("whimsy-global-hotkey"), ids.indexOf("essentials") - 1, "the step comes right before Essentials");
  return pages.find(page => page.id == "whimsy-global-hotkey");
}

add_task(async function test_onboarding_step() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.ai-onboarding", false]] });
  Services.prefs.clearUserPref(KEY_PREF);
  Services.prefs.setBoolPref(ENABLED_PREF, false);

  // O.1: ⌥Space is free, Yes is picked.
  let page = onboardingPage();
  ok(!page.skip(), "shown when ⌥Space is free");
  ok(!fake.registered, "trying the key doesn't keep it");
  Assert.deepEqual(page.descriptions, ["whimsy-welcome-hotkey-description"], "the ⌥Space line");
  let content = document.createElement("div");
  page.render(content);
  const yes = content.querySelector("#whimsy-welcome-hotkey-yes");
  ok(yes.checked, "Yes is picked");
  is(yes.nextElementSibling.getAttribute("data-l10n-id"), "whimsy-welcome-hotkey-yes", "YES, use ⌥Space.");
  ok(!content.querySelector(".whimsy-welcome-hotkey-taken"), "no taken line");
  page.commit(content);
  ok(Services.prefs.getBoolPref(ENABLED_PREF), "Next turns it on");
  ok(!Services.prefs.prefHasUserValue(KEY_PREF), "with the default ⌥Space");
  is(fake.current, `${MOD.Alt}:Space`, "registered");

  // No turns it off.
  page = onboardingPage();
  content = document.createElement("div");
  page.render(content);
  content.querySelector("#whimsy-welcome-hotkey-no").checked = true;
  page.commit(content);
  ok(!Services.prefs.getBoolPref(ENABLED_PREF), "No leaves it off");
  ok(!fake.registered, "and nothing is registered");

  // O.2: another app holds ⌥Space.
  fake.taken.add(`${MOD.Alt}:Space`);
  page = onboardingPage();
  ok(!page.skip(), "still shown");
  Assert.deepEqual(page.descriptions, ["whimsy-welcome-hotkey-description-fallback"], "the ⌥⇧Space line");
  content = document.createElement("div");
  page.render(content);
  is(
    content.querySelector("#whimsy-welcome-hotkey-yes").nextElementSibling.getAttribute("data-l10n-id"),
    "whimsy-welcome-hotkey-yes-fallback",
    "YES, use ⌥⇧Space."
  );
  ok(content.querySelector(".whimsy-welcome-hotkey-taken"), "says another app is using ⌥Space");
  page.commit(content);
  is(Services.prefs.getStringPref(KEY_PREF), "Alt+Shift+Space", "stores ⌥⇧Space");
  ok(Services.prefs.getBoolPref(ENABLED_PREF), "and turns it on");

  // Both taken: skipped.
  Services.prefs.setBoolPref(ENABLED_PREF, false);
  fake.taken.add(`${MOD.Alt | MOD.Shift}:Space`);
  page = onboardingPage();
  ok(page.skip(), "skipped when both are taken");

  fake.taken.clear();
  Services.prefs.clearUserPref(KEY_PREF);
  await SpecialPowers.popPrefEnv();
});
