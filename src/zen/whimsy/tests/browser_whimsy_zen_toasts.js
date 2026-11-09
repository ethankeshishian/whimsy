/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave13/toast: one toast, Zen's, extended (WhimsyZenToasts.sys.mjs, built
// by gZenUIManager through the overlay). Ported from the WhimsyToast tests
// (icon, Fluent second line, tab-owned toasts, in-place busy updates,
// "keep" buttons, until dismissed), plus what the extension adds:
// persistence with handles, buttons that show their words, the close
// button and Esc, stacking (order, sliding, a transient pushing the stack,
// "+k more"), Reduce Motion, keyed replacement and the 480px limit.
// Zen's own toast behaviour is checked unchanged by
// src/zen/tests/ui/browser_toasts.js.

const ICON = "chrome://browser/skin/zen-icons/selectable/time.svg";
const toasts = () => gZenUIManager.toasts;
const topOf = toast => toast.element.style.top;
const heightOf = toast => toast.element.clientHeight;

registerCleanupFunction(() => closeToasts());

// W23 polish: the AI discovery hints (WhimsyAIHints) show as a toast with
// the same key on a timer tied to the shared window, not this file, so one
// can land mid-test (left waiting by an earlier file's chat/ask surface)
// and throw off every exact pixel this file checks. Off for the file.
add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.ai-hints", false]] });
  closeToasts();
  await TestUtils.waitForCondition(
    () => !document.querySelector("#zen-toast-container > *"),
    "No toast is showing when the test starts"
  );
});

add_task(async function icon_and_fluent_description() {
  const toast = toasts().open("whimsy-archive-toast", {
    descriptionId: "whimsy-archive-toast-detail",
    icon: ICON,
    timeout: 0,
  });
  try {
    ok(toast.element.classList.contains("zen-toast"), "It's Zen's toast");
    await document.l10n.translateFragment(toast.element);
    const icon = toast.element.querySelector(".whimsy-toast-icon > img");
    ok(icon, "The icon is drawn");
    is(
      icon.compareDocumentPosition(toast.element.querySelector("vbox")) & Node.DOCUMENT_POSITION_FOLLOWING,
      Node.DOCUMENT_POSITION_FOLLOWING,
      "It comes before the text"
    );
    const description = toast.element.querySelector(".description");
    is(description.getAttribute("data-l10n-id"), "whimsy-archive-toast-detail", "The second line is Fluent");
    ok(description.textContent.length > 0, "and translated");
  } finally {
    toast.close({ instant: true });
  }
});

add_task(async function icon_element_and_badge() {
  const mark = document.createElementNS("http://www.w3.org/1999/xhtml", "img");
  mark.src = ICON;
  const toast = toasts().open("whimsy-archive-toast", {
    icon: { src: mark, badge: ICON, size: 24 },
    timeout: 0,
  });
  try {
    // Measured once it has arrived (it springs in from scale 0).
    await toast.shown;
    const slot = toast.element.querySelector(".whimsy-toast-icon");
    is(slot.firstElementChild, mark, "A caller's element is the mark, as is");
    ok(slot.querySelector(".whimsy-toast-icon-badge"), "with its badge");
    is(slot.getBoundingClientRect().width, 24, "at the size asked for");
    is(slot.getAttribute("aria-hidden"), "true", "Decoration only");
    toast.update({ icon: null });
    ok(!toast.element.querySelector(".whimsy-toast-icon"), "An update can take it away");
  } finally {
    toast.close({ instant: true });
  }
});

