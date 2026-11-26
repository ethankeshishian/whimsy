/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Settings › AI shots, part 2: the sheets (see settings-ai.js for why the
// shots are split). 55s on its own; 224s late in W31's full run.
requestLongerTimeout(8);

Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "head_settings_ai.js", this);

add_task(async function shots_sheets() {
  const open = (id, opts) => async page => {
    await listReady(page);
    page.S.openSheet(id, opts);
    return sheet(page, id);
  };
  await shoot("set-3.1", async page => {
    await open("add-provider")(page);
    await TestUtils.waitForCondition(() => page.doc.querySelectorAll("#whimsyAISheet .whimsy-ai-choice").length >= 4, "The choices show");
  });
  await shoot("set-3.2", async page => {
    await open("claude")(page);
    await TestUtils.waitForCondition(() => page.$("whimsyAIClaudeSignIn"), "Connect shows");
  });
  await shoot("set-3.5", async page => {
    claudeCode = { installed: true, loggedIn: false, email: "" };
    await open("claude")(page);
    await TestUtils.waitForCondition(() => page.$("whimsyAIClaudeSignIn"), "Sign in shows");
  });
  await shoot("fu-3.4-consent", async page => {
    claudeCode = { installed: false, loggedIn: false, email: "" };
    await open("claude")(page);
    await TestUtils.waitForCondition(() => page.$("whimsyAIClaudeInstall"), "Install shows");
  });
  await shoot("set-3.6", open("claude", { method: "key" }));
  await shoot("set-3.13", open("gemini"));
  await shoot("set-3.12", async page => {
    accept = false;
    await open("openai", { method: "key" })(page);
    const field = page.$("whimsyAIKeyField");
    field.focus();
    EventUtils.sendString("sk-" + "proj-" + "test0000000000000000wxyz", page.win);
    click(page, page.$("whimsyAIKeyConnect"));
    await TestUtils.waitForCondition(() => visible(page.$("whimsyAIKeyError")), "Rejected");
    return () => (accept = true);
  });
  await shoot("set-3.10", async page => {
    WhimsyAIProviders.connectPlan = async () => ({ welcome: true });
    await open("openai")(page);
    click(page, page.$("whimsyAIOpenAIContinue"));
    await TestUtils.waitForCondition(() => page.$("whimsyAIOpenAIDone"), "Welcome");
    closeToasts();
    return () => (WhimsyAIProviders.connectPlan = real.connectPlan);
  });
  await shoot("set-3.11", async page => {
    WhimsyAIProviders.connectPlan = async () => {
      throw Object.assign(new Error("ineligible"), { code: "plan-ineligible" });
    };
    await open("openai")(page);
    click(page, page.$("whimsyAIOpenAIContinue"));
    await TestUtils.waitForCondition(() => page.doc.querySelector("#whimsyAISheet .whimsy-ai-note[data-tone=fail]"), "Can't be used");
    return () => (WhimsyAIProviders.connectPlan = real.connectPlan);
  });
  const realDetails = WhimsyAIProviders.ollamaModelDetails;
  await shoot("set-3.14", async page => {
    const wait = Promise.withResolvers();
    WhimsyAIProviders.ollamaModelDetails = () => wait.promise;
    await open("ollama")(page);
    return () => {
      WhimsyAIProviders.ollamaModelDetails = realDetails;
      wait.resolve([]);
    };
  });
  await shoot("set-3.15", async page => {
    Services.prefs.setStringPref("whimsy.ai.ollama.endpoint", `${base}/ollama`);
    await open("ollama")(page);
    await TestUtils.waitForCondition(() => page.$("whimsyAIOllamaDone"), "Models found");
  });
  await shoot("set-3.16", async page => {
    Services.prefs.setStringPref("whimsy.ai.ollama.endpoint", "http://127.0.0.1:1");
    await open("ollama")(page);
    await TestUtils.waitForCondition(() => page.doc.querySelector("#whimsyAISheet .whimsy-ai-note[data-tone=fail]"), "Not running");
  });
});
