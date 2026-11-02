/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// AI provider: every Whimsy AI feature asks WhimsyAIProviders, which only
// ever uses the provider picked in Settings (no automatic cloud fallback),
// refuses everything while the AI kill switch is on, aborts requests in
// flight when it goes on, and keeps the Claude API key out of prefs.

const { WhimsyAIProviders, WhimsyAIError } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyAIProviders.sys.mjs"
);
const { OSKeyStoreTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/OSKeyStoreTestUtils.sys.mjs"
);

registerCleanupFunction(async () => {
  WhimsyAIProviders.setTestProvider(null);
  await WhimsyAIProviders.setClaudeKey("");
  for (const pref of ["whimsy.ai.enabled", "whimsy.ai.provider", "whimsy.ai.ollama.model", "whimsy.feature.ai-providers"]) {
    Services.prefs.clearUserPref(pref);
  }
});

async function rejectsWith(promise, code, message) {
  try {
    await promise;
    ok(false, `${message}: expected ${code}`);
  } catch (error) {
    is(error.code, code, message);
  }
}

add_task(async function test_defaults() {
  ok(Services.prefs.getBoolPref("whimsy.feature.ai-providers"), "The feature switch is on");
  is(Services.prefs.getStringPref("whimsy.ai.provider"), "apple", "On-device is the default provider");
  is(WhimsyAIProviders.provider, "apple", "and the module agrees");
  ok(!WhimsyAIProviders.isCloud, "which keeps text on the Mac");
  Services.prefs.setStringPref("whimsy.ai.provider", "nonsense");
  is(WhimsyAIProviders.provider, "apple", "An unknown provider falls back to the default, not the cloud");
  Services.prefs.clearUserPref("whimsy.ai.provider");
  is(WhimsyAIProviders.claudeModel, "claude-opus-5-5", "Claude defaults to the latest model");
});

add_task(async function test_fake_provider() {
  const seen = [];
  WhimsyAIProviders.setTestProvider(async request => {
    seen.push(request);
    return '  {"ok": true}  ';
  });
  is(WhimsyAIProviders.provider, "test", "The fake provider is in use");
  ok(await WhimsyAIProviders.isReady(), "and ready");
  is(await WhimsyAIProviders.complete({ prompt: "hi", system: "sys" }), '{"ok": true}', "Answers are trimmed");
  is(seen[0].prompt, "hi", "The prompt reaches the provider");
  is(seen[0].system, "sys", "and the system text");
  Assert.deepEqual(await WhimsyAIProviders.completeJSON({ prompt: "json" }), { ok: true }, "JSON answers parse");

  WhimsyAIProviders.setTestProvider(() => "no json here");
  await rejectsWith(WhimsyAIProviders.completeJSON({ prompt: "x" }), "bad-response", "A non-JSON answer is a bad response");
});

add_task(async function test_kill_switch() {
  let calls = 0;
  WhimsyAIProviders.setTestProvider(() => {
    calls++;
    return "answer";
  });
  Services.prefs.setBoolPref("whimsy.ai.enabled", false);
  ok(!WhimsyAIProviders.enabled, "The kill switch turns the provider off");
  ok(!(await WhimsyAIProviders.isReady()), "Nothing is ready");
  await rejectsWith(WhimsyAIProviders.complete({ prompt: "x" }), "blocked", "Requests are refused");
  is(calls, 0, "without reaching the provider");
  Services.prefs.clearUserPref("whimsy.ai.enabled");

  Services.prefs.setBoolPref("whimsy.feature.ai-providers", false);
  await rejectsWith(WhimsyAIProviders.complete({ prompt: "x" }), "blocked", "The feature switch off refuses too");
  Services.prefs.clearUserPref("whimsy.feature.ai-providers");
  is(await WhimsyAIProviders.complete({ prompt: "x" }), "answer", "Back on, requests work");
});

