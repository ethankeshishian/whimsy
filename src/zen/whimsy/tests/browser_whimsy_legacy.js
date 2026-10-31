/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// legacy: Firefox/Zen/Mozilla leftovers (whimsy-handoff/legacy-audit.md).
// Checks what Whimsy changed, and that what it decided to keep is still
// at its upstream value. It reads the *default* branch: the test profile sets
// user values for many network prefs (captive portal, region, add-on
// updates), but the defaults are what ships.

const defaults = Services.prefs.getDefaultBranch("");

const APPLE_CAPTIVE_URL = "http://captive.apple.com/hotspot-detect.html";
const APPLE_CAPTIVE_BODY = "<HTML><HEAD><TITLE>Success</TITLE></HEAD><BODY>Success</BODY></HTML>\n";
const CHANGELOG = "about:whimsy?tab=changelog";
const ISSUES = "https://github.com/ethankeshishian/whimsy/issues";

function asrouterProvider(id) {
  return JSON.parse(defaults.getStringPref(`browser.newtabpage.activity-stream.asrouter.providers.${id}`));
}

async function chromeText(url) {
  return (await fetch(url)).text();
}

add_task(async function test_changed_privacy_prefs() {
  is(defaults.getBoolPref("nimbus.rollouts.enabled"), false, "P1: Nimbus rollouts are off");
  ok(!Services.prefs.prefIsLocked("nimbus.rollouts.enabled"), "...but not locked, so about:config can turn them back on");
  is(defaults.getBoolPref("datareporting.usage.uploadEnabled"), false, "P2: the usage-reporting ping is off");
  is(defaults.getStringPref("app.feedback.baseURL"), ISSUES, "U4: Share Ideas and Feedback opens Whimsy's issues");
});

add_task(async function test_captive_portal_uses_apple() {
  is(defaults.getStringPref("captivedetect.canonicalURL"), APPLE_CAPTIVE_URL, "P3: captive check asks Apple");
  is(defaults.getStringPref("captivedetect.canonicalContent"), APPLE_CAPTIVE_BODY,
    "P3: the expected body is Apple's page byte for byte, trailing newline included");
  is(defaults.getStringPref("network.connectivity-service.IPv4.url"), APPLE_CAPTIVE_URL, "P3: IPv4 check asks Apple");
  is(defaults.getStringPref("network.connectivity-service.IPv6.url"), APPLE_CAPTIVE_URL, "P3: IPv6 check asks Apple");
  // Kept on: the "log in to this network" bar and offline detection.
  is(defaults.getBoolPref("network.captive-portal-service.enabled"), true, "P3: captive portal detection stays on");
  is(defaults.getBoolPref("network.connectivity-service.enabled"), true, "P3: connectivity checks stay on");
});

add_task(async function test_asrouter_remote_providers() {
  const cfr = asrouterProvider("cfr");
  is(cfr.enabled, false, "P6: remote CFR promos are off");
  Assert.deepEqual(
    { ...cfr, enabled: true },
    { id: "cfr", enabled: true, type: "remote-settings", collection: "cfr", updateCycleInMs: 3600000 },
    "P6: the cfr provider is otherwise Firefox's"
  );
  const experiments = asrouterProvider("messaging-experiments");
  is(experiments.enabled, false, "P6: Nimbus messaging experiments are off");
  is(experiments.type, "remote-experiments", "P6: ...and otherwise Firefox's");
  // Kept: message groups carry frequency caps and the user-pref gates.
  is(asrouterProvider("message-groups").enabled, true, "P6: message groups stay on");
  is(asrouterProvider("onboarding").enabled, true, "P6: local onboarding messages stay on");
});

add_task(async function test_branding_urls_are_whimsy() {
  // P7/P8/U1: these come from firefox-branding.js, which loads after
  // firefox.js; engine_overrides.py appends Whimsy's values there.
  is(defaults.getStringPref("startup.homepage_welcome_url"), "about:whimsy", "P7: first run opens Whimsy's home");
  is(defaults.getStringPref("startup.homepage_welcome_url.additional"), "", "P7: no second first-run page");
  for (const name of [
    "startup.homepage_override_url",
    "app.releaseNotesURL",
    "app.releaseNotesURL.aboutDialog",
    "app.releaseNotesURL.prompt",
    "app.update.url.details",
  ]) {
    is(defaults.getStringPref(name), CHANGELOG, `U1/P8: ${name} opens Whimsy's changelog`);
  }
  is(defaults.getStringPref("app.update.url.manual"), "https://github.com/ethankeshishian/whimsy/releases",
    "U1: manual download goes to Whimsy's releases");
  for (const name of Services.prefs.getChildList("")) {
    if (Services.prefs.getPrefType(name) != Services.prefs.PREF_STRING || !/^(startup\.homepage|app\.(releaseNotes|update\.url))/.test(name)) {
      continue;
    }
    ok(!defaults.getStringPref(name, "").includes("zen-browser.app"), `${name} doesn't point at zen-browser.app`);
  }
});

