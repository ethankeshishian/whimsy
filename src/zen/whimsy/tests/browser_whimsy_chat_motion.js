/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W24 chatmotion (BUGS.md #24): the chat panel's open/close must use the
// same duration and easing as the tabs sidebar, not a value that only looks
// close. Both read --whimsy-dur-panel/-exit and --whimsy-ease-panel/-exit
// (whimsy-browser.css), which are set to Zen's own compact-mode sidebar
// values (compact-mode/sidebar.inc.css); WhimsyChatPanel.peekMotion() reads
// those same Zen rules live, so comparing panelMotion() to peekMotion()
// proves the tokens haven't drifted from the sidebar they're copied from.

const { WhimsyChatPanel } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyChatPanel.sys.mjs");

const chat = () => WhimsyChatPanel.forWindow(window);

function widthKeyframed(anim) {
  return anim.effect.getKeyframes().some(k => "width" in k);
}
function slideKeyframed(anim) {
  return anim.effect.getKeyframes().some(k => "translate" in k);
}
function opacityOnly(anim) {
  return anim.effect.getKeyframes().every(k => !("width" in k) && !("translate" in k));
}

async function settle() {
  await TestUtils.waitForCondition(
    () => !chat().el || chat().el.getAnimations({ subtree: true }).every(a => a.playState != "running"),
    "The panel's motion has finished"
  );
}

async function closeChat() {
  if (chat().isOpen) {
    chat().close({ reason: "key" });
    await settle();
  }
}

// The same easing can be serialized differently: a custom property keeps the
// author's line breaks and float noise (7.000000000000001%), while
// Animation.easing rounds to six significant digits. Compare the values.
const easing = value =>
  String(value)
    .replace(/\s+/g, " ")
    .replace(/\(\s/g, "(")
    .replace(/\s\)/g, ")")
    .replace(/\s*,\s*/g, ", ")
    .trim();
const NUMBER = /-?\d*\.?\d+(?:e[-+]?\d+)?/gi;
// Gecko serializes linear() stops as floats, so the last digit can differ
// between two copies of the same curve; compare the shape exactly and the
// numbers to within 1e-3.
const sameEasing = (a, b) => {
  const [x, y] = [easing(a), easing(b)];
  const [nx, ny] = [x.match(NUMBER) || [], y.match(NUMBER) || []];
  return (
    x.replace(NUMBER, "#") == y.replace(NUMBER, "#") &&
    nx.length == ny.length &&
    nx.every((n, i) => Math.abs(Number(n) - Number(ny[i])) < 1e-3)
  );
};

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["whimsy.ai.enabled", true],
      ["whimsy.feature.ai-hints", false],
    ],
  });
  const { outerWidth, outerHeight } = window;
  window.resizeTo(1400, 900);
  await TestUtils.waitForCondition(() => window.innerWidth >= 1300, "Wide window, so chat never overlays");
  registerCleanupFunction(async () => {
    await closeChat();
    window.resizeTo(outerWidth, outerHeight);
  });
});

add_task(async function panel_tokens_equal_the_sidebars_own_motion() {
  const panel = chat().panelMotion();
  const sidebar = chat().peekMotion();
  ok(sidebar.enter && sidebar.exit, "Zen's sidebar rules were found");
  is(panel.in.duration, sidebar.enter.duration, "Chat's open duration is the sidebar's own");
  is(easing(panel.in.easing), easing(sidebar.enter.easing), "Chat's open easing is the sidebar's own spring");
  is(panel.out.duration, sidebar.exit.duration, "Chat's close duration is the sidebar's own");
  is(easing(panel.out.easing), easing(sidebar.exit.easing), "Chat's close easing is the sidebar's own");
});

add_task(async function open_and_close_use_that_exact_motion() {
  const motion = chat().panelMotion();

  const opened = chat().open();
  const widthIn = chat().el.getAnimations().find(widthKeyframed);
  const slideIn = chat().panel.getAnimations().find(slideKeyframed);
  ok(widthIn && slideIn, "Opening runs the width and the slide");
  for (const anim of [widthIn, slideIn]) {
    const timing = anim.effect.getTiming();
    is(timing.duration, motion.in.duration, "Open lasts exactly as long as the sidebar's show");
    ok(
      sameEasing(timing.easing, motion.in.easing),
      `...with the sidebar's own easing (${timing.easing} vs ${motion.in.easing})`
    );
    is(timing.delay, 0, "...and no delay");
  }
  await opened;
  await settle();

  chat().close({ reason: "key" });
  const widthOut = chat().el.getAnimations().find(widthKeyframed);
  const slideOut = chat().panel.getAnimations().find(slideKeyframed);
  ok(widthOut && slideOut, "Closing runs the width and the slide");
  for (const anim of [widthOut, slideOut]) {
    const timing = anim.effect.getTiming();
    is(timing.duration, motion.out.duration, "Close lasts exactly as long as the sidebar's hide");
    ok(
      sameEasing(timing.easing, motion.out.easing),
      `...with the sidebar's own easing (${timing.easing} vs ${motion.out.easing})`
    );
    is(timing.delay, 0, "...and no delay");
  }
  is(getComputedStyle(chat().el).transitionDelay, "0s", "No CSS transition-delay on the panel either");
  is(getComputedStyle(chat().panel).transitionDelay, "0s", "...nor on its inner panel");
  await settle();
});