add_task(async function test_kill_switch_aborts_inflight() {
  let started;
  const begun = new Promise(r => (started = r));
  WhimsyAIProviders.setTestProvider(request => {
    started();
    // Never answers on its own: only the abort ends it.
    return new Promise((_, reject) => request.signal.addEventListener("abort", () => reject(new Error("aborted"))));
  });
  const pending = WhimsyAIProviders.complete({ prompt: "slow" });
  await begun;
  Services.prefs.setBoolPref("whimsy.ai.enabled", false);
  await rejectsWith(pending, "blocked", "Turning AI off ends a request in flight");
  Services.prefs.clearUserPref("whimsy.ai.enabled");

  const controller = new AbortController();
  const cancelled = WhimsyAIProviders.complete({ prompt: "slow", signal: controller.signal });
  controller.abort();
  await rejectsWith(cancelled, "aborted", "A caller can cancel its own request");
  is(WhimsyAIProviders._inflight.size, 0, "Nothing is left in flight");
});

add_task(async function test_no_cloud_fallback() {
  WhimsyAIProviders.setTestProvider(null);
  // Claude with no key fails right away instead of trying another provider.
  Services.prefs.setStringPref("whimsy.ai.provider", "claude");
  ok(WhimsyAIProviders.isCloud, "Claude is the cloud provider");
  ok(!(await WhimsyAIProviders.isReady()), "Not ready without a key");
  await rejectsWith(WhimsyAIProviders.complete({ prompt: "x" }), "no-key", "No key: an error, not a fallback");

  // Ollama with no model picked fails the same way.
  Services.prefs.setStringPref("whimsy.ai.provider", "ollama");
  ok(!(await WhimsyAIProviders.isReady()), "Ollama isn't ready without a model");
  await rejectsWith(WhimsyAIProviders.complete({ prompt: "x" }), "no-model", "No model: an error, not a fallback");
  Services.prefs.clearUserPref("whimsy.ai.provider");
});

add_task(async function test_claude_key_storage() {
  OSKeyStoreTestUtils.setup();
  registerCleanupFunction(() => OSKeyStoreTestUtils.cleanup());
  const secret = "sk-ant-test-0123456789";
  ok(!(await WhimsyAIProviders.hasClaudeKey()), "No key at first");
  await WhimsyAIProviders.setClaudeKey(`  ${secret}  `);
  ok(await WhimsyAIProviders.hasClaudeKey(), "The key is saved");
  is(await WhimsyAIProviders.getClaudeKey(), secret, "and reads back, trimmed");
  const file = await IOUtils.readUTF8(PathUtils.join(PathUtils.profileDir, "whimsy-ai-keys.json"));
  ok(!file.includes(secret), "The file only holds ciphertext");
  for (const name of Services.prefs.getChildList("whimsy.ai.")) {
    if (Services.prefs.getPrefType(name) == Services.prefs.PREF_STRING) {
      ok(!Services.prefs.getStringPref(name).includes(secret), `${name} doesn't hold the key`);
    }
  }
  Services.prefs.setStringPref("whimsy.ai.provider", "claude");
  ok(await WhimsyAIProviders.isReady(), "Claude is ready with a key");
  Services.prefs.clearUserPref("whimsy.ai.provider");
  await WhimsyAIProviders.setClaudeKey("");
  ok(!(await WhimsyAIProviders.hasClaudeKey()), "Removing the key forgets it");
});

add_task(async function test_error_toasts() {
  for (const code of ["no-key", "blocked", "something-new"]) {
    WhimsyAIProviders.showError(window, new WhimsyAIError(code));
  }
  const toasts = () => [...(document.getElementById("zen-toast-container")?.children ?? [])].map(t => t._messageId);
  await TestUtils.waitForCondition(() => toasts().includes("whimsy-ai-error-no-key"), "A missing key says so");
  ok(toasts().includes("whimsy-ai-error-failed"), "An unknown error gets the general message");
  const before = toasts().length;
  WhimsyAIProviders.showError(window, new WhimsyAIError("aborted"));
  is(toasts().length, before, "A cancelled request shows nothing");
});

