/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W31 aievals: the network guard, chat answers (page and tab context, private wall, injection), and hover-card summaries.
// Set WHIMSY_AIEVALS=1 (whimsy/tools/aievals.sh) to run against the real
// model; otherwise a scripted provider answers from each case's `fake`.

Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "head_aievals.js", this);

requestLongerTimeout(6);

const AIEVALS_FEATURES = ["network", "chat", "hover"];

add_setup(async () => {
  await aievalsSetup({ features: AIEVALS_FEATURES, tag: "chat" });
});

const AIEVALS_COUNT = aievalsRegister(AIEVALS_FEATURES);

add_task(async function aievals_finish() {
  ok(AIEVALS_COUNT > 0, `${AIEVALS_COUNT} cases ran`);
  await aievalsFinish("chat");
});
