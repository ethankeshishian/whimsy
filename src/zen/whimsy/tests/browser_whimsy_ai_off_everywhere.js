/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Discovery: "AI off, everywhere" (disc-4.1) and the one-time hints audit.
// Each surface's own lane tests its own AI-off behaviour; this file is the
// cross-cutting check that they all hold true AT ONCE on the merged tree,
// plus the hint registry: every id a merged lane has actually registered
// gets its one toast, with no halo anywhere.
//
// Lanes not yet merged into dev at the time this was written (video,
// voice-image, routines-ui) own rows this checklist also names (no
// Summarize, the Routines opt-in card, read aloud/dictation/image-text
// working with AI off) that can't be exercised here yet; see the hand-off.

const { WhimsyAIHints } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIHints.sys.mjs");
const { WhimsyAISelectionCard } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAISelectionCard.sys.mjs");
const { WhimsyCommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommands.sys.mjs");

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
  for (const id of ["ask", "updates", "chat", "context-commands", "agent-mode"]) {
    ok(ids.has(id), `${id}'s lane is merged and registers its hint`);
  }
  for (const id of ["summarize", "voice", "image-text"]) {
    ok(!ids.has(id), `${id} belongs to a lane (video/voice-image) not merged yet`);
  }
  for (const id of ids) {
    ok(WhimsyAIHints.HINTS[id], `${id} has copy and an icon defined (WhimsyAIHints.HINTS)`);
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