// W10-28: Settings → AI: the provider is three cards (a radio group), and
// only the chosen provider's fields show, in a grid where every control
// starts at the same left edge (the API key field isn't centred).
add_task(async function test_settings_card() {
  await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:preferences#whimsyAI");
  const doc = gBrowser.selectedBrowser.contentDocument;
  const win = gBrowser.selectedBrowser.contentWindow;
  const group = await TestUtils.waitForCondition(() => doc.getElementById("whimsyAIProviderGroup"), "The card is there");
  await TestUtils.waitForCondition(() => group.checkVisibility(), "and showing");
  const radios = [...doc.querySelectorAll('#whimsyAIProvider input[type="radio"]')];
  Assert.deepEqual(radios.map(r => r.value), ["apple", "claude", "ollama"], "Three providers");
  ok(radios.find(r => r.value == "apple").checked, "The cards show the provider");
  ok(!doc.getElementById("whimsyAIAppleRow").hidden, "Apple's status row shows");
  ok(doc.getElementById("whimsyAIClaudeRow").hidden, "Claude's key row doesn't");

  // Arrow keys move between the cards and keep the keyboard there.
  radios[0].focus();
  EventUtils.synthesizeKey("KEY_ArrowRight", {}, win);
  await TestUtils.waitForCondition(() => Services.prefs.getStringPref("whimsy.ai.provider") == "claude", "Right picks Claude");
  is(doc.activeElement, radios[1], "Focus stays on the cards");
  await TestUtils.waitForCondition(() => !doc.getElementById("whimsyAIClaudeRow").hidden, "Picking Claude shows the key row");
  ok(doc.getElementById("whimsyAIAppleRow").hidden, "and hides Apple's");
  is(doc.getElementById("whimsyAIClaudeKey").value, "", "The key field never shows a saved key");

  // The key field is left-aligned in the control column.
  const key = doc.getElementById("whimsyAIClaudeKey").getBoundingClientRect();
  const label = doc.querySelector("#whimsyAIClaudeRow .whimsy-ai-field-label").getBoundingClientRect();
  const status = doc.getElementById("whimsyAIClaudeStatus");
  await TestUtils.waitForCondition(() => status.textContent, "The key status shows");
  // F22: the labels ("API key", "Status") are left-aligned, in a column of
  // their own; every control starts at the next column's edge.
  const grid = doc.getElementById("whimsyAIClaudeRow");
  const gridLeft = grid.getBoundingClientRect().left + parseFloat(win.getComputedStyle(grid).paddingLeft);
  ok(Math.abs(label.left - gridLeft) <= 1.5, `The label is left-aligned (${label.left} vs ${gridLeft})`);
  ok(Math.abs(key.left - (gridLeft + 110 + 12)) <= 1.5, `The key field starts at the control column (${key.left})`);
  const appleLabel = doc.querySelector("#whimsyAIAppleRow .whimsy-ai-field-label");
  is(win.getComputedStyle(appleLabel).textAlign, "start", "Apple's Status label is left-aligned too");
  ok(Math.abs(status.getBoundingClientRect().left - key.left) <= 1.5, "The status starts at the same edge");
  ok(status.dataset.state, "The status has a ready / needs-action dot");

  // A click moves the keyboard to the chosen provider's first control.
  EventUtils.synthesizeMouseAtCenter(radios[2].closest("label"), {}, win);
  await TestUtils.waitForCondition(() => doc.activeElement?.id == "whimsyAIOllamaEndpoint", "Ollama's server field gets focus");

  Services.prefs.setBoolPref("whimsy.ai.enabled", false);
  await TestUtils.waitForCondition(() => group.inert && group.hasAttribute("data-ai-off"), "Turning AI off dims the card");
  Services.prefs.clearUserPref("whimsy.ai.enabled");
  await TestUtils.waitForCondition(() => !group.inert, "and back");
  Services.prefs.clearUserPref("whimsy.ai.provider");
  BrowserTestUtils.removeTab(gBrowser.selectedTab);
});