add_task(async function update_in_place_and_busy() {
  let clicks = 0;
  const toast = toasts().open("whimsy-archive-toast", {
    timeout: 10000,
    buttons: [{ l10nId: "whimsy-archive-look", command: () => (clicks++, "keep") }],
  });
  const element = toast.element;
  try {
    toast.element.querySelector(".whimsy-toast-button").click();
    is(clicks, 1, "The button ran");
    ok(!toast.closing && !toast.closed, "\"keep\" keeps the toast");

    toast.update({
      messageId: "whimsy-archive-error",
      descriptionId: "whimsy-archive-looking",
      busy: true,
      buttons: [{ l10nId: "whimsy-archive-looking-button" }],
    });
    is(toast.element, element, "Updated in place, not replaced");
    is(toast.messageId, "whimsy-archive-error", "with the new message");
    is(document.l10n.getAttributes(element.querySelector("label")).id, "whimsy-archive-error", "on its label");
    ok(toast.busy && element.hasAttribute("busy"), "Busy");
    is(element.getAttribute("aria-busy"), "true", "and says so");
    const button = element.querySelector(".whimsy-toast-button");
    ok(button.disabled, "The button is disabled while busy");
    ok(element.querySelector(".whimsy-toast-spinner").checkVisibility(), "A spinner shows in the button");
    button.click();
    is(clicks, 1, "A busy button doesn't run");

    toast.update({ busy: false, buttons: null, timeout: 50 });
    ok(!element.querySelector(".whimsy-toast-button"), "The buttons can be removed");
    await TestUtils.waitForCondition(() => toast.closed, "The new timeout applies");
    ok(!element.isConnected, "and the toast is gone");
  } finally {
    toast.close({ instant: true });
  }
});

add_task(async function persistent_until_closed() {
  const reasons = [];
  const toast = toasts().open("whimsy-archive-toast", { timeout: 0, onClose: reason => reasons.push(reason) });
  ok(toast.persistent, "timeout 0 is persistent");
  is(toast.element.getAttribute("role"), "alert", "A toast that waits for you is an alert");
  await toast.shown;
  // eslint-disable-next-line mozilla/no-arbitrary-setTimeout
  await new Promise(resolve => setTimeout(resolve, 600));
  ok(!toast.closed && toast.element.isConnected, "It stays until it's closed");
  await toast.close();
  ok(toast.closed && !toast.element.isConnected, "close() takes it away");
  Assert.deepEqual(reasons, ["closed"], "and tells its owner once");
  await toast.close();
  Assert.deepEqual(reasons, ["closed"], "Closing again does nothing");
  ok(document.getElementById("zen-toast-container").hasAttribute("hidden"), "The empty container hides");
});

add_task(async function text_buttons() {
  let ran = 0;
  const toast = toasts().open("whimsy-archive-toast", {
    buttons: [
      { l10nId: "whimsy-undo-toast-action", id: "test-toast-undo", keys: "⌘Z", ariaKeys: "Meta+Z", command: () => ran++ },
      { label: "Plain words", id: "test-toast-other", command: () => "keep" },
    ],
  });
  is(toast.element.getAttribute("role"), "status", "A passing toast is a status");
  const undo = document.getElementById("test-toast-undo");
  await TestUtils.waitForCondition(() => undo.textContent.includes("Undo"), "The button has its word");
  ok(undo.querySelector(".whimsy-toast-button-label").checkVisibility(), "and the word shows (Zen hides its button text)");
  await toast.shown;
  Assert.greater(undo.getBoundingClientRect().width, 40, "wide enough for its word");
  Assert.greaterOrEqual(undo.getBoundingClientRect().height, 24, "a real target");
  is(undo.querySelector(".whimsy-toast-keys").textContent, "⌘Z", "The shortcut beside it");
  is(undo.getAttribute("aria-keyshortcuts"), "Meta+Z", "and announced");
  is(document.getElementById("test-toast-other").textContent, "Plain words", "A plain-text label works too");

  document.getElementById("test-toast-other").click();
  ok(!toast.closing, "\"keep\" keeps the toast");
  undo.click();
  is(ran, 1, "The command ran");
  ok(toast.closing || toast.closed, "and the toast goes");
  await toast.close();

  // A command that replaces its own toast (a keyed open) keeps the new one.
  const first = toasts().open("whimsy-archive-toast", {
    key: "test-toast",
    buttons: [{ label: "Stop", command: () => toasts().open("whimsy-archive-none-toast", { key: "test-toast", timeout: 5000 }) }],
  });
  first.element.querySelector(".whimsy-toast-button").click();
  ok(!first.closing && !first.closed, "The replacement stays");
  is(first.messageId, "whimsy-archive-none-toast", "and says the new thing");
  first.close({ instant: true });
});

