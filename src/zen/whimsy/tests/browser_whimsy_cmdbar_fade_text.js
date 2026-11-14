/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W26 (owner): "sometimes when i type in the command bar and press enter, a
// couple of the last letters disappear as it's fading away". The close
// stand-in shows a picture of the bar; that picture was only re-taken 80ms
// after typing paused, so fast typing then Enter faded out an older picture
// without the last letters. Every frame of the fade must show exactly what
// was in the bar when Enter was pressed, in light and dark, and on Zen's
// see-through (acrylic) bar the page behind it too.

const { UrlbarTestUtils } = ChromeUtils.importESModule("resource://testing-common/UrlbarTestUtils.sys.mjs");

registerCleanupFunction(() => {
  gReduceMotionOverride = undefined;
});

const ghosts = () => [...document.querySelectorAll(".whimsy-command-bar-ghost")];
const frame = () => new Promise(resolve => requestAnimationFrame(() => resolve()));

// The bar's own box (what the stand-in pictures) and its text row inside it.
function barBoxes() {
  const box = gURLBar.querySelector(".urlbar-background").getBoundingClientRect();
  const input = gURLBar.inputField.getBoundingClientRect();
  return { box, input };
}

async function pictureOf(rect) {
  const bitmap = await whimsySnapshot(window.browsingContext.currentWindowGlobal,
    new DOMRect(rect.x, rect.y, rect.width, rect.height), devicePixelRatio, "rgba(0,0,0,0)");
  return bitmapPixels(bitmap);
}

function bitmapPixels(source) {
  const canvas = document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  const context = canvas.getContext("2d");
  context.drawImage(source, 0, 0);
  return { canvas, data: context.getImageData(0, 0, canvas.width, canvas.height).data, width: canvas.width };
}

// How many pixels of the text row differ by more than a little.
function textRowDiff(a, b, row) {
  // The text row sits at the same place in both pictures, whatever the
  // results below it did, so only it is compared.
  const right = Math.min(row.right, a.width, b.width);
  const bottom = Math.min(row.bottom, a.data.length / 4 / a.width, b.data.length / 4 / b.width);
  let differing = 0;
  for (let y = row.top; y < bottom; y++) {
    for (let x = row.left; x < right; x++) {
      const i = (y * a.width + x) * 4;
      const j = (y * b.width + x) * 4;
      const delta = Math.abs(a.data[i] - b.data[j]) + Math.abs(a.data[i + 1] - b.data[j + 1]) +
        Math.abs(a.data[i + 2] - b.data[j + 2]) + Math.abs(a.data[i + 3] - b.data[j + 3]);
      if (delta > 48) {
        differing++;
      }
    }
  }
  return differing;
}

// The mean color of a small patch of the bar's own background (inside its
// bottom end corner, clear of the text and the results).
function backdropColor(picture, box) {
  const dpr = devicePixelRatio;
  const height = picture.data.length / 4 / picture.width;
  const left = Math.round(Math.min(box.width - 30, picture.width / dpr - 30) * dpr);
  const top = Math.round(Math.min(box.height - 10, height / dpr - 10) * dpr);
  const sum = [0, 0, 0];
  let count = 0;
  for (let y = top; y < top + 4 * dpr; y++) {
    for (let x = left; x < left + 8 * dpr; x++) {
      const i = (y * picture.width + x) * 4;
      sum[0] += picture.data[i];
      sum[1] += picture.data[i + 1];
      sum[2] += picture.data[i + 2];
      count++;
    }
  }
  return sum.map(value => value / count);
}

const colorApart = (a, b) => a.reduce((total, value, i) => total + Math.abs(value - b[i]), 0);

async function saveShot(canvas, name) {
  if (!WHIMSY_SHOTS_DIR) {
    return;
  }
  const blob = await new Promise(resolve => canvas.toBlob(resolve));
  const path = PathUtils.join(WHIMSY_SHOTS_DIR, `${name}.png`);
  await IOUtils.write(path, new Uint8Array(await blob.arrayBuffer()));
  info(`Saved ${path}`);
}

