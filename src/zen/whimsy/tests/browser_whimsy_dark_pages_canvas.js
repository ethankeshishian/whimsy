/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W30 (owner: with Adaptive dark pages, a 😅 drawn in a canvas showed dark
// brown instead of yellow). A 2D canvas on a generated dark page recolours
// its colours as it draws, as the page's CSS colours are recoloured, instead
// of a filter over its pixels: text and fills adapt, a chart keeps its hues,
// images keep their pixels as an <img> does (SVG icons adapt, SVG emoji
// don't), and WebGL keeps the display-time lightness flip.

Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "head_whimsy_dark_pages.js", this);

const CANVAS_PAGE = ROOT + "whimsy_dark_pages_canvas2d.html";

// The page redraws its canvases, then the screenshot is read at points
// relative to each canvas.
async function paint(browser) {
  return SpecialPowers.spawn(browser, [], () => {
    const doc = content.document;
    content.wrappedJSObject.drawCanvases();
    const shot = doc.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
    shot.width = content.innerWidth;
    shot.height = content.innerHeight;
    const ctx = shot.getContext("2d");
    ctx.drawWindow(content, 0, 0, shot.width, shot.height, "white");
    const box = id => doc.getElementById(id).getBoundingClientRect();
    const at = (id, x, y) => {
      const rect = box(id);
      return [...ctx.getImageData(Math.round(rect.x + x), Math.round(rect.y + y), 1, 1).data].slice(0, 3);
    };
    // The lightest and darkest pixels of the word "Hello".
    const word = box("text");
    const data = ctx.getImageData(Math.round(word.x + 10), Math.round(word.y + 15), 80, 30).data;
    let lightest = 0;
    let darkest = 255;
    for (let i = 0; i < data.length; i += 4) {
      const value = Math.max(data[i], data[i + 1], data[i + 2]);
      lightest = Math.max(lightest, value);
      darkest = Math.min(darkest, value);
    }
    let yellow = 0;
    const emoji = box("images");
    const face = ctx.getImageData(Math.round(emoji.x + 112), Math.round(emoji.y), 48, 48).data;
    for (let i = 0; i < face.length; i += 4) {
      if (face[i] >= 200 && face[i + 1] >= 150 && face[i + 2] <= 140) {
        yellow++;
      }
    }
    return {
      sheet: at("text", 4, 4), highlight: at("text", 180, 14), lightest, darkest,
      chartBackground: at("chart", 230, 10), blue: at("chart", 40, 100), orange: at("chart", 100, 100),
      gradientStart: at("chart", 142, 55), gradientEnd: at("chart", 218, 55),
      photo: at("images", 24, 24), icon: at("images", 80, 24), yellow,
      webgl: at("webgl", 24, 24),
    };
  });
}

// The text canvas's sheet as shown, without redrawing it.
function sheetPixel(browser) {
  return SpecialPowers.spawn(browser, [], () => {
    const shot = content.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
    shot.width = content.innerWidth;
    shot.height = content.innerHeight;
    const ctx = shot.getContext("2d");
    ctx.drawWindow(content, 0, 0, shot.width, shot.height, "white");
    const rect = content.document.getElementById("text").getBoundingClientRect();
    return [...ctx.getImageData(Math.round(rect.x + 4), Math.round(rect.y + 4), 1, 1).data].slice(0, 3);
  });
}