add_task(async function test_kept_at_upstream() {
  // Decided to keep (see the legacy cleanup commits for why).
  is(defaults.getBoolPref("browser.region.update.enabled"), true, "P4: region lookup kept");
  ok(defaults.getStringPref("browser.region.network.url").startsWith("https://location.services.mozilla.com/"),
    "P4: region lookup URL kept");
  is(defaults.getBoolPref("extensions.systemAddon.update.enabled"), true, "P5: system add-on updates kept");
  ok(defaults.getStringPref("extensions.systemAddon.update.url").startsWith("https://aus5.mozilla.org/"),
    "P5: system add-on update URL kept");
  is(defaults.getIntPref("network.trr.mode"), 0, "P9: DoH left to Firefox's rollout");
  ok(defaults.getStringPref("network.trr.default_provider_uri").includes("mozilla.cloudflare-dns.com"),
    "P9: Mozilla's DoH provider kept");
  is(defaults.getStringPref("zen.share.base-url"), "https://share.zen-browser.app", "P10: Zen's share server kept");
  is(defaults.getBoolPref("security.certerrors.mitm.priming.enabled"), true, "P12: MITM priming kept");
  is(defaults.getStringPref("security.certerrors.mitm.priming.endpoint"), "https://mitmdetection.services.mozilla.com/",
    "P12: MITM canary endpoint kept");
  is(defaults.getBoolPref("browser.preferences.experimental"), true, "U7: Firefox Labs pane kept");
  is(defaults.getBoolPref("identity.fxaccounts.enabled"), true, "Sync and Mozilla account kept");
  is(defaults.getStringPref("dom.push.serverURL"), "wss://push.services.mozilla.com/", "L1: web push kept");
  ok(defaults.getStringPref("app.support.baseURL").startsWith("https://support.mozilla.org/"), "U4: Get Help kept");
});

add_task(async function test_external_links_default_to_mini_whimsy() {
  is(defaults.getStringPref("whimsy.external-links.target"), "quick-window", "B3: links from other apps open in Mini Whimsy");
});

add_task(async function test_default_bookmarks() {
  const html = await chromeText("chrome://browser/content/default-bookmarks.html");
  ok(html.includes('data-l10n-id="whimsy-default-bookmarks-heading"'), "U2: a Whimsy folder");
  ok(html.includes(`href="${CHANGELOG}"`), "U2: ...with the changelog");
  ok(html.includes(`href="${ISSUES}"`), "U2: ...and feedback");
  // (The MPL license comment names mozilla.org; links are what matter.)
  ok(!/(?:href|icon)="[^"]*mozilla\.org/.test(html), "U2: no Mozilla links");
  const l10n = new Localization(["browser/whimsy.ftl"]);
  is(await l10n.formatValue("whimsy-default-bookmarks-heading"), "Whimsy", "U2: the folder is named Whimsy");
});

add_task(async function test_home_option_is_whimsy() {
  const config = await chromeText("chrome://browser/content/preferences/config/home-startup.mjs");
  ok(config.includes('const DEFAULT_HOMEPAGE_URL = "about:whimsy";'), "C2: the built-in homepage choice is about:whimsy");
  ok(config.includes('l10nId: "whimsy-home-mode-choice-default"'), "C2: ...labelled as Whimsy's");
  const l10n = new Localization(["browser/whimsy.ftl"]);
  const [message] = await l10n.formatMessages([{ id: "whimsy-home-mode-choice-default" }]);
  is(message.attributes.find(a => a.name == "label").value, "Whimsy Home (Default)", "C2: label text");
});