add_task(async function close_button_and_escape() {
  const before = document.activeElement;
  const reasons = [];
  const toast = toasts().open("whimsy-archive-toast", {
    timeout: 0,
    buttons: [{ label: "Go to Tab", id: "test-toast-go", command: () => "keep" }],
    onClose: reason => reasons.push(reason),
  });
  is(document.activeElement, before, "Showing a toast never takes focus");
  const close = toast.element.querySelector(".whimsy-toast-close");
  ok(close, "A persistent toast has a close button");
  await document.l10n.translateFragment(toast.element);
  is(close.getAttribute("aria-label"), "Dismiss", "named Dismiss");
  is(getComputedStyle(close).opacity, "0", "hidden until you point at the toast");
  // Point at it, as someone reaching for the button does.
  EventUtils.synthesizeMouseAtCenter(toast.element, { type: "mousemove" });
  await TestUtils.waitForCondition(() => getComputedStyle(close).opacity == "1", "Pointing shows the close button");
  close.click();
  // Point away again: a toast under the pointer holds its timer.
  EventUtils.synthesizeMouse(document.documentElement, 1, 1, { type: "mousemove" });
  ok(toast.closing || toast.closed, "The close button dismisses it");
  await toast.close();
  Assert.deepEqual(reasons, ["dismissed"], "as dismissed");

  const again = toasts().open("whimsy-archive-toast", {
    timeout: 10000,
    buttons: [{ label: "Go to Tab", id: "test-toast-go", command: () => "keep" }],
  });
  ok(!again.element.querySelector(".whimsy-toast-close"), "A passing toast has no close button unless asked");
  const go = document.getElementById("test-toast-go");
  go.focus();
  is(document.activeElement, go, "Its button can take keyboard focus");
  ok(again.paused, "Focus holds it");
  EventUtils.synthesizeKey("KEY_Escape", {}, window);
  ok(again.closing || again.closed, "Esc dismisses it");
  isnot(document.activeElement, go, "and focus goes back to the page");
  await again.close();
});

add_task(async function stacking_order_and_sliding() {
  const older = toasts().open("whimsy-archive-toast", { timeout: 0 });
  const newer = toasts().open("whimsy-archive-error", { timeout: 0 });
  await Promise.all([older.shown, newer.shown]);
  is(topOf(newer), "0px", "The newest sits at the corner");
  is(topOf(older), `${heightOf(newer) + 8}px`, "the older one 8px below it");
  is(getComputedStyle(older.element).transitionDuration, "0.24s", "Moves slide");

  const leaving = newer.close();
  is(topOf(older), `${heightOf(newer) + 8}px`, "A leaving toast keeps its place while it goes");
  await leaving;
  is(topOf(older), "0px", "then the rest slide up");
  older.close({ instant: true });
});

add_task(async function transient_pushes_the_stack() {
  const waiting = toasts().open("whimsy-archive-toast", { timeout: 0 });
  const copied = toasts().open("whimsy-archive-found", { timeout: 10000 });
  is(topOf(copied), "0px", "A passing toast arrives at the corner");
  is(topOf(waiting), `${heightOf(copied) + 8}px`, "and pushes the waiting one down");

  // A newer persistent toast still goes under the passing one.
  const second = toasts().open("whimsy-archive-error", { timeout: 0 });
  is(topOf(copied), "0px", "Passing toasts stay first");
  is(topOf(second), `${heightOf(copied) + 8}px`, "then the persistent ones, newest first");
  is(topOf(waiting), `${heightOf(copied) + heightOf(second) + 16}px`, "...and the oldest last");

  copied.close({ instant: true });
  is(topOf(second), "0px", "When it leaves, the stack moves back up");
  is(topOf(waiting), `${heightOf(second) + 8}px`, "all of it");
  closeToasts();
});

