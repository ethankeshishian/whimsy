/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W30 extension builder (ideas-inventory §5, mockup e1/e2): "Make an
// extension that…" in chat has the model call write_plugin, which writes a
// plugin folder into <profile>/whimsy-plugins and posts one card: the
// name, "Local plugin · not running yet", Firefox's permission wording under
// "It can:", the files behind a disclosure, and "Review and run", which
// opens the existing Run / Don't Run prompt. Nothing runs before Run; a
// changed manifest asks again (the loader's rule); a plugin this chat
// didn't make changes only when the person allows it. The model is a stub
// that calls the tool over the run's own MCP endpoint, as Claude Code does.

const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
const { ExtensionsUI } = ChromeUtils.importESModule("resource:///modules/ExtensionsUI.sys.mjs");
const { XPIDatabase } = ChromeUtils.importESModule("resource://gre/modules/addons/XPIDatabase.sys.mjs");
const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
const { WhimsyChatPanel } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyChatPanel.sys.mjs");
const { WhimsyAIProviders } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIProviders.sys.mjs");
const { WhimsyAIStore } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIStore.sys.mjs");
const { WhimsyAIClaudeCode } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIClaudeCode.sys.mjs");
const { WhimsyConnectors } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyConnectors.sys.mjs");
const { WhimsyMCPClient } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyMCPClient.sys.mjs");
const { WhimsyLocalPlugins } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyLocalPlugins.sys.mjs");

const PLUGINS = PathUtils.join(PathUtils.profileDir, "whimsy-plugins");
const OUTSIDE = PathUtils.join(PathUtils.profileDir, "whimsy-plugin-builder-outside");
const STORE = PathUtils.join(PathUtils.profileDir, "whimsy-plugin-builder-store");
const chat = () => WhimsyChatPanel.forWindow(window);
const el = () => document.getElementById("whimsy-chat");
const card = () => el().querySelector(".whimsy-chat-plugin");

function hideShorts({ version = "1.0", extraHosts = [] } = {}) {
  return {
    folder: "Hide Shorts",
    files: [
      {
        path: "manifest.json",
        content: JSON.stringify({
          manifest_version: 3,
          name: "Hide Shorts",
          version,
          host_permissions: ["*://*.youtube.com/*", ...extraHosts],
          content_scripts: [{ matches: ["*://*.youtube.com/*"], js: ["content/hide.js"], css: ["hide.css"] }],
        }),
      },
      { path: "content/hide.js", content: "document.documentElement.dataset.noShorts = '';\n" },
      { path: "hide.css", content: "ytd-reel-shelf-renderer { display: none !important; }\n" },
    ],
  };
}

// The stub model: each chat answer takes the next planned write_plugin call
// and makes it through the run's own server, like Claude Code with
// --mcp-config. Other tasks (memory after an answer that says "my") get a
// plain reply and never take a plan or count as an answer.
let plans = [];
let runs = [];
async function* builderModel(provider, request) {
  if (request.task != "chat") {
    yield { type: "text", delta: "[]" };
    return;
  }
  const server = request.tools.find(t => t.name == "whimsy_plugins");
  const run = { names: request.tools.map(t => t.name), server, result: null, error: null };
  runs.push(run);
  if (server) {
    const { tools } = await WhimsyMCPClient.connect(server.url, { headers: server.headers });
    run.description = tools.find(t => t.name == "write_plugin")?.description ?? "";
  }
  const plan = server ? plans.shift() : null;
  if (plan) {
    try {
      run.result = await WhimsyMCPClient.callTool(server.url, "write_plugin", plan, { headers: server.headers });
    } catch (e) {
      run.error = e.message;
    }
  }
  yield { type: "text", delta: "Done. It won’t run until you approve it." };
}

