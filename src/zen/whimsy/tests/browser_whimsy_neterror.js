/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

async function withWhimsyError(error, test, certificate = false) {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
  const browser = tab.linkedBrowser;
  try {
    const loaded = BrowserTestUtils.waitForErrorPage(browser);
    if (certificate) {
      BrowserTestUtils.startLoadingURIString(browser, "https://expired.example.com/");
    } else {
      const url = `about:neterror?e=${error}&u=${encodeURIComponent("https://example.com/")}&d=Connection%20failed`;
      await SpecialPowers.spawn(browser, [url], url => { content.location = url; });
    }
    await loaded;
    await test(browser);
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
}

add_task(async function network_and_certificate_layouts() {
  for (const felt of [false, true]) {
    await SpecialPowers.pushPrefEnv({ set: [
      ["security.certerrors.felt-privacy-v1", felt],
      ["browser.netError.searchCTA.enabled", false],
      ["whimsy.feature.net-error-branding", true],
      ["whimsy.feature.game", true],
      ["ui.prefersReducedMotion", 1],
    ] });
    try {
      for (const error of ["dnsNotFound", "netOffline", "connectionFailure", "certificate"]) {
        await withWhimsyError(error, async browser => {
          await SpecialPowers.spawn(browser, [error], async error => {
            const doc = content.document;
            const root = doc.querySelector("net-error-card")?.shadowRoot || doc;
            const brand = await ContentTaskUtils.waitForCondition(
              () => root.querySelector("#whimsy-neterror-brand"), "Whimsy label is installed"
            );
            await doc.l10n.translateRoots();
            is(brand.textContent, "Whimsy", "The page is branded Whimsy");
            await ContentTaskUtils.waitForCondition(
              () => root.querySelector("#whimsy-neterror-style")?.sheet,
              "The branding CSS loads, including inside the shadow root"
            );
            const text = (root.documentElement ?? root).textContent;
            ok(!/Firefox/.test(text), "No Firefox branding in page or certificate details");
            ok(text.includes("Whimsy"), "Whimsy wording is translated");
            const art = root.querySelector(".felt-privacy-container") || doc.querySelector("#text-container");
            ok(content.getComputedStyle(art, "::before").backgroundImage.includes("whimsy-deflated-balloon.svg"),
              "The Whimsy deflated balloon replaces upstream artwork");
            ok(root.querySelector("#tryAgainButton, #returnButton, #advancedButton, #advanced-button"),
              "Native recovery or security controls remain");
            if (error === "certificate") {
              ok(!doc.getElementById("whimsy-neterror-game-link"), "Certificate warnings have no game invitation");
              const advanced = root.querySelector("#advancedButton, #advanced-button");
              ok(advanced, "Certificate details remain accessible");
              advanced.click();
            } else {
              const game = doc.getElementById("whimsy-neterror-game-link");
              ok(game, "Network errors retain the game invitation");
              is(content.getComputedStyle(game).transitionDuration, "0s", "Reduced motion has no transition");
            }
            doc.dispatchEvent(new content.CustomEvent("AboutNetErrorLoad", { bubbles: true }));
            is(root.querySelectorAll("#whimsy-neterror-brand").length, 1, "Repeated initialization adds no duplicate label");
            is(root.querySelectorAll("#whimsy-neterror-style").length, 1, "Repeated initialization adds no duplicate stylesheet");
          });
        }, error === "certificate");
      }
    } finally {
      await SpecialPowers.popPrefEnv();
    }
  }
});

add_task(async function switches_off_keep_native_error_controls() {
  await SpecialPowers.pushPrefEnv({ set: [
    ["whimsy.feature.net-error-branding", false],
    ["whimsy.feature.game", false],
  ] });
  try {
    await withWhimsyError("dnsNotFound", async browser => {
      await SpecialPowers.spawn(browser, [], async () => {
        const doc = content.document;
        const root = doc.querySelector("net-error-card")?.shadowRoot || doc;
        await doc.l10n.translateRoots();
        ok(!root.querySelector("#whimsy-neterror-brand"), "Illustration switch disables the overlay");
        ok(!doc.getElementById("whimsy-neterror-game-link"), "Game switch disables its button");
        ok(!(root.documentElement ?? root).textContent.includes("Firefox"), "Product strings still say Whimsy when illustration is off");
        ok(root.querySelector("#tryAgainButton, #reloadButton"), "Native retry control remains");
      });
    });
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function game_button_opens_game() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.game", true]] });
  try {
    await withWhimsyError("netOffline", async browser => {
      const loaded = BrowserTestUtils.browserLoaded(browser, false, "about:whimsy?game");
      await SpecialPowers.spawn(browser, [], async () => {
        const button = await ContentTaskUtils.waitForCondition(
          () => content.document.getElementById("whimsy-neterror-game-link"), "Game invitation arrives"
        );
        button.click();
      });
      await loaded;
      is(browser.currentURI.spec, "about:whimsy?game", "The game opens in the current tab");
    });
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});
