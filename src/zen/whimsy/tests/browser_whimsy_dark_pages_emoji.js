/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W30 (owner: with Adaptive dark pages, a 😅 showed dark brown with odd
// highlights instead of yellow). Every way a page shows an emoji keeps its
// colours on a generated dark page: each form's yellow pixels are counted in
// light and in dark, from a screenshot of the same local page. Dark icons
// are still lightened.

Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "head_whimsy_dark_pages.js", this);

const EMOJI_PAGE = ROOT + "whimsy_dark_pages_emoji.html";

// A screenshot of the page, measured per [data-form] and [data-icon] box.
// With MOZ_UPLOAD_DIR set, the screenshot is kept as evidence.
async function shoot(browser, name) {
  const { boxes, png } = await SpecialPowers.spawn(browser, [], () => {
    const doc = content.document;
    const canvas = doc.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
    canvas.width = content.innerWidth;
    canvas.height = content.innerHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawWindow(content, 0, 0, canvas.width, canvas.height, "white");
    const boxes = {};
    for (const el of doc.querySelectorAll("[data-form], [data-icon]")) {
      const rect = el.getBoundingClientRect();
      const data = ctx.getImageData(Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)).data;
      let yellow = 0;
      const sum = [0, 0, 0];
      for (let i = 0; i < data.length; i += 4) {
        const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
        if (r >= 200 && g >= 150 && b <= 140 && r - b >= 90) {
          yellow++;
        }
        sum[0] += r;
        sum[1] += g;
        sum[2] += b;
      }
      const n = data.length / 4;
      const center = [...ctx.getImageData(Math.round(rect.x + rect.width / 2), Math.round(rect.y + rect.height / 2), 1, 1).data].slice(0, 3);
      boxes[el.dataset.form || el.dataset.icon] = { yellow, mean: sum.map(v => Math.round(v / n)), center };
    }
    return { boxes, png: canvas.toDataURL("image/png") };
  });
  const dir = Services.env.get("MOZ_UPLOAD_DIR");
  if (dir) {
    const bytes = Uint8Array.from(atob(png.split(",")[1]), c => c.charCodeAt(0));
    await IOUtils.write(PathUtils.join(dir, `whimsy-dark-emoji-${name}.png`), bytes);
  }
  return boxes;
}

add_task(async function every_emoji_form_keeps_its_colours() {
  await SpecialPowers.pushPrefEnv({ set: [[MODE, "off"]] });
  await BrowserTestUtils.withNewTab(EMOJI_PAGE, async browser => {
    await SpecialPowers.spawn(browser, [], () => ContentTaskUtils.waitForCondition(
      () => content.document.documentElement.dataset.emojiReady == "true", "The page's images decoded"));
    await darkState(browser, "original");
    const light = await shoot(browser, "light");

    await SpecialPowers.pushPrefEnv({ set: [[MODE, "always"]] });
    await darkState(browser, "generated");
    const dark = await shoot(browser, "dark");

    for (const [form, before] of Object.entries(light)) {
      const after = dark[form];
      info(`${form}: light ${before.yellow} yellow px, mean ${before.mean}; dark ${after.yellow} yellow px, mean ${after.mean}, centre ${after.center}`);
    }
    for (const form of Object.keys(light).filter(form => !form.includes("icon") && !form.includes("emoji picker"))) {
      ok(light[form].yellow > 150, `${form}: the light page shows a yellow face`);
      ok(dark[form].yellow >= light[form].yellow * 0.9,
        `${form}: the dark page keeps the face yellow (${dark[form].yellow} of ${light[form].yellow} px)`);
    }
    for (const icon of ["svg icon img", "svg icon background", "inline svg icon", "emoji picker button", "emoji picker svg"]) {
      ok(Math.max(...light[icon].center) < 60, `${icon}: dark in light mode`);
      ok(Math.min(...dark[icon].center) > 150, `${icon}: a dark icon is still lightened (${dark[icon].center})`);
    }
  });
  await SpecialPowers.popPrefEnv();
  await SpecialPowers.popPrefEnv();
});