async function ask(text) {
  if (!chat().isOpen) {
    EventUtils.synthesizeKey("e", { accelKey: true });
  }
  await TestUtils.waitForCondition(() => chat().isOpen && chat().ready, "Chat is open");
  const count = runs.length;
  chat().composer.focus();
  EventUtils.sendString(text);
  EventUtils.synthesizeKey("KEY_Enter");
  await TestUtils.waitForCondition(() => runs.length > count, "The model answers");
  await TestUtils.waitForCondition(() => !el().querySelector(".whimsy-chat-msg[data-role='ai'][busy]"), "The answer finishes");
  return runs.at(-1);
}

// Back to the test's tab. Closing a tab opened from it usually selects it
// already, and switchTab waits for a switch that then never comes.
async function backTo(tab) {
  if (gBrowser.selectedTab != tab) {
    await BrowserTestUtils.switchTab(gBrowser, tab);
  }
}

// Each chat task runs in its own tab (its own chat thread), which is closed
// even when the task fails, so no tab outlives the file.
async function inNewTab(task) {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
  try {
    await task(tab);
  } finally {
    if (chat().isOpen) {
      chat().close({ reason: "key" });
    }
    await closeAddonsTabs();
    BrowserTestUtils.removeTab(tab);
  }
}

async function ln(target, link) {
  const proc = await Subprocess.call({ command: "/bin/ln", arguments: ["-s", target, link] });
  is(await proc.wait().then(r => r.exitCode), 0, `ln -s ${link}`);
}

async function closeAddonsTabs() {
  for (const tab of [...gBrowser.tabs].filter(t => t.linkedBrowser?.currentURI?.spec?.startsWith("about:addons"))) {
    await BrowserTestUtils.removeTab(tab);
  }
}

// "Review and run" opens Firefox's prompt (in Add-ons, as for any
// sideload); this answers it like a person.
async function reviewAndRun(run) {
  const button = card().querySelector(".whimsy-chat-pill-btn.primary");
  ok(button && BrowserTestUtils.isVisible(button), "Review and run shows");
  const shown = BrowserTestUtils.waitForEvent(PopupNotifications.panel, "popupshown");
  button.scrollIntoView({ block: "center" });
  EventUtils.synthesizeMouseAtCenter(button, {});
  await shown;
  const notification = PopupNotifications.panel.querySelector("popupnotification:not([hidden])");
  is(notification?.id, "addon-webext-permissions-notification", "It's Firefox's own permission prompt");
  const strings = notification.notification.options.customElementOptions.strings;
  is(strings.header, "Run the plugin “<>”?", "the Local plugins wording");
  is(notification.secondaryButton.label, "Don’t Run", "with the curly apostrophe");
  const choice = run ? notification.button : notification.secondaryButton;
  await TestUtils.waitForCondition(() => !choice.disabled, "the prompt's safety delay has ended");
  await Promise.all(PopupNotifications.panel.getAnimations({ subtree: true }).map(a => a.finished.catch(() => {})));
  const response = new Promise(resolve => ExtensionsUI.once("sideload-response", resolve));
  const hidden = BrowserTestUtils.waitForEvent(PopupNotifications.panel, "popuphidden");
  EventUtils.synthesizeMouseAtCenter(choice, {}, window);
  await Promise.all([response, hidden]);
  return strings;
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["whimsy.ai.enabled", true],
      ["whimsy.feature.ai-hints", false],
      ["whimsy.feature.local-plugins", true],
      ["whimsy.ai.order", "claude"],
      ["whimsy.ai.off", ""],
    ],
  });
  // As in browser_whimsy_local_plugins.js: signing is required for
  // extensions, the way a real build decides it, while this file runs.
  const realMustSign = XPIDatabase.mustSign;
  XPIDatabase.mustSign = type => type == "extension";
  const before = new Map(
    Services.prefs.getChildList("").filter(name => Services.prefs.prefHasUserValue(name)).map(name => {
      const type = Services.prefs.getPrefType(name);
      return [name, { type, value: whimsyReadPref(name, type) }];
    })
  );
  await WhimsyAIStore._resetForTesting(STORE);
  const realTools = WhimsyConnectors.tools;
  WhimsyConnectors.tools = async () => [];
  WhimsyAIProviders.setTestProvider(builderModel);
  registerCleanupFunction(async () => {
    WhimsyConnectors.tools = realTools;
    WhimsyAIProviders.setTestProvider(null);
    if (chat().isOpen) {
      chat().close({ reason: "key" });
    }
    await closeAddonsTabs();
    WhimsyConnectors._bridge?.server.stop(() => {});
    WhimsyConnectors._bridge = null;
    await IOUtils.remove(PLUGINS, { recursive: true, ignoreAbsent: true });
    await IOUtils.remove(OUTSIDE, { recursive: true, ignoreAbsent: true });
    const { AddonManagerPrivate } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    await AddonManagerPrivate.getNewSideloads();
    XPIDatabase.mustSign = realMustSign;
    await WhimsyAIStore._resetForTesting(PathUtils.join(STORE, "done"));
    await IOUtils.remove(STORE, { recursive: true, ignoreAbsent: true });
    for (const name of new Set([...Services.prefs.getChildList(""), ...before.keys()])) {
      const old = before.get(name);
      const type = Services.prefs.getPrefType(name);
      if (!Services.prefs.prefHasUserValue(name)) {
        if (old) {
          whimsyWritePref(name, old.type, old.value);
        }
      } else if (!old) {
        Services.prefs.clearUserPref(name);
      } else if (old.type != type || whimsyReadPref(name, type) !== old.value) {
        whimsyWritePref(name, old.type, old.value);
      }
    }
  });
  await IOUtils.remove(PLUGINS, { recursive: true, ignoreAbsent: true });
});

