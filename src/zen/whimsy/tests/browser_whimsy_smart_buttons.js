/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave9: W9-06 Smart address bar buttons (Lens/Arc parity).
// Reader, Translate, media, and Downloads in progress appear beside the address
// bar only when relevant, reusing existing Firefox/Zen buttons without duplicates.
// Reviews R-D4-H3, R-D4-M8, R-D4-M9, R-D5-N5, R-D5-M8, security-full-2:
// - never hide Firefox's Downloads button when the feature is off
// - never overwrite the user's PiP-in-urlbar or download-autohide prefs
// - don't move the button; leave placement to toolbar customization
// - drop audio repurposing of PiP button; separate PiP & Media commands with isAvailable & icons
// - scope download watcher to public in normal windows

ChromeUtils.defineESModuleGetters(this, {
  CustomizableUI: "moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs",
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
  WhimsySmartButtons: "resource:///modules/whimsy/WhimsySmartButtons.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.smart-buttons";
const PIP_URLBAR_PREF = "media.videocontrols.picture-in-picture.urlbar-button.enabled";
const DOWNLOADS_AUTOHIDE_PREF = "browser.download.autohideButton";

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      [FEATURE_PREF, true],
      [DOWNLOADS_AUTOHIDE_PREF, true],
    ],
  });
  // Whimsy keeps Downloads in the customization palette by default; these
  // tasks need it in the toolbar, where a person may put it.
  const placement = CustomizableUI.getPlacementOfWidget("downloads-button");
  if (!placement) {
    // Zen's sidebar foot, where Downloads sat before Zen's Library replaced it.
    CustomizableUI.addWidgetToArea("downloads-button", "zen-sidebar-foot-buttons");
  }
  await TestUtils.waitForCondition(() => document.getElementById("downloads-button"), "Downloads is in the window");
  registerCleanupFunction(() => {
    if (!placement) {
      CustomizableUI.removeWidgetFromArea("downloads-button");
    }
  });
  WhimsySmartButtons.initWindow(window);
});

// Command-bar rows (icon, availability) for a command.
function action(commandId) {
  const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");
  return globalActions.find(a => a.commandId == commandId);
}

add_task(async function test_smart_buttons_registry_and_availability() {
  ok(WhimsySmartButtons.enabled, "Smart buttons feature is enabled");

  // Duplicate commands removed: Firefox's native commands are used
  ok(!WhimsyCommands.get("cmd_whimsyToggleReader"), "cmd_whimsyToggleReader duplicate is not registered");
  ok(!WhimsyCommands.get("cmd_whimsyDownloads"), "cmd_whimsyDownloads duplicate is not registered");

  // Picture-in-Picture command with icon and availability check
  const pipCmd = { ...WhimsyCommands.get("cmd_whimsyPictureInPicture"), ...action("cmd_whimsyPictureInPicture") };
  ok(WhimsyCommands.get("cmd_whimsyPictureInPicture"), "cmd_whimsyPictureInPicture is registered");
  is(pipCmd.l10nId, "whimsy-action-picture-in-picture", "PiP command l10n id");
  is(pipCmd.icon, "chrome://global/skin/media/picture-in-picture-open.svg", "PiP command icon");
  ok(typeof pipCmd.isAvailable === "function", "PiP command has isAvailable function");
  is(pipCmd.isAvailable(window), false, "PiP command is unavailable without eligible video");

  // Play or Pause Media command with icon and availability check
  const mediaCmd = { ...WhimsyCommands.get("cmd_whimsyPlayPauseMedia"), ...action("cmd_whimsyPlayPauseMedia") };
  ok(WhimsyCommands.get("cmd_whimsyPlayPauseMedia"), "cmd_whimsyPlayPauseMedia is registered");
  is(mediaCmd.l10nId, "whimsy-action-play-pause-media", "Media command l10n id");
  is(mediaCmd.icon, "chrome://browser/skin/zen-icons/media-unmute.svg", "Media command icon");
  ok(typeof mediaCmd.isAvailable === "function", "Media command has isAvailable function");

  const tab = gBrowser.selectedTab;
  tab.soundplaying = true;
  is(mediaCmd.isAvailable(window), true, "Media command is available when sound is playing");
  tab.soundplaying = false;

  // Translate Page command with icon and availability check
  const translateCmd = { ...WhimsyCommands.get("cmd_whimsyTranslatePage"), ...action("cmd_whimsyTranslatePage") };
  ok(WhimsyCommands.get("cmd_whimsyTranslatePage"), "cmd_whimsyTranslatePage is registered");
  is(translateCmd.l10nId, "whimsy-action-translate-page", "Translate command l10n id");
  is(translateCmd.icon, "chrome://browser/skin/translations.svg", "Translate command icon");
  ok(typeof translateCmd.isAvailable === "function", "Translate command has isAvailable function");

  // Running commands executes cleanly
  // (Translate isn't run: tests have no translation models.)
  ok(!translateCmd.isAvailable(window), "Translate isn't offered on a page Firefox can't translate");
  for (const id of ["cmd_whimsyPictureInPicture", "cmd_whimsyPlayPauseMedia"]) {
    document.getElementById(id).doCommand();
  }
});