// fix7: Settings said Apple's command line tools were missing although
// "xcode-select --install" said they were installed. The tools are now
// found wherever they are, and each failure names what's missing.
add_task(async function test_apple_toolchain_detection() {
  const { AI_ERROR_CODES } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIProviders.sys.mjs");
  const root = await IOUtils.createUniqueDirectory(PathUtils.tempDir, "whimsy-devtools");
  const clt = PathUtils.join(root, "CommandLineTools");
  const xcode = PathUtils.join(root, "Xcode.app", "Contents", "Developer");
  const swiftc = PathUtils.join(clt, "usr", "bin", "swiftc");
  const framework = PathUtils.join(clt, "SDKs", "MacOSX.sdk", "System", "Library", "Frameworks", "FoundationModels.framework");
  const realRun = WhimsyAIProviders._run;
  const realDirs = WhimsyAIProviders._developerDirCandidates;
  // xcode-select points at an Xcode that's gone (moved or deleted).
  WhimsyAIProviders._run = async (command, args) => {
    is(command, "/usr/bin/xcode-select", "Only xcode-select runs (xcrun could prompt)");
    Assert.deepEqual(args, ["-p"], "asked for the selected folder");
    return { exitCode: 0, output: xcode + "\n" };
  };
  WhimsyAIProviders._developerDirCandidates = [clt];
  try {
    is(await WhimsyAIProviders._findToolchain(), "apple-needs-tools", "No swiftc anywhere: the tools are missing");
    ok(WhimsyAIProviders.appleDetail.includes(clt), "Settings names the folders that were searched");

    await IOUtils.makeDirectory(PathUtils.parent(swiftc));
    await IOUtils.writeUTF8(swiftc, "");
    is(await WhimsyAIProviders._findToolchain(), "apple-tools-outdated", "swiftc without the FoundationModels SDK: tools too old");

    await IOUtils.makeDirectory(framework);
    Assert.deepEqual(
      await WhimsyAIProviders._findToolchain(),
      { developerDir: clt, sdk: PathUtils.join(clt, "SDKs", "MacOSX.sdk") },
      "The command line tools are found even when xcode-select points at a missing Xcode"
    );

    // An Xcode with the newer SDK in its platform folder works too.
    WhimsyAIProviders._developerDirCandidates = [];
    const xcodeSwiftc = PathUtils.join(xcode, "Toolchains", "XcodeDefault.xctoolchain", "usr", "bin", "swiftc");
    await IOUtils.makeDirectory(PathUtils.parent(xcodeSwiftc));
    await IOUtils.writeUTF8(xcodeSwiftc, "");
    const xcodeSdk = PathUtils.join(xcode, "Platforms", "MacOSX.platform", "Developer", "SDKs", "MacOSX.sdk");
    await IOUtils.makeDirectory(PathUtils.join(xcodeSdk, "System", "Library", "Frameworks", "FoundationModels.framework"));
    Assert.deepEqual(await WhimsyAIProviders._findToolchain(), { developerDir: xcode, sdk: xcodeSdk }, "Xcode's SDK is found");

    is(
      WhimsyAIProviders._buildFailure("You have not agreed to the Xcode license agreements."),
      "apple-needs-license",
      "An unaccepted Xcode license says so"
    );
    is(
      WhimsyAIProviders._buildFailure("error: active developer path (/Applications/Xcode.app) does not exist"),
      "apple-tools-path-invalid",
      "Invalid developer path diagnosed"
    );
    is(
      WhimsyAIProviders._buildFailure("error: no such module 'FoundationModels'"),
      "apple-tools-outdated",
      "Missing FoundationModels module diagnosed as outdated tools"
    );
    is(WhimsyAIProviders._buildFailure("error: cannot find 'X' in scope"), "apple-build-failed", "Other build errors aren't 'missing tools'");
    is(
      WhimsyAIProviders._buildDetail("warning: unused\n/tmp/WhimsyFM.swift:3:5: error: cannot find 'X' in scope\n"),
      "error: cannot find 'X' in scope",
      "The compiler's first error is what Settings shows"
    );

    const l10n = new Localization(["browser/whimsy.ftl"], true);
    for (const code of [
      "apple-needs-tools",
      "apple-tools-outdated",
      "apple-tools-path-invalid",
      "apple-needs-license",
      "apple-build-failed",
      "apple-helper-blocked",
    ]) {
      ok(AI_ERROR_CODES.includes(code), `${code} is a known error`);
      ok(l10n.formatValueSync(`whimsy-ai-error-${code}`), `${code} has a toast`);
      const status = l10n.formatValueSync(`whimsy-ai-apple-status-${code}`, { detail: "DETAIL" });
      ok(status, `${code} has a Settings message`);
      // W10-07: only "no swiftc anywhere" may send people to install tools.
      if (code != "apple-needs-tools") {
        ok(!status.includes("xcode-select --install"), `${code} doesn't tell people to install tools they have`);
      }
    }
    ok(
      l10n.formatValueSync("whimsy-ai-apple-status-apple-needs-tools", { detail: "DETAIL" }).includes("DETAIL"),
      "Missing tools name the folders searched"
    );
    // A failed build's compiler error shows under the status
    // (test_apple_build_falls_back_and_says_why).
  } finally {
    WhimsyAIProviders._run = realRun;
    WhimsyAIProviders._developerDirCandidates = realDirs;
    await IOUtils.remove(root, { recursive: true });
  }
});

