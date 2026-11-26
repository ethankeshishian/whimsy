/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Settings › AI shots, part 3: install steps, the narrow window, and
// animations held midway (see settings-ai.js for why the shots are split).
// 28s on its own.
requestLongerTimeout(6);

Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "head_settings_ai.js", this);

add_task(async function shots_install_steps() {
  let finish;
  const paused = new Promise(r => (finish = r));
  WhimsyClaudeCodeInstall.install = async ({ onStep }) => {
    for (const step of ["fetch", "signature", "download", "hash"]) {
      onStep(step);
    }
    await paused;
    throw Object.assign(new Error("stopped"), { code: "test" });
  };
  setup();
  claudeCode = { installed: false, loggedIn: false, email: "" };
  const page = await openAI();
  await atProviders(page);
  page.S.openSheet("claude");
  await sheet(page, "claude");
  const install = await TestUtils.waitForCondition(() => page.$("whimsyAIClaudeInstall"), "Install shows");
  await settled(page);
  click(page, install);
  await TestUtils.waitForCondition(() => page.$("whimsyAIInstallSteps")?.querySelector('[data-step="check"]')?.dataset.state == "busy", "Checking");
  await whimsyBothSchemes("w23-settings-ai-fu-3.4-steps", async () => {
    page.S.closeSheet({ restore: false });
    page.S.openSheet("claude");
    await sheet(page, "claude");
    await TestUtils.waitForCondition(() => page.$("whimsyAIInstallSteps"), "The steps show");
    await settled(page);
    return () => page.S.closeSheet({ restore: false });
  });
  await TestUtils.waitForCondition(() => !page.S.sheet, "The sheet is closed");
  finish();
  await TestUtils.waitForCondition(() => toastFor("whimsy-ai-toast-claude-code-failed"), "The stopped install says so");
  WhimsyClaudeCodeInstall.install = real.install;
  await done(page);
  restorePrefs();
});

add_task(async function shots_narrow() {
  await resizeTo(860, 800);
  try {
    await shoot("set-N.1", listReady);
  } finally {
    await resizeTo(1280, 800);
  }
});

add_task(async function shots_mid_animation() {
  await mid("sheet-open", 80, page => page.S.openSheet("add-provider"), page => page.S.sheet?.animation);
  await mid("confirm-unfold", 150, page => click(page, page.$("whimsyAIEnable").buttonEl), page => page.unfolds.at(-1));
  await mid("row-expand", 150, page => click(page, row(page, "claude").querySelector("[data-action=details]")), page => page.unfolds.at(-1));
  await mid("ai-off-fade", 90, async page => {
    page.S.fading = null;
    click(page, page.$("whimsyAIEnable").buttonEl);
    const strip = await TestUtils.waitForCondition(() => page.$("whimsyAIConfirmSlot").querySelector(".whimsy-ai-confirm"), "Turn off AI? asks");
    await settled(page);
    click(page, strip.querySelector("[data-action=confirm]"));
  }, page => page.S.fading);
  restorePrefs();
});
