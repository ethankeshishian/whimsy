/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W29: ⌘S (Hide Sidebar) with the pointer on the bar. The bar slides out once,
// never comes back on its own, and stays closed while the pointer rests on it
// or on the edge strip it settles into. Once the pointer leaves, the next
// approach to the edge reveals the bar as usual.

const root = document.documentElement;
const sidebar = () => gZenCompactModeManager.sidebar;
const nextFrame = () => new Promise(r => requestAnimationFrame(r));
// Frames watched after the slide settles: long past the queued hover task
// that used to reveal the bar again.
const SETTLED_FRAMES = 30;

function pressCmdS() {
  const key = document.getElementById("zen-compact-mode-toggle");
  EventUtils.synthesizeKey(key.getAttribute("key").toLowerCase(), { accelKey: true });
}

function moveTo({ x, y }) {
  EventUtils.synthesizeMouse(root, x, y, { type: "mousemove" });
}

function sliding() {
  return root.hasAttribute("zen-compact-animating") || sidebar().hasAttribute("animate");
}

function rightEdge() {
  return sidebar().getBoundingClientRect().right;
}

// A point `x` pixels into the shown bar, at mid-height.
function pointOnBar(x) {
  const r = sidebar().getBoundingClientRect();
  return { x: r.left + x, y: r.top + r.height / 2 };
}

// The middle of the page, well away from every edge.
function pointOnPage() {
  const r = gBrowser.selectedBrowser.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

// The hidden bar's edge strip.
function pointOnEdge() {
  const r = sidebar().getBoundingClientRect();
  return { x: Math.max(1, r.right - 2), y: r.top + r.height / 2 };
}

async function showSidebar() {
  moveTo(pointOnPage());
  if (gZenCompactModeManager.preference) {
    gZenCompactModeManager.preference = false;
  }
  await TestUtils.waitForCondition(
    () => !gZenCompactModeManager.preference && !sliding() && !sidebar().hasAttribute("zen-has-hover"),
    "Sidebar shown and settled"
  );
}

// Presses ⌘S and records the bar's right edge every frame until the slide has
// settled and SETTLED_FRAMES more frames have passed. `onFrame` runs before
// each sample (pointer jitter, a repeated key press).
async function closeAndWatch({ onFrame = () => {} } = {}) {
  const edges = [rightEdge()];
  pressCmdS();
  let frame = 0;
  let settledFor = 0;
  while (settledFor < SETTLED_FRAMES) {
    await nextFrame();
    frame++;
    onFrame(frame);
    edges.push(rightEdge());
    settledFor = sliding() || !gZenCompactModeManager.preference ? 0 : settledFor + 1;
  }
  return edges;
}

function assertSlidOutOnce(edges, label) {
  for (let i = 1; i < edges.length; i++) {
    if (edges[i] > edges[i - 1] + 1) {
      ok(false, `${label}: the bar moved back out at frame ${i} (${edges[i - 1]} -> ${edges[i]})`);
      return;
    }
  }
  ok(edges.at(-1) < edges[0] / 2, `${label}: the bar slid out (${edges[0]} -> ${edges.at(-1)})`);
}

function assertHidden(label) {
  ok(gZenCompactModeManager.preference, `${label}: compact mode is on`);
  ok(!sidebar().hasAttribute("zen-has-hover"), `${label}: no hover reveal`);
  ok(rightEdge() < 20, `${label}: the bar stays hidden (right edge ${rightEdge()})`);
}

async function revealFromEdge(label) {
  moveTo(pointOnPage());
  await nextFrame();
  moveTo(pointOnEdge());
  await TestUtils.waitForCondition(() => sidebar().hasAttribute("zen-has-hover"), `${label}: edge reveals the bar`);
  ok(true, `${label}: hover reveal works after the pointer left`);
  moveTo(pointOnPage());
  await TestUtils.waitForCondition(() => !sidebar().hasAttribute("zen-has-hover"), `${label}: bar hides again`);
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["zen.view.compact.animate-sidebar", true],
      ["zen.view.compact.hide-tabbar", true],
      ["zen.view.compact.enable-at-startup", false],
    ],
  });
  const page = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  delete gZenCompactModeManager._wasInCompactMode;
  registerCleanupFunction(async () => {
    await showSidebar();
    BrowserTestUtils.removeTab(page);
  });
});

