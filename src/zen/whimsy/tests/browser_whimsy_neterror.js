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

// wave4/fun: like Chrome's offline dino, an offline error page turns into
// Balloon Dash in place on Space, an arrow key or a tap on the balloon.
const GAME_PREFS = [
  ["whimsy.feature.game", true],
  ["whimsy.feature.net-error-branding", true],
  ["security.certerrors.felt-privacy-v1", false],
];

async function prepare(browser) {
  await SpecialPowers.spawn(browser, [], async () => {
    await ContentTaskUtils.waitForCondition(
      () => content.document.getElementById("whimsy-neterror-brand") || content.document.querySelector("net-error-card"),
      "The Whimsy actor has set up the page"
    );
    content.document.activeElement?.blur?.();
  });
  browser.focus();
}

async function gameState(browser, wait) {
  return SpecialPowers.spawn(browser, [wait], async wait => {
    const win = content.wrappedJSObject;
    if (wait) {
      await ContentTaskUtils.waitForCondition(() => win.__whimsyGame, "The game script ran in the page");
    } else {
      // eslint-disable-next-line mozilla/no-arbitrary-setTimeout
      await new Promise(resolve => content.setTimeout(resolve, 400));
    }
    return {
      state: win.__whimsyGame?.state.state ?? null,
      embedded: !!content.document.getElementById("whimsy-game-embed"),
    };
  });
}

