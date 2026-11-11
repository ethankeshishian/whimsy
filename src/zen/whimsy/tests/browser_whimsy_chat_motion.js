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
    .replace(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi, n => String(Number(Number(n).toPrecision(5))))
    .trim();

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
    is(easing(timing.easing), easing(motion.in.easing), "...with the sidebar's own easing");
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
    is(easing(timing.easing), easing(motion.out.easing), "...with the sidebar's own easing");
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