// The pointer near the bar's outer edge ends up on the strip the bar settles
// into. A resting hand jitters by a pixel; neither may bring the bar back.
add_task(async function cmd_s_with_pointer_on_bar_edge_stays_closed() {
  for (const jitter of [false, true]) {
    const label = jitter ? "edge, jitter" : "edge";
    await showSidebar();
    const at = pointOnBar(3);
    moveTo(at);
    await TestUtils.waitForCondition(() => sidebar().hasAttribute("zen-has-hover"), `${label}: pointer on the bar`);
    const edges = await closeAndWatch({
      onFrame: frame => jitter && moveTo({ x: at.x + (frame % 2), y: at.y }),
    });
    assertSlidOutOnce(edges, label);
    assertHidden(label);
    await revealFromEdge(label);
  }
});

// The pointer in the middle of the bar: the bar slides out from under it and
// the pointer is on the page, so the edge reveals the bar straight away.
add_task(async function cmd_s_with_pointer_mid_bar_closes() {
  await showSidebar();
  moveTo(pointOnBar(115));
  await TestUtils.waitForCondition(() => sidebar().hasAttribute("zen-has-hover"), "mid: pointer on the bar");
  const edges = await closeAndWatch();
  assertSlidOutOnce(edges, "mid");
  assertHidden("mid");
  moveTo(pointOnEdge());
  await TestUtils.waitForCondition(() => sidebar().hasAttribute("zen-has-hover"), "mid: edge reveals the bar");
  moveTo(pointOnPage());
  await TestUtils.waitForCondition(() => !sidebar().hasAttribute("zen-has-hover"), "mid: bar hides again");
});

// Key repeat while the bar slides: the second press is ignored, as Zen's
// setter does, and must not drop the explicit close's hover hold.
add_task(async function cmd_s_repeat_mid_slide_stays_closed() {
  await showSidebar();
  const at = pointOnBar(3);
  moveTo(at);
  await TestUtils.waitForCondition(() => sidebar().hasAttribute("zen-has-hover"), "repeat: pointer on the bar");
  let repeated = false;
  const edges = await closeAndWatch({
    onFrame: () => {
      if (!repeated && sliding()) {
        repeated = true;
        pressCmdS();
      }
    },
  });
  ok(repeated, "repeat: a second ⌘S arrived mid-slide");
  assertSlidOutOnce(edges, "repeat");
  assertHidden("repeat");
  await revealFromEdge("repeat");
});

// W29 (owner: "the tab bar only comes up after i press a button"): after ⌘S
// with the pointer at the bar's edge, the bar settles under the pointer.
// Pushing on toward the window edge is the way to ask for it back, and must
// reveal it without first moving off and back.
add_task(async function cmd_s_then_push_to_edge_reveals() {
  await showSidebar();
  const at = pointOnBar(3);
  moveTo(at);
  await TestUtils.waitForCondition(() => sidebar().hasAttribute("zen-has-hover"), "push: pointer on the bar");
  assertSlidOutOnce(await closeAndWatch(), "push");
  assertHidden("push");
  moveTo({ x: 0, y: at.y });
  await TestUtils.waitForCondition(() => sidebar().hasAttribute("zen-has-hover"), "push: pushing to the edge reveals the bar");
  ok(!gZenCompactModeManager._ignoreNextHover, "push: hover works again");
  moveTo(pointOnPage());
  await TestUtils.waitForCondition(() => !sidebar().hasAttribute("zen-has-hover"), "push: bar hides again");
});

// The pointer leaves the window past the bar's edge (the window isn't at the
// screen edge). That is the same request: the bar comes back, and hover works
// when the pointer returns, instead of staying dead until another ⌘S.
add_task(async function cmd_s_then_leave_window_reveals() {
  await showSidebar();
  const at = pointOnBar(3);
  moveTo(at);
  await TestUtils.waitForCondition(() => sidebar().hasAttribute("zen-has-hover"), "leave: pointer on the bar");
  assertSlidOutOnce(await closeAndWatch(), "leave");
  assertHidden("leave");
  root.dispatchEvent(new MouseEvent("mouseleave", { clientX: -1, clientY: at.y }));
  await TestUtils.waitForCondition(() => !gZenCompactModeManager._ignoreNextHover, "leave: the hold ends");
  await TestUtils.waitForCondition(() => sidebar().hasAttribute("zen-has-hover"), "leave: the edge reveals the bar");
  moveTo(pointOnPage());
  await TestUtils.waitForCondition(() => !sidebar().hasAttribute("zen-has-hover"), "leave: bar hides again");
});