add_task(async function a_build_request_is_chat_s_not_the_agent_s() {
  ok(WhimsyLocalPlugins.takes("Make an extension that hides YouTube Shorts"), "Making an extension is chat's");
  ok(WhimsyLocalPlugins.takes("Change my Hide Shorts plugin"), "and so is changing one");
  ok(!WhimsyLocalPlugins.takes("Find an extension that blocks ads"), "Finding one isn't");
  const { WhimsyChatAgent } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyChatAgent.sys.mjs");
  ok(!WhimsyChatAgent.looksLikeTask("Make an extension that hides YouTube Shorts"), "The agent leaves it to chat");
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.local-plugins", false]] });
  ok(!WhimsyLocalPlugins.takes("Make an extension that hides YouTube Shorts"), "With local plugins off, chat doesn't claim it");
  await SpecialPowers.popPrefEnv();
});

add_task(async function tool_is_offered_only_with_local_plugins_and_ai() {
  await inNewTab(() => offeredOnlyWithLocalPluginsAndAI());
});

async function offeredOnlyWithLocalPluginsAndAI() {
  let run = await ask("make an extension");
  ok(run.names.includes("whimsy_plugins"), "Chat offers write_plugin");
  const { allowed } = WhimsyAIClaudeCode._mcpConfig([run.server]);
  Assert.deepEqual(allowed, ["mcp__whimsy_plugins"], "Claude Code may call it without asking: writing runs nothing");

  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.local-plugins", false]] });
  run = await ask("make an extension");
  ok(!run.names.includes("whimsy_plugins"), "With local plugins off, the tool isn't offered");
  is(await WhimsyLocalPlugins.builder({ threadId: null }), null, "and no builder exists");
  await SpecialPowers.popPrefEnv();

  await SpecialPowers.pushPrefEnv({ set: [["whimsy.ai.enabled", false]] });
  ok(!WhimsyLocalPlugins.canBuild, "With AI off, chat can't build");
  is(await WhimsyLocalPlugins.builder({ threadId: null }), null, "and no builder exists");
  await SpecialPowers.popPrefEnv();

  // Turned off mid-run: a write already offered is refused.
  const builder = await WhimsyLocalPlugins.builder({ threadId: null });
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.local-plugins", false]] });
  await Assert.rejects(WhimsyMCPClient.callTool(builder.server.url, "write_plugin", hideShorts(), { headers: builder.server.headers }), /turned off/, "A write after the switch goes off is refused");
  await SpecialPowers.popPrefEnv();
  builder.dispose();
  ok(!(await IOUtils.exists(PathUtils.join(PLUGINS, "hide-shorts"))), "and nothing was written");
}

