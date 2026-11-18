/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "head_cmd_tab_numbers.js", this);

// A hint sits only on a visible tab row, inside it, never on another row
// (the Space header, a collapsed pinned section, a folder header).
add_task(async function hints_only_on_visible_tab_rows() {
  const pins = win.gZenWorkspaces.activeWorkspaceElement?.collapsiblePins;
  ok(pins, "The space has a collapsible pinned section");
  try {
    for (const collapse of [false, true]) {
      pins.collapsed = collapse;
      await TestUtils.waitForCondition(() => pins.collapsed == collapse, "The pinned section changed");
      await new Promise(resolve => win.requestAnimationFrame(() => win.requestAnimationFrame(resolve)));
      await new Promise(resolve => win.setTimeout(resolve, 400)); // eslint-disable-line mozilla/no-arbitrary-setTimeout
      await hold();
      await TestUtils.waitForCondition(() => win.getComputedStyle(Numbers.layer(win)).opacity == "1", "Hints faded in");
      const state = collapse ? "collapsed" : "expanded";
      let shown = 0;
      for (const [tab] of Numbers.targets(win)) {
        const node = badge(tab);
        if (!node || node.hidden) {
          continue;
        }
        shown++;
        const h = node.getBoundingClientRect();
        const t = tab.getBoundingClientRect();
        ok(h.width > 0 && h.left >= t.left && h.right <= t.right && h.top >= t.top && h.bottom <= t.bottom,
          `Pinned section ${state}: hint "${node.textContent}" sits inside its tab's row ` +
          `(hint ${[h.left, h.top, h.right, h.bottom].map(Math.round)}, tab ${[t.left, t.top, t.right, t.bottom].map(Math.round)})`);
        for (const [x, y] of [[h.left + 1, h.top + 1], [h.right - 1, h.bottom - 1], [h.left + h.width / 2, h.top + h.height / 2]]) {
          const hit = win.document.elementFromPoint(x, y);
          is(hit?.closest(".tabbrowser-tab"), tab, `Pinned section ${state}: hint "${node.textContent}" overlaps only its own tab row`);
        }
      }
      ok(shown > 0, `Pinned section ${state}: some hints show`);
      if (collapse) {
        ok(!badge(pinned) || badge(pinned).hidden, "A pinned tab in a collapsed section shows no hint");
      }
      release();
    }
  } finally {
    release();
    pins.collapsed = false;
  }
});

add_task(async function real_digits_match_badges() {
  await hold();
  ok(badge(essential), "Essentials follow the native shortcut order");
  ok(badge(pinned), "Pinned tabs follow the native shortcut order");
  release();
  await assertShortcutTargets();
});

add_task(async function chrome_document_blur_preserves_hold() {
  key("KEY_Meta", { type: "keydown", metaKey: true });
  try {
    // A document blur is not a window blur. Window blur deliberately resets
    // the chord (covered below); handing focus to content must preserve it.
    win.document.dispatchEvent(new win.FocusEvent("blur"));
    await TestUtils.waitForCondition(showing, "Document blur preserves the pending Command hold");
    win.document.dispatchEvent(new win.FocusEvent("blur"));
    ok(showing(), "Document blur preserves visible badges in the active window");
  } finally {
    release();
  }
  ok(!showing(), "Release still ends the hold after document blur");
});

