/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W31 (owner: with Adaptive dark pages, Google's wordmark turned one
// orange-gold colour, and a flight card had a muddy halo around it).
// A multicolour logo keeps its colours (each letter keeps its hue) in every
// form a page shows one, while monochrome icons are still lightened. A soft
// box-shadow on a generated dark page stays a dark shadow of the same shape,
// a zero-blur ring still recolours like a border, and a page that is
// already dark is left exactly as it was.

Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "head_whimsy_dark_pages.js", this);

const LOGO_PAGE = ROOT + "whimsy_dark_pages_logo.html";
const DARK_PAGE = ROOT + "whimsy_dark_pages_logo_dark.html";

// Hue in degrees and saturation (0..1) of an [r, g, b] pixel.
function hsl([r, g, b]) {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  const l = (max + min) / 2;
  const d = max - min;
  if (!d) {
    return { h: 0, s: 0, l };
  }
  const s = d / (1 - Math.abs(2 * l - 1));
  let h;
  const [R, G, B] = [r / 255, g / 255, b / 255];
  if (max == R) {
    h = ((G - B) / d) % 6;
  } else if (max == G) {
    h = (B - R) / d + 2;
  } else {
    h = (R - G) / d + 4;
  }
  return { h: (h * 60 + 360) % 360, s, l };
}

const luma = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

// The four letters' expected hues: blue, red, yellow, green.
const LETTERS = [
  { name: "blue", ok: h => h >= 195 && h <= 245 },
  { name: "red", ok: h => h >= 345 || h <= 15 },
  { name: "yellow", ok: h => h >= 35 && h <= 60 },
  { name: "green", ok: h => h >= 110 && h <= 160 },
];

async function shoot(browser, name) {
  const { result, png } = await SpecialPowers.spawn(browser, [], () => {
    const doc = content.document;
    const canvas = doc.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
    canvas.width = content.innerWidth;
    canvas.height = content.innerHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawWindow(content, 0, 0, canvas.width, canvas.height, "white");
    const pixel = (x, y) => [...ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data].slice(0, 3);
    const result = { logos: {}, icons: {} };
    for (const el of doc.querySelectorAll("[data-logo]")) {
      const rect = el.getBoundingClientRect();
      // Letters are 36px wide at x = 0, 40, 80, 120 of a 160 x 40 box.
      result.logos[el.dataset.logo] = [0, 1, 2, 3].map(i => pixel(rect.x + 18 + 40 * i, rect.y + 20));
    }
    for (const el of doc.querySelectorAll("[data-icon]")) {
      const rect = el.getBoundingClientRect();
      result.icons[el.dataset.icon] = pixel(rect.x + rect.width / 2, rect.y + rect.height / 2);
    }
    const card = doc.getElementById("card").getBoundingClientRect();
    result.card = pixel(card.x + card.width / 2, card.y + card.height / 2);
    // Inside the shadow's blur, below the card, and the page far from it.
    result.shadow = pixel(card.x + card.width / 2, card.bottom + 8);
    result.page = pixel(content.innerWidth - 6, card.y + card.height / 2);
    const ring = doc.getElementById("ring")?.getBoundingClientRect();
    if (ring) {
      result.ring = pixel(ring.x + ring.width / 2, ring.bottom + 3);
    }
    return { result, png: canvas.toDataURL("image/png") };
  });
  const dir = Services.env.get("MOZ_UPLOAD_DIR");
  if (dir) {
    const bytes = Uint8Array.from(atob(png.split(",")[1]), c => c.charCodeAt(0));
    await IOUtils.write(PathUtils.join(dir, `whimsy-dark-logo-${name}.png`), bytes);
  }
  return result;
}

async function decoded(browser) {
  await SpecialPowers.spawn(browser, [], async () => {
    await Promise.all([...content.document.images].map(img => img.decode().catch(() => {})));
    await new Promise(resolve => content.requestAnimationFrame(() => content.requestAnimationFrame(resolve)));
  });
}

add_task(async function multicolour_logos_keep_their_colours() {
  await SpecialPowers.pushPrefEnv({ set: [[MODE, "off"]] });
  await BrowserTestUtils.withNewTab(LOGO_PAGE, async browser => {
    await decoded(browser);
    await darkState(browser, "original");
    const light = await shoot(browser, "light");

    await SpecialPowers.pushPrefEnv({ set: [[MODE, "always"]] });
    await darkState(browser, "generated");
    await decoded(browser);
    const dark = await shoot(browser, "dark");

    for (const [form, letters] of Object.entries(dark.logos)) {
      info(`${form}: light ${JSON.stringify(light.logos[form])} dark ${JSON.stringify(letters)}`);
      LETTERS.forEach(({ name, ok: hueOk }, i) => {
        const before = hsl(light.logos[form][i]);
        ok(hueOk(before.h) && before.s > 0.5, `${form}: the light page shows a ${name} letter`);
        const after = hsl(letters[i]);
        ok(hueOk(after.h) && after.s > 0.35,
          `${form}: the ${name} letter stays ${name} on the dark page (${letters[i]}, hue ${Math.round(after.h)}, sat ${after.s.toFixed(2)})`);
      });
    }
    for (const [icon, center] of Object.entries(dark.icons)) {
      ok(Math.max(...light.icons[icon]) < 60, `${icon}: dark in light mode (${light.icons[icon]})`);
      ok(Math.min(...center) > 150, `${icon}: a dark icon is still lightened (${center})`);
    }

    info(`light: page ${light.page} shadow ${light.shadow} card ${light.card} ring ${light.ring}`);
    info(`dark: page ${dark.page} shadow ${dark.shadow} card ${dark.card} ring ${dark.ring}`);
    ok(luma(light.shadow) < luma(light.page) - 4, "Light page: the card casts a shadow");
    ok(luma(dark.page) < 60 && luma(dark.card) < 80, "Dark page: the page and card are dark");
    ok(luma(dark.shadow) < luma(dark.page) - 2,
      `Dark page: the card's shadow is darker than the page, not a light halo (shadow ${dark.shadow}, page ${dark.page})`);
    ok(luma(light.ring) < luma(light.page), "Light page: the zero-blur ring is darker than the page");
    ok(luma(dark.ring) > luma(dark.page) + 4,
      `Dark page: a zero-blur ring recolours like a border (ring ${dark.ring}, page ${dark.page})`);
  });
  await SpecialPowers.popPrefEnv();
  await SpecialPowers.popPrefEnv();
});

add_task(async function an_already_dark_page_is_left_alone() {
  await SpecialPowers.pushPrefEnv({ set: [[MODE, "off"]] });
  await BrowserTestUtils.withNewTab(DARK_PAGE, async browser => {
    await darkState(browser, "original");
    const before = await shoot(browser, "already-dark-off");

    await SpecialPowers.pushPrefEnv({ set: [[MODE, "always"]] });
    await darkState(browser, "native");
    const after = await shoot(browser, "already-dark-on");
    info(`off: page ${before.page} shadow ${before.shadow} card ${before.card}; on: page ${after.page} shadow ${after.shadow} card ${after.card}`);
    for (const key of ["page", "shadow", "card"]) {
      ok(after[key].every((v, i) => Math.abs(v - before[key][i]) <= 2),
        `The already-dark page's ${key} is unchanged (${before[key]} -> ${after[key]})`);
    }
    ok(luma(after.shadow) <= luma(after.page), "Its shadow is not a light halo");
  });
  await SpecialPowers.popPrefEnv();
  await SpecialPowers.popPrefEnv();
});
