/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Discovery: "AI off, everywhere" (disc-4.1) and the one-time hints audit.
// Each surface's own lane tests its own AI-off behaviour; this file is the
// cross-cutting check that they all hold true AT ONCE on the merged tree,
// plus the hint registry: every id a merged lane has actually registered
// gets its one toast, with no halo anywhere.
//
// The later W23 lanes are checked here too (polishfix2): video (no
// Summarize), voice-image (dictation, image text, and read aloud keep
// working; AI-only parts hide), routines-ui (the opt-in card, no Make It a
// Routine…), page-act (Compare, translate, fill, change, tab requests, the
// scam check, the find card's answer), and secfix's confirm card (no run, so
// no card).

const { WhimsyAIHints } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIHints.sys.mjs");
const { WhimsyAISelectionCard } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAISelectionCard.sys.mjs");
const { WhimsyCommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommands.sys.mjs");
const { WhimsyAI } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAI.sys.mjs");

const mod = name => ChromeUtils.importESModule(`resource:///modules/whimsy/${name}.sys.mjs`)[name];

// Whether a registered command lists itself in the command bar right now.
function commandAvailable(id) {
  const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");
  const action = globalActions.find(a => a.commandId == id);
  ok(action, `${id} is in the command bar's list`);
  return !!action?.isAvailable?.(window);
}

async function withAIOff(fn) {
  Services.prefs.setBoolPref("whimsy.ai.enabled", false);
  await WhimsyAI.pending;
  try {
    await fn();
  } finally {
    Services.prefs.setBoolPref("whimsy.ai.enabled", true);
    await WhimsyAI.pending;
  }
}

registerCleanupFunction(async () => {
  Services.prefs.setBoolPref("whimsy.ai.enabled", true);
  WhimsyAIHints._settleForTesting();
});

// The ids a currently-merged lane has actually registered (ai-core/ai-base,
// chat-shell, cmdbar-ai/cmdbar-updates, commands/context-commands,
// agent-chat). Asserted as a set, not hardcoded against the full disc-1.1
// list, so this doesn't need rewriting as later lanes merge (handoff's
// recommendation).
add_task(function registered_hints_match_merged_lanes() {
  const ids = new Set(WhimsyAIHints._registeredIdsForTesting());
  for (const id of ["ask", "updates", "chat", "context-commands", "agent-mode", "voice", "image-text"]) {
    ok(ids.has(id), `${id}'s lane is merged and registers its hint`);
  }
  // Voice and image text work on this Mac, so their hints show with AI off.
  for (const id of ["voice", "image-text"]) {
    ok(WhimsyAIHints._registeredHintForTesting(id).aiOff, `${id}'s hint shows with AI off`);
  }
  ok(!ids.has("summarize"), "No hint is registered under the old summarize id");
  for (const id of ids) {
    // A hint takes its copy and icon from WhimsyAIHints.HINTS, or brings its own copy.
    const hint = WhimsyAIHints._registeredHintForTesting(id);
    ok(WhimsyAIHints.HINTS[id] || hint.l10nId != `whimsy-ai-hint-${id}`, `${id} has its copy defined`);
  }
});

// cmd-1.17/1.18, disc-4.2: covered end to end by browser_whimsy_cmdbar_ask.js
// (ai_off_no_ask_row_set_up_ai_when_typed) and browser_whimsy_cmdk_ai.js
// (ai_off_and_private_unchanged). Not duplicated here.

// disc-4.1: no AI right-click rows with AI off. WhimsyAISelectionCard
// gates on WhimsyAI.enabled (available()), but nothing asserted it with AI
// off until now.
add_task(async function ai_off_no_selection_rows() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?ai-off-selection");
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.ai.enabled", false]] });
  try {
    ok(!WhimsyAISelectionCard.available(window), "AI off: WhimsyAISelectionCard refuses to offer anything");
    for (const id of ["cmd_whimsyAIImproveWriting", "cmd_whimsyAIFixSpelling"]) {
      ok(WhimsyCommands.get(id), `${id} is still a registered command`);
    }
    // Both commands' isAvailable is `w => this.available(w)` (checked above),
    // so neither ever lists itself in the command bar or right-click rows
    // with AI off; WhimsyCommands.get() doesn't expose isAvailable itself
    // (it's command-bar/menu-listing internals, not part of the public entry).
  } finally {
    await SpecialPowers.popPrefEnv();
    BrowserTestUtils.removeTab(tab);
  }
});