add_task(async function cancel_on_release_key_pointer_and_deactivate() {
  await hold();
  release();
  ok(!showing(), "Release hides immediately");
  await hold();
  key("KEY_Shift", { type: "keydown", metaKey: true });
  ok(!showing(), "Another key hides immediately");
  key("KEY_Shift", { type: "keyup", metaKey: true });
  release();
  await hold();
  const tab = win.gBrowser.selectedTab;
  tab.dispatchEvent(new win.PointerEvent("pointerdown", { bubbles: true, buttons: 1 }));
  ok(!showing(), "Pointer press hides immediately");
  tab.dispatchEvent(new win.PointerEvent("pointerup", { bubbles: true, buttons: 0 }));
  release();
  await hold();
  win.dispatchEvent(new win.MouseEvent("mousemove", { bubbles: true, metaKey: true }));
  ok(showing(), "Moving the pointer while Command is held keeps the numbers");
  win.dispatchEvent(new win.MouseEvent("mousemove", { bubbles: true }));
  ok(!showing(), "Any later input with Command up repairs a missed release");
  release();
  // Model activation transitions without competing for the OS-active window.
  focus.returns(true);
  try {
    await hold();
    focus.returns(false);
    win.dispatchEvent(new win.Event("deactivate"));
    ok(!showing(), "Losing win activation hides immediately");
    await TestUtils.waitForCondition(() => win.getComputedStyle(Numbers.layer(win)).opacity == "0",
      "Window blur while Command is held fades the hints out");
    key("KEY_Meta", { metaKey: true });
    win.dispatchEvent(new win.Event("deactivate"));
    await TestUtils.waitForCondition(showing, "Keys delivered without activation survive pending deactivation");
    win.dispatchEvent(new win.Event("deactivate"));
    ok(showing(), "Keys delivered without activation survive visible deactivation");
    // No keyup and no activation transition: a new non-repeat keydown is
    // evidence of a new physical press and must repair the missed release.
    key("KEY_Meta", { metaKey: true });
    ok(!showing(), "A fresh press starts a fresh delay after a missed release");
    await TestUtils.waitForCondition(showing, "A missed release cannot block the next Command hold");
  } finally {
    focus.returns(false);
    release();
  }
  await hold();
  release();
});

// Real key synthesis routed by focus (web page, URL bar, sidebar), not a
// window-dispatched event: the release must fade the badges out to opacity 0.
add_task(async function release_fades_out_in_every_focus_state() {
  const tab = await BrowserTestUtils.openNewForegroundTab(win.gBrowser,
    "data:text/html,<input id=field>");
  const browser = tab.linkedBrowser;
  const faded = () => win.getComputedStyle(Numbers.layer(win)).opacity == "0";
  const synth = type => EventUtils.synthesizeKey("KEY_Meta", { type }, win);
  const focusers = {
    async page() {
      browser.focus();
      await SpecialPowers.spawn(browser, [], () => content.document.getElementById("field").focus());
      await TestUtils.waitForCondition(() => win.document.activeElement == browser, "The web page has focus");
    },
    async urlbar() {
      win.gURLBar.inputField.focus();
      await TestUtils.waitForCondition(() => win.gURLBar.focused, "The URL bar has focus");
      win.gURLBar.view.close();
    },
    async sidebar() {
      win.gBrowser.selectedTab.focus();
      await TestUtils.waitForCondition(() => win.gNavToolbox.contains(win.document.activeElement),
        "The sidebar has focus");
    },
  };
  try {
    for (const [where, focusIt] of Object.entries(focusers)) {
      await focusIt();
      let contentKeyup;
      if (where == "page") {
        contentKeyup = SpecialPowers.spawn(browser, [], () => new Promise(resolve =>
          content.addEventListener("keyup", e => e.key == "Meta" && resolve(), { once: false })));
      }
      synth("keydown");
      await TestUtils.waitForCondition(showing, `Holding Command with the ${where} focused reveals numbers`);
      await TestUtils.waitForCondition(() => win.getComputedStyle(Numbers.layer(win)).opacity == "1",
        `Badges finish fading in with the ${where} focused`);
      await TestUtils.waitForCondition(() => [...Numbers.layer(win).children].some(node =>
        !node.hidden && /[1-9]/.test(node.textContent) && node.getBoundingClientRect().height >= 14),
      `A visible digit is painted with the ${where} focused`);
      synth("keyup");
      if (contentKeyup) {
        await contentKeyup;
        ok(true, "The release went through the web page");
      }
      await TestUtils.waitForCondition(faded, `Releasing Command with the ${where} focused fades the badges out`);
      ok(!showing(), `The hold ended with the ${where} focused`);
    }
  } finally {
    synth("keyup");
    release();
    await BrowserTestUtils.removeTab(tab, { animate: false });
  }
});