add_task(async function canvas_drawing_adapts_and_emoji_keep_their_colours() {
  await SpecialPowers.pushPrefEnv({ set: [[MODE, "off"]] });
  await BrowserTestUtils.withNewTab(CANVAS_PAGE, async browser => {
    await SpecialPowers.spawn(browser, [], () => ContentTaskUtils.waitForCondition(
      () => content.document.documentElement.dataset.ready == "true", "The page's images decoded"));
    await darkState(browser, "original");
    const light = await paint(browser);
    info(`light: ${JSON.stringify(light)}`);
    ok(Math.min(...light.sheet) > 240 && light.darkest < 60, "Light: black text on a white sheet");
    ok(Math.min(...light.chartBackground) > 240, "Light: the chart is white");
    Assert.deepEqual(light.webgl, [255, 255, 255], "Light: the WebGL canvas is white");

    await SpecialPowers.pushPrefEnv({ set: [[MODE, "always"]] });
    await darkState(browser, "generated");
    const dark = await paint(browser);
    info(`dark: ${JSON.stringify(dark)}`);

    // Text and fills.
    ok(Math.max(...dark.sheet) < 80, `The canvas's white sheet is dark (${dark.sheet})`);
    ok(dark.lightest > 170, `Canvas text is light on it (${dark.lightest})`);
    ok(dark.highlight[0] > dark.highlight[2] && Math.max(...dark.highlight) < 160,
      `The highlight is a dark warm colour (${dark.highlight})`);

    // A chart keeps its hues on a dark background.
    ok(Math.max(...dark.chartBackground) < 80, `The chart's background is dark (${dark.chartBackground})`);
    ok(dark.blue[2] > dark.blue[0] + 40, `The blue bar stays blue (${dark.blue})`);
    ok(dark.orange[0] > dark.orange[2] + 40, `The orange bar stays orange (${dark.orange})`);
    ok(dark.gradientStart[1] > dark.gradientStart[0], `The gradient starts green (${dark.gradientStart})`);
    ok(dark.gradientEnd[0] > dark.gradientEnd[1], `The gradient ends red (${dark.gradientEnd})`);

    // drawImage: a photo keeps its pixels, an SVG icon adapts, an SVG emoji
    // keeps its colours.
    for (let i = 0; i < 3; i++) {
      Assert.lessOrEqual(Math.abs(dark.photo[i] - light.photo[i]), 2, `The photo keeps its pixels (${dark.photo})`);
    }
    ok(Math.max(...light.icon) < 60 && Math.min(...dark.icon) > 150, `The dark SVG icon is lightened (${light.icon} → ${dark.icon})`);
    ok(light.yellow > 900, `Light: the SVG emoji is yellow (${light.yellow} px)`);
    ok(dark.yellow >= light.yellow * 0.9, `The SVG emoji keeps its yellow (${dark.yellow} of ${light.yellow} px)`);

    // WebGL can't recolour as it draws; it keeps the lightness flip.
    ok(Math.max(...dark.webgl) < 60, `The white WebGL canvas is shown dark (${dark.webgl})`);
  });
  await SpecialPowers.popPrefEnv();
  await SpecialPowers.popPrefEnv();
});

// A canvas drawn before the page turned dark, and not redrawn, gets the
// lightness flip until it draws again; then its colours are recoloured and
// the flip goes.
add_task(async function a_canvas_drawn_before_the_switch_adapts() {
  await SpecialPowers.pushPrefEnv({ set: [[MODE, "off"]] });
  await BrowserTestUtils.withNewTab(CANVAS_PAGE, async browser => {
    await SpecialPowers.spawn(browser, [], () => ContentTaskUtils.waitForCondition(
      () => content.document.documentElement.dataset.ready == "true", "The page's images decoded"));
    await darkState(browser, "original");
    await SpecialPowers.pushPrefEnv({ set: [[MODE, "always"]] });
    await darkState(browser, "generated");
    const sheet = await sheetPixel(browser);
    ok(Math.max(...sheet) < 80, `The white sheet drawn in light mode is shown dark (${sheet})`);
    const redrawn = await paint(browser);
    ok(Math.max(...redrawn.sheet) < 80 && redrawn.lightest > 170, "Redrawn, it's still dark with light text");

    await SpecialPowers.pushPrefEnv({ set: [[MODE, "off"]] });
    await darkState(browser, "original");
    const after = await sheetPixel(browser);
    ok(Math.min(...after) > 200, `Back in light mode, the canvas drawn dark is shown light (${after})`);
    await SpecialPowers.popPrefEnv();
    await SpecialPowers.popPrefEnv();
  });
  await SpecialPowers.popPrefEnv();
});