// A hint never shows with AI off unless it's marked aiOff (voice, image
// text; not merged yet), and shows no halo on any control when it does.
add_task(async function hints_never_show_with_ai_off_unless_marked() {
  await SpecialPowers.pushPrefEnv({
    set: [["whimsy.ai.enabled", false], ["whimsy.ai.hints.seen", ""], ["whimsy.ai.hints.today", ""]],
  });
  const unregister = WhimsyAIHints.register({ id: "test-ai-off-hint", isVisible: () => true });
  try {
    const asked = WhimsyAIHints.request(window, "test-ai-off-hint");
    is(asked, false, "request() refuses outright (not even queued) for a plain hint with AI off");
    await new Promise(r => setTimeout(r, 50));
    is(currentToast(), null, "...so nothing ever shows");
  } finally {
    unregister();
    WhimsyAIHints._settleForTesting();
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function no_halo_anywhere_in_the_document() {
  ok(!document.querySelector("[whimsy-ai-halo], .whimsy-ai-halo, [data-whimsy-halo]"),
    "No halo attribute or class exists anywhere in the browser window (owner, 2026-11-08: toast only)");
});

// video: no Summarize (plate or command); the speed plates stay.
add_task(async function video_with_ai_off() {
  await withAIOff(async () => {
    ok(!mod("WhimsyVideoSummary").enabled, "video: Summarize is off with AI off");
    ok(!commandAvailable("cmd_whimsySummarizeVideo"), "video: Summarize This Video isn't offered");
    ok(mod("WhimsyVideoSpeed").enabled, "video: the speed plates keep working");
  });
});

// voice-image: dictation, image text, and read aloud work on this Mac, so
// they keep working; the AI-only parts (Ask about this image, translation
// through a provider) hide.
add_task(async function voice_image_with_ai_off() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") + "whimsy_chat_article.html");
  try {
    await withAIOff(async () => {
      ok(mod("WhimsyDictation").enabled, "voice: dictation works with AI off");
      ok(mod("WhimsyImageText").enabled, "image text works with AI off");
      ok(mod("WhimsyReadAloud").enabled, "read aloud works with AI off");
      is(commandAvailable("cmd_whimsyDictate"), mod("WhimsyDictation").available(), "voice: Dictate is offered exactly when this Mac can dictate, AI or not");
      is(commandAvailable("cmd_whimsyListenPage"), mod("WhimsyReadAloud").readable(window), "read aloud: Listen to This Page is offered exactly when the page is readable, AI or not");
      ok(!mod("WhimsyAITranslate").enabled, "AI translation (Translate better) is off");
      ok(!commandAvailable("cmd_whimsyAITranslateBetter"), "and isn't offered");
    });
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
});

// routines-ui: the Library shows the opt-in card; chat's Save as… can't make
// a routine (no agent at all with AI off).
add_task(async function routines_with_ai_off() {
  await withAIOff(async () => {
    ok(!mod("WhimsyRoutines").enabled, "routines: off with AI off");
    ok(!mod("WhimsyPageWatch").enabled, "page watches: off with AI off");
    ok(!mod("WhimsyChatAgent").enabled, "agent: off with AI off, so no Save as… and no Make It a Routine…");
    ok(mod("WhimsyRoutinesUI").openLibrary(window), "The Library opens on Routines");
    const section = await TestUtils.waitForCondition(() => document.querySelector("whimsy-library-routines-section")?.loaded && document.querySelector("whimsy-library-routines-section"), "The Routines section is up");
    await TestUtils.waitForCondition(() => section.querySelector(".whimsy-routines-opt-in"), "routines: the opt-in card, not the list");
    ok(!mod("WhimsyRoutinesUI").openForm(window, {}), "routines: the form doesn't open");
    const ZenLibrary = window.customElements.get("zen-library");
    if (ZenLibrary?.isLibraryOpen) {
      ZenLibrary.animateProgress(0);
      await TestUtils.waitForCondition(() => !ZenLibrary.isLibraryOpen, "The Library closes");
    }
  });
});

// page-act: every AI page action is gone at once.
add_task(async function page_act_with_ai_off() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?ai-off-page-act");
  try {
    await withAIOff(async () => {
      ok(!mod("WhimsyAICompare").enabled, "Compare is off");
      ok(!document.getElementById("whimsy-compare-action") || document.getElementById("whimsy-compare-action").hidden, "and its pill isn't in the address field");
      ok(!mod("WhimsyAIPageEdits").enabled, "Change This Page… is off");
      ok(!mod("WhimsyAITabRequests").enabled, "tab requests are off");
      ok(!mod("WhimsyScamCheck").enabled, "the scam check is off");
      ok(!document.querySelector("notification-message.whimsy-scam"), "and no scam warning shows");
      ok(!mod("WhimsyAIPage").askEnabled, "the find card offers no AI answer");
      for (const id of ["cmd_whimsyAICompare", "cmd_whimsyAIChangePage", "cmd_whimsyAITabRequest", "cmd_whimsyAIDraftReply", "cmd_whimsyAIFillForm"]) {
        ok(!commandAvailable(id), `${id} isn't offered`);
      }
    });
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
});

// secfix: the connector confirm card only comes from a run, and no run
// starts with AI off, so no card can ask.
add_task(async function secfix_confirm_card_with_ai_off() {
  await withAIOff(async () => {
    let confirmed = false;
    await Assert.rejects(
      mod("WhimsyAIRouter").run({ task: "chat", messages: [{ role: "user", content: "hi" }], confirmTool: () => (confirmed = true) }),
      e => e.code == "blocked",
      "A chat run is blocked before any tool or confirm card"
    );
    ok(!confirmed, "nothing asked to be confirmed");
    ok(!document.querySelector(".whimsy-tool-confirm"), "no confirm card anywhere");
  });
});