add_task(async function quick_tap_and_chords_never_reveal() {
  key("KEY_Meta", { type: "keydown", metaKey: true });
  release();
  await pastDeadline();
  ok(!showing(), "A quick Command tap never reveals badges");
  key("KEY_Meta", { type: "keydown", metaKey: true });
  key("c", { metaKey: true });
  key("c", { type: "keyup", metaKey: true });
  await pastDeadline();
  ok(!showing(), "A quick shortcut cancels the pending reveal");
  release();
  key("c");
  key("KEY_Meta", { metaKey: true });
  await pastDeadline();
  ok(!showing(), "A non-modifier already held prevents a reveal");
  key("c", { type: "keyup", metaKey: true });
  release();
  key("KEY_Shift", { type: "keydown" });
  key("KEY_Meta", { type: "keydown", metaKey: true, shiftKey: true });
  await pastDeadline();
  ok(!showing(), "Command held with another modifier never starts a reveal");
  release();
  key("KEY_Shift", { type: "keyup" });
});

add_task(async function pointer_down_before_command_and_pending_cancellation() {
  const tab = win.gBrowser.selectedTab;
  tab.dispatchEvent(new win.PointerEvent("pointerdown", { bubbles: true, buttons: 1 }));
  key("KEY_Meta", { type: "keydown", metaKey: true });
  await pastDeadline();
  ok(!showing(), "Command with a mouse button held never reveals numbers");
  release();
  tab.dispatchEvent(new win.PointerEvent("pointerup", { bubbles: true, buttons: 0 }));
  key("KEY_Meta", { type: "keydown", metaKey: true });
  tab.dispatchEvent(new win.PointerEvent("pointerdown", { bubbles: true, buttons: 1 }));
  tab.dispatchEvent(new win.PointerEvent("pointerup", { bubbles: true, buttons: 0 }));
  await pastDeadline();
  ok(!showing(), "A pointer press cancels the pending timer");
  release();
});

add_task(async function preference_disables_pending_and_visible_hints() {
  await hold();
  await SpecialPowers.pushPrefEnv({ set: [[Numbers.PREF, false]] });
  ok(!showing(), "Turning the switch off hides existing hints");
  release();
  key("KEY_Meta", { type: "keydown", metaKey: true });
  await pastDeadline();
  ok(!showing(), "No reveal while the switch is off");
  release();
  await SpecialPowers.popPrefEnv();
  key("KEY_Meta", { type: "keydown", metaKey: true });
  await SpecialPowers.pushPrefEnv({ set: [[Numbers.PREF, false]] });
  await pastDeadline();
  ok(!showing(), "Turning the switch off cancels a pending reveal");
  release();
  await SpecialPowers.popPrefEnv();
});

add_task(async function content_focus_blur_preserves_pending_hold() {
  try {
    for (const active of [true, false]) {
      focus.returns(active);
      key("KEY_Meta", { metaKey: true });
      const before = Numbers.chordState(win);
      win.dispatchEvent(new win.Event("blur"));
      const after = Numbers.chordState(win);
      ok(after.meta && after.timer == before.timer,
        `Content blur without an activation loss preserves the pending hold (active=${active})`);
      await TestUtils.waitForCondition(showing, "Delivered Command still reveals after content focus changes");
      win.dispatchEvent(new win.Event("blur"));
      ok(showing(), "Content focus blur also preserves a visible hold");
      release();
    }
  } finally {
    release();
    focus.returns(false);
  }
});

add_task(async function blur_and_visibility_reset_the_entire_chord() {
  for (const type of ["blur", "visibilitychange"]) {
    focus.returns(true);
    await hold();
    key("2", { code: "Digit2", metaKey: true });
    focus.returns(false);
    if (type == "blur") {
      win.dispatchEvent(new win.Event(type));
    } else {
      win.document.dispatchEvent(new win.Event(type, { bubbles: true }));
    }
    ok(!showing(), `${type} ends the hold without keyup`);
    await hold();
    release();
  }
});