add_task(async function reduced_motion_is_only_a_fade() {
  await SpecialPowers.pushPrefEnv({ set: [["ui.prefersReducedMotion", 1]] });
  try {
    await chat().open();
    for (const anim of chat().el.getAnimations({ subtree: true })) {
      ok(opacityOnly(anim), "Reduced motion: no width or slide transition while opening");
    }
    await settle();
    chat().close({ reason: "key" });
    for (const anim of chat().el.getAnimations({ subtree: true })) {
      ok(opacityOnly(anim), "Reduced motion: no width or slide transition while closing");
    }
    await settle();
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});

// W25 designfix: ⌘S (Hide Sidebar, Zen's compact-mode toggle) and ⌘E (chat)
// must move identically. Both read the same tokens, so the animations each
// key starts must have equal duration, easing, and delay, both ways.
function pressShortcut(id) {
  const key = document.getElementById(id);
  ok(key, `${id} is bound`);
  const mods = key.getAttribute("modifiers") || "";
  EventUtils.synthesizeKey(key.getAttribute("key").toLowerCase(), {
    accelKey: /accel/.test(mods),
    shiftKey: /shift/.test(mods),
    altKey: /alt/.test(mods),
    ctrlKey: /control/.test(mods),
  });
}

// Records every Web Animation started on `el` until stop() is called.
function recordAnimations(el) {
  const seen = [];
  el.animate = function (...args) {
    const anim = Element.prototype.animate.apply(this, args);
    seen.push(anim);
    return anim;
  };
  return { seen, stop: () => delete el.animate };
}

add_task(async function cmd_s_and_cmd_e_share_one_motion() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["zen.view.compact.animate-sidebar", true],
      ["zen.view.compact.hide-tabbar", true],
      ["zen.view.compact.enable-at-startup", false],
    ],
  });
  await closeChat();
  // Zen skips the animation over an empty tab (the sidebar stays shown for
  // it) and on the first toggle after startup; neither is what's measured.
  const page = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  registerCleanupFunction(() => {
    if (page.isConnected) {
      BrowserTestUtils.removeTab(page);
    }
  });
  delete gZenCompactModeManager._wasInCompactMode;
  const motion = chat().panelMotion();
  const sidebar = gZenCompactModeManager.sidebar;
  const timings = {};
  const sidebarStep = async (name, wantCompact) => {
    const rec = recordAnimations(sidebar);
    try {
      pressShortcut("zen-compact-mode-toggle");
      await TestUtils.waitForCondition(() => gZenCompactModeManager.preference == wantCompact, `⌘S ${name}`);
      const slide = () => rec.seen.filter(a => a.effect.getKeyframes().some(k => "marginLeft" in k || "marginRight" in k));
      await TestUtils.waitForCondition(() => slide().length, `⌘S ${name} animates the sidebar`);
      timings[`s-${name}`] = slide().map(a => a.effect.getTiming());
      await TestUtils.waitForCondition(() => !document.documentElement.hasAttribute("zen-compact-animating"), "Sidebar settled");
    } finally {
      rec.stop();
    }
  };
  const chatStep = async (name, wantOpen) => {
    const recs = [recordAnimations(chat().el), recordAnimations(chat().panel)];
    try {
      pressShortcut("key_cmd_whimsyChatToggle");
      await TestUtils.waitForCondition(() => chat().isOpen == wantOpen, `⌘E ${name}`);
      await TestUtils.waitForCondition(() => recs.some(r => r.seen.length), `⌘E ${name} animates the panel`);
      timings[`e-${name}`] = recs.flatMap(r => r.seen).map(a => a.effect.getTiming());
    } finally {
      recs.forEach(r => r.stop());
    }
    await settle();
  };

  await sidebarStep("hide", true);
  await whimsyBothSchemes("w25-cmd-s-sidebar-hidden", async () => {});
  await sidebarStep("show", false);
  await chatStep("show", true);
  await whimsyBothSchemes("w25-cmd-e-chat-open", async () => {});
  await chatStep("hide", false);

  for (const dir of ["show", "hide"]) {
    const want = dir == "show" ? motion.in : motion.out;
    for (const key of ["s", "e"]) {
      const list = timings[`${key}-${dir}`];
      ok(list?.length, `⌘${key.toUpperCase()} ${dir} ran animations`);
      for (const t of list) {
        is(t.duration, want.duration, `⌘${key.toUpperCase()} ${dir}: the shared duration`);
        ok(sameEasing(t.easing, want.easing), `⌘${key.toUpperCase()} ${dir}: the shared easing (${t.easing})`);
        is(t.delay, 0, `⌘${key.toUpperCase()} ${dir}: no delay`);
      }
    }
  }
  if (page.isConnected) {
    BrowserTestUtils.removeTab(page);
  }
  await SpecialPowers.popPrefEnv();
});