add_task(async function test_zen_strings_say_whimsy() {
  const l10n = new Localization([
    "branding/brand.ftl",
    "browser/zen-boosts.ftl",
    "browser/zen-share.ftl",
    "browser/zen-general.ftl",
    "browser/zen-library.ftl",
    "browser/preferences/zen-preferences.ftl",
  ]);
  const ids = [
    "zen-boost-receive-title",
    "zen-share-overlay-add-space",
    "zen-share-overlay-add-folder",
    "zen-share-confirm-description",
    "zen-window-sync-migration-dialog-message",
    "library-media-opt-in-body",
    "zenCKSOption-group-zen-other",
  ];
  for (const id of ids) {
    const text = await l10n.formatValue(id);
    ok(!/\bZen\b(?!'s share server)/.test(text), `U5: ${id} doesn't call the app Zen: ${text}`);
  }
  const [hide] = await l10n.formatMessages([{ id: "library-downloads-menu-hide" }]);
  is(hide.attributes.find(a => a.name == "label").value, "Hide from Whimsy", "U5: downloads menu");
  ok((await l10n.formatValue("zen-share-confirm-description")).includes("Zen's share server"),
    "P10: the share confirmation says whose server it is");
  is(await l10n.formatValue("zen-theme-marketplace-header"), "Zen Mods", "U6: Zen Mods keeps its name");
});

add_task(async function test_about_dialog() {
  const opened = BrowserTestUtils.domWindowOpenedAndLoaded(
    null,
    win => win.document.documentURI == "chrome://browser/content/aboutDialog.xhtml"
  );
  window.openAboutDialog();
  const dialog = await opened;
  const doc = dialog.document;
  await doc.l10n.ready;
  const community = doc.getElementById("communityDesc");
  const contribute = doc.getElementById("contributeDesc");
  is(community.getAttribute("data-l10n-id"), "whimsy-about-community", "U3: Whimsy's community line");
  await TestUtils.waitForCondition(() => community.textContent.includes("built on"), "U3: translated");
  ok(!community.textContent.includes("global community"), "U3: not Mozilla's 'global community' line");
  ok(community.querySelector('[data-l10n-name="community-creditsLink"][href="about:credits"]'), "U3: Zen credits link kept");
  ok(community.querySelector(`[data-l10n-name="community-mozillaLink"][href="${ISSUES}"]`), "U3: feedback link");
  is(contribute.getAttribute("data-l10n-id"), "whimsy-about-no-telemetry", "U3: no donation ask");
  await TestUtils.waitForCondition(() => contribute.textContent.includes("telemetry"), "U3: translated");
  ok(!contribute.querySelector('[data-l10n-name="helpus-donateLink"]'), "U3: no Mozilla donation link");
  const link = id => doc.querySelector(`[data-l10n-id="${id}"]`).getAttribute("href");
  is(link("bottomLinks-license"), "about:license", "U3: licensing link kept (MPL)");
  is(link("bottom-links-terms"), "about:rights", "U3: rights link kept");
  is(link("bottom-links-privacy"), "about:whimsy?tab=privacy", "U3: privacy notice is Whimsy's");
  await BrowserTestUtils.closeWindow(dialog);
});

add_task(async function test_privacy_tab() {
  await BrowserTestUtils.withNewTab("about:whimsy?tab=privacy", async browser => {
    const doc = browser.contentDocument;
    await doc.l10n.ready;
    is(doc.getElementById("whimsy-tab-privacy").getAttribute("aria-selected"), "true", "?tab=privacy selects Privacy");
    ok(!doc.getElementById("whimsy-panel-privacy").hidden, "Privacy panel shown");
    ok(doc.getElementById("whimsy-panel-home").hidden, "Home panel hidden");
    const items = [...doc.querySelectorAll(".whimsy-privacy-list li")];
    Assert.greater(items.length, 5, "Lists the services Whimsy talks to");
    await TestUtils.waitForCondition(() => items.every(li => li.textContent.trim()), "Every item translated");
    ok(items.some(li => li.textContent.includes("captive.apple.com")), "Mentions Apple's captive check");
  });
});

// wave8: README rebranded to Whimsy with credits preserved.
add_task(async function test_readme_rebranded_to_whimsy() {
  let dir = Services.dirsvc.get("CurWorkD", Ci.nsIFile).path;
  let readmePath = null;
  for (let i = 0; i < 5; i++) {
    const candidate = PathUtils.join(dir, "README.md");
    if (await IOUtils.exists(candidate)) {
      readmePath = candidate;
      break;
    }
    dir = PathUtils.parent(dir);
  }
  ok(readmePath, "README.md found in the repository");
  const content = await IOUtils.readUTF8(readmePath);
  ok(content.includes("### `Whimsy`"), "README heading is Whimsy");
  ok(content.includes("whimsy-berry-desktop.svg"), "README references Whimsy icon");
  ok(content.includes("https://github.com/ethankeshishian/whimsy"), "README links to Whimsy repository");
  ok(content.includes("Mozilla Public License 2.0"), "README preserves MPL 2.0 license notice");
  ok(content.includes("Zen Browser"), "README credits Zen Browser");
  ok(content.includes("Mozilla Firefox"), "README credits Mozilla Firefox");
  ok(!content.includes("### `Zen Browser`"), "README no longer titled Zen Browser");
});

