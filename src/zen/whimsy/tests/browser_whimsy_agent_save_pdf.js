/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W27 aiwrite: the agent's save_pdf tool saves a tab as a PDF in Downloads
// with Firefox's silent Save to PDF, only after the person approves, and
// never overwrites a file ("Title.pdf", then "Title (2).pdf").

const { WhimsyAI } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAI.sys.mjs");
const { WhimsyClaude } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyClaude.sys.mjs");
const { WhimsyAgentTasks } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAgentTasks.sys.mjs");
const { WhimsyAgentGuard } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAgentGuard.sys.mjs");

const AI_ENABLED = "whimsy.ai.enabled";
const ROOT = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com");
const PAGE = ROOT + "whimsy_agent_settings.html";
const NAME = "Account settings";

const aiHadUserValue = Services.prefs.prefHasUserValue(AI_ENABLED);
const aiValue = Services.prefs.getBoolPref(AI_ENABLED, false);

let dir;

function textOf(result) {
  return result.content.filter(c => c.type == "text").map(c => c.text).join("\n");
}

function own(task, name, args = {}) {
  return WhimsyClaude.callTool(name, args, { taskId: task.id });
}

function waitForPause(task, kind) {
  return TestUtils.waitForCondition(() => task.pause && !task.pause.choice && task.pause.kind == kind && task.pause,
    `The task pauses (${kind})`);
}

async function filesIn(folder) {
  return (await IOUtils.getChildren(folder)).map(p => PathUtils.filename(p)).sort();
}

async function isPDF(path) {
  const bytes = await IOUtils.read(path);
  return bytes.length > 100 && new TextDecoder().decode(bytes.subarray(0, 5)) == "%PDF-";
}

add_setup(async function () {
  dir = await useTempDownloadDir();
  Services.prefs.setBoolPref(AI_ENABLED, true);
  WhimsyAgentGuard._setSiteKnownForTesting(() => true);
  registerCleanupFunction(async () => {
    WhimsyAgentGuard._setSiteKnownForTesting(null);
    WhimsyAgentTasks._resetForTesting();
    Services.prefs.clearUserPref("whimsy.feature.ai-agent-save-pdf");
    if (aiHadUserValue) {
      Services.prefs.setBoolPref(AI_ENABLED, aiValue);
    } else {
      Services.prefs.clearUserPref(AI_ENABLED);
    }
    await WhimsyAI.pending;
  });
});

add_task(async function save_pdf_is_listed() {
  const tool = WhimsyClaude.TOOLS.find(t => t.name == "save_pdf");
  ok(tool, "The agent has a save_pdf tool");
  ok(!tool.inputSchema.required?.includes("tabId"), "The tab is optional (the current one by default)");
});

add_task(async function save_pdf_asks_first_and_never_overwrites() {
  const task = WhimsyAgentTasks.start({ mode: "drive" });
  const created = await own(task, "tabs_create", { url: PAGE });
  ok(!created.isError, "Opened the page");
  const { tabId } = JSON.parse(textOf(created));
  const tab = WhimsyClaude.tabById(tabId);
  await TestUtils.waitForCondition(() => tab.label == NAME, "The tab has the page's title");

  // Don't save: nothing is written.
  let pending = own(task, "save_pdf", { tabId });
  let pause = await waitForPause(task, "download");
  is(pause.preview.fields[0].value, `${NAME}.pdf`, "The pause names the file");
  is(pause.preview.title, `Download ${NAME}.pdf?`, "The title says what will be saved");
  is(pause.host, "example.com", "The pause is for the page's site");
  Assert.deepEqual(await filesIn(dir), [], "Nothing is written before the person chooses");
  WhimsyAgentTasks.decide(task.id, "skip");
  let result = await pending;
  ok(textOf(result).includes("chose not to"), "Skipping the pause skips the save");
  Assert.deepEqual(await filesIn(dir), [], "and writes nothing");

  // Save: a real PDF in the (test's) Downloads folder.
  pending = own(task, "save_pdf", { tabId });
  await waitForPause(task, "download");
  WhimsyAgentTasks.decide(task.id, "do");
  result = await pending;
  ok(!result.isError, "The save goes ahead once approved");
  const first = PathUtils.join(dir, `${NAME}.pdf`);
  ok(textOf(result).includes(first), "The result has the saved file's path");
  ok(await isPDF(first), "The file is a PDF");

  // Again: a new name, the first file untouched.
  const before = (await IOUtils.stat(first)).size;
  pending = own(task, "save_pdf", { tabId });
  await waitForPause(task, "download");
  WhimsyAgentTasks.decide(task.id, "do", { allowForTask: true });
  result = await pending;
  const second = PathUtils.join(dir, `${NAME} (2).pdf`);
  ok(textOf(result).includes(second), "A second save gets \" (2)\"");
  ok(await isPDF(second), "and is a PDF too");
  is((await IOUtils.stat(first)).size, before, "The first file is left as it was");

  // No tabId: the tab the person is looking at.
  gBrowser.selectedTab = tab;
  result = await own(task, "save_pdf", {});
  ok(!task.pause, "Allowed for this task on this site, the save doesn't pause again");
  ok(!result.isError, "Saving without a tabId works");
  const third = PathUtils.join(dir, `${NAME} (3).pdf`);
  ok(textOf(result).includes(third), "It saves the current tab, with the next free name");
  ok(await isPDF(third), "as a PDF");
  Assert.deepEqual(await filesIn(dir), [`${NAME} (2).pdf`, `${NAME} (3).pdf`, `${NAME}.pdf`], "Only the three PDFs are written");

  // Bad arguments and the feature switch.
  result = await own(task, "save_pdf", { tabId: "one" });
  ok(result.isError, "A tabId that isn't a number is refused");
  Services.prefs.setBoolPref("whimsy.feature.ai-agent-save-pdf", false);
  result = await own(task, "save_pdf", { tabId });
  ok(result.isError && !task.pause, "With the feature off, the tool refuses without asking");
  Services.prefs.clearUserPref("whimsy.feature.ai-agent-save-pdf");
  is((await filesIn(dir)).length, 3, "Nothing else is written");

  await own(task, "tabs_close", { tabId });
  WhimsyAgentTasks.finish(task.id);
});
