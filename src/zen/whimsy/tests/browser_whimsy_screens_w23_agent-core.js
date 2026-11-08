/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W23 agent-core screenshots. The engine's one visible surface: "Keep apps
// in their own space" adds a normal AI space to the switcher (fu-agent 3.4,
// "Turned on: a normal AI space appears in the switcher"). Pause cards, the
// run card, and the Drive look are the chat and agent-tabs lanes' shots.

const OWN = "whimsy.ai.outside-agents.own-space";
const OWN_ID = "whimsy.ai.outside-agents.space-id";

add_task(async function shot_fu_agent_3_4_ai_space() {
  await gZenWorkspaces.promiseInitialized;
  Services.prefs.setBoolPref(OWN, true);
  const spaceId = await TestUtils.waitForCondition(() => Services.prefs.getStringPref(OWN_ID, ""), "The AI space is made");
  const space = gZenWorkspaces.getWorkspaces().find(w => w.uuid == spaceId);
  try {
    ok(space, "It's in the switcher");
    await whimsyBothSchemes("w23-agent-core-fu-agent-3.4-ai-space", async () => {
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    });
  } finally {
    Services.prefs.clearUserPref(OWN);
    Services.prefs.clearUserPref(OWN_ID);
    if (space) {
      await gZenWorkspaces.removeWorkspace(space.uuid);
      const { ContextualIdentityService } = ChromeUtils.importESModule("resource://gre/modules/ContextualIdentityService.sys.mjs");
      ContextualIdentityService.remove(space.containerTabId);
    }
  }
});