add_task(async function more_than_three_fold() {
  const ids = [
    "whimsy-archive-toast",
    "whimsy-archive-error",
    "whimsy-archive-found",
    "whimsy-archive-none-toast",
    "whimsy-form-protected-toast",
  ];
  const stack = ids.map(id => toasts().open(id, { timeout: 0 }));
  const visible = () => stack.filter(t => !t.closed && !t.element.hasAttribute("stacked-away"));
  is(visible().length, 3, "Three persistent toasts show");
  Assert.deepEqual(visible(), stack.slice(2), "the newest three");
  const more = document.querySelector("#zen-toast-container > .whimsy-toast-more");
  ok(more, "The rest fold into one line");
  Assert.deepEqual(document.l10n.getAttributes(more), { id: "whimsy-toast-more", args: { count: 2 } }, "+2 more");
  await document.l10n.translateFragment(more);
  is(more.textContent, "+2 more", "It says how many");
  const lastTop = parseFloat(topOf(stack[2]));
  is(more.style.top, `${lastTop + heightOf(stack[2]) + 8}px`, "under the third");

  more.click();
  is(visible().length, 5, "Clicking it shows them all");
  ok(!more.isConnected, "and it goes");

  stack[4].close({ instant: true });
  stack[3].close({ instant: true });
  is(visible().length, 3, "Three left show");
  ok(!document.querySelector("#zen-toast-container > .whimsy-toast-more"), "with no fold");

  // Back above three, it folds again.
  stack.push(toasts().open("whimsy-archive-toast", { key: "test-toast-4", timeout: 0 }));
  is(visible().length, 3, "A fourth folds again");
  ok(document.querySelector("#zen-toast-container > .whimsy-toast-more"), "into +1 more");
  closeToasts();
  await TestUtils.waitForCondition(
    () => !document.querySelector("#zen-toast-container > *"),
    "The fold goes with the last toast"
  );
});

add_task(async function reduce_motion() {
  await SpecialPowers.pushPrefEnv({ set: [["ui.prefersReducedMotion", 1]] });
  await TestUtils.waitForCondition(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    "Reduce Motion is on"
  );
  try {
    const toast = toasts().open("whimsy-archive-toast", { timeout: 10000 });
    await toast.shown;
    is(toast.element.style.transform, "", "It arrives without the spring (no scale)");
    is(getComputedStyle(toast.element).opacity, "1", "it fades in");
    is(getComputedStyle(toast.element).transitionDuration, "0s", "The stack jumps instead of sliding");

    // Zen's reuse pulse is skipped too.
    await gZenUIManager.showToast("whimsy-archive-toast", { timeout: 10000 });
    is(toast.element.style.transform, "", "Showing it again doesn't pulse");

    const start = performance.now();
    await toast.close();
    Assert.less(performance.now() - start, 1000, "It fades out quickly");
    ok(toast.closed, "and is gone");
  } finally {
    await SpecialPowers.popPrefEnv();
  }

  // Without Reduce Motion, Zen's spring (a scale) as before.
  await TestUtils.waitForCondition(
    () => !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    "Reduce Motion is off"
  );
  const springy = toasts().open("whimsy-archive-toast", { timeout: 10000 });
  ok(springy.element.style.transform.includes("scale"), "Zen's spring scales it in");
  await springy.shown;
  springy.close({ instant: true });
});

add_task(async function keyed_replace_clears_what_it_leaves_out() {
  const toast = toasts().open("whimsy-archive-toast", {
    key: "test-toast",
    descriptionId: "whimsy-archive-toast-detail",
    icon: ICON,
    timeout: 0,
    buttons: [{ label: "Find" }],
  });
  const element = toast.element;
  const same = toasts().open("whimsy-archive-found", { key: "test-toast", timeout: 10000 });
  is(same, toast, "The same key is the same toast");
  is(same.element, element, "updated in place");
  is(toast.messageId, "whimsy-archive-found", "with the new message");
  ok(!element.querySelector(".description"), "Its second line went");
  ok(!element.querySelector(".whimsy-toast-icon"), "its icon went");
  ok(!element.querySelector(".whimsy-toast-button"), "its buttons went");
  ok(!element.querySelector(".whimsy-toast-close"), "and so did the close button");
  ok(!toast.persistent, "It times out now");
  is(element.getAttribute("role"), "status", "a status again");
  toast.close({ instant: true });
});