add_task(async function test_downloads_button_not_moved() {
  const dlBtn = document.getElementById("downloads-button");
  const urlbarContainer = document.getElementById("urlbar-container");
  ok(dlBtn, "Downloads button exists");
  ok(urlbarContainer, "Urlbar container exists");
  // Don't move the button: customization belongs to the user
  ok(
    dlBtn.previousElementSibling !== urlbarContainer,
    "Downloads button is not forcibly inserted after urlbar-container"
  );
});

add_task(async function test_user_prefs_never_overwritten() {
  // Zen locks the PiP-in-urlbar pref on; the feature must leave it as is.
  const pipBefore = Services.prefs.getBoolPref(PIP_URLBAR_PREF);
  await SpecialPowers.pushPrefEnv({ set: [[DOWNLOADS_AUTOHIDE_PREF, false]] });

  // Re-run initWindow
  WhimsySmartButtons.initWindow(window);

  is(Services.prefs.getBoolPref(PIP_URLBAR_PREF), pipBefore, "The PiP-in-urlbar pref is left as it was");
  ok(!Services.prefs.prefHasUserValue(PIP_URLBAR_PREF), "…never given a user value");
  is(
    Services.prefs.getBoolPref(DOWNLOADS_AUTOHIDE_PREF),
    false,
    "User's download-autohide pref was not overwritten"
  );
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_downloads_autohide_pref_respected() {
  const dlBtn = document.getElementById("downloads-button");

  // 1. When user disabled autohide (button should stay visible):
  await SpecialPowers.pushPrefEnv({
    set: [[DOWNLOADS_AUTOHIDE_PREF, false]],
  });
  await WhimsySmartButtons.updateDownloadsButton(window, {
    getAll: async () => [{ stopped: true }],
  });
  ok(!dlBtn.hidden, "Downloads button is never hidden when autohide pref is false");

  // 2. When autohide pref is true:
  await SpecialPowers.pushPrefEnv({
    set: [[DOWNLOADS_AUTOHIDE_PREF, true]],
  });
  // Active download -> unhidden
  await WhimsySmartButtons.updateDownloadsButton(window, {
    getAll: async () => [{ stopped: false }],
  });
  ok(!dlBtn.hidden, "Downloads button appears when download is in progress");

  // Finished download -> hides
  await WhimsySmartButtons.updateDownloadsButton(window, {
    getAll: async () => [{ stopped: true }],
  });
  ok(dlBtn.hidden, "Downloads button hides when download is stopped and autohide is enabled");
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

add_task(async function test_pip_button_no_audio_repurposing() {
  const pipBtn = document.getElementById("picture-in-picture-button");
  ok(pipBtn, "PiP button exists in address bar");

  const tab = gBrowser.selectedTab;
  tab.soundplaying = true;

  // With audio playing, PiP button must NOT be repurposed with audio-playing attribute
  WhimsySmartButtons.updateButtons(window);
  ok(
    !pipBtn.hasAttribute("whimsy-audio-playing"),
    "PiP button does not hijack audio playback (M9 parity)"
  );
  tab.soundplaying = false;
});

add_task(async function test_feature_switch_off_never_hides_downloads() {
  const dlBtn = document.getElementById("downloads-button");
  dlBtn.removeAttribute("hidden");

  // Turn feature off
  await SpecialPowers.pushPrefEnv({
    set: [[FEATURE_PREF, false]],
  });

  ok(
    !document.documentElement.hasAttribute("whimsy-smart-buttons"),
    "Root attribute whimsy-smart-buttons is removed when feature is off"
  );
  ok(!dlBtn.hidden, "Downloads button is never hidden when feature is off (H3 fix)");
});