// W10-07: Set Up still failed on a Mac with the tools installed. Whimsy (like
// Firefox) has LSFileQuarantineEnabled, so the helper swiftc linked was
// flagged com.apple.quarantine and macOS held it at launch: the --check
// never returned. The flag is now cleared before the helper runs, and a
// helper that still doesn't start says so instead of hanging.
add_task(async function test_apple_helper_quarantine() {
  if (Services.appinfo.OS != "Darwin") {
    ok(true, "macOS only");
    return;
  }
  const root = await IOUtils.createUniqueDirectory(PathUtils.tempDir, "whimsy-fm");
  const helper = PathUtils.join(root, "whimsy-fm-test");
  const descriptor = Object.getOwnPropertyDescriptor(WhimsyAIProviders, "_helperPath");
  const realTimeout = WhimsyAIProviders._helperCheckTimeoutMs;
  Object.defineProperty(WhimsyAIProviders, "_helperPath", { get: () => helper, configurable: true });
  const quarantine = "com.apple.quarantine";
  try {
    await IOUtils.writeUTF8(helper, "#!/bin/sh\necho available\n");
    await IOUtils.setPermissions(helper, 0o755);
    await IOUtils.setMacXAttr(helper, quarantine, new TextEncoder().encode("0081;6ae6c5e6;Whimsy;"));
    ok(await IOUtils.hasMacXAttr(helper, quarantine), "The helper starts out quarantined, as Whimsy's files are");
    WhimsyAIProviders._helperPromise = null;
    is(await WhimsyAIProviders.appleStatus({ build: true }), "available", "The helper runs");
    ok(!(await IOUtils.hasMacXAttr(helper, quarantine)), "Its quarantine flag was cleared before it ran");

    // A helper macOS holds at launch reports that, not "Checking…" forever.
    await IOUtils.writeUTF8(helper, "#!/bin/sh\nexec sleep 30\n");
    await IOUtils.setPermissions(helper, 0o755);
    WhimsyAIProviders._helperPromise = null;
    WhimsyAIProviders._helperCheckTimeoutMs = 500;
    is(await WhimsyAIProviders.appleStatus({ build: true }), "apple-helper-blocked", "A helper that never starts is reported as blocked");

    // F22: a helper that answers but never exits: its answer, not
    // "Checking…" forever.
    await IOUtils.writeUTF8(helper, "#!/bin/sh\necho available\nexec sleep 30\n");
    await IOUtils.setPermissions(helper, 0o755);
    WhimsyAIProviders._helperPromise = null;
    is(await WhimsyAIProviders.appleStatus({ build: true }), "available", "A helper that answers but stays up still counts");
  } finally {
    Object.defineProperty(WhimsyAIProviders, "_helperPath", descriptor);
    WhimsyAIProviders._helperCheckTimeoutMs = realTimeout;
    WhimsyAIProviders._helperPromise = null;
    await IOUtils.remove(root, { recursive: true });
  }
});

