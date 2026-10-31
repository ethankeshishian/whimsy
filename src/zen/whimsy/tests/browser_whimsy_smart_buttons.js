/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave9: W9-06 Smart address bar buttons (Lens/Arc parity).
// Reader, Translate, media, and Downloads in progress appear beside the address
// bar only when relevant, reusing existing Firefox/Zen buttons without duplicates.

ChromeUtils.defineESModuleGetters(this, {
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
  WhimsySmartButtons: "resource:///modules/whimsy/WhimsySmartButtons.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.smart-buttons";

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      [FEATURE_PREF, true],
      ["media.videocontrols.picture-in-picture.urlbar-button.enabled", true],
      ["browser.download.autohideButton", true],
    ],
  });
  WhimsySmartButtons.initWindow(window);
});

add_task(async function test_smart_buttons_registry_and_layout() {
  ok(WhimsySmartButtons.enabled, "Smart buttons feature is enabled");

  // Commands in WhimsyCommands registry with assignable shortcuts
  const readerCmd = WhimsyCommands.get("cmd_whimsyToggleReader");
  ok(readerCmd, "cmd_whimsyToggleReader is registered");
  is(readerCmd.l10nId, "whimsy-action-toggle-reader", "Reader command l10n id");

  const translateCmd = WhimsyCommands.get("cmd_whimsyTranslatePage");
  ok(translateCmd, "cmd_whimsyTranslatePage is registered");
  is(translateCmd.l10nId, "whimsy-action-translate-page", "Translate command l10n id");

  const mediaCmd = WhimsyCommands.get("cmd_whimsyToggleMedia");
  ok(mediaCmd, "cmd_whimsyToggleMedia is registered");
  is(mediaCmd.l10nId, "whimsy-action-media-pip", "Media PiP command l10n id");

  const downloadsCmd = WhimsyCommands.get("cmd_whimsyDownloads");
  ok(downloadsCmd, "cmd_whimsyDownloads is registered");
  is(downloadsCmd.l10nId, "whimsy-action-downloads", "Downloads command l10n id");

  // Downloads button layout beside address bar
  const dlBtn = document.getElementById("downloads-button");
  const urlbarContainer = document.getElementById("urlbar-container");
  ok(dlBtn, "Downloads button exists");
  ok(urlbarContainer, "Urlbar container exists");
  is(dlBtn.previousElementSibling, urlbarContainer, "Downloads button is placed beside address bar");
});

add_task(async function test_reader_button_contextual() {
  const readerBtn = document.getElementById("reader-mode-button");
  ok(readerBtn, "Reader mode button exists");

  const browser = gBrowser.selectedBrowser;
  const originalIsArticle = browser.isArticle;

  // Article detected -> button unhidden
  browser.isArticle = true;
  WhimsySmartButtons.updateButtons(window);
  ok(!readerBtn.hidden, "Reader button is visible when article is detected");

  // Non-article -> button hidden
  browser.isArticle = false;
  readerBtn.removeAttribute("readeractive");
  readerBtn.setAttribute("hidden", "true");
  WhimsySmartButtons.updateButtons(window);
  ok(readerBtn.hidden, "Reader button is hidden when page is not an article");

  // Active in reader mode -> button unhidden
  readerBtn.setAttribute("readeractive", "true");
  WhimsySmartButtons.updateButtons(window);
  ok(!readerBtn.hidden, "Reader button is visible when reader mode is active");
  readerBtn.removeAttribute("readeractive");

  browser.isArticle = originalIsArticle;
});

add_task(async function test_media_button_contextual() {
  const pipBtn = document.getElementById("picture-in-picture-button");
  ok(pipBtn, "PiP/Media button exists in address bar");

  const tab = gBrowser.selectedTab;

  // Simulating audio playing in tab
  tab.soundplaying = true;
  WhimsySmartButtons.updateButtons(window);
  ok(!pipBtn.hidden, "Media button is visible when audio is playing");
  ok(pipBtn.hasAttribute("whimsy-audio-playing"), "Whimsy audio-playing attribute set");

  // Clicking toggles mute on tab
  pipBtn.click();
  ok(tab.muted, "Clicking media button while audio playing toggled mute");
  pipBtn.click();
  ok(!tab.muted, "Clicking media button again unmuted");

  // Stop audio -> media button hidden
  tab.soundplaying = false;
  WhimsySmartButtons.updateButtons(window);
  ok(pipBtn.hidden, "Media button is hidden when audio stops");
});

add_task(async function test_downloads_button_contextual() {
  const dlBtn = document.getElementById("downloads-button");

  // No active downloads -> hidden
  await WhimsySmartButtons.updateDownloadsButton(window, {
    getAll: async () => [{ stopped: true }],
  });
  ok(dlBtn.hidden, "Downloads button is hidden when no downloads in progress");

  // Active download in progress -> unhidden
  await WhimsySmartButtons.updateDownloadsButton(window, {
    getAll: async () => [{ stopped: false }],
  });
  ok(!dlBtn.hidden, "Downloads button appears beside address bar when download is in progress");

  // Finished download -> hides again
  await WhimsySmartButtons.updateDownloadsButton(window, {
    getAll: async () => [{ stopped: true }],
  });
  ok(dlBtn.hidden, "Downloads button hides when download finishes");
});

add_task(async function test_page_action_overlap_and_commands() {
  const pageActions = document.getElementById("page-action-buttons");
  ok(pageActions, "Page action buttons container exists");

  // Ensure commands run without exception
  const readerCmd = WhimsyCommands.get("cmd_whimsyToggleReader");
  readerCmd.run(window);

  const mediaCmd = WhimsyCommands.get("cmd_whimsyToggleMedia");
  mediaCmd.run(window);

  const dlCmd = WhimsyCommands.get("cmd_whimsyDownloads");
  dlCmd.run(window);
});

add_task(async function test_feature_switch_off() {
  await SpecialPowers.pushPrefEnv({
    set: [[FEATURE_PREF, false]],
  });

  is(
    document.documentElement.getAttribute("whimsy-smart-buttons"),
    "false",
    "Root has whimsy-smart-buttons='false' when disabled"
  );
  const dlBtn = document.getElementById("downloads-button");
  ok(dlBtn.hidden, "Downloads button is hidden when feature disabled");
});
