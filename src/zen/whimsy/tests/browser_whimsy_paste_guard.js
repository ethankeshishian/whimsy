/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave7/focus: paste guard. A paste that looks like a secret waits for a
// sheet by the field (Cancel by default); ordinary text, a card number
// into a card field, and the switches off all paste straight away.

const { detectSecret, isHome, isCardNumber, WhimsyPasteGuard } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyPasteGuard.sys.mjs"
);
const { WhimsyCommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommands.sys.mjs");

const PAGE = "https://example.com/?whimsy-paste-guard";
const PANEL_ID = "whimsy-paste-guard";
// AWS's own documentation example key.
const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";

const sheet = () => document.getElementById(PANEL_ID);
const sheetOpen = () => sheet()?.state == "open";

async function openPage() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    content.document.body.innerHTML = `
      <input id="plain" style="width: 300px">
      <input id="secret" type="password">
      <input id="card" autocomplete="cc-number">
      <textarea id="area" rows="12" cols="40"></textarea>
      <div id="editor" contenteditable="true" style="min-height: 2em"></div>`;
    // M2: a page that reads every paste first (capturing, on window) and
    // inserts it itself, like a rich editor or a phishing page.
    const body = content.document.body;
    body.dataset.seen = "0";
    content.addEventListener(
      "paste",
      event => {
        event.clipboardData.getData("text/plain");
        body.dataset.seen = String(Number(body.dataset.seen) + 1);
        if (event.target.id == "editor") {
          event.preventDefault();
          event.target.textContent += event.clipboardData.getData("text/plain");
        }
      },
      true
    );
  });
  return tab;
}

async function focusField(browser, id) {
  await SpecialPowers.spawn(browser, [id], fieldId => {
    const field = content.document.getElementById(fieldId);
    field.value = "";
    field.focus();
  });
  browser.focus();
}

const valueOf = (browser, id) =>
  SpecialPowers.spawn(browser, [id], fieldId => content.document.getElementById(fieldId).value);

// Pastes `text` into the field; resolves once it lands or the sheet opens.
async function paste(browser, id, text) {
  await SimpleTest.promiseClipboardChange(text, () => SpecialPowers.clipboardCopyString(text));
  await focusField(browser, id);
  goDoCommand("cmd_paste");
  await TestUtils.waitForCondition(
    async () => sheetOpen() || (await valueOf(browser, id)) == text,
    "The paste lands or the sheet asks"
  );
}

add_task(function test_detector() {
  const secrets = {
    "sk-proj-4fJ9xQ2mZ8vB7nL1kR5tY3wE6uI0oPaS9dF2gH": "openai",
    "sk-ant-api03-Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0LzXcVbNm-AbCd": "anthropic",
    "ghp_1a2B3c4D5e6F7g8H9i0JkLmNoPqRsTuVwXyZ": "github",
    [AWS_KEY]: "aws",
    ["xox" + "b-123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx"]: "slack",
    ["sk_" + "live_4eC39HqLyjWDarjtT1zdp7dc"]: "stripe",
    "AIzaSyD4f8Gq2Lm9Xb3Kc7Vn1Pz5Wr0Ty6Hs8Ju": "google",
    "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----": "private-key",
    "-----BEGIN PRIVATE KEY-----": "private-key",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U": "jwt",
    "4111 1111 1111 1111": "card",
    "  378282246310005 ": "card",
    [`export KEY=${AWS_KEY}\necho done`]: "aws",
  };
  for (const [text, kind] of Object.entries(secrets)) {
    is(detectSecret(text), kind, `${kind} detected`);
  }
  const ordinary = [
    "",
    "Hello, world",
    "pip install sk-learn scikit-learn",
    "sk-this-is-just-a-long-hyphenated-sentence-of-words",
    "ghp_short",
    "AKIA is a prefix, AKIAEXAMPLE is too short",
    "The order number is 4111111111111111 for your records",
    "4111 1111 1111 1112",
    "1234567890123",
    "0000000000000000",
    "eyJhbGciOi.notajwt",
    "1698765432123",
    "-----BEGIN PUBLIC KEY-----",
    "x".repeat(20000) + AWS_KEY,
  ];
  for (const text of ordinary) {
    is(detectSecret(text), null, `Ordinary: ${text.slice(0, 40)}`);
  }
  ok(isCardNumber("5555-5555-5555-4444"), "Mastercard with dashes");
  ok(!isCardNumber("9111111111111111"), "No network starts with 9");

  ok(isHome("github", "github.com") && isHome("aws", "signin.aws.amazon.com"), "The issuer's own sign-in is home");
  ok(!isHome("github", "notgithub.com") && !isHome("github", "github.com.evil.example"), "Look-alikes aren't");
  // L2: hosts that serve anyone's pages are never home.
  ok(!isHome("aws", "evil.s3.amazonaws.com") && !isHome("aws", "amazonaws.com"), "Not S3-hosted pages");
  ok(!isHome("google", "storage.googleapis.com") && !isHome("google", "sites.google.com"), "Not Cloud Storage or Sites");
  ok(!isHome("github", "evil.github.io") && !isHome("github", "gist.github.com"), "Exact hosts only");
  ok(!isHome("card", "example.com") && !isHome("aws", ""), "Cards and empty hosts have no home");
});