// With an icon, the second line still goes under the message: the icon
// slot comes first in the toast, so it's no place to look for the text
// (Fire's result and the Wayback date landed in the icon, or never went).
add_task(async function second_line_beside_an_icon() {
  const toast = toasts().open("whimsy-archive-toast", { key: "test-toast", icon: ICON, timeout: 0 });
  try {
    toast.update({ descriptionId: "whimsy-archive-found-date", descriptionArgs: { date: "March 12, 2024" } });
    const box = toast.element.querySelector(":scope > vbox");
    is(toast.element.querySelectorAll(".description").length, 1, "One second line");
    is(toast.element.querySelector(".description").parentNode, box, "under the message");
    await document.l10n.translateFragment(toast.element);
    ok(toast.element.querySelector(".description").textContent.includes("2024"), "saying what it was given");
    toast.update({ messageId: "whimsy-archive-found" });
    is(document.l10n.getAttributes(box.querySelector("label")).id, "whimsy-archive-found", "The message changes in place");
    toasts().open("whimsy-archive-none-toast", { key: "test-toast", icon: ICON, timeout: 0 });
    ok(!toast.element.querySelector(".description"), "A replacement without one takes it away");
  } finally {
    toast.close({ instant: true });
  }
});

// Zen gives a second line the options themselves as its Fluent args; with
// a label's l10nArgs among them (an object) the whole translation failed.
add_task(async function zen_second_line_args_with_label_args() {
  const toast = toasts().open("whimsy-form-quit-warning", {
    l10nArgs: { count: 1 },
    descriptionId: "whimsy-form-save-drafts-note",
    timeout: 10000,
  });
  try {
    await document.l10n.translateFragment(toast.element);
    ok(toast.element.querySelector(".description").textContent.length > 0, "The second line translates");
  } finally {
    toast.close({ instant: true });
  }
});

// Shown again, a toast is the newest news: it moves to the corner.
add_task(async function shown_again_comes_to_the_corner() {
  const older = toasts().open("whimsy-archive-toast", { key: "test-toast", timeout: 10000 });
  const newer = toasts().open("whimsy-archive-error", { timeout: 10000 });
  is(toasts().getToasts()[0], newer, "The newer one is at the corner");
  const again = toasts().open("whimsy-archive-found", { key: "test-toast", timeout: 10000 });
  is(again, older, "The same key is the same toast");
  is(toasts().getToasts()[0], older, "and, shown again, it's the newest");
  is(topOf(older), "0px", "at the corner");
  is(topOf(newer), `${heightOf(older) + 8}px`, "the other one under it");
  closeToasts();
});

add_task(async function owned_by_a_tab() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?owned");
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.org/");
  try {
    await BrowserTestUtils.switchTab(gBrowser, tab);
    const reasons = [];
    let toast = toasts().open("whimsy-archive-toast", {
      browser: tab.linkedBrowser,
      timeout: 0,
      onClose: reason => reasons.push(reason),
    });
    await BrowserTestUtils.switchTab(gBrowser, other);
    ok(toast.closed, "Switching away dismisses it at once");
    Assert.deepEqual(reasons, ["owner"], "because its tab went");

    await BrowserTestUtils.switchTab(gBrowser, tab);
    toast = toasts().open("whimsy-archive-toast", { browser: tab.linkedBrowser, timeout: 0 });
    // A same-document change (a hash) keeps it.
    await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
      content.location.hash = "x";
    });
    ok(!toast.closed, "A hash change keeps it");
    const loaded = BrowserTestUtils.browserLoaded(tab.linkedBrowser);
    BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, "https://example.com/?next");
    await loaded;
    ok(toast.closed, "Navigating the tab dismisses it");
  } finally {
    closeToasts();
    BrowserTestUtils.removeTab(other);
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function background_window_holds() {
  const toast = toasts().open("whimsy-archive-toast", {
    timeout: 10000,
    buttons: [{ label: "Undo" }],
  });
  await toast.shown;
  window.dispatchEvent(new Event("deactivate"));
  ok(toast.paused, "A toast with a button waits while the window is behind");
  window.dispatchEvent(new Event("activate"));
  ok(!toast.paused, "and carries on when it's in front again");
  toast.element.dispatchEvent(new MouseEvent("mouseover"));
  ok(toast.paused, "Pointing at it holds it too");
  toast.element.dispatchEvent(new MouseEvent("mouseout"));
  ok(!toast.paused, "until the pointer leaves");
  toast.close({ instant: true });

  // Zen's own toasts keep Zen's rule: only hover holds them.
  const plain = toasts().open("whimsy-archive-found", { timeout: 10000 });
  window.dispatchEvent(new Event("deactivate"));
  ok(!plain.paused, "A plain toast doesn't wait for the window");
  window.dispatchEvent(new Event("activate"));
  plain.close({ instant: true });
});