// Zen's ⌘T, the way the app runs it (tests otherwise get a real new tab).
// Picking a result from this bar closes it within a couple of timeouts,
// well inside the 80ms it took the old picture to catch up.
function commandT() {
  const testing = gZenUIManager.testingEnabled;
  gZenUIManager.testingEnabled = false;
  try {
    document.getElementById("cmd_newNavigatorTab").doCommand();
  } finally {
    gZenUIManager.testingEnabled = testing;
  }
}

// A vivid page under the bar, so a picture that leaves the page out (the
// window's plain background instead) shows on a see-through bar.
const VIVID_PAGE = "data:text/html,<body style='margin:0;height:100vh;background:rgb(255,0,200)'>";

async function fadeAfterEnter({ dark, seeThrough }) {
  const tag = `${dark ? "dark" : "light"}${seeThrough ? "-acrylic" : ""}`;
  info(`--- ${tag} ---`);
  await whimsySetScheme(dark);
  const tabsBefore = new Set(gBrowser.tabs);
  const page = await BrowserTestUtils.openNewForegroundTab(gBrowser, VIVID_PAGE);
  try {
    gBrowser.selectedBrowser.focus();
    commandT();
    await TestUtils.waitForCondition(() => gURLBar.hasAttribute("zen-newtab") && gURLBar.focused, "⌘T opens the bar");
    EventUtils.sendString("example.com/");
    await TestUtils.waitForCondition(
      () => gURLBar.getAttribute("zen-floating-urlbar") == "true" && gURLBar.hasAttribute("open") && gURLBar.view.isOpen,
      "The command bar floats open with results"
    );
    await TestUtils.waitForCondition(() => !WhimsyCommandBarMotion.animation, "The open motion is over");
    const background = gURLBar.querySelector(".urlbar-background");
    if (seeThrough) {
      // Zen's acrylic bar (zen-omnibox.css under zen.theme.acrylic-urlbar,
      // on in Twilight builds). That pref is read once at startup, so its
      // two rules are applied to this bar as they are.
      background.style.setProperty("--zen-urlbar-background-transparent",
        dark ? "rgba(20, 20, 20, .92)" : "rgba(255, 255, 255, .93)");
      background.style.setProperty("backdrop-filter", "var(--zen-backdrop-underlay) blur(40px)", "important");
    }
    const barStyle = getComputedStyle(background);
    const alpha = Number(barStyle.backgroundColor.match(/rgba?\(([^)]*)\)/)[1].split(",")[3] ?? 1);
    if (seeThrough) {
      Assert.less(alpha, 1, `The acrylic bar is see-through (${barStyle.backgroundColor}, ${barStyle.backdropFilter})`);
    } else {
      is(alpha, 1, "The plain bar is solid");
    }
    // Let the bar settle so its picture is taken (80ms after the last change),
    // the state the owner's fast typing starts from.
    await new Promise(resolve => setTimeout(resolve, 300));
    const before = await pictureOf(barBoxes().box);

    // Type fast and press Enter at once, as a quick typist does. The bar as it
    // is the instant before Enter is the reference.
    EventUtils.sendString("fadetext");
    is(gURLBar.value, "example.com/fadetext", "Every letter is in the bar");
    const { box, input } = barBoxes();
    const pendingTyped = whimsySnapshot(window.browsingContext.currentWindowGlobal,
      new DOMRect(box.x, box.y, box.width, box.height), devicePixelRatio, "rgba(0,0,0,0)");
    // The stand-in, caught the moment it's added (it only lives ~110ms), and
    // what its picture shows on every frame it's on screen (read in each
    // frame's callbacks, so before that frame paints).
    const shownFrames = [];
    let ghost = null;
    let sampling = true;
    const sampled = new Promise(resolve => {
      const sample = () => {
        if (!ghost.isConnected || !sampling) {
          resolve();
          return;
        }
        const canvas = ghost.querySelector("canvas");
        shownFrames.push(canvas ? bitmapPixels(canvas) : null);
        requestAnimationFrame(sample);
      };
      const watch = new MutationObserver(() => {
        [ghost] = ghosts();
        if (ghost) {
          watch.disconnect();
          // Keep the stand-in up (its picture doesn't depend on how far it
          // has faded) until its picture has the page behind the bar.
          ghost.getAnimations().forEach(animation => animation.pause());
          requestAnimationFrame(sample);
        }
      });
      watch.observe(document.documentElement, { childList: true });
    });
    EventUtils.synthesizeKey("KEY_Enter");
    const typed = bitmapPixels(await pendingTyped);
    const typedBackdrop = backdropColor(typed, box);
    info(`Bar background at Enter: ${typedBackdrop.map(Math.round)}`);

    const dpr = devicePixelRatio;
    const row = {
      left: Math.max(0, Math.floor((input.left - box.left) * dpr)),
      right: Math.min(typed.width, Math.ceil((input.right - box.left) * dpr)),
      top: Math.max(0, Math.floor((input.top - box.top) * dpr)),
      bottom: Math.min(typed.canvas.height, Math.ceil((input.bottom - box.top) * dpr)),
    };
    const lettersApart = textRowDiff(typed, before, row);
    Assert.greater(lettersApart, 20, `The new letters show in the bar's text row (${lettersApart} px)`);
    await saveShot(before.canvas, `cmdfade-${tag}-0-settled-before-typing`);
    await saveShot(typed.canvas, `cmdfade-${tag}-1-bar-at-enter`);

    await TestUtils.waitForCondition(() => ghost, "The bar's stand-in fades after Enter");
    await TestUtils.waitForCondition(() => {
      const canvas = ghost.querySelector("canvas");
      return canvas && colorApart(backdropColor(bitmapPixels(canvas), box), typedBackdrop) < 6;
    }, "The stand-in's picture comes to have the page behind the bar");
    sampling = false;
    await sampled;
    // The picture it came to, checked with the frames below.
    shownFrames.push(bitmapPixels(ghost.querySelector("canvas")));
    ghost.getAnimations().forEach(animation => animation.finish());

    // Every frame of the fade, from the first one painted.
    let frames = 0;
    for (const shown of shownFrames) {
      ok(shown, `Frame ${frames}: the stand-in shows the bar's picture`);
      if (!shown) {
        break;
      }
      const fromTyped = textRowDiff(shown, typed, row);
      const fromBefore = textRowDiff(shown, before, row);
      const backdrop = colorApart(backdropColor(shown, box), typedBackdrop);
      info(`Frame ${frames}: ${fromTyped} px from the typed text, ${fromBefore} px from the older picture, background ${Math.round(backdrop)} apart`);
      Assert.less(fromTyped, lettersApart / 4,
        `Frame ${frames}: the fading bar shows every letter typed, unchanged`);
      await saveShot(shown.canvas, `cmdfade-${tag}-2-fade-frame-${frames}`);
      frames++;
    }
    Assert.greater(frames, 0, "At least one frame of the fade was checked");
    await TestUtils.waitForCondition(() => !ghosts().length, "The stand-in goes away");
    isnot(gURLBar.getAttribute("zen-floating-urlbar"), "true", "Enter closed the bar");
  } finally {
    for (const tab of [...gBrowser.tabs]) {
      if (!tabsBefore.has(tab) && tab != page) {
        BrowserTestUtils.removeTab(tab);
      }
    }
    BrowserTestUtils.removeTab(page);
    gURLBar.querySelector(".urlbar-background").style.removeProperty("--zen-urlbar-background-transparent");
    gURLBar.querySelector(".urlbar-background").style.removeProperty("backdrop-filter");
    await SpecialPowers.popPrefEnv();
  }
}

add_task(async function fast_typing_then_enter_fades_the_whole_text() {
  gReduceMotionOverride = false;
  // Enter handled as quickly as on a real Mac. In automation the urlbar
  // holds Enter up to 1500ms (300ms in the app) for the new first result,
  // which left the old 80ms picture plenty of time to catch up; on a real
  // Mac that result is there at once and the bar closes within ~15ms.
  await SpecialPowers.pushPrefEnv({ set: [
    ["browser.urlbar.eventBufferer.deferringTimeoutMs", 0],
  ] });
  for (const dark of [true, false]) {
    for (const seeThrough of [false, true]) {
      await fadeAfterEnter({ dark, seeThrough });
    }
  }
});