add_task(async function test_sheet_cancel_and_paste() {
  const tab = await openPage();
  const browser = tab.linkedBrowser;

  await paste(browser, "plain", AWS_KEY);
  ok(sheetOpen(), "A key asks first");
  is(await valueOf(browser, "plain"), "", "and nothing is pasted yet");
  const panel = sheet();
  await TestUtils.waitForCondition(
    () => panel.querySelector(".whimsy-sheet-title span")?.textContent == "This looks like an AWS access key",
    "Titled with the kind"
  );
  is(
    panel.querySelector(".whimsy-sheet-subtitle").textContent.replace(/[\u2068\u2069]/g, ""),
    "Paste into example.com?",
    "Names the site"
  );
  const cancel = panel.querySelector(".whimsy-sheet-footer-button.primary");
  await TestUtils.waitForCondition(() => document.activeElement == cancel, "Cancel has the keyboard");
  ok(!panel.textContent.includes(AWS_KEY), "The sheet never shows the text");

  EventUtils.synthesizeKey("KEY_Escape");
  await TestUtils.waitForCondition(() => !sheet(), "Esc closes it");
  // Give a wrongly let-through paste time to land.
  await new Promise(resolve => setTimeout(resolve, 300));
  is(await valueOf(browser, "plain"), "", "Cancelled: nothing pasted");

  await paste(browser, "plain", AWS_KEY);
  ok(sheetOpen(), "Asks again");
  sheet().querySelector(".whimsy-sheet-footer-button:not(.primary)").doCommand();
  await TestUtils.waitForCondition(async () => (await valueOf(browser, "plain")) == AWS_KEY, "Paste pastes");
  ok(!sheet(), "and closes the sheet");

  // A tall field anchors at the caret; the flow is the same.
  await paste(browser, "area", AWS_KEY);
  ok(sheetOpen(), "A textarea asks too");
  sheet().querySelector(".whimsy-sheet-footer-button.primary").doCommand();
  await TestUtils.waitForCondition(() => !sheet(), "Cancel closes it");
  is(await valueOf(browser, "area"), "", "Cancelled");

  BrowserTestUtils.removeTab(tab);
});

// M2: the guard runs before the page's own capturing listener, so a page
// (or an editor that handles paste itself) learns nothing until "Paste".
add_task(async function test_before_the_page() {
  const tab = await openPage();
  const browser = tab.linkedBrowser;
  const seen = () => SpecialPowers.spawn(browser, [], () => Number(content.document.body.dataset.seen));
  const editorText = () => SpecialPowers.spawn(browser, [], () => content.document.getElementById("editor").textContent);

  await SimpleTest.promiseClipboardChange(AWS_KEY, () => SpecialPowers.clipboardCopyString(AWS_KEY));
  await SpecialPowers.spawn(browser, [], () => content.document.getElementById("editor").focus());
  browser.focus();
  goDoCommand("cmd_paste");
  await TestUtils.waitForCondition(sheetOpen, "A self-handling editor still asks");
  is(await seen(), 0, "The page hasn't seen the paste");
  sheet().querySelector(".whimsy-sheet-footer-button.primary").doCommand();
  await TestUtils.waitForCondition(() => !sheet(), "Cancelled");
  await new Promise(resolve => setTimeout(resolve, 300));
  is(await seen(), 0, "and never does after Cancel");
  is(await editorText(), "", "nothing inserted");

  goDoCommand("cmd_paste");
  await TestUtils.waitForCondition(sheetOpen, "Asks again");
  sheet().querySelector(".whimsy-sheet-footer-button:not(.primary)").doCommand();
  await TestUtils.waitForCondition(async () => (await editorText()) == AWS_KEY, "Paste hands it to the page's editor");
  is(await seen(), 1, "The page sees it once, after Paste");

  await paste(browser, "plain", "ordinary words");
  is(await seen(), 2, "Ordinary pastes reach the page as usual");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_quiet_cases() {
  const tab = await openPage();
  const browser = tab.linkedBrowser;

  await paste(browser, "plain", "Just a note about sk-learn");
  ok(!sheetOpen(), "Ordinary text pastes straight away");

  await paste(browser, "card", "4111 1111 1111 1111");
  ok(!sheetOpen(), "A card number into a card field pastes");

  await paste(browser, "secret", AWS_KEY);
  ok(sheetOpen(), "A password field on another site still asks");
  sheet().querySelector(".whimsy-sheet-footer-button.primary").doCommand();
  await TestUtils.waitForCondition(() => !sheet(), "Cancelled");

  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_command_and_switches() {
  const entry = WhimsyCommands.get("cmd_whimsyPasteGuard");
  ok(entry?.keyId, "Paste guard is a command with an assignable shortcut");
  ok(document.getElementById(entry.keyId), "with its <key>");

  const tab = await openPage();
  const browser = tab.linkedBrowser;

  ok(WhimsyPasteGuard.active, "On by default");
  document.getElementById("cmd_whimsyPasteGuard").doCommand();
  ok(!WhimsyPasteGuard.active, "The command turns it off");
  await paste(browser, "plain", AWS_KEY);
  ok(!sheetOpen(), "Off: the key pastes");
  document.getElementById("cmd_whimsyPasteGuard").doCommand();
  ok(WhimsyPasteGuard.active, "and back on");

  await SpecialPowers.pushPrefEnv({ set: [[WhimsyPasteGuard.FEATURE_PREF, false]] });
  ok(!WhimsyPasteGuard.active, "The feature switch wins");
  await paste(browser, "plain", AWS_KEY);
  ok(!sheetOpen(), "Switch off: the key pastes");
  document.getElementById("cmd_whimsyPasteGuard").doCommand();
  ok(Services.prefs.getBoolPref(WhimsyPasteGuard.ENABLED_PREF), "The command does nothing while the switch is off");
  await SpecialPowers.popPrefEnv();

  Services.prefs.clearUserPref(WhimsyPasteGuard.ENABLED_PREF);
  BrowserTestUtils.removeTab(tab);
});