add_task(async function max_width_crops() {
  const long = "A very long second line that keeps going ".repeat(8);
  const toast = toasts().open("whimsy-archive-toast", { description: long, timeout: 0 });
  try {
    Assert.lessOrEqual(toast.element.getBoundingClientRect().width, 480, "No wider than 480px");
    const description = toast.element.querySelector(".description");
    Assert.greater(description.scrollWidth, description.clientWidth, "The text is cropped");
    is(getComputedStyle(description).textOverflow, "ellipsis", "with an ellipsis");
    is(description.getAttribute("tooltiptext"), long, "The whole text on hover");
  } finally {
    toast.close({ instant: true });
  }
});

add_task(async function zen_callers_unchanged() {
  // Zen's showToast without the new options: Zen's toast, as before.
  await gZenUIManager.showToast("whimsy-archive-toast", {
    timeout: 5000,
    button: { command: () => {}, id: "test-toast-zen-button" },
  });
  const toast = toasts().getToast("whimsy-archive-toast");
  ok(toast.element.hasAttribute("button"), "Zen's icon button");
  is(toast.element.querySelectorAll("button").length, 1, "and nothing else: no close button");
  ok(!toast.element.querySelector(".whimsy-toast-button"), "no text buttons");
  is(toast.element.getAttribute("role"), "status", "Read out politely");
  ok(!toast.persistent, "It times out");
  window.dispatchEvent(new Event("deactivate"));
  ok(!toast.paused, "with Zen's rules");
  window.dispatchEvent(new Event("activate"));
  toast.close({ instant: true });
});

// W23 polish (MUST 2): white text on the space colour, 4.5:1 or better on
// any space colour, a pale yellow one included, with the second line legible.
add_task(async function white_text_on_any_space_colour() {
  const luminance = ({ r, g, b }) => {
    const lin = c => {
      c /= 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  };
  const toast = toasts().open("whimsy-archive-toast", {
    descriptionId: "whimsy-archive-toast-detail",
    timeout: 0,
  });
  try {
    await document.l10n.translateFragment(toast.element);
    for (const primary of ["#1573DE", "#FFE066", "#9FE7F5", "#2B2A33"]) {
      toast.element.style.setProperty("--zen-primary-color", primary);
      const style = getComputedStyle(toast.element);
      is(style.color, "rgb(255, 255, 255)", `White text on ${primary}`);
      const stops = style.backgroundImage.match(/(?:oklch|oklab|rgba?|color)\([^()]*\)/g) ?? [];
      ok(stops.length >= 2, `The gradient resolves on ${primary}: ${style.backgroundImage}`);
      for (const stop of stops) {
        const rgba = InspectorUtils.colorToRGBA(stop);
        ok(rgba, `${stop} parses`);
        const ratio = 1.05 / (luminance(rgba) + 0.05);
        Assert.greaterOrEqual(ratio, 4.5, `${stop} on ${primary}: ${ratio.toFixed(2)}:1`);
      }
    }
    const description = toast.element.querySelector(".description");
    is(getComputedStyle(description).color, "rgba(255, 255, 255, 0.8)", "The second line is 80% white");
  } finally {
    toast.element.style.removeProperty("--zen-primary-color");
    closeToasts();
  }
});