add_task(async function bad_paths_and_manifests_are_refused() {
  const builder = await WhimsyLocalPlugins.builder({ threadId: null });
  const write = args => WhimsyMCPClient.callTool(builder.server.url, "write_plugin", args, { headers: builder.server.headers });
  const good = hideShorts();
  const withFile = file => ({ folder: "escape", files: [...good.files, file] });
  for (const path of ["../outside.js", "/tmp/x.js", "~/x.js", "a\\..\\b.js", "C:x.js", "a//b.js", "./a.js", "a/./b.js", "a/../../b.js", "a\u0000.js"]) {
    await Assert.rejects(write(withFile({ path, content: "x" })), /isn't a relative path/, `${JSON.stringify(path)} is refused`);
  }
  await Assert.rejects(write(withFile({ path: "Hide.CSS", content: "x" })), /used twice/, "two names for one file are refused");
  await Assert.rejects(write(withFile({ path: "hide.css/x.js", content: "x" })), /used twice/, "a file and a folder can't share a name");
  await Assert.rejects(write(withFile({ path: "big.js", content: "x".repeat(WhimsyLocalPlugins.LIMITS.fileBytes + 1) })), /larger than/, "an oversized file is refused");
  await Assert.rejects(
    write({ folder: "many", files: [...good.files, ...Array.from({ length: WhimsyLocalPlugins.LIMITS.files }, (_, i) => ({ path: `f${i}.js`, content: "" }))] }),
    /at most/,
    "too many files are refused"
  );
  await Assert.rejects(write({ folder: "x", files: [{ path: "a.js", content: "" }] }), /needs a manifest.json/, "a manifest is required");
  const manifest = content => ({ folder: "bad", files: [{ path: "manifest.json", content }] });
  await Assert.rejects(write(manifest("{")), /isn't valid JSON/, "broken JSON is refused");
  await Assert.rejects(write(manifest("[]")), /must be a JSON object/, "a manifest is an object");
  await Assert.rejects(write(manifest(JSON.stringify({ manifest_version: 4, name: "a", version: "1" }))), /manifest_version/, "manifest_version 2 or 3 only");
  await Assert.rejects(write(manifest(JSON.stringify({ manifest_version: 3, version: "1" }))), /needs a "name"/, "a name is required");
  await Assert.rejects(write(manifest(JSON.stringify({ manifest_version: 3, name: "a" }))), /needs a "version"/, "a version is required");
  for (const name of ["escape", "many", "x", "bad"]) {
    ok(!(await IOUtils.exists(PathUtils.join(PLUGINS, name))), `nothing was written for ${name}`);
  }

  // The folder name is made safe, so it can't climb out either.
  is(WhimsyLocalPlugins.folderName("../../Évil  Name/.."), "evil-name", "a folder name keeps letters, digits, and dashes");

  // A plugins entry that's a link to elsewhere is never written through.
  await IOUtils.makeDirectory(OUTSIDE, { createAncestors: true });
  await IOUtils.makeDirectory(PLUGINS, { createAncestors: true });
  await ln(OUTSIDE, PathUtils.join(PLUGINS, "linked"));
  try {
    await Assert.rejects(write({ ...good, folder: "linked" }), /isn't a plugin folder/, "a linked folder is refused, before anyone is asked");
    Assert.deepEqual(await IOUtils.getChildren(OUTSIDE), [], "and nothing reached the folder it points to");
  } finally {
    await IOUtils.remove(PathUtils.join(PLUGINS, "linked"));
  }

  builder.dispose();
  await Assert.rejects(write(good), e => e.code == "auth", "A finished run's tool stops answering");
  const stray = (await IOUtils.getChildren(PathUtils.profileDir)).filter(p => PathUtils.filename(p).startsWith("whimsy-plugin-") && p.endsWith(".tmp"));
  Assert.deepEqual(stray, [], "no staging folder is left behind");
});

add_task(async function chat_writes_a_plugin_that_stays_off_until_run() {
  await inNewTab(tab => writesAPluginThatStaysOff(tab));
});

async function writesAPluginThatStaysOff(tab) {
  plans = [hideShorts()];
  const run = await ask("Make an extension that hides YouTube Shorts");
  ok(run.result?.includes("stays off until"), `The tool reports the write (${run.error ?? "no error"})`);
  const dir = PathUtils.join(PLUGINS, "hide-shorts");
  const manifest = JSON.parse(await IOUtils.readUTF8(PathUtils.join(dir, "manifest.json")));
  is(manifest.browser_specific_settings.gecko.id, "hide-shorts@whimsy-plugins", "Whimsy sets the id");
  is(await IOUtils.readUTF8(PathUtils.join(dir, "content", "hide.js")), "document.documentElement.dataset.noShorts = '';\n", "files are written as given");
  ok(await IOUtils.exists(PathUtils.join(dir, "hide.css")), "every file is there");

  const id = "hide-shorts@whimsy-plugins";
  const addon = await AddonManager.getAddonByID(id);
  ok(addon.userDisabled && !addon.isActive, "The plugin is off");
  ok(!WebExtensionPolicy.getByID(id), "and nothing runs");

  await TestUtils.waitForCondition(() => card()?.querySelector(".whimsy-chat-report-title")?.textContent == "Hide Shorts", "One card names the plugin");
  is(el().querySelectorAll(".whimsy-chat-plugin").length, 1, "one card");
  await TestUtils.waitForCondition(() => card().querySelector(".whimsy-chat-report-detail").textContent == "Local plugin · not running yet", "not running yet");
  is(card().querySelector(".whimsy-chat-plugin-can").textContent, "It can:", "It can: as in the prompt");
  const permissions = [...card().querySelectorAll(".whimsy-chat-plugin-permissions li")].map(li => li.textContent);
  ok(permissions.some(text => text.includes("youtube.com")), "Firefox's permission wording names the site");
  Assert.deepEqual(permissions, WhimsyLocalPlugins.permissions(addon), "the same descriptions the Run prompt uses");
  is(card().querySelectorAll("button:not(.whimsy-chat-plugin-files button)").length, 2, "Two controls: the files row and one button");

  const disclosure = card().querySelector(".whimsy-chat-disclosure");
  is(disclosure.textContent, "3 files", "the files, counted");
  is(disclosure.getAttribute("aria-expanded"), "false", "collapsed");
  const list = card().querySelector(".whimsy-chat-plugin-files");
  ok(list.hidden, "the list is hidden");
  disclosure.scrollIntoView({ block: "center" });
  EventUtils.synthesizeMouseAtCenter(disclosure, {});
  is(disclosure.getAttribute("aria-expanded"), "true", "it expands");
  ok(!list.hidden, "to the file list");
  Assert.deepEqual([...list.querySelectorAll("li")].map(li => li.textContent), ["content/hide.js", "hide.css", "manifest.json"], "names only");
  const opened = BrowserTestUtils.waitForNewTab(gBrowser, url => url.startsWith("view-source:file:") && url.endsWith("/whimsy-plugins/hide-shorts/hide.css"), true);
  EventUtils.synthesizeMouseAtCenter(list.querySelectorAll("li button")[1], {});
  BrowserTestUtils.removeTab(await opened);
  await backTo(tab);

  // Don't Run: still off.
  let strings = await reviewAndRun(false);
  ok(strings.msgs.some(text => text.includes("youtube.com")), "The prompt lists what it can do");
  ok((await AddonManager.getAddonByID(id)).userDisabled, "Don’t Run keeps it off");
  ok(!WebExtensionPolicy.getByID(id), "nothing runs");
  await closeAddonsTabs();
  await backTo(tab);

  // Run: it runs, and the card says so.
  await TestUtils.waitForCondition(() => card()?.querySelector(".whimsy-chat-pill-btn.primary"), "The card is back");
  strings = await reviewAndRun(true);
  await TestUtils.waitForCondition(() => WebExtensionPolicy.getByID(id)?.active, "Run starts the plugin");
  await closeAddonsTabs();
  await backTo(tab);
  await TestUtils.waitForCondition(() => card()?.querySelector(".whimsy-chat-report-detail")?.textContent == "Local plugin · running", "Local plugin · running");
  ok(!card().querySelector(".whimsy-chat-pill-btn"), "with nothing left to review");

  // Asked again in the same chat: the same folder is rewritten, the card
  // updates in place, and the changed manifest asks again.
  plans = [hideShorts({ version: "1.1", extraHosts: ["*://*.example.com/*"] })];
  const again = await ask("Also hide them on example.com");
  ok(again.result, "The change is written");
  Assert.deepEqual((await IOUtils.getChildren(PLUGINS)).map(p => PathUtils.filename(p)), ["hide-shorts"], "into the same folder");
  ok(again.description.includes("hide-shorts"), "The tool told the model which plugin this chat made");
  await TestUtils.waitForCondition(() => !WebExtensionPolicy.getByID(id)?.active, "A changed manifest stops it");
  const changed = await AddonManager.getAddonByID(id);
  ok(changed.userDisabled && !changed.seen, "and waits for approval again");
  is(el().querySelectorAll(".whimsy-chat-plugin").length, 1, "Still one card");
  await TestUtils.waitForCondition(() => card().querySelector(".whimsy-chat-report-detail")?.textContent == "Local plugin · not running yet", "It shows the plugin is off");
  await TestUtils.waitForCondition(() => [...card().querySelectorAll(".whimsy-chat-plugin-permissions li")].some(li => li.textContent.includes("example.com")), "and what it can do now");
  strings = await reviewAndRun(true);
  ok(strings.msgs.some(text => text.includes("example.com")), "The prompt asks about the new site");
  await TestUtils.waitForCondition(() => WebExtensionPolicy.getByID(id)?.active, "Run starts it again");
}

add_task(async function a_plugin_this_chat_did_not_make_asks_first() {
  await inNewTab(() => anotherChatsPluginAsksFirst());
});

async function anotherChatsPluginAsksFirst() {
  const dir = PathUtils.join(PLUGINS, "hide-shorts");
  const original = await IOUtils.readUTF8(PathUtils.join(dir, "manifest.json"));
  plans = [hideShorts({ version: "9.0" })];
  if (!chat().isOpen) {
    EventUtils.synthesizeKey("e", { accelKey: true });
  }
  await TestUtils.waitForCondition(() => chat().isOpen && chat().ready, "Chat is open");
  const count = runs.length;
  chat().composer.focus();
  EventUtils.sendString("Change my Hide Shorts plugin");
  EventUtils.synthesizeKey("KEY_Enter");
  const confirm = await TestUtils.waitForCondition(() => el().querySelector(".whimsy-tool-confirm:not([data-decided])"), "A new chat asks before changing another chat's plugin");
  await TestUtils.waitForCondition(() => confirm.querySelector(".whimsy-tool-confirm-title")?.textContent.includes("Write Plugin"), "It names the tool");
  const deny = confirm.querySelector("[data-choice='deny']");
  deny.scrollIntoView({ block: "center" });
  EventUtils.synthesizeMouseAtCenter(deny, {});
  await TestUtils.waitForCondition(() => runs.length > count && (runs.at(-1).result || runs.at(-1).error), "The model hears back");
  ok(/didn't allow/.test(runs.at(-1).error), "Don't allow refuses the write");
  is(await IOUtils.readUTF8(PathUtils.join(dir, "manifest.json")), original, "and the plugin is untouched");
  await TestUtils.waitForCondition(() => !el().querySelector(".whimsy-chat-msg[data-role='ai'][busy]"), "The answer finishes");
  ok(!el().querySelector(".whimsy-chat-plugin"), "No card for a write that didn't happen");
}