// W10-07: Settings still said "xcode-select --install" on a Mac whose
// tools were installed. Any failed build was "reinstall the tools", and
// only MacOSX.sdk was tried (Software Update can point it at an SDK the
// compiler can't read, or leave FoundationModels only in a versioned SDK).
// Now every SDK and toolchain is tried, swiftc runs directly, and Settings
// shows what the compiler said.
add_task(async function test_apple_build_falls_back_and_says_why() {
  const root = await IOUtils.createUniqueDirectory(PathUtils.tempDir, "whimsy-devtools");
  const clt = PathUtils.join(root, "CommandLineTools");
  const swiftc = PathUtils.join(clt, "usr", "bin", "swiftc");
  const sdks = PathUtils.join(clt, "SDKs");
  const framework = sdk => PathUtils.join(sdks, sdk, "System", "Library", "Frameworks", "FoundationModels.framework");
  await IOUtils.makeDirectory(PathUtils.parent(swiftc));
  await IOUtils.writeUTF8(swiftc, "");
  // MacOSX.sdk is an old SDK; the new ones are only in versioned folders.
  await IOUtils.makeDirectory(PathUtils.join(sdks, "MacOSX.sdk"));
  await IOUtils.makeDirectory(framework("MacOSX26.5.sdk"));
  await IOUtils.makeDirectory(framework("MacOSX27.0.sdk"));
  await IOUtils.makeDirectory(PathUtils.join(sdks, "MacOSX12.0.sdk"));
  const helper = PathUtils.join(root, "profile", "whimsy-ai", "whimsy-fm-test");

  const realRun = WhimsyAIProviders._run;
  const realDirs = WhimsyAIProviders._developerDirCandidates;
  const realPath = Object.getOwnPropertyDescriptor(WhimsyAIProviders, "_helperPath");
  Object.defineProperty(WhimsyAIProviders, "_helperPath", { get: () => helper, configurable: true });
  WhimsyAIProviders._developerDirCandidates = [clt];
  const calls = [];
  let builds = {};
  WhimsyAIProviders._run = async (command, args, options) => {
    if (command == "/usr/bin/xcode-select") {
      return { exitCode: 0, output: clt + "\n" };
    }
    calls.push({ command, args, options });
    const sdk = args[args.indexOf("-sdk") + 1];
    const result = builds[PathUtils.filename(sdk)] ?? { exitCode: 1, output: "error: unexpected" };
    if (result.exitCode == 0) {
      await IOUtils.writeUTF8(helper, "");
    }
    return result;
  };
  try {
    const found = await WhimsyAIProviders._findToolchains();
    Assert.deepEqual(
      found.map(t => PathUtils.filename(t.sdk)),
      ["MacOSX27.0.sdk", "MacOSX26.5.sdk"],
      "Every SDK with FoundationModels is found, newest first (before, an old MacOSX.sdk meant 'tools outdated')"
    );
    is(found[0].swiftc, swiftc, "with the swiftc beside it");
    if (Services.appinfo.OS != "Darwin") {
      ok(true, "Apple Intelligence only builds on macOS");
      return;
    }

    // The newest SDK is newer than the compiler; the next one builds.
    builds = {
      "MacOSX27.0.sdk": {
        exitCode: 1,
        output:
          "error: failed to build module 'FoundationModels'; this SDK is not supported by the compiler " +
          "(the SDK is built with 'Apple Swift version 6.4', while this compiler is 'Apple Swift version 6.2'). " +
          "Please select a toolchain which matches the SDK.\n",
      },
      "MacOSX26.5.sdk": { exitCode: 0, output: "" },
    };
    is(await WhimsyAIProviders._ensureHelper(), helper, "A failed SDK falls back to the next one");
    is(calls.length, 2, "Two builds were tried");
    is(calls[0].command, swiftc, "swiftc runs directly (xcrun's shim can prompt or need Xcode's first launch)");
    ok(calls[0].args.includes("-module-cache-path"), "with its own module cache");
    is(calls[0].options.environment.DEVELOPER_DIR, clt, "in its own developer folder");

    // Nothing builds: the most telling reason, and the compiler's words.
    await IOUtils.remove(helper);
    WhimsyAIProviders._helperPromise = null;
    calls.length = 0;
    builds = {
      "MacOSX27.0.sdk": { exitCode: 1, output: "/x/WhimsyFM.swift:9:5: error: something odd happened\n1 error generated.\n" },
      "MacOSX26.5.sdk": {
        exitCode: 1,
        output: "error: failed to build module 'FoundationModels'; this SDK is not supported by the compiler\n",
      },
    };
    is(await WhimsyAIProviders.appleStatus({ build: true }), "apple-tools-mismatch", "A compiler older than its SDK says so");
    ok(WhimsyAIProviders.appleDetail.includes("this SDK is not supported by the compiler"), "and keeps the compiler's words");

    builds["MacOSX26.5.sdk"] = builds["MacOSX27.0.sdk"];
    is(await WhimsyAIProviders.appleStatus({ build: true }), "apple-build-failed", "Another failure is a failed build");
    is(WhimsyAIProviders.appleDetail, "error: something odd happened", "shown without the file path");

    // Settings shows it under the status, and no longer says to reinstall.
    await BrowserTestUtils.withNewTab("about:preferences#whimsyAI", async browser => {
      const doc = browser.contentDocument;
      const button = await TestUtils.waitForCondition(() => doc.getElementById("whimsyAIAppleCheck"), "Apple's row");
      // The first look (no build) says "Set Up" before the click builds.
      await TestUtils.waitForCondition(
        () => !button.disabled && doc.getElementById("whimsyAIAppleStatus").getAttribute("data-l10n-id") != "whimsy-ai-apple-status-checking" &&
          doc.getElementById("whimsyAIAppleStatus").hasAttribute("data-l10n-id"),
        "Apple's status is shown"
      );
      button.doCommand();
      const detail = doc.getElementById("whimsyAIAppleDetail");
      await TestUtils.waitForCondition(() => !detail.hidden, "The compiler's message shows");
      is(detail.textContent, "error: something odd happened", "word for word");
      await TestUtils.waitForCondition(
        () => doc.getElementById("whimsyAIAppleStatus").textContent.includes("Swift tools"),
        "with a reason that fits"
      );
      ok(!doc.getElementById("whimsyAIAppleStatus").textContent.includes("xcode-select"), "not 'xcode-select --install'");
    });

    const l10n = new Localization(["browser/whimsy.ftl"], true);
    for (const id of ["whimsy-ai-error-apple-tools-mismatch", "whimsy-ai-apple-status-apple-tools-mismatch"]) {
      ok(l10n.formatValueSync(id), `${id} has a string`);
    }
  } finally {
    WhimsyAIProviders._run = realRun;
    WhimsyAIProviders._developerDirCandidates = realDirs;
    if (realPath) {
      Object.defineProperty(WhimsyAIProviders, "_helperPath", realPath);
    } else {
      delete WhimsyAIProviders._helperPath;
    }
    WhimsyAIProviders._helperPromise = null;
    WhimsyAIProviders.appleDetail = "";
    await IOUtils.remove(root, { recursive: true });
  }
});