add_task(async function offline_key_turns_the_page_into_the_game() {
  await SpecialPowers.pushPrefEnv({ set: GAME_PREFS });
  try {
    for (const key of [" ", "KEY_ArrowRight"]) {
      await withWhimsyError("netOffline", async browser => {
        await prepare(browser);
        await BrowserTestUtils.synthesizeKey(key, {}, browser);
        const { state, embedded } = await gameState(browser, true);
        is(state, "running", `${key} starts the run at once`);
        ok(embedded, "The game is drawn in the error page itself");
        ok(browser.currentURI.spec.startsWith("about:neterror?"), "The page stays the error page");
        await SpecialPowers.spawn(browser, [], () => {
          const doc = content.document;
          const root = doc.querySelector("net-error-card")?.shadowRoot || doc;
          ok(root.querySelector("#neterrorTryAgainButton, #tryAgainButton"), "Try Again is still in the page");
          ok(doc.body.classList.contains("whimsy-game-embedded"), "The game takes over the page");
        });
      });
    }
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function offline_tap_on_the_balloon_starts_it() {
  for (const felt of [false, true]) {
    await SpecialPowers.pushPrefEnv({ set: [...GAME_PREFS, ["security.certerrors.felt-privacy-v1", felt]] });
    try {
      await withWhimsyError("netOffline", async browser => {
        await prepare(browser);
        const point = await SpecialPowers.spawn(browser, [], () => {
          const doc = content.document;
          const container = doc.querySelector("net-error-card")?.shadowRoot?.querySelector(".felt-privacy-container") || doc.querySelector("#text-container");
          const rect = container.getBoundingClientRect();
          return { x: rect.left + 40, y: rect.top + 30 };
        });
        await BrowserTestUtils.synthesizeMouseAtPoint(point.x, point.y, {}, browser);
        is((await gameState(browser, true)).state, "running", `Balloon tap starts game (felt=${felt})`);
      });
    } finally {
      await SpecialPowers.popPrefEnv();
    }
  }
});

add_task(async function embedded_game_saves_the_high_score() {
  await SpecialPowers.pushPrefEnv({ set: [...GAME_PREFS, ["whimsy.game.high-score", 0]] });
  try {
    await withWhimsyError("netOffline", async browser => {
      await prepare(browser);
      await BrowserTestUtils.synthesizeKey(" ", {}, browser);
      await gameState(browser, true);
      await SpecialPowers.spawn(browser, [], () => {
        const game = content.wrappedJSObject.__whimsyGame;
        game.freeze();
        game.setAutoSpawn(false);
        game.clear();
        game.state.bonus = 40;
        game.spawn("seed");
        game.tick(1 / 60);
        is(game.state.state, "over", "The run ends on a hit");
      });
      await TestUtils.waitForCondition(
        () => Services.prefs.getIntPref("whimsy.game.high-score", 0) >= 40,
        "The parent saves the embedded game's high score"
      );
    });
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function only_offline_errors_and_never_from_a_field() {
  await SpecialPowers.pushPrefEnv({ set: GAME_PREFS });
  try {
    // Online, a DNS error is not "offline": no game.
    await withWhimsyError("dnsNotFound", async browser => {
      await prepare(browser);
      await BrowserTestUtils.synthesizeKey(" ", {}, browser);
      ok(!(await gameState(browser, false)).embedded, "Not for errors other than offline");
    });
    await withWhimsyError("certificate", async browser => {
      await prepare(browser);
      await BrowserTestUtils.synthesizeKey("KEY_ArrowRight", {}, browser);
      ok(!(await gameState(browser, false)).embedded, "Never on a certificate warning");
    }, true);
    await withWhimsyError("netOffline", async browser => {
      await prepare(browser);
      await SpecialPowers.spawn(browser, [], () => {
        const doc = content.document;
        const field = doc.createElement("input");
        field.id = "whimsy-test-field";
        doc.body.append(field);
        field.focus();
      });
      await BrowserTestUtils.synthesizeKey(" ", {}, browser);
      await BrowserTestUtils.synthesizeKey("KEY_ArrowLeft", {}, browser);
      ok(!(await gameState(browser, false)).embedded, "Typing in a text field never starts it");
      await SpecialPowers.spawn(browser, [], () => {
        const doc = content.document;
        const button = doc.createElement("button");
        doc.body.append(button);
        button.focus();
      });
      await BrowserTestUtils.synthesizeKey(" ", {}, browser);
      ok(!(await gameState(browser, false)).embedded, "Space on a focused button stays that button's");
    });
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});

// fix7/game: while it's played the game is the only thing on screen (like
// Chrome's dino); Esc brings the error page and Try Again back, paused, and
// a key shows the game again. Browser shortcuts such as Cmd+W pass through.
add_task(async function playing_fills_the_page_and_esc_returns() {
  await SpecialPowers.pushPrefEnv({ set: GAME_PREFS });
  try {
    await withWhimsyError("netOffline", async browser => {
      await prepare(browser);
      await BrowserTestUtils.synthesizeKey(" ", {}, browser);
      is((await gameState(browser, true)).state, "running", "Space starts the game");
      await SpecialPowers.spawn(browser, [], () => {
        const doc = content.document;
        const win = content;
        const embed = doc.getElementById("whimsy-game-embed");
        const rect = embed.getBoundingClientRect();
        is(Math.round(rect.width), win.innerWidth, "The game fills the page's width");
        is(Math.round(rect.height), win.innerHeight, "and its height");
        for (const el of doc.body.children) {
          if (el != embed) {
            is(win.getComputedStyle(el).display, "none", `${el.localName}#${el.id} is hidden while playing`);
          }
        }
      });

      // Cmd/Ctrl+W, and other shortcuts, are the browser's, never the game's.
      const prevented = await SpecialPowers.spawn(browser, [], () => {
        const win = content.wrappedJSObject;
        win.__whimsyGame.freeze();
        let result = null;
        content.addEventListener("keydown", e => {
          result = e.defaultPrevented;
        }, { once: true });
        content.document.body.dispatchEvent(new content.KeyboardEvent("keydown", {
          key: "w", bubbles: true, cancelable: true, metaKey: true, ctrlKey: true,
        }));
        return result;
      });
      is(prevented, false, "Accel+W is left to the browser");

      await BrowserTestUtils.synthesizeKey("KEY_Escape", {}, browser);
      await SpecialPowers.spawn(browser, [], async () => {
        const doc = content.document;
        await ContentTaskUtils.waitForCondition(() => !doc.body.classList.contains("whimsy-game-embedded"), "Esc leaves the game");
        is(content.wrappedJSObject.__whimsyGame.state.state, "paused", "and pauses it");
        is(content.getComputedStyle(doc.getElementById("whimsy-game-embed")).display, "none", "The game is out of sight");
        const root = doc.querySelector("net-error-card")?.shadowRoot || doc;
        const tryAgain = root.querySelector("#neterrorTryAgainButton, #tryAgainButton");
        Assert.greater(tryAgain.getBoundingClientRect().width, 0, "Try Again is back on screen");
      });

      await BrowserTestUtils.synthesizeKey("KEY_ArrowRight", {}, browser);
      await SpecialPowers.spawn(browser, [], async () => {
        const doc = content.document;
        await ContentTaskUtils.waitForCondition(() => doc.body.classList.contains("whimsy-game-embedded"), "A key shows the game again");
        is(content.wrappedJSObject.__whimsyGame.state.state, "running", "and picks the run back up");
      });
    });
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function accel_w_closes_the_game_tab() {
  await SpecialPowers.pushPrefEnv({ set: GAME_PREFS });
  try {
    const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
    const browser = tab.linkedBrowser;
    const loaded = BrowserTestUtils.waitForErrorPage(browser);
    const url = `about:neterror?e=netOffline&u=${encodeURIComponent("https://example.com/")}&d=x`;
    await SpecialPowers.spawn(browser, [url], u => { content.location = u; });
    await loaded;
    await prepare(browser);
    await BrowserTestUtils.synthesizeKey(" ", {}, browser);
    await gameState(browser, true);
    const closed = BrowserTestUtils.waitForTabClosing(tab);
    EventUtils.synthesizeKey("w", { accelKey: true });
    await closed;
    ok(!gBrowser.tabs.includes(tab), "Accel+W closes the tab the game is playing in");
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});

// wave8: Balloon Dash back online notice (W8-43)
add_task(async function online_notice_in_embedded_game_and_not_for_fun() {
  await SpecialPowers.pushPrefEnv({ set: GAME_PREFS });
  // Really offline (F27: a game that starts online says so at once).
  const manage = Services.io.manageOfflineStatus;
  Services.io.manageOfflineStatus = false;
  Services.io.offline = true;
  try {
    await withWhimsyError("netOffline", async browser => {
      await prepare(browser);
      await BrowserTestUtils.synthesizeKey(" ", {}, browser);
      await gameState(browser, true);

      await SpecialPowers.spawn(browser, [], async () => {
        const doc = content.document;
        const notice = doc.getElementById("whimsy-game-online-notice");
        ok(notice, "The online notice exists in the embedded error game");
        ok(notice.hidden, "The notice is hidden initially while offline");

        const reloadBtn = doc.getElementById("whimsy-game-reload-btn");
        ok(reloadBtn, "The reload button exists in the notice");

        content.dispatchEvent(new content.Event("online"));
        ok(!notice.hidden, "Dispatching online shows the notice");

        content.dispatchEvent(new content.Event("offline"));
        ok(notice.hidden, "Dispatching offline hides the notice again");

        content.dispatchEvent(new content.Event("online"));
        ok(!notice.hidden, "Dispatching online brings the notice back");
      });
    });
  } finally {
    Services.io.offline = false;
    Services.io.manageOfflineStatus = manage;
    await SpecialPowers.popPrefEnv();
  }
});

// W10-51: coming back online keeps the run going under the notice. A click
// on the notice (while dashing with the mouse) is a dash, not a reload; only
// the Reload button reloads.
add_task(async function back_online_keeps_playing_until_reload_is_chosen() {
  await SpecialPowers.pushPrefEnv({ set: GAME_PREFS });
  try {
    await withWhimsyError("netOffline", async browser => {
      await prepare(browser);
      await BrowserTestUtils.synthesizeKey(" ", {}, browser);
      await gameState(browser, true);

      const points = await SpecialPowers.spawn(browser, [], async () => {
        const win = content.wrappedJSObject;
        const game = win.__whimsyGame;
        game.freeze();
        game.setAutoSpawn(false);
        game.clear();
        game.state.player.dashCd = 0;
        win.whimsyW1051 = "same page";
        content.dispatchEvent(new content.Event("online"));
        const notice = content.document.getElementById("whimsy-game-online-notice");
        ok(!notice.hidden, "The back-online notice shows");
        is(notice.getAttribute("role"), "status", "The notice is announced as a status");
        // The notice may only render after a frame.
        await new Promise(resolve => content.requestAnimationFrame(() => content.requestAnimationFrame(resolve)));
        const pill = notice.getBoundingClientRect();
        const dot = notice.querySelector(".whimsy-game-online-dot").getBoundingClientRect();
        const button = content.document.getElementById("whimsy-game-reload-btn").getBoundingClientRect();
        ok(pill.width > 0 && pill.height > 0, "The notice is on screen");
        return {
          notice: { x: dot.left + dot.width / 2, y: pill.top + pill.height / 2 },
          button: { x: button.left + button.width / 2, y: button.top + button.height / 2 },
        };
      });

      // Let a real "online" moment pass: nothing reloads by itself.
      await SpecialPowers.spawn(browser, [], async () => {
        // eslint-disable-next-line mozilla/no-arbitrary-setTimeout
        await new Promise(resolve => content.setTimeout(resolve, 500));
      });
      await BrowserTestUtils.synthesizeMouseAtPoint(points.notice.x, points.notice.y, {}, browser);
      await SpecialPowers.spawn(browser, [], async () => {
        // eslint-disable-next-line mozilla/no-arbitrary-setTimeout
        await new Promise(resolve => content.setTimeout(resolve, 500));
        const win = content.wrappedJSObject;
        is(win.whimsyW1051, "same page", "Clicking the notice does not reload the page");
        const game = win.__whimsyGame.state;
        is(game.state, "running", "The run keeps going");
        ok(game.player.dashCd > 0, "A click on the notice dashes like a click anywhere on the stage");
        ok(!content.document.getElementById("whimsy-game-online-notice").hidden, "The notice stays up");
      });

      const reloaded = BrowserTestUtils.waitForErrorPage(browser);
      await BrowserTestUtils.synthesizeMouseAtPoint(points.button.x, points.button.y, {}, browser);
      await reloaded;
      const fresh = await SpecialPowers.spawn(browser, [], () => content.wrappedJSObject.whimsyW1051 ?? null);
      is(fresh, null, "The Reload button reloads the page when the user chooses it");
    });
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});

// F27: really going offline and back (not a synthetic event), both ways
// Firefox can be offline (Work Offline, and the network link going down):
// the notice shows once the browser is online again.
add_task(async function online_notice_when_really_back_online() {
  await SpecialPowers.pushPrefEnv({ set: GAME_PREFS });
  const manage = Services.io.manageOfflineStatus;
  Services.io.manageOfflineStatus = false;
  const ways = {
    offline: on => (Services.io.offline = !on),
    link: on => Services.io.setConnectivityForTesting(on),
  };
  try {
    for (const [way, setOnline] of Object.entries(ways)) {
      setOnline(false);
      await withWhimsyError("netOffline", async browser => {
        await prepare(browser);
        await BrowserTestUtils.synthesizeKey(" ", {}, browser);
        is((await gameState(browser, true)).state, "running", `${way}: the error page is the game`);
        ok(await SpecialPowers.spawn(browser, [], () => content.document.getElementById("whimsy-game-online-notice").hidden),
          "No notice while offline");
        ok(await SpecialPowers.spawn(browser, [], () => !content.navigator.onLine), "The page knows it's offline");
        setOnline(true);
        await SpecialPowers.spawn(browser, [], () =>
          ContentTaskUtils.waitForCondition(() => {
            const notice = content.document.getElementById("whimsy-game-online-notice");
            return notice && !notice.hidden && notice.checkVisibility();
          }, "Back online, the notice shows"));
      });
      // Back online before the first dash: the notice shows at once.
      setOnline(false);
      await withWhimsyError("netOffline", async browser => {
        await prepare(browser);
        setOnline(true);
        await SpecialPowers.spawn(browser, [], () =>
          ContentTaskUtils.waitForCondition(() => content.navigator.onLine, "The page is online"));
        await BrowserTestUtils.synthesizeKey(" ", {}, browser);
        await gameState(browser, true);
        await SpecialPowers.spawn(browser, [], () =>
          ContentTaskUtils.waitForCondition(() =>
            !content.document.getElementById("whimsy-game-online-notice").hidden,
          "Online before the game started: the notice shows"));
      });
    }
  } finally {
    Services.io.offline = false;
    Services.io.setConnectivityForTesting(true);
    Services.io.manageOfflineStatus = manage;
    await SpecialPowers.popPrefEnv();
  }
});
