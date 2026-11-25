/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W31 aievals: selection verbs (improve, fix, translate, summarize, quiz) and whole-page translation.
// Set WHIMSY_AIEVALS=1 (whimsy/tools/aievals.sh) to run against the real
// model; otherwise a scripted provider answers from each case's `fake`.

Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "head_aievals.js", this);

requestLongerTimeout(6);

const { PromiseTestUtils } = ChromeUtils.importESModule("resource://testing-common/PromiseTestUtils.sys.mjs");

const AIEVALS_FEATURES = ["selection", "translate"];

add_setup(async () => {
  // Whimsy hands a page to Firefox's translator when no provider can go on;
  // the eval browser cannot download its models (network narrowed), and
  // that fetch rejects outside anything the product awaits.
  PromiseTestUtils.allowMatchingRejectionsGlobally(/Unable to retrieve the translation models/);
  await aievalsSetup({ features: AIEVALS_FEATURES, tag: "text" });
});

const AIEVALS_COUNT = aievalsRegister(AIEVALS_FEATURES);

add_task(async function aievals_finish() {
  ok(AIEVALS_COUNT > 0, `${AIEVALS_COUNT} cases ran`);
  await aievalsFinish("text");
});
